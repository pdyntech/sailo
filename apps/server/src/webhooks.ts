/**
 * POST /api/webhooks/velo: verify the signature (raw body), skip deliveries already handled, then route the
 * payment.succeeded to the portal invoice or the demo run whose checkout it belongs to.
 * A delivery is marked handled only after it was applied, so a failure lets Velo's retry through.
 */
import * as demo from "./demo.js";
import { withDb } from "./db.js";
import { env } from "./env.js";
import { getRaw, kvEnabled, setNx } from "./kv.js";
import { dueJobs, recordPayment, startJobs } from "./portal-chain.js";
import { WebhookRejected, retrievePaymentStatus, verifyWebhook, type VerifiedEvent } from "./velo.js";

const seenLocal = new Set<string>();
const WEEK_MS = 7 * 86_400_000;

async function seen(id: string): Promise<boolean> {
  if (!kvEnabled()) return seenLocal.has(id);
  return (await getRaw(`velo:delivery:${id}`)) !== null;
}
async function markSeen(id: string): Promise<void> {
  if (!kvEnabled()) seenLocal.add(id);
  else await setNx(`velo:delivery:${id}`, "1", WEEK_MS);
}

export async function handleVeloWebhook(raw: string, signature: string | null, deliveryId: string | null): Promise<{ status: number; body: unknown }> {
  let ev: VerifiedEvent;
  try {
    ev = await verifyWebhook(raw, signature);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("velo webhook rejected:", msg);
    return { status: e instanceof WebhookRejected ? e.status : 400, body: { ok: false, error: msg } };
  }
  const id = deliveryId ?? ev.id;
  if (id && (await seen(id))) return { status: 200, body: { ok: true, duplicate: true } };
  if (ev.type !== "payment.succeeded" || !ev.paymentIntent) {
    if (id) await markSeen(id);
    return { status: 200, body: { ok: true, ignored: ev.type } };
  }
  const piId = ev.paymentIntent.id;
  // Ask Velo directly before moving money: the signed webhook says "paid", the payment intent must agree.
  let status: Awaited<ReturnType<typeof retrievePaymentStatus>>;
  try {
    status = await retrievePaymentStatus(piId);
  } catch (e) {
    console.warn("velo payment status lookup failed:", e instanceof Error ? e.message : e);
    return { status: 503, body: { ok: false, error: "payment status unavailable, retry" } };
  }
  if (status) {
    if (status.status !== "paid") return { status: 409, body: { ok: false, error: `payment intent is ${status.status}, not paid` } };
    const asset = env("VELO_CHECKOUT_ASSET") ?? "native";
    if (status.asset !== asset) return { status: 409, body: { ok: false, error: `paid in ${status.asset}, expected ${asset}` } };
    // Velo's record wins over the webhook body for amount and asset.
    ev = { ...ev, paymentIntent: { ...ev.paymentIntent, amount: status.amount, asset: status.asset } };
  }
  const portal = await withDb(() => ({ matched: recordPayment(piId, ev, false), due: dueJobs() }));
  let result: { status: number; body: unknown };
  if (portal.matched) {
    startJobs(portal.due);
    result = { status: 200, body: { ok: true, invoice: "portal" } };
  } else {
    try {
      result = await demo.withDemo(() => demo.applyPayment(ev, false));
    } catch (e) {
      // The demo is mid-step on another server: ask Velo to retry shortly.
      if (e instanceof demo.BusyElsewhere) return { status: 503, body: { ok: false, error: "busy, retry" } };
      throw e;
    }
  }
  if (id && result.status === 200) await markSeen(id);
  return result;
}
