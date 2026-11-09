/**
 * Demo orchestrator: one invoice at a time, driven through the real Noir contracts on Testnet.
 *
 *   tokenize -> fund (LP) -> depart -> [agent ADVANCE] -> voyage -> berth + attestation
 *   -> Velo checkout -> verified payment.succeeded -> treasury funds escrow (PAID)
 *   -> guardrail probe (over-cap payout refused) -> [agent SETTLE] -> SETTLED
 *
 * Chain calls go through ONE shared NoirAgentClient and are serialised (shared Testnet accounts).
 * The agent re-evaluates after every event and decides on its own; the executor re-checks everything.
 *
 * With a shared store (kv.ts) the run survives instance changes: one instance at a time holds the demo lease
 * and runs steps, every change is saved as a snapshot, and other instances serve that snapshot. An instance that
 * takes over a run whose owner disappeared resumes it (an interrupted voyage continues from its last AIS tick).
 */
import { createHash, randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  defaultRecovery,
  execute,
  horizonXlmBalance,
  keypairSigner,
  runDefaultRecovery,
  runGuardrail,
  type AgentDecision,
  type ExecutionResult,
  type ExecutorContext,
  type NoirSigner,
  type Role,
} from "@noirxvelo/agent";
import { SEED_WAYBILL, canonicalJson, computePayouts, fromStroops, invoiceHash, toStroops } from "@noirxvelo/shared";
import { decide, llmConfigured, propose, type Facts, type OpsReview } from "./agent.js";
import { createSimChain, type SimChain } from "./simchain.js";
import { env, missingChainEnv } from "./env.js";
import { addBusyCheck } from "./background.js";
import { INSTANCE_ID, delIf, extendIf, getJson, getRaw, kvEnabled, setJson, setNx } from "./kv.js";
import { chainClient, topUp } from "./wallets.js";
import { resumePayouts } from "./resume.js";
import { AIS_DARK, CEBU, TOTAL_TICKS, isBerthed, isUnderway, makeTick, voyageSignals, type Tick } from "./telemetry.js";
import {
  createCheckout,
  signSimulatedDelivery,
  usingRealWebhookSecret,
  veloCheckoutConfigured,
  verifyWebhook,
  type CheckoutSession,
  type VerifiedEvent,
} from "./velo.js";

export type Status = "DRAFT" | "TOKENIZED" | "FUNDED" | "ADVANCED" | "IN_TRANSIT" | "BERTHED" | "PAID" | "SETTLED" | "HOLD" | "DEFAULT";
type Wallet = "TREASURY" | "SHIPOWNER" | "LP" | "AGENT" | "DEBTOR";

export interface TxRow {
  label: string;
  role: string;
  hash: string;
  url: string;
  at: string;
}

export interface Attestation {
  record: Record<string, string>;
  canonical: string;
  sha256: string;
  signature: string;
  signer: string;
  scheme: string;
}

export interface DecisionRow {
  id: string;
  at: string;
  decision: string;
  requested: string;
  ok: boolean;
  reason: string;
  engine: string;
  refusal: string | null;
  detail: string | null;
  proposal: AgentDecision | null;
  payouts: { role: string; xlm: string }[];
  txs: { step: string; role: string; xlm: string; hash: string; url: string }[];
  finalEscrowXlm: string | null;
  attestation: Attestation | null;
  extra: unknown;
  /** Concerns the model listed when it decided. */
  risks?: string[];
  /** A hold an ops review may release (the agent's judgment or a hard limit, not a failed check). */
  reviewable?: boolean;
  /** The decision point this row answers (run, rules decision, status, review), so it is never asked twice. */
  key?: string;
}

export type Scenario = "normal" | "ais-dark";

export interface LogRow {
  at: string;
  level: "info" | "ok" | "warn" | "error";
  text: string;
}

export interface DemoState {
  run: number;
  status: Status;
  holdFrom: Status | null;
  invoice: {
    id: string;
    hash: string | null;
    waybill: Record<string, string>;
    faceXlm: string;
    facePhp: string;
    payouts: { advance: string; yield: string; lpRepayment: string; fee: string; rebate: string; maxAmount: string };
    policyExpiresAt: string | null;
  };
  escrowXlm: string | null;
  balances: Record<Wallet, string | null>;
  addresses: Record<Wallet, string | null>;
  voyage: { running: boolean; ticks: Tick[]; latest: Tick | null; berthed: boolean; totalTicks: number };
  attestation: Attestation | null;
  checkout: CheckoutSession | null;
  payment: { verified: boolean; eventId: string; deliveryId: string; amountXlm: string; amountMatches: boolean; verifiedBy: string; simulated: boolean; at: string; raw: unknown } | null;
  guardrail: unknown;
  recovery: unknown;
  decisions: DecisionRow[];
  txs: TxRow[];
  log: LogRow[];
  busy: string | null;
  autopilot: boolean;
  /** What the voyage does in this run ("ais-dark": AIS drops out mid-voyage and the vessel reappears off the lane). */
  scenario?: Scenario;
  /** An ops review that released a hold in this run. */
  opsReview?: OpsReview | null;
  error: string | null;
  config: { chainReady: boolean; mode: "testnet" | "simulation"; canGoLive: boolean; missing: string[]; veloCheckout: boolean; realWebhookSecret: boolean; llm: boolean; tickMs: number };
  updatedAt: string;
}

const V = toStroops("1000"); // demo: PHP 1,000,000 at 1 XLM = PHP 1,000
const PAYOUTS = computePayouts(V);
const TICK_MS = Number(env("DEMO_TICK_MS") ?? 1800);
const xlm = (s: bigint) => fromStroops(s);
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- wallets ----------
const pub = (r: Wallet) => env(`${r}_PUBLIC`) ?? null;
// ---------- chain mode ----------
// Simulation is used when Testnet wallets are missing, when SIMULATE_CHAIN=1, or after the operator
// switches to it (e.g. Testnet RPC down). The UI labels every simulated transaction.
let simMode = env("SIMULATE_CHAIN") === "1" || missingChainEnv().length > 0;
let sim: SimChain | null = null;
const getSim = () => (sim ??= createSimChain());
const linkFor = (url: string) => (simMode ? "" : url);

let signers: Record<"AGENT" | Role, NoirSigner> | null = null;
function getSigners(): Record<"AGENT" | Role, NoirSigner> {
  if (simMode) return getSim().signers;
  if (signers) return signers;
  const miss = missingChainEnv();
  if (miss.length) throw new Error(`Missing wallet env: ${miss.join(", ")}. Run npm run provision.`);
  signers = {
    AGENT: keypairSigner(env("AGENT_SECRET")!),
    SHIPOWNER: keypairSigner(env("SHIPOWNER_SECRET")!),
    LP: keypairSigner(env("LP_SECRET")!),
    TREASURY: keypairSigner(env("TREASURY_SECRET")!),
  };
  return signers;
}

// Testnet: the shared client whose writes take a per-account lock (safe across instances).
const getClient = () => (simMode ? getSim().client : chainClient());

// ---------- state ----------
let runCounter = 0;
/** Run number whose simulated ledger lives in this instance (a simulated run can't move between instances). */
let simLedgerRun = 0; // declared before the first freshState(), which sets it in simulation mode
let state: DemoState = freshState();
const listeners = new Set<(s: DemoState) => void>();
let voyageToken = 0;
let fastForward = false;
const decided = new Set<string>();

function freshState(): DemoState {
  runCounter += 1;
  if (simMode) simLedgerRun = runCounter;
  const id = `INV-2026-${String(runCounter).padStart(3, "0")}`;
  const miss = missingChainEnv();
  return {
    run: runCounter,
    status: "DRAFT",
    holdFrom: null,
    invoice: {
      id,
      hash: null,
      waybill: { ...SEED_WAYBILL, invoice_id: id, waybill_no: `VMP-2026-${String(runCounter).padStart(4, "0")}` },
      faceXlm: xlm(V),
      facePhp: "1000000",
      payouts: {
        advance: xlm(PAYOUTS.advance),
        yield: xlm(PAYOUTS.yield),
        lpRepayment: xlm(PAYOUTS.lpRepayment),
        fee: xlm(PAYOUTS.fee),
        rebate: xlm(PAYOUTS.rebate),
        maxAmount: xlm(PAYOUTS.maxAmount),
      },
      policyExpiresAt: null,
    },
    escrowXlm: null,
    balances: { TREASURY: null, SHIPOWNER: null, LP: null, AGENT: null, DEBTOR: null },
    addresses: simMode
      ? { TREASURY: getSim().signers.TREASURY.publicKey, SHIPOWNER: getSim().signers.SHIPOWNER.publicKey, LP: getSim().signers.LP.publicKey, AGENT: getSim().signers.AGENT.publicKey, DEBTOR: getSim().signers.DEBTOR.publicKey }
      : { TREASURY: pub("TREASURY"), SHIPOWNER: pub("SHIPOWNER"), LP: pub("LP"), AGENT: pub("AGENT"), DEBTOR: pub("DEBTOR") },
    voyage: { running: false, ticks: [], latest: null, berthed: false, totalTicks: TOTAL_TICKS },
    attestation: null,
    checkout: null,
    payment: null,
    guardrail: null,
    recovery: null,
    decisions: [],
    txs: [],
    log: [{ at: now(), level: "info", text: `New invoice ${id} drafted for ${SEED_WAYBILL.vessel} (${SEED_WAYBILL.route}).` }],
    busy: null,
    autopilot: false,
    scenario: "normal",
    opsReview: null,
    error: null,
    config: {
      chainReady: simMode || miss.length === 0,
      mode: simMode ? "simulation" : "testnet",
      canGoLive: miss.length === 0,
      missing: miss,
      veloCheckout: veloCheckoutConfigured(),
      realWebhookSecret: usingRealWebhookSecret(),
      llm: llmConfigured(),
      tickMs: TICK_MS,
    },
    updatedAt: now(),
  };
}

export const getState = (): DemoState => state;
export function subscribe(fn: (s: DemoState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(): void {
  state.updatedAt = now();
  persistSoon();
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {
      /* a broken listener must not stop the demo */
    }
  }
}
function log(level: LogRow["level"], text: string): void {
  state.log.push({ at: now(), level, text });
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  emit();
}
function setStatus(s: Status): void {
  if (state.status !== s) {
    state.status = s;
    log("info", `Status → ${s}`);
  }
}
function addTx(label: string, role: string, t: { hash: string; explorerUrl: string }): void {
  state.txs.push({ label, role, hash: t.hash, url: linkFor(t.explorerUrl), at: now() });
  log("ok", `${label}: ${t.hash.slice(0, 10)}…`);
}

// ---------- serial chain queue ----------
let chainQueue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chainQueue.then(fn, fn);
  chainQueue = p.catch(() => undefined);
  return p;
}

async function refreshBalances(): Promise<void> {
  const wallets: Wallet[] = ["TREASURY", "SHIPOWNER", "LP", "AGENT", "DEBTOR"];
  await Promise.all(
    wallets.map(async (w) => {
      const a = state.addresses[w];
      if (!a) return;
      try {
        state.balances[w] = xlm(simMode ? getSim().ledger.balance(a) : await horizonXlmBalance(a));
      } catch {
        /* keep the last value */
      }
    }),
  );
  if (state.invoice.hash && state.config.chainReady) {
    try {
      state.escrowXlm = xlm(await getClient().balanceOf(state.invoice.hash));
    } catch {
      /* keep the last value */
    }
  }
  emit();
}

/** Keeps a Testnet wallet able to pay `need` (plus fees), refilling from Friendbot when it runs low. */
async function refill(pub: string, need: bigint, who: string): Promise<void> {
  const n = await topUp(pub, need + toStroops("50"));
  if (n) log("info", `${who} wallet was low; refilled with ${n * 10_000} test XLM from Friendbot.`);
}

// ---------- action wrapper ----------
export class BusyError extends Error {
  constructor(readonly busyWith: string) {
    super(`Busy: ${busyWith}`);
  }
}
export class StepError extends Error {}

async function action<T>(name: string, fn: () => Promise<T>, { allowWhenBusy = false } = {}): Promise<T> {
  if (state.busy && !allowWhenBusy) throw new BusyError(state.busy);
  const owner = !state.busy;
  if (owner) state.busy = name;
  state.error = null;
  emit();
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    state.error = `${name}: ${msg}`;
    log("error", `${name} failed: ${msg}`);
    throw e;
  } finally {
    if (owner) state.busy = null;
    emit();
  }
}

function requireChain(): void {
  if (!state.config.chainReady) throw new StepError(`Chain wallets not configured (${state.config.missing.join(", ")}).`);
}
function requireStatus(...ok: Status[]): void {
  if (!ok.includes(state.status)) throw new StepError(`Not allowed in status ${state.status} (needs ${ok.join(" or ")}).`);
}

// ---------- steps ----------
export function tokenize() {
  return action("Tokenize & register", async () => {
    requireChain();
    requireStatus("DRAFT");
    const s = getSigners();
    const agentPub = s.AGENT.publicKey;
    // Unique per run: the registry rejects a hash that is already registered (spike S3).
    const waybill = { ...state.invoice.waybill, run_nonce: randomBytes(8).toString("hex") };
    const hash = invoiceHash(waybill);
    state.invoice.waybill = waybill;
    state.invoice.hash = hash;
    log("info", `Waybill hashed (sha256 canonical JSON): ${hash.slice(0, 16)}…`);
    const expires = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    addTx("device_registry.register (invoice device)", "TREASURY", await serial(() => getClient().registerDevice(s.TREASURY, hash, agentPub)));
    addTx(
      `agent_registry.register_agent (cap ${xlm(PAYOUTS.maxAmount)} XLM)`,
      "TREASURY",
      await serial(() => getClient().registerAgent(s.TREASURY, hash, agentPub, PAYOUTS.maxAmount, undefined, expires)),
    );
    state.invoice.policyExpiresAt = expires.toISOString();
    setStatus("TOKENIZED");
    await refreshBalances();
  });
}

export function fund() {
  return action("Fund 85% advance", async () => {
    requireChain();
    requireStatus("TOKENIZED");
    const s = getSigners();
    if (!simMode) await refill(s.LP.publicKey, PAYOUTS.advance, "LP");
    addTx(`payment_escrow.fund_escrow (LP ${xlm(PAYOUTS.advance)} XLM)`, "LP", await serial(() => getClient().fundEscrow(s.LP, state.invoice.hash!, PAYOUTS.advance)));
    setStatus("FUNDED");
    await refreshBalances();
  });
}

function facts(): Facts {
  const ticks = state.voyage.ticks;
  return {
    invoiceId: state.invoice.id,
    faceValue: V,
    status: state.status,
    // Last on-chain escrow read (refreshed after every funding): it must cover the advance.
    escrowFunded: state.escrowXlm != null && toStroops(state.escrowXlm) >= PAYOUTS.advance,
    vesselUnderway: isUnderway(state.voyage.latest ?? undefined) || (state.voyage.running && ticks.some((t) => isUnderway(t))),
    berthed: state.voyage.berthed,
    paymentVerified: !!state.payment?.verified,
    paymentAmountMatches: !!state.payment?.amountMatches,
    vessel: SEED_WAYBILL.vessel,
    port: CEBU.name,
    signals: ticks.length ? voyageSignals(ticks) : undefined,
    opsReview: state.opsReview ?? null,
  };
}

function execContext(execState: string): ExecutorContext {
  const s = getSigners();
  return {
    client: getClient(),
    invoice: { id: state.invoice.id, state: execState, faceValue: V },
    deviceHash: state.invoice.hash!,
    addresses: { SHIPOWNER: s.SHIPOWNER.publicKey, LP: s.LP.publicKey, TREASURY: s.TREASURY.publicKey },
    signers: s,
    gates: {
      hashRegisteredByUs: !!state.invoice.hash,
      vesselUnderway: facts().vesselUnderway,
      webhookVerified: !!state.payment?.verified,
      webhookAmount: state.payment ? toStroops(state.payment.amountXlm) : undefined,
      berthingAttestation: !!state.attestation,
    },
  };
}

function recordDecision(proposal: AgentDecision | null, engine: string, r: ExecutionResult | null, extra: Partial<DecisionRow> = {}): DecisionRow {
  const row: DecisionRow = {
    id: `dec_${state.decisions.length + 1}_${randomBytes(3).toString("hex")}`,
    at: now(),
    decision: r?.decision ?? proposal?.decision ?? "HOLD",
    requested: r?.requested ?? proposal?.decision ?? "HOLD",
    ok: r?.ok ?? true,
    reason: proposal?.reason ?? r?.reason ?? "",
    engine,
    refusal: r?.refusal ?? null,
    detail: r?.failure?.detail ?? null,
    proposal,
    payouts: (proposal?.payouts ?? []).map((p) => ({ role: p.role, xlm: xlm(BigInt(p.amountStroops)) })),
    txs: (r?.steps ?? []).map((st) => ({ step: st.step, role: st.role, xlm: xlm(st.amount), hash: st.hash, url: linkFor(st.explorerUrl) })),
    finalEscrowXlm: r?.finalEscrowBalance == null ? null : xlm(r.finalEscrowBalance),
    attestation: null,
    extra: null,
    ...extra,
  };
  state.decisions.push(row);
  for (const t of row.txs) state.txs.push({ label: `payment_escrow.${t.step === "authorize" ? "authorize" : "claim"} (${t.role}${t.step === "authorize" ? ` ${t.xlm} XLM` : ""})`, role: t.step === "authorize" ? "AGENT" : t.role, hash: t.hash, url: t.url, at: row.at });
  emit();
  return row;
}

/** Resume of a payout an earlier server started (see resume.ts), with this run's facts and signers. */
function resumePartialPayout(d: AgentDecision) {
  const gateOk = d.decision === "ADVANCE" ? facts().vesselUnderway : !!(state.payment?.verified && state.payment.amountMatches && state.attestation);
  return resumePayouts({ client: getClient(), signers: getSigners(), deviceHash: state.invoice.hash!, decision: d, faceValue: V, gateOk, serial, log: (m) => log("warn", m) });
}

/** The agent looks at the facts and acts if a decision is due. Safe to call often. */
async function agentStep(): Promise<void> {
  if (!state.config.chainReady || !state.invoice.hash) return;
  if (state.status === "FUNDED" && (state.escrowXlm == null || toStroops(state.escrowXlm) < PAYOUTS.advance)) {
    try {
      state.escrowXlm = xlm(await getClient().balanceOf(state.invoice.hash)); // the last read failed or is stale
    } catch {
      /* keep the last value: no ADVANCE until the escrow is confirmed */
    }
  }
  const f = facts();
  // The LP's funding is on record but the escrow no longer covers the advance: an earlier server's advance may have
  // landed without being recorded. Let the decision run; the resume (or the executor) checks the real balance.
  if (f.status === "FUNDED" && !f.escrowFunded && state.txs.some((t) => t.label.startsWith("payment_escrow.fund_escrow (LP"))) f.escrowFunded = true;
  // The rules say whether a decision is due (cheap, every tick); the model is asked once per decision point.
  const due = propose(f);
  if (!due) return;
  const key = `${state.run}:${due.decision.decision}:${state.status}:${state.opsReview?.at ?? ""}`;
  if (decided.has(key)) return;
  decided.add(key);
  const prop = await decide(f);
  if (!prop) return;
  const kind = prop.decision.decision;
  log("info", `Agent decided ${kind} (${prop.engine}).${kind === "HOLD" ? "" : " Executor checking gates, amounts and policy…"}`);
  if (kind === "HOLD") {
    recordDecision(prop.decision, prop.engine, null, { risks: prop.risks, reviewable: prop.reviewable, key });
    if (prop.reviewable && state.status !== "HOLD") {
      state.holdFrom = state.status;
      setStatus("HOLD");
      log("warn", `The agent held the ${due.decision.decision}: ${prop.decision.reason} No money moved; an ops review can release it.`);
    }
    return;
  }
  const run = state.run;
  const execState = kind === "ADVANCE" ? "FUNDED" : "PAID";
  const resumed = await resumePartialPayout(prop.decision);
  const result = resumed?.result ?? (await serial(() => execute(prop.decision, execContext(execState))));
  if (state.run !== run) return; // demo was reset while the chain call was in flight
  recordDecision(prop.decision, prop.engine, result, { risks: prop.risks, key, ...(resumed ? { extra: { executor: "resumed after a partial run", alreadyLanded: resumed.alreadyLanded } } : {}) });
  if (result.ok && result.decision === kind) {
    if (kind === "ADVANCE") {
      setStatus("ADVANCED");
      log("ok", `Advance of ${xlm(PAYOUTS.advance)} XLM (₱850,000) claimed by the shipowner.`);
    } else {
      setStatus("SETTLED");
      log("ok", `Settled: LP ${xlm(PAYOUTS.lpRepayment)}, shipowner ${xlm(PAYOUTS.rebate)}, treasury ${xlm(PAYOUTS.fee)} XLM. Escrow ${result.finalEscrowBalance == null ? "?" : xlm(result.finalEscrowBalance)} XLM.`);
    }
  } else {
    state.holdFrom = state.status;
    setStatus("HOLD");
    log("warn", `Executor forced HOLD: ${result.refusal ?? result.reason}${result.failure?.detail ? ` (${result.failure.detail})` : ""}.`);
  }
  await refreshBalances();
}

// ---------- voyage ----------
function signAttestation(t: Tick): Attestation {
  const record = {
    invoiceId: state.invoice.id,
    vesselMMSI: SEED_WAYBILL.vessel_mmsi,
    destinationPort: "CEBU_BASEPORT",
    berthTimestamp: t.at,
    lat: t.lat.toFixed(5),
    lng: t.lng.toFixed(5),
    sogKnots: t.sog.toFixed(1),
    rule: "inside 800 m Cebu geofence, SOG <= 0.5 kn for 3 consecutive ticks",
  };
  const canonical = canonicalJson(record);
  const sha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  const secret = env("AGENT_SECRET");
  const kp = secret ? Keypair.fromSecret(secret) : null;
  return {
    record,
    canonical,
    sha256,
    signature: kp ? kp.sign(Buffer.from(sha256, "hex")).toString("base64") : "unsigned (AGENT_SECRET missing)",
    signer: kp?.publicKey() ?? "n/a",
    scheme: "ed25519 over sha256(canonical JSON), agent key",
  };
}

async function onTick(t: Tick): Promise<void> {
  state.voyage.ticks.push(t);
  if (state.voyage.ticks.length > 60) state.voyage.ticks.shift();
  state.voyage.latest = t;
  if (state.status === "ADVANCED" && isUnderway(t)) setStatus("IN_TRANSIT");
  emit();
  const run = state.run;
  await agentStep(); // ADVANCE fires on the first underway tick
  if (state.run !== run) return;

  if (!state.voyage.berthed && isBerthed(state.voyage.ticks)) {
    state.voyage.berthed = true;
    state.attestation = signAttestation(t);
    log("ok", `Berthing detected at ${CEBU.name}. Attestation signed: ${state.attestation.sha256.slice(0, 16)}…`);
    if (state.status === "ADVANCED" || state.status === "IN_TRANSIT") setStatus("BERTHED");
    recordDecision(null, "berthing-detector", null, {
      decision: "BERTHED",
      requested: "BERTHED",
      reason: `${SEED_WAYBILL.vessel} inside the ${CEBU.radiusM} m Port of Cebu geofence at ≤0.5 kn for 3 ticks. Proof of delivery signed by the agent.`,
      attestation: state.attestation,
    });
    await progressPayment();
  }
}

async function voyageLoop(token: number, startSeq = 0): Promise<void> {
  let seq = startSeq;
  while (token === voyageToken && seq < TOTAL_TICKS) {
    const scenarioDark = state.scenario === "ais-dark";
    if (scenarioDark && AIS_DARK.dark.has(seq)) {
      // No reading arrives: the gap is what the agent sees.
      if (!AIS_DARK.dark.has(seq - 1)) log("warn", `AIS signal lost after ${state.voyage.latest?.leg ?? "the last reading"}.`);
    } else {
      const t = makeTick(seq, scenarioDark && seq === AIS_DARK.reappear ? { offsetKm: AIS_DARK.offsetKm } : {});
      await onTick(t);
      if (scenarioDark && seq === AIS_DARK.reappear) log("warn", `AIS back after ${voyageSignals(state.voyage.ticks).aisGapHours.toFixed(1)} h dark, ${t.laneKm.toFixed(1)} km off the sea lane.`);
    }
    seq += 1;
    // Fast-forward replays the remaining readings quickly rather than skipping them (a skip would read as an AIS gap).
    if (seq < TOTAL_TICKS) await sleep(fastForward ? 150 : TICK_MS);
  }
  if (token === voyageToken) {
    fastForward = false;
    state.voyage.running = false;
    emit();
    scheduleRelease();
  }
}

let voyagePromise: Promise<void> = Promise.resolve();
export function depart() {
  return action("Depart Manila", async () => {
    requireChain();
    requireStatus("FUNDED");
    if (state.voyage.running) throw new StepError("Voyage already running.");
    state.voyage.running = true;
    log("info", `${SEED_WAYBILL.vessel} departing ${SEED_WAYBILL.origin}. AIS simulator streaming every ${TICK_MS} ms.`);
    const token = ++voyageToken;
    voyagePromise = voyageLoop(token).catch((e) => log("error", `voyage: ${e instanceof Error ? e.message : e}`));
  });
}

export function fastForwardVoyage() {
  return action(
    "Fast-forward",
    async () => {
      if (!state.voyage.running) {
        if (state.status === "FUNDED") {
          fastForward = true;
          state.voyage.running = true;
          log("warn", "Fast-forward: replaying the voyage's AIS readings quickly.");
          const token = ++voyageToken;
          voyagePromise = voyageLoop(token).catch((e) => log("error", `voyage: ${e instanceof Error ? e.message : e}`));
          return;
        }
        throw new StepError("Nothing to fast-forward (voyage not running).");
      }
      if (!fastForward) log("warn", "Fast-forward: replaying the rest of the voyage's AIS readings quickly.");
      fastForward = true;
    },
    { allowWhenBusy: true },
  );
}

// ---------- payment ----------
export function checkout() {
  return action("Create Velo checkout", async () => {
    if (state.checkout) return state.checkout;
    if (state.status === "DRAFT") throw new StepError("Tokenize the invoice first.");
    state.checkout = await createCheckout({
      invoiceId: state.invoice.id,
      amountXlm: xlm(V),
      description: `Freight invoice ${state.invoice.id} (Manila → Cebu), ${SEED_WAYBILL.vessel}`,
    });
    log(state.checkout.simulated ? "warn" : "ok", state.checkout.simulated ? `Checkout simulated (no VELO_API_KEY): ${state.checkout.id}` : `Velo checkout session ${state.checkout.id} created for ${xlm(V)} XLM.`);
    return state.checkout;
  });
}

/**
 * Applies a verified Velo payment.succeeded to the demo invoice (webhooks.ts verifies and routes it here).
 * Idempotent: the same event twice is a no-op.
 */
export async function applyPayment(ev: VerifiedEvent, simulated = false): Promise<{ status: number; body: unknown }> {
  const pi = ev.paymentIntent;
  if (!pi) return { status: 200, body: { ok: true, ignored: ev.type } };
  if (!state.checkout || pi.id !== state.checkout.id) {
    log("warn", `payment.succeeded for unknown intent ${pi.id} ignored.`);
    return { status: 200, body: { ok: true, ignored: "unknown payment intent" } };
  }
  if (state.payment?.verified && state.payment.eventId === ev.id) return { status: 200, body: { ok: true, duplicate: true } };
  let amountMatches = false;
  try {
    amountMatches = toStroops(String(pi.amount)) === V;
  } catch {
    amountMatches = false;
  }
  state.payment = {
    verified: true,
    eventId: ev.id,
    deliveryId: ev.id,
    amountXlm: String(pi.amount),
    amountMatches,
    verifiedBy: ev.verifiedBy,
    simulated,
    at: now(),
    raw: ev.raw,
  };
  log(amountMatches ? "ok" : "warn", `Velo payment.succeeded verified (${ev.verifiedBy}) for ${pi.amount} XLM${amountMatches ? "" : " — amount does not match the invoice!"}.`);
  void progressPayment().catch((e) => log("error", `settlement: ${e instanceof Error ? e.message : e}`));
  return { status: 200, body: { ok: true } };
}

let paymentInFlight: Promise<void> | null = null;
/** Once berthed and paid: treasury funds the escrow with the debtor's money, guardrail probe, then the agent settles. */
function progressPayment(): Promise<void> {
  if (paymentInFlight) return paymentInFlight;
  if (!state.payment?.verified || !state.voyage.berthed || state.status !== "BERTHED") return Promise.resolve();
  paymentInFlight = (async () => {
    try {
      const s = getSigners();
      const run = state.run;
      if (!state.payment!.amountMatches) {
        state.status = "PAID";
        await agentStep(); // HOLD with reason
        return;
      }
      // A server that stopped right after funding must not fund twice when another one resumes.
      const already = await getClient().balanceOf(state.invoice.hash!).catch(() => 0n);
      if (already >= V) log("info", `Escrow already holds ${xlm(already)} XLM from the Velo payment; not funding again.`);
      else {
        if (!simMode) await refill(s.TREASURY.publicKey, V, "Treasury");
        if (simMode) getSim().ledger.wallets.set(s.TREASURY.publicKey, getSim().ledger.balance(s.TREASURY.publicKey) + V); // simulated Velo payout from the debtor
        if (simMode) getSim().ledger.wallets.set(state.addresses.DEBTOR!, getSim().ledger.balance(state.addresses.DEBTOR!) - V);
        addTx(`payment_escrow.fund_escrow (Treasury ${xlm(V)} XLM from Velo checkout)`, "TREASURY", await serial(() => getClient().fundEscrow(s.TREASURY, state.invoice.hash!, V)));
      }
      if (state.run !== run) return;
      setStatus("PAID");
      await refreshBalances();
      await guardrailProbe("Agent pre-settlement self-check");
      await agentStep(); // SETTLE
    } finally {
      paymentInFlight = null;
      scheduleRelease();
    }
  })();
  return paymentInFlight;
}

/** Paid but not settled when its server stopped: the agent decides again. Counted as work so this server keeps the run (and isn't frozen) until it's done. */
function resumeSettlement(): Promise<void> {
  if (paymentInFlight) return paymentInFlight;
  // Not inside serial(): agentStep queues its own chain calls there, so wrapping it would deadlock.
  paymentInFlight = agentStep().finally(() => {
    paymentInFlight = null;
    scheduleRelease();
  });
  return paymentInFlight;
}

export function simulateWebhook() {
  return action("Simulate Velo webhook", async () => {
    if (state.status === "DRAFT") throw new StepError("Tokenize the invoice first.");
    if (!state.checkout) {
      state.checkout = await createCheckout({ invoiceId: state.invoice.id, amountXlm: xlm(V), description: `Freight invoice ${state.invoice.id}` });
    }
    const d = signSimulatedDelivery({ id: state.checkout.id, amount: xlm(V), asset: state.checkout.asset, description: `Freight invoice ${state.invoice.id}` });
    log("info", `Simulated payment.succeeded signed (HMAC-SHA256) and verified like a delivery to /api/webhooks/velo.`);
    let ev: VerifiedEvent;
    try {
      ev = await verifyWebhook(d.body, d.signature, { simulated: true });
    } catch (e) {
      throw new StepError(`webhook rejected: ${e instanceof Error ? e.message : e}`);
    }
    const r = await applyPayment(ev, true);
    if (r.status !== 200) throw new StepError(`webhook returned ${r.status}`);
    if (paymentInFlight) await paymentInFlight;
  });
}

// ---------- guardrail ----------
async function guardrailProbe(label: string): Promise<void> {
  if (!state.invoice.hash) return;
  const s = getSigners();
  log("info", `${label}: agent attempts a single ${xlm(V)} XLM payout against its ${xlm(PAYOUTS.maxAmount)} XLM cap…`);
  const r = await serial(() =>
    runGuardrail({ client: getClient(), deviceHash: state.invoice.hash!, agent: s.AGENT, merchant: s.SHIPOWNER.publicKey, capAmount: PAYOUTS.maxAmount, attemptAmount: V }),
  );
  const json = JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  state.guardrail = { ...json, ranAt: now() };
  recordDecision(null, "noir-policy", null, {
    decision: r.unexpectedSuccess ? "GUARDRAIL_FAILED" : "REFUSED",
    requested: "PAY 1000 XLM",
    ok: !r.unexpectedSuccess,
    reason: r.summary,
    refusal: r.checkPayment.ok ? null : r.checkPayment.reason,
    detail: r.sdkError ? `${r.sdkError.errorName ?? r.sdkError.name}${r.sdkError.code != null ? ` #${r.sdkError.code}` : ""}` : null,
    payouts: [{ role: "SHIPOWNER", xlm: xlm(V) }],
    extra: json,
  });
  log(r.unexpectedSuccess ? "error" : "ok", r.summary);
}

export function guardrail() {
  return action("Guardrail demo", async () => {
    requireChain();
    if (!state.invoice.hash) throw new StepError("Tokenize the invoice first.");
    await guardrailProbe("Guardrail demo");
  });
}

// ---------- default ----------
export function simulateDefault() {
  return action("Simulate default", async () => {
    requireChain();
    requireStatus("FUNDED", "ADVANCED", "IN_TRANSIT", "BERTHED", "HOLD");
    voyageToken++;
    state.voyage.running = false;
    const s = getSigners();
    const decision: AgentDecision = { invoiceId: state.invoice.id, decision: "DEFAULT", reason: "Due date + grace passed (simulated clock) with no verified payment. Ops may recover the escrow.", payouts: [] };
    const ctx: ExecutorContext = {
      ...execContext(state.status === "HOLD" ? (state.holdFrom ?? "FUNDED") : state.status),
      gates: { ...execContext("FUNDED").gates, webhookVerified: false, dueDatePlusGracePassed: true },
      recovery: () => defaultRecovery({ client: getClient(), ownerSigner: s.TREASURY, deviceHash: state.invoice.hash!, agent: s.AGENT, ...(simMode ? { readTreasuryBalance: async (acct: string) => getSim().ledger.balance(acct) } : {}) }),
    };
    const result = await serial(() => execute(decision, ctx));
    recordDecision(decision, "rules", result);
    if (!(result.ok && result.decision === "DEFAULT")) throw new StepError(`executor refused DEFAULT: ${result.refusal}`);
    setStatus("DEFAULT");
    const rec = await serial(() => runDefaultRecovery(result, ctx));
    rec.txs.forEach((t, i) => addTx(`default recovery tx ${i + 1}/${rec.txs.length} (revoke_agent + sweep_on_revoke → Treasury)`, "TREASURY", t));
    state.recovery = JSON.parse(JSON.stringify(rec, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    log("ok", `Recovery: escrow ${xlm(rec.escrowBefore)} → ${xlm(rec.escrowAfter)} XLM swept to Treasury; revoked agent now refused (${rec.checkAfterRevoke}).`);
    await refreshBalances();
  });
}

// ---------- chain mode switch ----------
export function setMode(mode: "testnet" | "simulation") {
  return action(mode === "simulation" ? "Switch to simulation" : "Switch to Testnet", async () => {
    if (mode === "testnet" && missingChainEnv().length) throw new StepError(`Testnet wallets not configured (${missingChainEnv().join(", ")}).`);
    voyageToken++;
    fastForward = false;
    await chainQueue.catch(() => undefined);
    simMode = mode === "simulation";
    sim = null; // fresh simulated ledger each time
    const prevLog = state.log.slice(-3);
    state = freshState();
    state.busy = "Switching mode";
    state.log.unshift(...prevLog.map((l) => ({ ...l, text: `(previous run) ${l.text}` })));
    log(simMode ? "warn" : "ok", simMode ? "Simulation mode: contracts run in memory with the same rules (cap, escrow, revoke). Transactions are labelled simulated." : "Testnet mode: every action is a real Stellar Testnet transaction.");
    await refreshBalances();
  });
}
export const useSimulation = () => setMode("simulation");
export const useTestnet = () => setMode("testnet");

// ---------- reset / run demo ----------
export function reset() {
  return action("Reset", async () => {
    voyageToken++;
    fastForward = false;
    await chainQueue.catch(() => undefined);
    const prevLog = state.log.slice(-3);
    state = freshState();
    state.busy = "Reset";
    state.log.unshift(...prevLog.map((l) => ({ ...l, text: `(previous run) ${l.text}` })));
    await refreshBalances();
  });
}

export function runDemo(scenario: Scenario = "normal") {
  return action(scenario === "ais-dark" ? "Run Demo (AIS goes dark)" : "Run Demo", async () => {
    requireChain();
    state.autopilot = true;
    try {
      if (state.status !== "DRAFT") {
        voyageToken++;
        await chainQueue.catch(() => undefined);
        const keep = state.log.slice(-2);
        const busy = state.busy;
        state = freshState();
        state.busy = busy;
        state.autopilot = true;
        state.log.unshift(...keep);
        emit();
      }
      state.scenario = scenario;
      log("info", simMode ? "▶ Run Demo: full loop in SIMULATION mode (in-memory contracts, no Testnet transactions)." : "▶ Run Demo: full loop on Stellar Testnet.");
      if (scenario === "ais-dark") log("warn", "Scenario: AIS goes dark mid-voyage and the vessel reappears off the sea lane, both under the hard limits. The agent decides whether to pay.");
      await inner(tokenize);
      await sleep(800);
      await inner(fund);
      await sleep(800);
      await inner(depart);
      await voyagePromise;
      if (!state.voyage.berthed) throw new StepError("Vessel did not berth.");
      await inner(checkout);
      await sleep(1200);
      await inner(simulateWebhook);
      log(state.status === "SETTLED" ? "ok" : "warn", `■ Run Demo finished with status ${state.status}.`);
    } finally {
      state.autopilot = false;
    }
  });
}

/**
 * Ops review: releases a hold the agent chose (or a hard-limit hold). The agent then decides again, with the review
 * note among its facts; it may still hold. A hold from a failed check (no payment, wrong amount) can't be released.
 */
export function releaseHold() {
  return action("Ops review: release hold", async () => {
    requireChain();
    if (state.status !== "HOLD" || !state.holdFrom) throw new StepError("Nothing is on hold.");
    const held = [...state.decisions].reverse().find((d) => d.decision === "HOLD");
    if (!held?.reviewable) throw new StepError("This hold came from a failed check, not a judgment: a review can't release it.");
    state.opsReview = { at: now(), note: `Ops reviewed the concern behind the hold ("${held.reason.slice(0, 160)}") and cleared it.` };
    const from = state.holdFrom;
    state.holdFrom = null;
    setStatus(from);
    log("ok", "Ops review: hold released. The agent decides again, with the review note among its facts.");
    await agentStep();
    // An advance released after the vessel already berthed: catch the invoice up with the voyage.
    if ((state.status as Status) === "ADVANCED" && state.voyage.berthed && !state.voyage.running) {
      setStatus("BERTHED");
      await progressPayment();
    }
  });
}

/** Run a step from inside Run Demo (re-uses the outer busy lock). */
async function inner(step: () => Promise<unknown>): Promise<void> {
  const outer = state.busy;
  state.busy = null;
  try {
    await step();
  } finally {
    state.busy = outer;
    emit();
  }
}

// ---------- shared state across instances ----------
const SNAP = "demo:state";
const LEASE = "demo:lease";
const LEASE_MS = 30_000;
let leaseHeld = false;
let leaseKeeper: NodeJS.Timeout | null = null;
let activeOps = 0;
let persistTimer: NodeJS.Timeout | null = null;
let persistQueue: Promise<void> = Promise.resolve();

/** Work in progress on this instance (a step, a voyage, a payment, or a request being handled). */
export const isActive = (): boolean => activeOps > 0 || !!state.busy || state.voyage.running || !!paymentInFlight;
addBusyCheck(() => isActive() || leaseHeld || !!persistTimer);

function persistSoon(): void {
  if (!kvEnabled() || !leaseHeld || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNow();
  }, 250);
}
function persistNow(): Promise<void> {
  if (!kvEnabled()) return Promise.resolve();
  const snap = state;
  persistQueue = persistQueue.then(() => setJson(SNAP, snap)).catch((e) => console.error("demo: save failed:", e instanceof Error ? e.message : e));
  return persistQueue;
}

let leaseQueue: Promise<unknown> = Promise.resolve();
function inLeaseQueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = leaseQueue.then(fn, fn);
  leaseQueue = p.catch(() => undefined);
  return p;
}

async function acquireLease(): Promise<boolean> {
  if (!kvEnabled()) return true;
  if (leaseHeld && (await extendIf(LEASE, INSTANCE_ID, LEASE_MS))) return true;
  leaseHeld = false;
  if (!(await setNx(LEASE, INSTANCE_ID, LEASE_MS)) && (await getRaw(LEASE)) !== INSTANCE_ID) return false;
  leaseHeld = true;
  leaseKeeper ??= setInterval(() => {
    if (!leaseHeld) return;
    void extendIf(LEASE, INSTANCE_ID, LEASE_MS)
      .then((kept) => {
        if (!kept) {
          leaseHeld = false;
          console.error("demo: lease lost while running; another instance may take over.");
        }
      })
      .catch(() => undefined);
  }, 5_000);
  return true;
}

async function releaseIfIdle(): Promise<void> {
  if (!kvEnabled() || !leaseHeld || isActive()) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistNow();
  if (isActive()) return;
  await delIf(LEASE, INSTANCE_ID).catch(() => undefined);
  leaseHeld = false;
  if (leaseKeeper) clearInterval(leaseKeeper);
  leaseKeeper = null;
}

/** Hand the demo back once this instance has nothing left to do (a short delay lets a follow-up step start). */
function scheduleRelease(): void {
  if (!kvEnabled()) return;
  setTimeout(() => void inLeaseQueue(releaseIfIdle), 1_500);
}

export class BusyElsewhere extends Error {
  constructor() {
    super("Busy: the demo is running on another server. It shows up here as it progresses; try again when it finishes.");
  }
}

const STATUS_OF: Record<string, Status> = { ADVANCE: "FUNDED", SETTLE: "PAID", HOLD: "PAID" };

/** Takes over the saved run (this instance now holds the lease). Resumes work its last owner left unfinished. */
function adopt(snap: DemoState): void {
  if (snap.config.mode === "simulation" && !["DRAFT", "SETTLED", "DEFAULT"].includes(snap.status) && simLedgerRun !== snap.run) {
    // Simulated contracts live in one server's memory, so a simulated run can't continue elsewhere.
    runCounter = Math.max(runCounter, snap.run);
    simMode = true;
    sim = null;
    state = freshState();
    log("warn", "The simulated run restarted because it moved to another server. Testnet runs continue where they left off.");
    return;
  }
  const interrupted = snap.busy;
  const voyageWasRunning = snap.voyage.running;
  state = snap;
  runCounter = Math.max(runCounter, snap.run);
  const miss = missingChainEnv();
  simMode = snap.config.mode === "simulation" || miss.length > 0;
  state.config = {
    ...state.config,
    chainReady: simMode || miss.length === 0,
    mode: simMode ? "simulation" : "testnet",
    canGoLive: miss.length === 0,
    missing: miss,
    veloCheckout: veloCheckoutConfigured(),
    realWebhookSecret: usingRealWebhookSecret(),
    llm: llmConfigured(),
  };
  decided.clear();
  for (const d of state.decisions) {
    if (d.key) decided.add(d.key);
    else if (STATUS_OF[d.requested]) decided.add(`${state.run}:${d.requested}:${STATUS_OF[d.requested]}:`);
  }
  state.busy = null;
  state.autopilot = false;
  state.voyage.running = false;
  if (interrupted) log("warn", `"${interrupted}" was interrupted when its server stopped. Picking up from the last saved step.`);
  if (voyageWasRunning && !state.voyage.berthed && ["FUNDED", "ADVANCED", "IN_TRANSIT"].includes(state.status)) {
    const from = state.voyage.latest ? state.voyage.latest.seq + 1 : 0;
    state.voyage.running = true;
    log("warn", `Voyage resumed on this server from AIS tick ${from}.`);
    const token = ++voyageToken;
    voyagePromise = voyageLoop(token, from).catch((e) => log("error", `voyage: ${e instanceof Error ? e.message : e}`));
  } else if (state.status === "BERTHED" && state.payment?.verified) {
    void progressPayment().catch((e) => log("error", `settlement: ${e instanceof Error ? e.message : e}`));
  } else if (state.status === "PAID") {
    void resumeSettlement().catch((e) => log("error", `settlement: ${e instanceof Error ? e.message : e}`));
  }
  emit();
}

/**
 * Runs a demo step on this instance: takes the lease (or reports that another instance is running the demo),
 * loads the latest saved run, then calls fn.
 */
export async function withDemo<T>(fn: () => Promise<T>): Promise<T> {
  activeOps++;
  try {
    if (!(await inLeaseQueue(acquireLease))) throw new BusyElsewhere();
    if (kvEnabled() && !state.busy && !state.voyage.running && !paymentInFlight) {
      const snap = await getJson<DemoState>(SNAP);
      if (snap && (snap.run !== state.run || snap.updatedAt > state.updatedAt)) adopt(snap);
    }
    return await fn();
  } finally {
    activeOps--;
    scheduleRelease();
  }
}

let viewCache: { at: number; snap: DemoState | null; p: Promise<DemoState | null> | null } = { at: 0, snap: null, p: null };

/**
 * The run to show: this instance's own state while it holds the lease, otherwise the saved snapshot.
 * A saved run that is mid-step with nobody holding the lease (its server stopped) is taken over and resumed.
 */
export async function viewState(): Promise<DemoState> {
  if (!kvEnabled() || leaseHeld) return state;
  const t = Date.now();
  if (t - viewCache.at > 800 && !viewCache.p) {
    viewCache.p = (async () => {
      const snap = await getJson<DemoState>(SNAP).catch(() => null);
      if (snap && (snap.busy || snap.voyage.running || (snap.status === "BERTHED" && snap.payment?.verified) || snap.status === "PAID")) {
        const holder = await getRaw(LEASE).catch(() => "unknown");
        if (holder === null) void withDemo(async () => undefined).catch(() => undefined); // orphaned run: resume it here
      }
      return snap;
    })().finally(() => {
      viewCache.at = Date.now();
      viewCache.p = null;
    });
    viewCache.snap = (await viewCache.p) ?? viewCache.snap;
  } else if (viewCache.p) viewCache.snap = (await viewCache.p) ?? viewCache.snap;
  if (leaseHeld) return state;
  const snap = viewCache.snap;
  if (!snap) return state;
  // A saved run keeps the flags of the server that saved it; show what this deployment has configured.
  return { ...snap, config: { ...snap.config, veloCheckout: veloCheckoutConfigured(), realWebhookSecret: usingRealWebhookSecret(), llm: llmConfigured() } };
}

export async function init(): Promise<void> {
  if (simMode) {
    log("warn", state.config.missing.length ? `Testnet wallets missing (${state.config.missing.join(", ")}): running in SIMULATION mode.` : "SIMULATE_CHAIN=1: running in SIMULATION mode.");
  } else if (state.config.chainReady) {
    try {
      getSigners();
    } catch (e) {
      state.config.chainReady = false;
      state.error = e instanceof Error ? e.message : String(e);
    }
  } else {
    log("warn", `Wallets missing (${state.config.missing.join(", ")}). UI runs read-only until they are set.`);
  }
  if (!state.config.realWebhookSecret) log("warn", "VELO_WEBHOOK_SECRET not set: only simulated (self-signed) webhooks will verify.");
  // With a shared store, balances are refreshed by whichever instance runs the demo.
  if (!kvEnabled()) await refreshBalances();
}
