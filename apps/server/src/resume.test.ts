import { describe, expect, it, vi } from "vitest";
import { ChainError, keypairSigner, type AgentDecision, type Role } from "@noirxvelo/agent";
import { computePayouts, toStroops } from "@noirxvelo/shared";
import { Keypair } from "@stellar/stellar-sdk";
import { resumePayouts } from "./resume.js";

const V = toStroops("1000");
const P = computePayouts(V);
const kp = () => keypairSigner(Keypair.random().secret());
const signers = { AGENT: kp(), LP: kp(), SHIPOWNER: kp(), TREASURY: kp() };
const settle: AgentDecision = {
  invoiceId: "INV-1",
  decision: "SETTLE",
  reason: "ok",
  payouts: [
    { role: "LP", amountStroops: P.lpRepayment.toString() },
    { role: "SHIPOWNER", amountStroops: P.rebate.toString() },
    { role: "TREASURY", amountStroops: P.fee.toString() },
  ],
};

/** A fake escrow: authorize moves funds to the payee's pending balance, claim pays it out. */
function chain(balance: bigint, pending: Partial<Record<Role, bigint>> = {}) {
  const who = (addr: string) => (Object.keys(signers) as (keyof typeof signers)[]).find((r) => signers[r].publicKey === addr) as Role;
  const client = {
    balanceOf: vi.fn(async () => balance),
    authorizePayment: vi.fn(async (p: { merchant: string; amount: bigint }) => {
      if (p.amount > balance) return { ok: false as const, refused: true as const, reason: "insufficient_escrow" };
      balance -= p.amount;
      const r = who(p.merchant);
      pending[r] = (pending[r] ?? 0n) + p.amount;
      return { ok: true as const, hash: `auth_${r}`, explorerUrl: "" };
    }),
    claim: vi.fn(async (s: { publicKey: string }) => {
      const r = who(s.publicKey);
      if (!pending[r]) throw new ChainError("nothing", { errorName: "NothingToClaim" });
      pending[r] = 0n;
      return { hash: `claim_${r}`, explorerUrl: "" };
    }),
  };
  return { client, pending: () => pending, balance: () => balance };
}
const input = (c: ReturnType<typeof chain>, over: object = {}) => ({ client: c.client as never, signers, deviceHash: "h", decision: settle, faceValue: V, gateOk: true, ...over });

describe("resuming a half-done payout", () => {
  it("does nothing when nothing landed: the executor runs as normal", async () => {
    expect(await resumePayouts(input(chain(V)))).toBeNull();
  });

  it("pays only what is left after LP and shipowner landed (the live INV-2026-004 case)", async () => {
    const c = chain(P.fee, { LP: P.lpRepayment }); // shipowner already claimed, LP not yet
    const r = (await resumePayouts(input(c)))!;
    expect(r.alreadyLanded).toEqual(["LP", "SHIPOWNER"]);
    expect(c.client.authorizePayment).toHaveBeenCalledTimes(1);
    expect(c.client.authorizePayment.mock.calls[0]![0]).toMatchObject({ merchant: signers.TREASURY.publicKey, amount: P.fee });
    expect(r.result).toMatchObject({ ok: true, decision: "SETTLE", finalEscrowBalance: 0n });
    expect(r.result.steps.map((s) => `${s.step}:${s.role}`)).toEqual(["authorize:TREASURY", "claim:LP", "claim:TREASURY"]);
    expect(c.pending()).toEqual({ LP: 0n, TREASURY: 0n });
  });

  it("only claims when every authorize already landed", async () => {
    const c = chain(0n, { TREASURY: P.fee });
    const r = (await resumePayouts(input(c)))!;
    expect(c.client.authorizePayment).not.toHaveBeenCalled();
    expect(r.result.ok).toBe(true);
  });

  it("refuses to guess when the escrow doesn't match a run of payouts", async () => {
    expect(await resumePayouts(input(chain(V - 1n)))).toBeNull();
  });

  it("never resumes past a failed gate or a payout the code didn't compute", async () => {
    expect(await resumePayouts(input(chain(P.fee), { gateOk: false }))).toBeNull();
    const tampered = { ...settle, payouts: settle.payouts.map((p) => (p.role === "TREASURY" ? { ...p, amountStroops: "1" } : p)) };
    expect(await resumePayouts(input(chain(P.fee), { decision: tampered }))).toBeNull();
  });
});
