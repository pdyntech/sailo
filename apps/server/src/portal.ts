/**
 * Portal invoices for signed-in users (Shipowner, Investor, Cargo owner).
 *
 * Invoices live in one shared ledger, so the roles meet each other:
 *   shipowner tokenizes -> any investor funds from the marketplace -> agent ADVANCE -> voyage -> berth
 *   -> the named cargo owner pays from their portal -> agent SETTLE.
 * Amounts use the same integer payout math as the on-chain demo (@noirxvelo/shared, 1 XLM = PHP 1,000).
 *
 * Invoices a shipowner creates run on Stellar Testnet when the platform wallets are configured
 * (portal-chain.ts): real Noir contracts, the real agent policy and executor, and custodial Testnet
 * wallets for the shipowner and investor. Otherwise they run in memory and are labelled simulated.
 *
 * New accounts get a few private sample invoices so the portal is not empty. Samples are always
 * simulated, and a sample's missing counterparty (investor or cargo owner) acts on its own after a short delay.
 */
import { createHash } from "node:crypto";
import { canonicalJson, computePayouts, fromStroops, phpToStroops, stroopsToPhp } from "@noirxvelo/shared";
import { db, onDbLoad, save, type User } from "./db.js";
import { HttpError } from "./http.js";
import { normEmail } from "./accounts.js";
import { kvEnabled } from "./kv.js";
import {
  MAX_ONCHAIN_FACE,
  STEP_LABEL,
  VOYAGE_MS,
  chainAvailable,
  jobFor,
  jobRunning,
  isAgentHold,
  needsRetry,
  newChain,
  recordPayment,
  resetRetry,
  signBerthing,
  voyageReadings,
  voyageStart,
  type PortalChain,
} from "./portal-chain.js";
import { readingsAfter, readingsBerthed, type Reading } from "./telemetry.js";
import { veloCheckoutConfigured, type CheckoutSession, type VerifiedEvent } from "./velo.js";

export type PState = "TOKENIZED" | "FUNDED" | "ADVANCED" | "IN_TRANSIT" | "BERTHED" | "PAID" | "SETTLED" | "HOLD";
type Contract = "device_registry" | "agent_registry" | "payment_escrow";
type PayRole = "SHIPOWNER" | "LP" | "TREASURY";

export interface LogEntry {
  at: string;
  title: string;
  text: string;
  c: Contract;
  decision?: "ADVANCE" | "SETTLE" | "HOLD";
  pay?: [PayRole, number][];
  raw?: unknown;
  /** Stellar Testnet transactions behind this entry. */
  txs?: { label: string; hash: string; url: string }[];
  /** True when the entry describes real Testnet activity (false or absent: simulated). */
  onchain?: boolean;
}

export interface PortalInvoice {
  seq: number;
  id: string;
  hash: string;
  createdAt: string;
  vessel: string;
  route: string;
  port: string;
  debtor: string;
  debtorEmail: string | null;
  ownerId: string | null;
  ownerName: string;
  funderId: string | null;
  funderName: string | null;
  face: number;
  term: number;
  state: PState;
  holdFrom: PState | null;
  /** ms epoch when the current state began; drives the automatic steps. */
  stateAt: number;
  paidAmount: number | null;
  berthAttested: boolean;
  /** Sample invoices are visible only to the account they were created for. */
  sampleFor: string | null;
  simInvestor: boolean;
  simDebtor: boolean;
  log: LogEntry[];
  /** Present when the invoice runs on Stellar Testnet. */
  chain?: PortalChain | null;
}

const ORDER: PState[] = ["TOKENIZED", "FUNDED", "ADVANCED", "IN_TRANSIT", "BERTHED", "PAID", "SETTLED"];
const TERMS = [30, 45, 60, 90];
const MAX_OPEN_PER_USER = 50;

// ---------- money ----------
export interface Money {
  adv: number;
  lp: number;
  fee: number;
  reb: number;
  cap: number;
}

export function money(face: number): Money {
  const p = computePayouts(phpToStroops(BigInt(face)));
  const php = (s: bigint) => Number(stroopsToPhp(s));
  return { adv: php(p.advance), lp: php(p.lpRepayment), fee: php(p.fee), reb: php(p.rebate), cap: php(p.maxAmount) };
}

const peso = (n: number) => "₱" + n.toLocaleString("en-US");
const xlm = (n: number) => (n / 1000).toLocaleString("en-US") + " XLM";
const stroops = (php: number) => (BigInt(php) * 10_000n).toString();

function escrowOf(i: PortalInvoice): number {
  if (i.chain?.escrowXlm != null) return Math.round(Number(i.chain.escrowXlm) * 1000); // read from the chain
  const s = i.state === "HOLD" ? i.holdFrom : i.state;
  const m = money(i.face);
  return s === "FUNDED" ? m.adv : s === "PAID" ? i.face : 0;
}

// ---------- ledger helpers ----------
function log(i: PortalInvoice, e: Omit<LogEntry, "at">): void {
  i.log.push({ at: new Date().toISOString(), ...e });
}

function setState(i: PortalInvoice, s: PState, at = Date.now()): void {
  i.state = s;
  i.stateAt = at;
}

function nextId(): { seq: number; id: string } {
  db.seq += 1;
  return { seq: db.seq, id: `INV-${new Date().getFullYear()}-${String(db.seq).padStart(3, "0")}` };
}

interface NewInvoice {
  vessel: string;
  route: string;
  debtor: string;
  debtorEmail: string | null;
  ownerId: string | null;
  ownerName: string;
  face: number;
  term: number;
  sampleFor?: string | null;
  simInvestor?: boolean;
  simDebtor?: boolean;
  onchain?: boolean;
}

function create(n: NewInvoice): PortalInvoice {
  const { seq, id } = nextId();
  const chain = n.onchain ? newChain() : null;
  // On-chain invoices add a random nonce: the registry rejects a hash that was ever registered before.
  const record = { id, vessel: n.vessel, route: n.route, debtor: n.debtor, face: String(n.face), term: n.term, ...(chain ? { nonce: chain.nonce } : {}) };
  const hash = createHash("sha256").update(canonicalJson(record)).digest("hex");
  if (db.invoices.some((x) => x.hash === hash)) throw new HttpError(409, "This invoice is already registered.");
  const i: PortalInvoice = {
    seq,
    id,
    hash,
    createdAt: new Date().toISOString(),
    vessel: n.vessel,
    route: n.route,
    port: "Port of " + n.route.split(/\s+to\s+/i)[1]!.trim(),
    debtor: n.debtor,
    debtorEmail: n.debtorEmail,
    ownerId: n.ownerId,
    ownerName: n.ownerName,
    funderId: null,
    funderName: null,
    face: n.face,
    term: n.term,
    state: "TOKENIZED",
    holdFrom: null,
    stateAt: Date.now(),
    paidAmount: null,
    berthAttested: false,
    sampleFor: n.sampleFor ?? null,
    simInvestor: n.simInvestor ?? false,
    simDebtor: n.simDebtor ?? !n.debtorEmail,
    log: [],
    chain,
  };
  const m = money(n.face);
  log(
    i,
    chain
      ? { title: "Invoice submitted", text: `SHA-256 ${hash.slice(0, 16)}… is being registered on Stellar Testnet, with an agent limit of ${xlm(m.cap)} per payment.`, c: "device_registry", onchain: true }
      : { title: "Invoice tokenized", text: `SHA-256 ${hash.slice(0, 16)}… registered as the invoice’s ID, with an agent limit of ${xlm(m.cap)} per payment.`, c: "device_registry" },
  );
  db.invoices.push(i);
  return i;
}

// ---------- lifecycle steps ----------
function fund(i: PortalInvoice, funderId: string | null, funderName: string): void {
  const m = money(i.face);
  i.funderId = funderId;
  i.funderName = funderName;
  log(i, { title: "Investor funded the advance", text: `${funderName} deposited ${peso(m.adv)} (${xlm(m.adv)}) into escrow.`, c: "payment_escrow" });
  setState(i, "FUNDED");
}

function hold(i: PortalInvoice, reason: string, checks: string[]): void {
  log(i, { title: "HOLD", text: reason, c: "payment_escrow", decision: "HOLD", pay: [], raw: { invoiceId: i.id, decision: "HOLD", reason, checks, payouts: [] } });
  i.holdFrom = i.state;
  setState(i, "HOLD");
}

/** The agent proposes; these code checks decide. Any failure holds the invoice and moves nothing. */
function agentAdvance(i: PortalInvoice): void {
  const m = money(i.face);
  const checks: [string, boolean][] = [
    ["invoice hash registered", /^[0-9a-f]{64}$/.test(i.hash)],
    ["investor deposit recorded", Boolean(i.funderName)],
    [`escrow covers the advance (${xlm(escrowOf(i))} ≥ ${xlm(m.adv)})`, escrowOf(i) >= m.adv],
    [`advance within the per-payment cap (${xlm(m.adv)} ≤ ${xlm(m.cap)})`, m.adv <= m.cap],
  ];
  const failed = checks.filter((c) => !c[1]).map((c) => c[0]);
  if (failed.length) return hold(i, `Advance refused: ${failed.join("; ")}.`, checks.map((c) => `${c[1] ? "pass" : "FAIL"}: ${c[0]}`));
  const reason = "The waybill hash is registered, the investor deposit is in escrow and covers the advance, and the payment is within the cap. Policy check passed.";
  const pay: [PayRole, number][] = [["SHIPOWNER", m.adv]];
  log(i, {
    title: "ADVANCE",
    text: reason,
    c: "payment_escrow",
    decision: "ADVANCE",
    pay,
    raw: { invoiceId: i.id, decision: "ADVANCE", reason, checks: checks.map((c) => `pass: ${c[0]}`), payouts: pay.map(([role, v]) => ({ role, amountStroops: stroops(v) })) },
  });
  setState(i, "ADVANCED");
}

function depart(i: PortalInvoice): void {
  const m = money(i.face);
  // On-chain invoices: the vessel sailed when the funding landed and the claim really happened in the advance step.
  if (i.chain) log(i, { title: "Under way", text: `The shipowner claimed ${peso(m.adv)}. The voyage continues; escrow is back to 0 until the cargo owner pays.`, c: "payment_escrow", onchain: true });
  else log(i, { title: "Vessel departed", text: `The shipowner claimed ${peso(m.adv)}. Escrow is back to 0 until the cargo owner pays.`, c: "payment_escrow" });
  setState(i, "IN_TRANSIT");
}

/** Arrival, once the berthing rule holds on the AIS readings (the last 3 at the quay at <= 0.5 kn). */
function berth(i: PortalInvoice, readings: Reading[]): void {
  if (!readingsBerthed(readings)) throw new Error("berth: the berthing rule does not hold");
  const sogs = readings.slice(-3).map((r) => r.sog.toFixed(1)).join(", ");
  const rule = `At the ${i.port} quay for 3 consecutive AIS readings at ${sogs} kn (rule: ≤ 0.5 kn; simulated AIS)`;
  i.berthAttested = true;
  if (i.chain) {
    i.chain.attestation = signBerthing(i, readings);
    const a = i.chain.attestation;
    log(i, {
      title: `Berthed at ${i.port}`,
      text: `${rule}. Proof of delivery signed by the agent key${a ? ` ${a.signer.slice(0, 6)}…: sha256 ${a.sha256.slice(0, 16)}…` : ""}.`,
      c: "agent_registry",
      onchain: true,
    });
  } else log(i, { title: `Berthed at ${i.port}`, text: `${rule}. Arrival attestation recorded.`, c: "agent_registry" });
  setState(i, "BERTHED");
}

function pay(i: PortalInvoice, payer: string): void {
  i.paidAmount = i.face;
  log(i, { title: "Cargo owner paid", text: `${payer} paid ${peso(i.face)} through checkout. Payment verified and escrow funded.`, c: "payment_escrow" });
  setState(i, "PAID");
}

function agentSettle(i: PortalInvoice): void {
  const m = money(i.face);
  const pay: [PayRole, number][] = [
    ["LP", m.lp],
    ["SHIPOWNER", m.reb],
    ["TREASURY", m.fee],
  ];
  const total = pay.reduce((a, p) => a + p[1], 0);
  const checks: [string, boolean][] = [
    [`payment equals the invoice (${peso(i.paidAmount ?? 0)} = ${peso(i.face)})`, i.paidAmount === i.face],
    ["arrival attested", i.berthAttested],
    [`escrow holds the payment (${xlm(escrowOf(i))})`, escrowOf(i) === i.face],
    [`payouts sum to the invoice (${peso(total)})`, total === i.face],
    [`every payout within the cap of ${xlm(m.cap)}`, pay.every((p) => p[1] <= m.cap)],
  ];
  const failed = checks.filter((c) => !c[1]).map((c) => c[0]);
  if (failed.length) return hold(i, `Settlement refused: ${failed.join("; ")}.`, checks.map((c) => `${c[1] ? "pass" : "FAIL"}: ${c[0]}`));
  const reason = "Payment verified for the exact invoice amount and arrival attested. Repaying the investor, returning the reserve and taking the fee. The parts sum to the invoice value.";
  log(i, {
    title: "SETTLE",
    text: reason,
    c: "payment_escrow",
    decision: "SETTLE",
    pay,
    raw: { invoiceId: i.id, decision: "SETTLE", reason, checks: checks.map((c) => `pass: ${c[0]}`), payouts: pay.map(([role, v]) => ({ role, amountStroops: stroops(v) })) },
  });
  setState(i, "SETTLED");
}

/** One automatic step if its delay has passed. Returns true if the invoice changed. */
function autoStep(i: PortalInvoice, now: number): boolean {
  const age = now - i.stateAt;
  if (i.chain) {
    // On-chain invoices: money moves only in chain jobs (portal-chain.ts). Only the voyage is timed here.
    if (i.state === "ADVANCED" && age >= 1400) return depart(i), true;
    if (i.state === "IN_TRANSIT") {
      const rs = voyageReadings(i, now);
      return readingsBerthed(rs) ? (berth(i, rs), true) : false;
    }
    if (i.state === "BERTHED" && i.simDebtor && !i.chain.payment && age >= 5000) {
      // No cargo owner account was named, so their payment is simulated (labelled). Escrow is still funded on-chain.
      i.chain.payment = { verified: true, eventId: `sim_${i.id}`, amountXlm: fromStroops(phpToStroops(BigInt(i.face))), amountMatches: true, verifiedBy: "simulated payer", simulated: true, at: new Date(now).toISOString() };
      log(i, { title: "Cargo owner paid", text: `${i.debtor} (simulated) paid ${peso(i.face)} through checkout.`, c: "payment_escrow" });
      return true;
    }
    return false;
  }
  const due: Partial<Record<PState, [number, () => void]>> = {
    TOKENIZED: [i.simInvestor ? 8000 : Infinity, () => fund(i, null, "A simulated investor")],
    FUNDED: [1400, () => agentAdvance(i)],
    ADVANCED: [1400, () => depart(i)],
    IN_TRANSIT: [VOYAGE_MS, () => berth(i, voyageReadings(i, now))],
    BERTHED: [i.simDebtor ? 5000 : Infinity, () => pay(i, `${i.debtor} (simulated)`)],
    PAID: [1600, () => agentSettle(i)],
  };
  const step = due[i.state];
  if (!step || age < step[0]) return false;
  step[1]();
  return true;
}

function autoStepAll(): void {
  const now = Date.now();
  let changed = false;
  for (const i of db.invoices) if (autoStep(i, now)) changed = true;
  if (changed) save();
}
// Every request first catches up on time-based steps (works on serverless, where timers don't run between requests).
onDbLoad(autoStepAll);
// A long-running process without a shared store also advances them between requests.
if (!kvEnabled()) setInterval(autoStepAll, 400).unref();

// ---------- samples for new accounts ----------
/** Push an invoice through the manual steps up to `target`, without waiting. */
function fastForward(i: PortalInvoice, target: PState, sampleFunder: string): void {
  while (ORDER.indexOf(i.state) < ORDER.indexOf(target)) {
    if (i.state === "TOKENIZED") fund(i, null, sampleFunder);
    else if (i.state === "FUNDED") agentAdvance(i);
    else if (i.state === "ADVANCED") depart(i);
    else if (i.state === "IN_TRANSIT") berth(i, readingsAfter(VOYAGE_MS, VOYAGE_MS));
    else if (i.state === "BERTHED") pay(i, `${i.debtor} (simulated)`);
    else if (i.state === "PAID") agentSettle(i);
  }
}

type Seed = [vessel: string, route: string, debtor: string, owner: string, face: number, term: number, target: PState, voyagePct?: number];

export function seedSamples(u: User): void {
  const me = u.company || u.name;
  const sample = (s: Seed, opts: { owner: boolean; debtor: boolean; investorIsMe?: boolean; simInvestor?: boolean }) => {
    const [vessel, route, debtor, owner, face, term, target, pct] = s;
    const i = create({
      vessel,
      route,
      debtor: opts.debtor ? me : debtor,
      debtorEmail: opts.debtor ? u.email : null,
      ownerId: opts.owner ? u.id : null,
      ownerName: opts.owner ? me : owner,
      face,
      term,
      sampleFor: u.id,
      simInvestor: opts.simInvestor ?? false,
      simDebtor: !opts.debtor,
    });
    if (target !== "TOKENIZED") {
      fastForward(i, target, opts.investorIsMe ? u.name : "A simulated investor");
      if (opts.investorIsMe) i.funderId = u.id;
    }
    if (target === "IN_TRANSIT" && pct) i.stateAt = Date.now() - Math.floor(VOYAGE_MS * pct);
  };
  // Created oldest-last so the newest-first list matches the intended order.
  if (u.role === "Shipowner") {
    sample(["MV Archipelago Star", "Manila to Davao", "Isla Beverages Corp.", "", 1_500_000, 90, "SETTLED"], { owner: true, debtor: false });
    sample(["MV Mindanao Express", "Cebu to Cagayan de Oro", "Isla Beverages Corp.", "", 750_000, 45, "IN_TRANSIT", 0.55], { owner: true, debtor: false });
    sample(["MV VisMin Pioneer", "Manila to Cebu", "Isla Beverages Corp.", "", 1_000_000, 60, "TOKENIZED"], { owner: true, debtor: false, simInvestor: true });
  } else if (u.role === "Investor") {
    sample(["MV Archipelago Star", "Manila to Davao", "Isla Beverages Corp.", "Archipelago Marine", 1_500_000, 90, "SETTLED"], { owner: false, debtor: false, investorIsMe: true });
    sample(["MV VisMin Pioneer", "Manila to Cebu", "Isla Beverages Corp.", "Visayan Lines", 1_000_000, 60, "IN_TRANSIT", 0.55], { owner: false, debtor: false, investorIsMe: true });
    sample(["MV Dapitan Express", "Manila to Dumaguete", "Northern Foods Inc.", "Dapitan Marine", 1_200_000, 60, "TOKENIZED"], { owner: false, debtor: false });
    sample(["MV Samar Star", "Cebu to Tacloban", "Isla Beverages Corp.", "Samar Shipping", 600_000, 30, "TOKENIZED"], { owner: false, debtor: false });
    sample(["MV Bisaya Trader", "Manila to Iloilo", "Northern Foods Inc.", "Bisaya Lines", 900_000, 45, "TOKENIZED"], { owner: false, debtor: false });
  } else {
    sample(["MV Archipelago Star", "Manila to Davao", "", "Archipelago Marine", 1_500_000, 90, "SETTLED"], { owner: false, debtor: true });
    sample(["MV VisMin Pioneer", "Manila to Cebu", "", "Visayan Lines", 1_000_000, 60, "BERTHED"], { owner: false, debtor: true });
    sample(["MV Mindanao Express", "Cebu to Cagayan de Oro", "", "Mindanao Lines", 750_000, 45, "IN_TRANSIT", 0.55], { owner: false, debtor: true });
  }
  save();
}

// ---------- views ----------
function visible(i: PortalInvoice, u: User): boolean {
  if (i.sampleFor && i.sampleFor !== u.id) return false;
  if (u.role === "Shipowner") return i.ownerId === u.id;
  if (u.role === "Cargo owner") return i.debtorEmail === u.email;
  if (i.funderId === u.id) return true;
  // On-chain invoices are listed once their registration has landed.
  return i.state === "TOKENIZED" && !i.funderName && !i.simInvestor && i.ownerId !== u.id && (!i.chain || i.chain.registered);
}

export interface InvoiceView {
  id: string;
  hash: string;
  vessel: string;
  route: string;
  port: string;
  debtor: string;
  debtorEmail: string | null;
  owner: string;
  funder: string | null;
  face: number;
  term: number;
  state: PState;
  holdFrom: PState | null;
  prog: number;
  escrow: number;
  m: Money;
  funded: boolean;
  sample: boolean;
  simInvestor: boolean;
  simDebtor: boolean;
  log: LogEntry[];
  onchain: boolean;
  /** What the chain is doing right now, for a progress note. */
  chainBusy: string | null;
  chainError: string | null;
  canRetry: boolean;
  /** On hold by the agent's judgment: the parties can ask it to look again. */
  agentHold: boolean;
  txs: { label: string; hash: string; url: string; at: string }[];
  /** Velo checkout to open, for the cargo owner, while the payment is outstanding. */
  checkoutUrl: string | null;
  paymentPending: boolean;
}

function progress(i: PortalInvoice, now: number): number {
  const k = ORDER.indexOf(i.state === "HOLD" ? (i.holdFrom ?? "TOKENIZED") : i.state);
  if (k >= ORDER.indexOf("BERTHED")) return 100;
  if (i.state === "IN_TRANSIT") return Math.min(99, Math.max(0, Math.floor(((now - voyageStart(i)) / VOYAGE_MS) * 100)));
  return 0;
}

function view(i: PortalInvoice, u: User, now: number): InvoiceView {
  return {
    id: i.id,
    hash: i.hash,
    vessel: i.vessel,
    route: i.route,
    port: i.port,
    debtor: i.debtor,
    debtorEmail: u.role === "Shipowner" ? i.debtorEmail : null,
    owner: i.ownerName,
    funder: i.funderName,
    face: i.face,
    term: i.term,
    state: i.state,
    holdFrom: i.holdFrom,
    prog: progress(i, now),
    escrow: escrowOf(i),
    m: money(i.face),
    funded: u.role === "Investor" ? i.funderId === u.id : Boolean(i.funderName),
    sample: Boolean(i.sampleFor),
    simInvestor: i.simInvestor,
    simDebtor: i.simDebtor,
    log: i.log,
    onchain: !!i.chain,
    chainBusy: i.chain ? (jobRunning(i, now) && i.chain.job ? STEP_LABEL[i.chain.job.step] : jobFor(i) && !i.chain.error ? STEP_LABEL[jobFor(i)!] : null) : null,
    chainError: i.chain?.error ?? null,
    canRetry: needsRetry(i),
    agentHold: isAgentHold(i),
    txs: (i.chain?.txs ?? []).map((t) => ({ label: t.label, hash: t.hash, url: t.url, at: t.at })),
    checkoutUrl: u.role === "Cargo owner" && i.chain?.checkout?.url && !i.chain.payment ? i.chain.checkout.url : null,
    paymentPending: !!i.chain?.checkout && !i.chain.payment,
  };
}

export function portalFor(u: User): { invoices: InvoiceView[]; voyageMs: number; velo: boolean } {
  const now = Date.now();
  const invoices = db.invoices
    .filter((i) => visible(i, u))
    .sort((a, b) => b.seq - a.seq)
    .map((i) => view(i, u, now));
  return { invoices, voyageMs: VOYAGE_MS, velo: veloCheckoutConfigured() };
}

function find(u: User, id: unknown): PortalInvoice {
  const i = db.invoices.find((x) => x.id === id);
  if (!i || !visible(i, u)) throw new HttpError(404, "Invoice not found.");
  return i;
}

// ---------- user actions ----------
export function createInvoice(u: User, b: Record<string, unknown>): InvoiceView {
  if (u.role !== "Shipowner") throw new HttpError(403, "Only shipowners can tokenize invoices.");
  const text = (v: unknown, label: string, max: number) => {
    const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
    if (!s) throw new HttpError(400, `Enter the ${label}.`);
    if (s.length > max) throw new HttpError(400, `The ${label} is too long.`);
    return s;
  };
  const vessel = text(b.vessel, "vessel", 80);
  const route = text(b.route, "route", 120);
  if (!/^.+\s+to\s+.+$/i.test(route)) throw new HttpError(400, 'Write the route like "Manila to Cebu".');
  const debtor = text(b.debtor, "cargo owner", 120);
  const debtorEmail = typeof b.debtorEmail === "string" && b.debtorEmail.trim() ? normEmail(b.debtorEmail) : null;
  if (debtorEmail === u.email) throw new HttpError(400, "The cargo owner must be a different account.");
  const face = Number(b.face);
  const onchain = chainAvailable();
  const maxFace = onchain ? MAX_ONCHAIN_FACE : 100_000_000;
  if (!Number.isSafeInteger(face) || face < 10_000 || face > maxFace)
    throw new HttpError(400, `Enter an invoice value between ₱10,000 and ${peso(maxFace)} in whole pesos${onchain ? " (Stellar Testnet limit)" : ""}.`);
  const term = Number(b.term);
  if (!TERMS.includes(term)) throw new HttpError(400, "Choose Net-30, Net-45, Net-60 or Net-90.");
  const open = db.invoices.filter((i) => i.ownerId === u.id && !i.sampleFor && i.state !== "SETTLED").length;
  if (open >= MAX_OPEN_PER_USER) throw new HttpError(429, "You have too many open invoices.");
  const i = create({ vessel, route, debtor, debtorEmail, ownerId: u.id, ownerName: u.company || u.name, face, term, onchain });
  save();
  return view(i, u, Date.now());
}

export function fundInvoice(u: User, id: unknown): InvoiceView {
  if (u.role !== "Investor") throw new HttpError(403, "Only investors can fund invoices.");
  const i = find(u, id);
  if (i.state !== "TOKENIZED" || i.funderName) throw new HttpError(409, "This invoice has already been funded.");
  if (i.chain) {
    // Reserve it for this investor; the funding transaction runs from their wallet in a chain job.
    if (!i.chain.registered) throw new HttpError(409, "This invoice is still being registered on Stellar. Try again in a moment.");
    i.funderId = u.id;
    i.funderName = u.company || u.name;
    i.chain.fundRequest = { userId: u.id, at: Date.now() };
    log(i, { title: "Funding requested", text: `${i.funderName} is funding ${peso(money(i.face).adv)} from their Stellar Testnet wallet.`, c: "payment_escrow", onchain: true });
  } else fund(i, u.id, u.company || u.name);
  save();
  return view(i, u, Date.now());
}

export type PayPlan =
  | { kind: "done"; view: InvoiceView }
  | { kind: "checkout"; invoiceId: string; amountXlm: string; description: string }
  | { kind: "existing"; view: InvoiceView; checkoutId: string; invoiceId: string; amountXlm: string; description: string };

/** First half of paying (under the db lock). Simulated invoices are paid at once; on-chain ones need a Velo checkout. */
export function preparePay(u: User, id: unknown): PayPlan {
  if (u.role !== "Cargo owner") throw new HttpError(403, "Only the cargo owner can pay this invoice.");
  const i = find(u, id);
  if (i.state !== "BERTHED") throw new HttpError(409, i.state === "IN_TRANSIT" ? "The vessel has not arrived yet." : "This invoice is not awaiting payment.");
  if (!i.chain) {
    pay(i, u.company || u.name);
    save();
    return { kind: "done", view: view(i, u, Date.now()) };
  }
  if (i.chain.payment?.verified) return { kind: "done", view: view(i, u, Date.now()) };
  const amountXlm = fromStroops(phpToStroops(BigInt(i.face)));
  const description = `Freight invoice ${i.id}: ${i.vessel}, ${i.route}`;
  // A real checkout already exists: the caller asks Velo whether it was paid or expired before reusing it.
  if (i.chain.checkout && !i.chain.checkout.simulated && i.chain.checkout.url) {
    return { kind: "existing", view: view(i, u, Date.now()), checkoutId: i.chain.checkout.id, invoiceId: i.id, amountXlm, description };
  }
  return { kind: "checkout", invoiceId: i.id, amountXlm, description };
}

/**
 * Velo says this invoice's checkout is paid, but no webhook was applied (lost or delayed): record it from the
 * payment status, as PRD §8.4 asks. A webhook arriving later is a duplicate and changes nothing.
 */
export function recordPolledPayment(u: User, id: unknown, checkoutId: string, ev: VerifiedEvent): InvoiceView {
  const i = find(u, id);
  if (i.chain?.checkout?.id === checkoutId && !i.chain.payment?.verified) {
    log(i, { title: "Payment confirmed with Velo", text: `No webhook had arrived, so Sailo asked Velo directly: checkout ${checkoutId} is paid.`, c: "payment_escrow" });
    recordPayment(checkoutId, ev, false);
  }
  save();
  return view(i, u, Date.now());
}

/** Second half (under the db lock again): store the checkout and, for a simulated one, its verified payment. */
export function recordCheckout(u: User, id: unknown, session: CheckoutSession, ev: VerifiedEvent | null, replaces?: string): InvoiceView {
  const i = find(u, id);
  if (!i.chain) throw new HttpError(409, "This invoice is not on Stellar.");
  if (!i.chain.payment?.verified) {
    // replaces: an expired or cancelled checkout this one takes over from (only if it is still the current one).
    if (!i.chain.checkout || i.chain.checkout.simulated || (replaces && i.chain.checkout.id === replaces)) {
      i.chain.checkout = { id: session.id, url: session.checkoutUrl, simulated: session.simulated, amountXlm: session.amount, createdAt: new Date().toISOString() };
    }
    if (ev) recordPayment(session.id, ev, true);
    else log(i, { title: "Velo checkout opened", text: `Checkout ${session.id} for ${session.amount} XLM. Settlement starts when Velo confirms the payment.`, c: "payment_escrow" });
  }
  save();
  return view(i, u, Date.now());
}

/** Lets a party to the invoice re-run a chain step that failed three times. */
export function retryInvoice(u: User, id: unknown): InvoiceView {
  const i = find(u, id);
  if (!needsRetry(i)) throw new HttpError(409, "Nothing to retry.");
  const held = isAgentHold(i);
  resetRetry(i);
  const step = jobFor(i);
  log(i, {
    title: held ? "Asked the agent again" : "Retrying",
    text: held ? `${u.company || u.name} asked the agent to look at this invoice again. It decides on the same evidence and may hold again.` : `${u.company || u.name} asked to retry${step ? `: ${STEP_LABEL[step]}` : ""}.`,
    c: "payment_escrow",
    onchain: true,
  });
  save();
  return view(i, u, Date.now());
}
