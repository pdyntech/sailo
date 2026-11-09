/**
 * Portal invoices on Stellar Testnet: the same Noir contracts, agent policy (agent.ts) and executor
 * (@noirxvelo/agent) as the /app demo, driven by the shipowner, investor and cargo owner accounts.
 *
 *   register  treasury registers the invoice hash (device_registry) and the agent policy with its cap (agent_registry)
 *   fund      the investor's wallet funds the 85% advance into escrow
 *   advance   the agent decides ADVANCE; the executor authorizes it and the shipowner's wallet claims it
 *   payin     after berthing and a verified Velo payment.succeeded, treasury moves the payment into escrow
 *   settle    the agent decides SETTLE; the executor pays investor, shipowner and treasury, escrow ends at 0
 *
 * Each step is a "job" on the invoice. A job is claimed under the db lock (so only one instance runs it),
 * the transactions run outside the lock, and the result is written back under the lock. Every transaction
 * is recorded as soon as the step returns, and a retried step skips what already landed, so a crash or a
 * Testnet hiccup never double-pays. Sample invoices for new accounts stay simulated and are labelled so.
 */
import { createHash, randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { execute, keypairSigner, normalizeError, type AgentDecision, type ExecutorContext, type NoirSigner, type Role } from "@noirxvelo/agent";
import { canonicalJson, computePayouts, fromStroops, phpToStroops, toStroops } from "@noirxvelo/shared";
import { decide, type Facts } from "./agent.js";
import { track } from "./background.js";
import { db, save, withDb, type StoredWallet } from "./db.js";
import { env, missingChainEnv } from "./env.js";
import { INSTANCE_ID, withLock } from "./kv.js";
import { TOTAL_TICKS, readingUnderway, readingsAfter, type Reading } from "./telemetry.js";
import type { LogEntry, PortalInvoice, PState } from "./portal.js";
import type { VerifiedEvent } from "./velo.js";
import { chainClient, createWallet, topUp, walletSigner } from "./wallets.js";

export type JobStep = "register" | "fund" | "advance" | "payin" | "settle";

export interface ChainTx {
  step: JobStep;
  kind: "register_device" | "register_agent" | "fund" | "authorize" | "claim";
  role: string;
  label: string;
  hash: string;
  url: string;
  at: string;
}

export interface PortalPayment {
  verified: boolean;
  eventId: string;
  amountXlm: string;
  amountMatches: boolean;
  verifiedBy: string;
  simulated: boolean;
  at: string;
}

export interface PortalCheckout {
  id: string;
  url: string | null;
  simulated: boolean;
  amountXlm: string;
  createdAt: string;
}

export interface PortalChain {
  nonce: string;
  registered: boolean;
  job: { step: JobStep; by: string; at: number; fromState: PState } | null;
  attempts: number;
  error: string | null;
  lastErrorAt: number | null;
  txs: ChainTx[];
  escrowXlm: string | null;
  fundRequest: { userId: string; at: number } | null;
  checkout: PortalCheckout | null;
  payment: PortalPayment | null;
  attestation: { sha256: string; signature: string; signer: string } | null;
  /** ms epoch when the vessel sailed (set when the investor's funding lands). Absent on older invoices. */
  sailedAt?: number | null;
  /** The invoice is on HOLD because the agent judged the evidence needed a second look (not a failed check). */
  agentHold?: boolean;
}

export const MAX_ONCHAIN_FACE = 5_000_000; // PHP; 5,000 test XLM, so Friendbot top-ups keep up
const STROOPS = 10_000_000n;
const JOB_STALE_MS = 240_000;
const MAX_ATTEMPTS = 3;
const now = () => new Date().toISOString();
const xlm = (s: bigint) => `${fromStroops(s)} XLM`;

// ---------- voyage (simulated AIS readings, same rule as the demo) ----------
// The vessel sails when the funding lands and the advance runs during the voyage, so the voyage must outlast the
// advance's Testnet transactions (about 30 s) or the vessel would already be in port when the advance lands.
export const VOYAGE_MS = Number(process.env.PORTAL_VOYAGE_MS ?? 60_000);
/** Time between two AIS readings. */
const READING_MS = VOYAGE_MS / (TOTAL_TICKS - 1);
/** When the voyage began: on-chain invoices sail when the funding lands; otherwise when the current state began. */
export const voyageStart = (i: PortalInvoice): number => i.chain?.sailedAt ?? i.stateAt;
export const voyageReadings = (i: PortalInvoice, now = Date.now()): Reading[] => readingsAfter(now - voyageStart(i), VOYAGE_MS);
/** The agent's ADVANCE gate: some AIS reading shows the vessel under way. */
export const hasSailed = (i: PortalInvoice, now = Date.now()): boolean => voyageReadings(i, now).some(readingUnderway);

/** True when new portal invoices run on Testnet (platform wallets valid, not switched off). */
export function chainAvailable(): boolean {
  return missingChainEnv().length === 0 && env("SIMULATE_CHAIN") !== "1" && env("PORTAL_ONCHAIN") !== "0";
}

export function newChain(): PortalChain {
  return { nonce: randomBytes(8).toString("hex"), registered: false, job: null, attempts: 0, error: null, lastErrorAt: null, txs: [], escrowXlm: null, fundRequest: null, checkout: null, payment: null, attestation: null, sailedAt: null };
}

let platformSigners: { AGENT: NoirSigner; TREASURY: NoirSigner } | null = null;
function platform(): { AGENT: NoirSigner; TREASURY: NoirSigner } {
  return (platformSigners ??= { AGENT: keypairSigner(env("AGENT_SECRET")!), TREASURY: keypairSigner(env("TREASURY_SECRET")!) });
}

export const STEP_LABEL: Record<JobStep, string> = {
  register: "Registering the invoice on Stellar Testnet",
  fund: "Funding the escrow from the investor’s wallet on Stellar Testnet",
  advance: "The agent is releasing the advance on Stellar Testnet",
  payin: "Moving the cargo owner’s payment into escrow on Stellar Testnet",
  settle: "The agent is settling on Stellar Testnet",
};

/** The chain step this invoice is waiting for, if any. */
export function jobFor(i: PortalInvoice, now = Date.now()): JobStep | null {
  const c = i.chain;
  if (!c) return null;
  switch (i.state) {
    case "TOKENIZED":
      return !c.registered ? "register" : c.fundRequest ? "fund" : null;
    case "FUNDED":
      // The advance is released once AIS shows the vessel under way, never before.
      return hasSailed(i, now) ? "advance" : null;
    case "BERTHED":
      return c.payment?.verified ? "payin" : null;
    case "PAID":
      return "settle";
    default:
      return null;
  }
}

export const jobRunning = (i: PortalInvoice, t = Date.now()): boolean => !!i.chain?.job && t - i.chain.job.at < JOB_STALE_MS;

function isDue(i: PortalInvoice, t: number): boolean {
  const c = i.chain;
  if (!c || !jobFor(i, t) || jobRunning(i, t)) return false;
  if (c.error) {
    if (c.attempts >= MAX_ATTEMPTS) return false;
    if (t - (c.lastErrorAt ?? 0) < 8_000 * c.attempts) return false;
  }
  return true;
}

/** Invoices with a chain step to start. Call inside withDb; pass the result to startJobs after it returns. */
export function dueJobs(): string[] {
  if (!chainAvailable()) return [];
  const t = Date.now();
  return db.invoices.filter((i) => isDue(i, t)).map((i) => i.id);
}

/** True if the invoice failed its step too often, or the agent held it for a second look, and waits for Retry. */
export const needsRetry = (i: PortalInvoice): boolean =>
  (!!i.chain?.error && i.chain.attempts >= MAX_ATTEMPTS && !!jobFor(i)) || isAgentHold(i);

/** On HOLD by the agent's judgment, from a step it can retake (nothing moved, so asking again is safe). */
export const isAgentHold = (i: PortalInvoice): boolean => i.state === "HOLD" && !!i.chain?.agentHold && (i.holdFrom === "FUNDED" || i.holdFrom === "PAID");

/** Clears the error (or the agent's hold) so the step runs again. Call inside withDb. */
export function resetRetry(i: PortalInvoice): void {
  if (!i.chain) return;
  if (isAgentHold(i)) {
    // Back to the state the agent held, so it decides again on the same evidence. No money moved on the hold.
    i.state = i.holdFrom!;
    i.holdFrom = null;
    i.chain.agentHold = false;
  }
  i.chain.error = null;
  i.chain.attempts = 0;
  i.chain.lastErrorAt = null;
  save();
}

// ---------- helpers on the invoice (under the db lock) ----------
function log(i: PortalInvoice, e: Omit<LogEntry, "at">): void {
  i.log.push({ at: now(), ...e });
}
function setState(i: PortalInvoice, s: PState): void {
  i.state = s;
  i.stateAt = Date.now();
}

/** Signs the berthing record (with the 3 AIS readings that met the rule) with the agent key, like the demo's proof of delivery. */
export function signBerthing(i: PortalInvoice, readings: Reading[]): PortalChain["attestation"] {
  const secret = env("AGENT_SECRET");
  if (!secret) return null;
  const record = canonicalJson({
    invoiceId: i.id,
    hash: i.hash,
    port: i.port,
    berthedAt: now(),
    rule: "at the destination quay, SOG <= 0.5 kn for 3 consecutive readings (simulated AIS)",
    readings: readings.slice(-3).map((r) => ({ seq: r.seq, sogKnots: r.sog.toFixed(1), navStatus: r.navStatus, atDestination: r.atDestination })),
  });
  const sha256 = createHash("sha256").update(record, "utf8").digest("hex");
  const kp = Keypair.fromSecret(secret);
  return { sha256, signature: kp.sign(Buffer.from(sha256, "hex")).toString("base64"), signer: kp.publicKey() };
}

/** Records a verified payment for a portal invoice. Returns false if no invoice has this checkout. Call inside withDb. */
/** True if a portal invoice's checkout created this payment intent. */
export const hasCheckout = (paymentIntentId: string): boolean => db.invoices.some((x) => x.chain?.checkout?.id === paymentIntentId);

export function recordPayment(paymentIntentId: string, ev: VerifiedEvent, simulated: boolean): boolean {
  const i = db.invoices.find((x) => x.chain?.checkout?.id === paymentIntentId);
  if (!i?.chain) return false;
  const pi = ev.paymentIntent!;
  if (i.chain.payment?.verified) return true; // already recorded (duplicate delivery)
  const expected = fromStroops(phpToStroops(BigInt(i.face)));
  let amountMatches = false;
  try {
    amountMatches = phpToStroops(BigInt(i.face)) === toStroops(String(pi.amount));
  } catch {
    amountMatches = false;
  }
  i.chain.payment = { verified: true, eventId: ev.id, amountXlm: String(pi.amount), amountMatches, verifiedBy: ev.verifiedBy, simulated, at: now() };
  log(i, {
    title: "Cargo owner paid",
    text: `${simulated ? "Simulated " : ""}Velo payment.succeeded for ${pi.amount} XLM verified (${ev.verifiedBy})${amountMatches ? "" : `, but the invoice is ${expected} XLM`}.`,
    c: "payment_escrow",
  });
  save();
  return true;
}

// ---------- jobs ----------
interface JobInput {
  id: string;
  step: JobStep;
  fromState: PState;
  hash: string;
  face: number;
  term: number;
  vessel: string;
  port: string;
  ownerId: string | null;
  funderId: string | null;
  owner: StoredWallet | null;
  funder: StoredWallet | null;
  txs: ChainTx[];
  payment: PortalPayment | null;
  attested: boolean;
  registered: boolean;
  sailed: boolean;
}

interface JobOutcome {
  txs: ChainTx[];
  logs: Omit<LogEntry, "at">[];
  error?: string;
  next?: PState;
  holdReason?: string;
  /** The hold is the agent's judgment, which the invoice's parties may ask it to reconsider. */
  reviewableHold?: boolean;
  registered?: boolean;
  escrowXlm?: string;
}

/** Claims the invoice's next step for this instance. Call inside withDb. */
function claimJob(id: string): JobInput | null {
  const i = db.invoices.find((x) => x.id === id);
  if (!i?.chain || !isDue(i, Date.now())) return null;
  const step = jobFor(i)!;
  i.chain.job = { step, by: INSTANCE_ID, at: Date.now(), fromState: i.state };
  save();
  const userWallet = (uid: string | null) => (uid ? (db.users.find((u) => u.id === uid)?.wallet ?? null) : null);
  return {
    id,
    step,
    fromState: i.state,
    hash: i.hash,
    face: i.face,
    term: i.term,
    vessel: i.vessel,
    port: i.port,
    ownerId: i.ownerId,
    funderId: i.funderId,
    owner: userWallet(i.ownerId),
    funder: userWallet(i.funderId),
    txs: i.chain.txs.slice(),
    payment: i.chain.payment,
    attested: !!i.chain.attestation,
    registered: i.chain.registered,
    sailed: hasSailed(i),
  };
}

/** Writes a finished step back. Call inside withDb. */
function applyOutcome(inp: JobInput, out: JobOutcome): void {
  const i = db.invoices.find((x) => x.id === inp.id);
  if (!i?.chain) return;
  const c = i.chain;
  if (c.job?.by === INSTANCE_ID && c.job.step === inp.step) c.job = null;
  c.txs.push(...out.txs);
  if (out.escrowXlm != null) c.escrowXlm = out.escrowXlm;
  if (out.registered) c.registered = true;
  for (const e of out.logs) log(i, e);
  if (out.error) {
    c.error = out.error;
    c.attempts += 1;
    c.lastErrorAt = Date.now();
    save();
    return;
  }
  c.error = null;
  c.attempts = 0;
  c.lastErrorAt = null;
  if (inp.step === "fund") c.fundRequest = null;
  // Only move the invoice if nobody else moved it meanwhile (a stale job taken over by another instance).
  if (out.next && i.state === inp.fromState) {
    if (out.next === "FUNDED") {
      c.sailedAt ??= Date.now();
      log(i, { title: "Vessel sailed", text: `${i.vessel} left port. The agent releases the advance once AIS shows it under way.`, c: "payment_escrow" });
    }
    if (out.next === "HOLD") {
      c.agentHold = !!out.reviewableHold;
      i.holdFrom = i.state;
      log(i, { title: "HOLD", text: out.holdReason ?? "The agent held this invoice.", c: "payment_escrow", decision: "HOLD", pay: [] });
    }
    setState(i, out.next);
  }
  save();
}

/** ms until a funded invoice's vessel shows under way (null if it is not waiting for that). Call inside withDb. */
function msUntilSail(id: string): number | null {
  const i = db.invoices.find((x) => x.id === id);
  if (!i?.chain || i.state !== "FUNDED" || hasSailed(i)) return null;
  return Math.max(50, voyageStart(i) + READING_MS - Date.now() + 50);
}

const running = new Set<string>();

async function runJob(id: string): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  try {
    // Several steps can follow each other without a user action (fund -> advance).
    for (let n = 0; n < 5; n++) {
      const inp = await withDb(() => claimJob(id));
      if (!inp) {
        // Just funded: the advance becomes due on the first under-way AIS reading, a moment later.
        const wait = await withDb(() => msUntilSail(id));
        if (wait === null) return;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const out = await perform(inp);
      await withDb(() => applyOutcome(inp, out));
      if (out.error) {
        console.error(`portal ${id} ${inp.step}: ${out.error}`);
        return;
      }
    }
  } catch (e) {
    console.error(`portal job ${id}:`, e instanceof Error ? e.message : e);
  } finally {
    running.delete(id);
  }
}

/** Starts the given invoices' steps in the background (tracked, so Vercel keeps the instance alive). */
export function startJobs(ids: string[]): void {
  for (const id of ids) if (!running.has(id)) track(runJob(id));
}

/** Creates the user's Testnet wallet once (one creator at a time, across instances). */
export async function ensureWallet(userId: string): Promise<StoredWallet> {
  return withLock(
    `wallet:${userId}`,
    async () => {
      const existing = await withDb(() => db.users.find((u) => u.id === userId)?.wallet ?? null);
      if (existing) return existing;
      const w = await createWallet();
      return withDb(() => {
        const u = db.users.find((x) => x.id === userId);
        if (!u) throw new Error("That account no longer exists.");
        if (!u.wallet) {
          u.wallet = w;
          save();
        }
        return u.wallet;
      });
    },
    { ttlMs: 90_000, waitMs: 120_000 },
  );
}

function friendly(e: unknown): string {
  const ce = normalizeError(e);
  const m = ce.message || String(e);
  return (ce.errorName && ce.errorName !== "Unknown" ? `${ce.errorName}: ` : "") + m.slice(0, 300);
}

async function perform(inp: JobInput): Promise<JobOutcome> {
  const out: JobOutcome = { txs: [], logs: [] };
  const client = chainClient();
  const P = platform();
  const face = phpToStroops(BigInt(inp.face));
  const pay = computePayouts(face);
  const add = (kind: ChainTx["kind"], role: string, label: string, t: { hash: string; explorerUrl: string }): ChainTx => {
    const tx: ChainTx = { step: inp.step, kind, role, label, hash: t.hash, url: t.explorerUrl, at: now() };
    out.txs.push(tx);
    return tx;
  };
  const done = (kind: ChainTx["kind"], role: string) => [...inp.txs, ...out.txs].some((t) => t.step === inp.step && t.kind === kind && t.role === role);
  const links = (txs: ChainTx[]) => txs.map((t) => ({ label: t.label, hash: t.hash, url: t.url }));

  try {
    switch (inp.step) {
      case "register": {
        if (inp.ownerId) await ensureWallet(inp.ownerId); // the shipowner's wallet receives the advance later
        if (!done("register_device", "TREASURY")) {
          try {
            add("register_device", "TREASURY", "device_registry.register (invoice hash)", await client.registerDevice(P.TREASURY, inp.hash, P.AGENT.publicKey));
          } catch (e) {
            // Our hash includes a random nonce, so AlreadyRegistered means an earlier attempt of ours landed.
            if (normalizeError(e).errorName !== "AlreadyRegistered") throw e;
          }
        }
        if (!done("register_agent", "TREASURY")) {
          const expires = new Date(Date.now() + (inp.term + 7) * 86_400_000);
          try {
            add("register_agent", "TREASURY", `agent_registry.register_agent (cap ${xlm(pay.maxAmount)})`, await client.registerAgent(P.TREASURY, inp.hash, P.AGENT.publicKey, pay.maxAmount, undefined, expires));
          } catch (e) {
            // An earlier attempt may have landed: a policy that accepts a 1-stroop payment means it exists.
            const chk = await client.checkPayment({ deviceHash: inp.hash, agent: P.AGENT.publicKey, amount: 1n }).catch(() => ({ ok: false }));
            if (!chk.ok) throw e;
          }
        }
        out.registered = true;
        out.logs.push({
          title: "Invoice tokenized on Stellar",
          text: `Hash ${inp.hash.slice(0, 16)}… registered in Noir’s device_registry, with an agent policy capped at ${xlm(pay.maxAmount)} per payment (expires Net-${inp.term} + 7 days).`,
          c: "device_registry",
          txs: links(out.txs),
          onchain: true,
        });
        break;
      }
      case "fund": {
        if (!inp.funderId) throw new Error("No investor on this invoice.");
        const w = await ensureWallet(inp.funderId);
        await topUp(w.publicKey, pay.advance + 30n * STROOPS);
        const bal = await client.balanceOf(inp.hash);
        if (bal < pay.advance) add("fund", "LP", `payment_escrow.fund_escrow (investor ${xlm(pay.advance)})`, await client.fundEscrow(walletSigner(w), inp.hash, pay.advance));
        out.next = "FUNDED";
        out.logs.push({ title: "Investor funded the advance", text: `${xlm(pay.advance)} moved from the investor’s wallet into the invoice escrow on Stellar Testnet.`, c: "payment_escrow", txs: links(out.txs), onchain: true });
        break;
      }
      case "advance":
      case "settle": {
        await agentPayout(inp, out, pay, add, done, links);
        break;
      }
      case "payin": {
        if (!inp.payment?.verified) throw new Error("No verified payment yet.");
        if (!inp.payment.amountMatches) {
          out.next = "HOLD";
          out.holdReason = `The verified payment (${inp.payment.amountXlm} XLM) does not match the invoice (${fromStroops(face)} XLM). Nothing moved.`;
          break;
        }
        await topUp(P.TREASURY.publicKey, face + 50n * STROOPS);
        const bal = await client.balanceOf(inp.hash);
        if (bal < face) add("fund", "TREASURY", `payment_escrow.fund_escrow (cargo owner’s ${xlm(face)} via Velo)`, await client.fundEscrow(P.TREASURY, inp.hash, face));
        out.next = "PAID";
        out.logs.push({
          title: "Payment in escrow",
          text: `Treasury moved the cargo owner’s ${inp.payment.simulated ? "simulated " : ""}Velo payment of ${xlm(face)} into the invoice escrow.`,
          c: "payment_escrow",
          txs: links(out.txs),
          onchain: true,
        });
        break;
      }
    }
    try {
      out.escrowXlm = fromStroops(await client.balanceOf(inp.hash));
    } catch {
      /* read failed: keep the last value */
    }
  } catch (e) {
    out.error = friendly(e);
    if (out.txs.length) out.logs.push({ title: "Partly done", text: `${out.txs.length} transaction(s) landed before an error. The step resumes from here.`, c: "payment_escrow", txs: links(out.txs), onchain: true });
  }
  return out;
}

/**
 * ADVANCE or SETTLE: the agent proposes from observed facts, the executor checks and pays.
 *
 * Resuming is exact, not guessed. When a step starts, the invoice escrow holds exactly the step's total: the investor
 * funds exactly the advance, which ADVANCE pays out in full, and the payin funds exactly the invoice value, which
 * SETTLE pays out in full. Payouts always land in the same order, so `total - escrow` must equal the sum of the
 * payouts that already landed (recorded or not). Any other balance is an anomaly: the invoice is held and nothing moves.
 */
async function agentPayout(
  inp: JobInput,
  out: JobOutcome,
  pay: ReturnType<typeof computePayouts>,
  add: (kind: ChainTx["kind"], role: string, label: string, t: { hash: string; explorerUrl: string }) => ChainTx,
  done: (kind: ChainTx["kind"], role: string) => boolean,
  links: (txs: ChainTx[]) => { label: string; hash: string; url: string }[],
): Promise<void> {
  const kind = inp.step === "advance" ? "ADVANCE" : "SETTLE";
  const client = chainClient();
  const P = platform();
  if (!inp.owner) throw new Error("The shipowner has no wallet yet.");
  if (!inp.funder) throw new Error("The investor has no wallet yet.");
  const signers: Record<"AGENT" | Role, NoirSigner> = { AGENT: P.AGENT, TREASURY: P.TREASURY, SHIPOWNER: walletSigner(inp.owner), LP: walletSigner(inp.funder) };
  const face = phpToStroops(BigInt(inp.face));
  // Same order as the executor's settlement order (LP, shipowner, treasury).
  const expected: { role: Role; amount: bigint }[] =
    kind === "ADVANCE"
      ? [{ role: "SHIPOWNER", amount: pay.advance }]
      : [
          { role: "LP", amount: pay.lpRepayment },
          { role: "SHIPOWNER", amount: pay.rebate },
          { role: "TREASURY", amount: pay.fee },
        ];
  const total = expected.reduce((a, p) => a + p.amount, 0n);

  // Which payouts already landed, from the escrow balance alone.
  const escrow = await client.balanceOf(inp.hash);
  const recorded = expected.map((p) => done("authorize", p.role));
  const fresh = escrow >= total && !recorded.some(Boolean);
  const landed = fresh ? 0 : landedPayouts(expected, total - escrow, recorded);
  if (landed < 0) {
    out.next = "HOLD";
    out.holdReason = `The invoice escrow holds ${xlm(escrow)}, which matches no point of this ${kind} (it started at ${xlm(total)}). Nothing moved. Ops must check this invoice.`;
    return;
  }

  const facts: Facts = {
    invoiceId: inp.id,
    faceValue: face,
    status: kind === "ADVANCE" ? "FUNDED" : "PAID",
    escrowFunded: true, // checked just above: the escrow is exactly where this step expects it
    vesselUnderway: inp.sailed,
    berthed: inp.attested,
    paymentVerified: !!inp.payment?.verified,
    paymentAmountMatches: !!inp.payment?.amountMatches,
    vessel: inp.vessel,
    port: inp.port,
    voyageNote:
      kind === "ADVANCE"
        ? "AIS readings arrive at the normal interval and show the vessel under way. This route has no plotted sea lane, so positions are not compared with one."
        : "AIS readings arrived at the normal interval for the whole voyage, with no gaps; the last 3 were at the destination quay at <= 0.5 kn. This route has no plotted sea lane, so positions are not compared with one.",
  };
  const prop = await decide(facts);
  const label = (step: string, role: string, amount: bigint) => (step === "authorize" ? `payment_escrow.authorize (${role} ${xlm(amount)}, signed by the agent)` : `payment_escrow.claim (${role}, signed by the payee)`);
  const decisionLog = (d: AgentDecision, engine: string, extra: Record<string, unknown>) => ({
    title: d.decision,
    text: d.reason,
    c: "payment_escrow" as const,
    decision: d.decision as "ADVANCE" | "SETTLE" | "HOLD",
    pay: d.payouts.map((p) => [p.role, Number(BigInt(p.amountStroops) / 10_000n)] as [Role, number]),
    raw: { ...d, engine, ...extra },
    txs: links(out.txs),
    onchain: true,
  });

  if (!prop || prop.decision.decision !== kind) {
    out.next = "HOLD";
    out.reviewableHold = !!prop?.reviewable;
    out.holdReason =
      prop?.decision.reason ??
      `The agent did not decide ${kind}: ${kind === "ADVANCE" ? "AIS does not show the vessel under way" : "the payment or the berthing attestation is missing"}. Nothing moved.`;
    return;
  }

  if (fresh) {
    // Normal path: the executor re-validates the decision, gates, amounts and policy, then pays.
    const ctx: ExecutorContext = {
      client,
      invoice: { id: inp.id, state: kind === "ADVANCE" ? "FUNDED" : "PAID", faceValue: face },
      deviceHash: inp.hash,
      addresses: { SHIPOWNER: signers.SHIPOWNER.publicKey, LP: signers.LP.publicKey, TREASURY: signers.TREASURY.publicKey },
      signers,
      gates: {
        hashRegisteredByUs: inp.registered,
        vesselUnderway: inp.sailed,
        webhookVerified: !!inp.payment?.verified,
        webhookAmount: inp.payment ? toStroops(inp.payment.amountXlm) : undefined,
        berthingAttestation: inp.attested,
      },
    };
    const r = await execute(prop.decision, ctx);
    for (const st of r.steps) add(st.step, st.role, label(st.step, st.role, st.amount), { hash: st.hash, explorerUrl: st.explorerUrl });
    if (r.ok) {
      out.next = kind === "ADVANCE" ? "ADVANCED" : "SETTLED";
      out.logs.push(decisionLog(prop.decision, prop.engine, { executor: "ok", finalEscrowXlm: r.finalEscrowBalance == null ? null : fromStroops(r.finalEscrowBalance) }));
      return;
    }
    if (r.failure?.reason === "chain_error") throw new Error(`${r.failure.step}${r.failure.role ? ` ${r.failure.role}` : ""}: ${r.failure.detail ?? "chain error"}`);
    out.next = "HOLD";
    out.holdReason = `The executor refused the agent’s ${kind}: ${r.refusal}${r.failure?.detail ? ` (${r.failure.detail})` : ""}.${r.authorized.length ? "" : " Nothing moved."}`;
    return;
  }

  // Resume: the executor's gates and payout check, then only the payouts that have not landed, in order.
  const gate = resumeGate(kind, inp);
  const proposed = prop.decision.payouts.map((p) => `${p.role}:${p.amountStroops}`).sort().join(",");
  const want = expected.map((p) => `${p.role}:${p.amount}`).sort().join(",");
  if (gate || proposed !== want) {
    out.next = "HOLD";
    out.holdReason = `Resuming the ${kind} was refused: ${gate ?? `the agent's payouts (${proposed}) are not the computed ones (${want})`}. Nothing more moved.`;
    return;
  }
  for (const p of expected.slice(landed)) {
    const r = await client.authorizePayment({ agentSigner: signers.AGENT, deviceHash: inp.hash, merchant: signers[p.role].publicKey, amount: p.amount });
    if (!r.ok) {
      out.next = "HOLD";
      out.holdReason = `Resuming the ${kind}, the contract refused ${p.role} ${xlm(p.amount)} (${r.reason}). Nothing more moved.`;
      return;
    }
    add("authorize", p.role, label("authorize", p.role, p.amount), r);
  }
  for (const p of expected) {
    if (done("claim", p.role)) continue;
    try {
      add("claim", p.role, label("claim", p.role, p.amount), await client.claim(signers[p.role]));
    } catch (e) {
      // An earlier attempt's claim landed without being recorded.
      if (normalizeError(e).errorName !== "NothingToClaim") throw e;
    }
  }
  out.next = kind === "ADVANCE" ? "ADVANCED" : "SETTLED";
  const unrecorded = expected.slice(0, landed).filter((_, k) => !recorded[k]).map((p) => p.role);
  out.logs.push(
    decisionLog(prop.decision, prop.engine, {
      executor: "resumed after a partial run",
      alreadyLanded: expected.slice(0, landed).map((p) => p.role),
      ...(unrecorded.length ? { landedWithoutRecordedHash: unrecorded } : {}),
    }),
  );
}

/**
 * How many of `payouts` (in order) already landed, given how much left the escrow. -1 if that amount is not the sum
 * of a leading run of payouts, if nothing landed, or if a recorded authorize is not among the landed ones.
 */
export function landedPayouts(payouts: { amount: bigint }[], spent: bigint, recorded: boolean[]): number {
  let sum = 0n;
  for (let k = 1; k <= payouts.length; k++) {
    sum += payouts[k - 1]!.amount;
    if (sum === spent) return recorded.some((r, i) => r && i >= k) ? -1 : k;
  }
  return -1;
}

/** The executor's preconditions, for a resumed payout. Returns the failed one, or null. */
function resumeGate(kind: "ADVANCE" | "SETTLE", inp: JobInput): string | null {
  if (!inp.registered) return "the invoice hash is not registered";
  if (kind === "ADVANCE") return inp.sailed ? null : "AIS does not show the vessel under way";
  if (!inp.payment?.verified) return "no verified payment";
  if (!inp.payment.amountMatches) return "the payment does not match the invoice";
  return inp.attested ? null : "no berthing attestation";
}
