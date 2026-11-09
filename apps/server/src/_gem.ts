import { readFileSync } from "node:fs";
import { toStroops } from "@noirxvelo/shared";
process.env.LLM_API_KEY = readFileSync("../../.env.local", "utf8").match(/^LLM_API_KEY=(.*)$/m)![1]!.trim();
process.env.LLM_MODEL = process.argv[2]!;
const { decide } = await import("./agent.ts");
const base = { invoiceId: "INV-T", faceValue: toStroops("1000"), status: "PAID", escrowFunded: true, vesselUnderway: true, berthed: true, paymentVerified: true, paymentAmountMatches: true, vessel: "MV Test", port: "Port of Cebu" };
const dark = { aisGapHours: 7.7, aisIntervalHours: 1.9, offRouteKm: 13.9 };
const cases = [
  ["normal", { ...base, signals: { aisGapHours: 1.9, aisIntervalHours: 1.9, offRouteKm: 0.4 } }],
  ["one-missed", { ...base, signals: { aisGapHours: 3.8, aisIntervalHours: 1.9, offRouteKm: 1.2 } }],
  ["ais-dark", { ...base, signals: dark }],
  ["ais-dark again", { ...base, signals: dark }],
  ["ais-dark + ops review", { ...base, signals: dark, opsReview: { at: "2026-11-09T10:00:00Z", note: "Called the master: AIS transponder fuse failed; port agent confirmed seals intact on arrival." } }],
  ["advance", { ...base, status: "FUNDED", berthed: false, paymentVerified: false, paymentAmountMatches: false, signals: { aisGapHours: 1.9, aisIntervalHours: 1.9, offRouteKm: 0.2 } }],
] as const;
for (const [name, f] of cases) {
  const t = Date.now();
  const p = await decide(f as never);
  console.log(`${name} (${((Date.now() - t) / 1000).toFixed(1)}s) -> ${p!.engine} ${p!.decision.decision} | ${p!.decision.reason} | ${JSON.stringify(p!.risks)}`);
}
