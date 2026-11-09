/**
 * Resuming a payout that a stopped server left half done.
 *
 * The executor authorizes payouts in a fixed order (SHIPOWNER for an advance; LP, SHIPOWNER, TREASURY for a
 * settlement), then each payee claims. If the server stops in between, some authorizes are on-chain but not in our
 * record, and running the executor again would fail on insufficient escrow. The escrow balance tells how many landed;
 * this pays only the rest, then claims for every payee (NothingToClaim means that claim already landed).
 */
import { normalizeError, type AgentDecision, type ExecutionResult, type NoirAgentClient, type NoirSigner, type Role, type StepLog } from "@noirxvelo/agent";
import { computePayouts } from "@noirxvelo/shared";
import { landedPayouts } from "./portal-chain.js";

export interface ResumeInput {
  client: Pick<NoirAgentClient, "balanceOf" | "authorizePayment" | "claim">;
  signers: Record<"AGENT" | Role, NoirSigner>;
  deviceHash: string;
  decision: AgentDecision;
  faceValue: bigint;
  /** The executor's gates for this decision passed (vessel under way; or verified matching payment and attestation). */
  gateOk: boolean;
  serial?: <T>(fn: () => Promise<T>) => Promise<T>;
  log?: (msg: string) => void;
}

/** Null when there is nothing to resume (nothing landed, or not a code-computed payout): run the executor as normal. */
export async function resumePayouts(o: ResumeInput): Promise<{ result: ExecutionResult; alreadyLanded: Role[] } | null> {
  const d = o.decision;
  if (d.decision !== "ADVANCE" && d.decision !== "SETTLE") return null;
  const p = computePayouts(o.faceValue);
  const expected: Partial<Record<Role, bigint>> = d.decision === "ADVANCE" ? { SHIPOWNER: p.advance } : { LP: p.lpRepayment, SHIPOWNER: p.rebate, TREASURY: p.fee };
  const order = Object.keys(expected) as Role[];
  const payouts = order.map((role) => ({ role, amount: BigInt(d.payouts.find((x) => x.role === role)?.amountStroops ?? "-1") }));
  if (d.payouts.length !== order.length || payouts.some((x) => x.amount !== expected[x.role])) return null;
  if (!o.gateOk) return null; // the executor refuses it, with the reason

  const run = o.serial ?? (<T>(fn: () => Promise<T>) => fn());
  const required = payouts.reduce((a, x) => a + x.amount, 0n);
  const balance = await o.client.balanceOf(o.deviceHash);
  if (balance >= required) return null;
  const landed = landedPayouts(payouts, required - balance, []);
  if (landed <= 0) return null;

  const alreadyLanded = payouts.slice(0, landed).map((x) => x.role);
  o.log?.(`Resuming the ${d.decision}: ${alreadyLanded.join(", ")} already left the escrow on an earlier attempt; paying only the rest.`);
  const steps: StepLog[] = [];
  const base = { requested: d.decision, invoiceId: d.invoiceId, reason: d.reason, pendingUnclaimed: [] as Role[] };
  const finalBalance = () => o.client.balanceOf(o.deviceHash).catch(() => null);
  for (const x of payouts.slice(landed)) {
    const r = await run(() => o.client.authorizePayment({ agentSigner: o.signers.AGENT, deviceHash: o.deviceHash, merchant: o.signers[x.role].publicKey, amount: x.amount }));
    if (!r.ok) {
      return {
        alreadyLanded,
        result: { ...base, decision: "HOLD", ok: false, refusal: r.reason, failure: { step: "authorize", role: x.role, reason: r.reason }, steps, authorized: [], claimed: [], finalEscrowBalance: await finalBalance() },
      };
    }
    steps.push({ step: "authorize", role: x.role, amount: x.amount, hash: r.hash, explorerUrl: r.explorerUrl });
  }
  for (const x of payouts) {
    try {
      const r = await run(() => o.client.claim(o.signers[x.role]));
      steps.push({ step: "claim", role: x.role, amount: x.amount, hash: r.hash, explorerUrl: r.explorerUrl });
    } catch (e) {
      if (normalizeError(e).errorName !== "NothingToClaim") throw e;
    }
  }
  return { alreadyLanded, result: { ...base, decision: d.decision, ok: true, steps, authorized: order, claimed: order, finalEscrowBalance: await finalBalance() } };
}
