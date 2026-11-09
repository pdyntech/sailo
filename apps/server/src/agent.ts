/**
 * AGT-01: the settlement agent.
 *
 * Two layers, so the agent can use judgment without ever paying outside the rules:
 *   1. Rules (code) decide what is permitted: the gates (escrow, AIS under way, verified payment for the exact
 *      amount, berthing attestation) and the hard limits (AIS dark > 12 h, > 50 km off the sea lane). Amounts
 *      always come from computePayouts.
 *   2. When a payout is permitted and a model is configured (LLM_API_KEY: a Claude or Gemini key), the model decides
 *      whether to PROCEED with it now or HOLD it for ops review, weighing evidence the rules don't judge (an AIS
 *      gap below the hard limit, the vessel reappearing off the lane, an ops review note). It can always decline
 *      to pay; it can never pay what the rules don't permit, and it never sets amounts or payees.
 * If the model is unavailable, the rules decide and the record says so. The executor in @noirxvelo/agent then
 * re-validates everything before any chain call, and Noir's policy caps every payment on-chain.
 */
import Anthropic from "@anthropic-ai/sdk";
import { computePayouts, fromStroops } from "@noirxvelo/shared";
import type { AgentDecision } from "@noirxvelo/agent";
import { env } from "./env.js";

/** Voyage evidence the rules only check against hard limits. */
export interface RiskSignals {
  /** Longest interval between two AIS readings, in voyage hours. */
  aisGapHours: number;
  /** Normal interval between readings, in voyage hours. */
  aisIntervalHours: number;
  /** Farthest any reading was from the planned sea lane, in km. */
  offRouteKm: number;
}

export interface OpsReview {
  at: string;
  note: string;
}

export interface Facts {
  invoiceId: string;
  faceValue: bigint;
  status: string;
  escrowFunded: boolean;
  vesselUnderway: boolean;
  berthed: boolean;
  paymentVerified: boolean;
  paymentAmountMatches: boolean;
  vessel: string;
  port: string;
  signals?: RiskSignals;
  /** Plain description of the voyage evidence when there is no plotted track (portal routes have no sea lane). */
  voyageNote?: string;
  /** An ops review that cleared an earlier hold on this invoice. */
  opsReview?: OpsReview | null;
}

export interface Proposal {
  decision: AgentDecision;
  /** Who made the call: the model id, "rules", or "rules (model unavailable: …)". */
  engine: string;
  /** True for a hold an ops review may release (a judgment or hard-limit hold, not a missing gate). */
  reviewable: boolean;
  /** Concerns the model listed, if it decided. */
  risks: string[];
}

/** PRD §8.1: IN_TRANSIT -> HOLD on AIS dark > 12 h or a deviation. Ops can clear these after review. */
export const HARD_LIMITS = { aisGapHours: 12, offRouteKm: 50 };

const xlm = (s: bigint) => `${fromStroops(s)} XLM`;

/** The rules: what is permitted right now. Returns null when there is nothing to decide yet. */
export function propose(f: Facts): { decision: AgentDecision; reviewable: boolean } | null {
  const p = computePayouts(f.faceValue);
  const hold = (reason: string, reviewable: boolean) => ({ decision: { invoiceId: f.invoiceId, decision: "HOLD" as const, reason, payouts: [] }, reviewable });
  let pay: AgentDecision | null = null;
  if (f.status === "FUNDED" && f.escrowFunded && f.vesselUnderway) {
    pay = {
      invoiceId: f.invoiceId,
      decision: "ADVANCE",
      reason: `Waybill hash registered and ${f.vessel} is underway. Releasing the 85% advance (${xlm(p.advance)}) to the shipowner for bunker fuel and port dues.`,
      payouts: [{ role: "SHIPOWNER", amountStroops: p.advance.toString() }],
    };
  } else if (f.status === "PAID") {
    if (!f.berthed) return hold("Payment received but no berthing attestation yet; holding settlement.", false);
    if (!f.paymentVerified || !f.paymentAmountMatches) return hold("Payment not verified or amount does not match the invoice; holding settlement.", false);
    pay = {
      invoiceId: f.invoiceId,
      decision: "SETTLE",
      reason: `Berthing at ${f.port} attested and the debtor's ${xlm(f.faceValue)} Velo payment is verified. Repaying the LP ${xlm(p.lpRepayment)}, rebating ${xlm(p.rebate)} to the shipowner and ${xlm(p.fee)} to treasury.`,
      payouts: [
        { role: "LP", amountStroops: p.lpRepayment.toString() },
        { role: "SHIPOWNER", amountStroops: p.rebate.toString() },
        { role: "TREASURY", amountStroops: p.fee.toString() },
      ],
    };
  }
  if (!pay) return null;
  const s = f.signals;
  if (s && !f.opsReview) {
    if (s.aisGapHours > HARD_LIMITS.aisGapHours) return hold(`AIS was dark for ${s.aisGapHours.toFixed(1)} h (limit ${HARD_LIMITS.aisGapHours} h); holding the ${pay.decision} for ops review.`, true);
    if (s.offRouteKm > HARD_LIMITS.offRouteKm) return hold(`The vessel was ${s.offRouteKm.toFixed(0)} km off the sea lane (limit ${HARD_LIMITS.offRouteKm} km); holding the ${pay.decision} for ops review.`, true);
  }
  return { decision: pay, reviewable: false };
}

// ---------- the model ----------
// Claude (Anthropic SDK) or Gemini (Google's REST API). LLM_PROVIDER picks one; otherwise a Claude key (sk-ant-…) or
// ANTHROPIC_API_KEY means Claude and any other key (Google's AIza… or AQ.…) means Gemini.
type Provider = "anthropic" | "gemini";
const apiKey = () => env("LLM_API_KEY") ?? env("ANTHROPIC_API_KEY") ?? env("GEMINI_API_KEY");
export function llmProvider(): Provider | null {
  const key = apiKey();
  if (!key) return null;
  const p = env("LLM_PROVIDER")?.toLowerCase();
  if (p === "gemini" || p === "google") return "gemini";
  if (p === "anthropic" || p === "claude") return "anthropic";
  const k = env("LLM_API_KEY");
  return (k ? k.startsWith("sk-ant-") : !!env("ANTHROPIC_API_KEY")) ? "anthropic" : "gemini";
}
const MODEL = () => env("LLM_MODEL") ?? (llmProvider() === "gemini" ? "gemini-3.5-flash" : "claude-opus-5-5");
/** Server-side refusal fallbacks are available for these models only. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export const llmConfigured = (): boolean => !!llmProvider();

let client: Anthropic | null = null;
let clientKey: string | undefined;
function getClient(key: string): Anthropic {
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key, timeout: 30_000, maxRetries: 1 });
    clientKey = key;
  }
  return client;
}

const SYSTEM = `You are the settlement agent for Sailo, which advances freight invoices for Philippine inter-island shipping lines. An investor's money sits in an on-chain escrow for each invoice; you decide when it is paid out.

Code has already checked the hard rules and found that the payout in the request is permitted: the escrow is funded, the amounts are computed and within the on-chain cap, and for a settlement the cargo owner's payment is verified for the exact amount and arrival at the port is attested. Your job is the judgment those rules can't make: PROCEED with the payout now, or HOLD it for a human ops review.

Hold when the voyage or payment evidence is inconsistent in a way that matters for the investor's money. AIS going dark for hours mid-voyage, or the vessel reappearing away from the expected sea lane, can mean a transshipment, a cargo swap or spoofed positions; that is what an arrival attestation can't rule out on its own. Readings arrive at a normal interval. One missed reading, or a track within a couple of km of the lane, is ordinary. A blackout of several intervals together with the vessel turning up well off the lane is the signature of a ship-to-ship transfer or spoofing, even though each figure is below its hard limit: the hard limits are where code holds automatically, not a line below which the evidence is fine. Proceed when the evidence is consistent. If an ops review cleared an earlier hold, weigh their note: it means a person checked the concern.

You can't change amounts or payees, and holding moves no money. Write "reason" in one or two plain sentences for the ops dashboard, under 240 characters, naming the facts you relied on. List concrete concerns in "risks" (empty if there are none).`;

const SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["PROCEED", "HOLD"] },
    reason: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
  },
  required: ["decision", "reason", "risks"],
  additionalProperties: false,
};

export interface ModelVerdict {
  decision: "PROCEED" | "HOLD";
  reason: string;
  risks: string[];
  /** The model that answered, when it was a fallback rather than LLM_MODEL. */
  model?: string;
}

/** What the model sees: the permitted payout and the evidence, in plain units. */
function evidence(f: Facts, permitted: AgentDecision): Record<string, unknown> {
  return {
    invoice: { id: f.invoiceId, vessel: f.vessel, destination: f.port, faceValue: xlm(f.faceValue) },
    permittedPayout: { decision: permitted.decision, payouts: permitted.payouts.map((p) => ({ role: p.role, amount: xlm(BigInt(p.amountStroops)) })) },
    checksPassed: permitted.decision === "ADVANCE" ? ["escrow funded with the advance", "AIS shows the vessel under way"] : ["arrival attested (3 AIS readings at the quay at <= 0.5 kn)", "cargo owner's payment verified for the exact invoice amount"],
    voyage: f.signals
      ? {
          normalHoursBetweenAisReadings: Number(f.signals.aisIntervalHours.toFixed(1)),
          longestHoursWithoutAis: Number(f.signals.aisGapHours.toFixed(1)),
          farthestKmFromSeaLane: Number(f.signals.offRouteKm.toFixed(1)),
          hardLimits: { hoursWithoutAis: HARD_LIMITS.aisGapHours, kmFromSeaLane: HARD_LIMITS.offRouteKm },
        }
      : (f.voyageNote ?? "no AIS track recorded for this decision"),
    opsReview: f.opsReview ?? null,
  };
}

/** Same schema in the OpenAPI subset Gemini's responseSchema takes. */
const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    decision: { type: "STRING", enum: ["PROCEED", "HOLD"] },
    reason: { type: "STRING" },
    risks: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["decision", "reason", "risks"],
  propertyOrdering: ["decision", "reason", "risks"],
};

function parseVerdict(text: string): ModelVerdict {
  let v: Partial<ModelVerdict>;
  try {
    v = JSON.parse(text) as Partial<ModelVerdict>;
  } catch {
    throw new Error("the answer did not match the schema");
  }
  if ((v.decision !== "PROCEED" && v.decision !== "HOLD") || typeof v.reason !== "string" || !v.reason.trim() || !Array.isArray(v.risks)) {
    throw new Error("the answer did not match the schema");
  }
  return { decision: v.decision, reason: v.reason.trim().slice(0, 280), risks: v.risks.filter((r): r is string => typeof r === "string").slice(0, 8) };
}

/** Asks Claude to PROCEED or HOLD. Throws if the model is unavailable or its answer is unusable. */
export async function askModel(c: Anthropic, f: Facts, permitted: AgentDecision): Promise<ModelVerdict> {
  const model = MODEL();
  const res = await c.beta.messages.create({
    model,
    max_tokens: 4000,
    ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(evidence(f, permitted)) }],
  });
  if (res.stop_reason === "refusal") throw new Error("the model declined");
  if (res.stop_reason === "max_tokens") throw new Error("the answer was cut off");
  return parseVerdict(res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""));
}

const GEMINI_BASE = () => env("GEMINI_BASE_URL") ?? "https://generativelanguage.googleapis.com/v1beta";

/**
 * Second model to try when the first is rate-limited (429) or overloaded (5xx). Google limits each model separately,
 * so this keeps the agent deciding on a free-tier key. LLM_FALLBACK_MODEL="" turns it off.
 */
const GEMINI_FALLBACK = () => process.env.LLM_FALLBACK_MODEL?.trim() ?? "gemini-3.5-flash-lite";

/** Asks Gemini to PROCEED or HOLD. Throws if the model is unavailable or its answer is unusable. */
export async function askGemini(key: string, f: Facts, permitted: AgentDecision, fetchFn: typeof fetch = fetch): Promise<ModelVerdict> {
  const models = [...new Set([MODEL(), GEMINI_FALLBACK()].filter(Boolean))];
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(evidence(f, permitted)) }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: GEMINI_SCHEMA, maxOutputTokens: 4000 },
  });
  let res: Response | undefined;
  let model = models[0]!;
  for (const m of models) {
    model = m;
    res = await fetchFn(`${GEMINI_BASE()}/models/${encodeURIComponent(m)}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body, signal: AbortSignal.timeout(25_000) });
    if (res.status !== 429 && res.status < 500) break;
  }
  if (!res!.ok) throw new Error(`API ${res!.status}`);
  const data = (await res!.json()) as {
    promptFeedback?: { blockReason?: string };
    candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  };
  if (data.promptFeedback?.blockReason) throw new Error("the model declined");
  const cand = data.candidates?.[0];
  if (!cand) throw new Error("the model declined");
  if (cand.finishReason === "MAX_TOKENS") throw new Error("the answer was cut off");
  if (cand.finishReason && cand.finishReason !== "STOP") throw new Error("the model declined");
  const v = parseVerdict((cand.content?.parts ?? []).flatMap((p) => (p.thought || !p.text ? [] : [p.text])).join(""));
  return model === MODEL() ? v : { ...v, model };
}

/** The configured model's verdict on a permitted payout. */
export type Ask = (f: Facts, permitted: AgentDecision) => Promise<ModelVerdict>;
const askConfigured: Ask = (f, permitted) => {
  const key = apiKey()!;
  return llmProvider() === "gemini" ? askGemini(key, f, permitted) : askModel(getClient(key), f, permitted);
};

/** The agent's decision: the rules say what is permitted, the model (when configured) decides whether to go ahead. */
export async function decide(f: Facts, ask: Ask = askConfigured): Promise<Proposal | null> {
  const base = propose(f);
  if (!base) return null;
  const rules: Proposal = { decision: base.decision, engine: "rules", reviewable: base.reviewable, risks: [] };
  // A hold from the rules stands: the model may only ever decline a payout, never approve one.
  if (base.decision.decision === "HOLD") return rules;
  if (!llmConfigured()) return rules;
  try {
    const v = await ask(f, base.decision);
    const engine = v.model ?? MODEL();
    if (v.decision === "PROCEED") return { decision: { ...base.decision, reason: v.reason }, engine, reviewable: false, risks: v.risks };
    return { decision: { invoiceId: f.invoiceId, decision: "HOLD", reason: v.reason, payouts: [] }, engine, reviewable: true, risks: v.risks };
  } catch (e) {
    const why = e instanceof Anthropic.APIError ? `API ${e.status ?? "error"}` : e instanceof Error ? e.message : String(e);
    console.warn("agent: model unavailable, rules decide:", why);
    return { ...rules, engine: `rules (model unavailable: ${why.slice(0, 60)})` };
  }
}
