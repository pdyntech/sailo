import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computePayouts, toStroops } from "@noirxvelo/shared";
import type Anthropic from "@anthropic-ai/sdk";
import { HARD_LIMITS, askGemini, askModel, decide, llmProvider, propose, type Facts, type ModelVerdict } from "./agent.js";

const V = toStroops("1000");
const P = computePayouts(V);
const funded: Facts = { invoiceId: "INV-2026-001", faceValue: V, status: "FUNDED", escrowFunded: true, vesselUnderway: true, berthed: false, paymentVerified: false, paymentAmountMatches: false, vessel: "MV T", port: "Port of Cebu" };
const paid: Facts = { ...funded, status: "PAID", berthed: true, paymentVerified: true, paymentAmountMatches: true, signals: { aisGapHours: 7.7, aisIntervalHours: 1.9, offRouteKm: 13.9 } };
const verdict = (v: ModelVerdict) => vi.fn(async () => v);

beforeEach(() => {
  delete process.env.LLM_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_PROVIDER;
  delete process.env.GEMINI_API_KEY;
});
afterEach(() => vi.restoreAllMocks());

describe("rules: what is permitted", () => {
  it("permits the advance once funded and under way, with code-computed amounts", () => {
    const r = propose(funded)!;
    expect(r.decision.decision).toBe("ADVANCE");
    expect(r.decision.payouts).toEqual([{ role: "SHIPOWNER", amountStroops: P.advance.toString() }]);
    expect(propose({ ...funded, vesselUnderway: false })).toBeNull();
  });
  it("holds on hard limits, and an ops review lifts them", () => {
    const dark = { ...paid, signals: { aisGapHours: HARD_LIMITS.aisGapHours + 1, aisIntervalHours: 1.9, offRouteKm: 0 } };
    expect(propose(dark)).toMatchObject({ decision: { decision: "HOLD" }, reviewable: true });
    expect(propose({ ...dark, opsReview: { at: "t", note: "checked" } })!.decision.decision).toBe("SETTLE");
    expect(propose({ ...paid, signals: { aisGapHours: 1.9, aisIntervalHours: 1.9, offRouteKm: HARD_LIMITS.offRouteKm + 1 } })!.decision.decision).toBe("HOLD");
  });
  it("a missing check is a hold no review can release", () => {
    expect(propose({ ...paid, paymentAmountMatches: false })).toMatchObject({ decision: { decision: "HOLD" }, reviewable: false });
  });
});

describe("the agent: the model decides within what the rules permit", () => {
  it("without a key, the rules decide", async () => {
    const ask = verdict({ decision: "HOLD", reason: "x", risks: [] });
    const p = (await decide(paid, ask))!;
    expect(p).toMatchObject({ engine: "rules", decision: { decision: "SETTLE" } });
    expect(ask).not.toHaveBeenCalled();
  });

  it("PROCEED keeps the code's payouts and uses the model's reason", async () => {
    process.env.LLM_API_KEY = "test";
    const p = (await decide(paid, verdict({ decision: "PROCEED", reason: "Track consistent.", risks: [] })))!;
    expect(p.engine).toBe("claude-opus-5-5");
    expect(p.decision.decision).toBe("SETTLE");
    expect(p.decision.reason).toBe("Track consistent.");
    expect(p.decision.payouts).toEqual(propose(paid)!.decision.payouts);
  });

  it("HOLD moves nothing and is reviewable", async () => {
    process.env.LLM_API_KEY = "test";
    const p = (await decide(paid, verdict({ decision: "HOLD", reason: "AIS dark 7.7 h, reappeared 14 km off the lane.", risks: ["possible transshipment"] })))!;
    expect(p).toMatchObject({ reviewable: true, risks: ["possible transshipment"], decision: { decision: "HOLD", payouts: [] } });
  });

  it("never asks the model when the rules hold: it can only decline a payout, never approve one", async () => {
    process.env.LLM_API_KEY = "test";
    const ask = verdict({ decision: "PROCEED", reason: "pay", risks: [] });
    expect((await decide({ ...paid, paymentVerified: false }, ask))!.decision.decision).toBe("HOLD");
    expect(ask).not.toHaveBeenCalled();
  });

  it("falls back to the rules when the model is unavailable", async () => {
    process.env.LLM_API_KEY = "test";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = (await decide(funded, vi.fn(async () => { throw new Error("timeout"); })))!;
    expect(p.engine).toBe("rules (model unavailable: timeout)");
    expect(p.decision.decision).toBe("ADVANCE");
  });
});

describe("the model call", () => {
  const fake = (res: unknown) => {
    const create = vi.fn(async () => res);
    return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
  };
  const answer = (o: unknown, stop_reason = "end_turn") => ({ stop_reason, content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(o) }] });
  const permitted = propose(paid)!.decision;

  it("asks for a schema-checked verdict, with refusal fallbacks, and returns it", async () => {
    const { client, create } = fake(answer({ decision: "HOLD", reason: "  Gap and offset.  ", risks: ["spoofing"] }));
    expect(await askModel(client, paid, permitted)).toEqual({ decision: "HOLD", reason: "Gap and offset.", risks: ["spoofing"] });
    const req = (create.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.fallbacks).toBe("default");
    expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(req.output_config.format.type).toBe("json_schema");
    const evidence = JSON.parse(req.messages[0].content);
    expect(evidence.voyage.longestHoursWithoutAis).toBe(7.7);
    expect(evidence.permittedPayout.decision).toBe("SETTLE");
  });

  it("sends no fallbacks for a model that has none", async () => {
    process.env.LLM_MODEL = "claude-haiku-5-5";
    const { client, create } = fake(answer({ decision: "PROCEED", reason: "ok", risks: [] }));
    await askModel(client, paid, permitted);
    const req = (create.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(req.fallbacks).toBeUndefined();
    expect(req.betas).toBeUndefined();
  });

  it("rejects refusals, cut-off answers and answers off the schema", async () => {
    await expect(askModel(fake(answer({}, "refusal")).client, paid, permitted)).rejects.toThrow("declined");
    await expect(askModel(fake(answer({}, "max_tokens")).client, paid, permitted)).rejects.toThrow("cut off");
    await expect(askModel(fake(answer({ decision: "PAY", reason: "x", risks: [] })).client, paid, permitted)).rejects.toThrow("schema");
    await expect(askModel(fake(answer({ decision: "PROCEED", reason: " ", risks: [] })).client, paid, permitted)).rejects.toThrow("schema");
  });
});

describe("Gemini", () => {
  const permitted = propose(paid)!.decision;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const said = (o: unknown, finishReason = "STOP") => ({ candidates: [{ finishReason, content: { parts: [{ text: "thinking", thought: true }, { text: JSON.stringify(o) }] } }] });

  it("picks the provider from the key, or LLM_PROVIDER", () => {
    expect(llmProvider()).toBeNull();
    process.env.LLM_API_KEY = "AIzaTest";
    expect(llmProvider()).toBe("gemini");
    process.env.LLM_API_KEY = "sk-ant-test";
    expect(llmProvider()).toBe("anthropic");
    process.env.LLM_PROVIDER = "gemini";
    expect(llmProvider()).toBe("gemini");
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_PROVIDER;
    process.env.GEMINI_API_KEY = "x";
    expect(llmProvider()).toBe("gemini");
  });

  it("asks for a schema-checked verdict and returns it", async () => {
    process.env.LLM_API_KEY = "AIzaTest";
    const fetchFn = vi.fn(async () => reply(said({ decision: "HOLD", reason: " Gap. ", risks: ["spoofing"] })));
    expect(await askGemini("AIzaTest", paid, permitted, fetchFn as unknown as typeof fetch)).toEqual({ decision: "HOLD", reason: "Gap.", risks: ["spoofing"] });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIzaTest");
    const req = JSON.parse(init.body as string);
    expect(req.generationConfig.responseMimeType).toBe("application/json");
    expect(req.generationConfig.responseSchema.properties.decision.enum).toEqual(["PROCEED", "HOLD"]);
    expect(JSON.parse(req.contents[0].parts[0].text).permittedPayout.decision).toBe("SETTLE");
  });

  it("retries once on a server error, then reports the status", async () => {
    const fetchFn = vi.fn(async () => reply({}, 503));
    await expect(askGemini("k", paid, permitted, fetchFn as unknown as typeof fetch)).rejects.toThrow("API 503");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await expect(askGemini("k", paid, permitted, (async () => reply({}, 400)) as unknown as typeof fetch)).rejects.toThrow("API 400");
  });

  it("rejects blocked, cut-off and off-schema answers", async () => {
    const ask = (body: unknown) => askGemini("k", paid, permitted, (async () => reply(body)) as unknown as typeof fetch);
    await expect(ask({ promptFeedback: { blockReason: "SAFETY" } })).rejects.toThrow("declined");
    await expect(ask(said({}, "SAFETY"))).rejects.toThrow("declined");
    await expect(ask(said({}, "MAX_TOKENS"))).rejects.toThrow("cut off");
    await expect(ask(said({ decision: "PAY", reason: "x", risks: [] }))).rejects.toThrow("schema");
    await expect(ask({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not json" }] } }] })).rejects.toThrow("schema");
  });

  it("decide() names the Gemini model as the engine", async () => {
    process.env.LLM_API_KEY = "AIzaTest";
    const p = (await decide(paid, vi.fn(async () => ({ decision: "PROCEED" as const, reason: "ok", risks: [] }))))!;
    expect(p.engine).toBe("gemini-flash-latest");
  });
});
