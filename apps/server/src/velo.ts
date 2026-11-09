/**
 * VLO-01 / VLO-02 (demo version): Velo checkout sessions and signed-webhook verification.
 * Call shapes follow docs/spikes.md S4/S6 and the Builder Handbook:
 *   velo.checkout.sessions.create({ amount, asset, description, successUrl, cancelUrl }, { idempotencyKey })
 *   Velo.webhooks.verify({ payload, signature, secret, toleranceSeconds })
 * Header: x-velo-signature = "t=<unix>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>", x-velo-delivery = delivery id.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env.js";

type VeloModule = typeof import("@carts1024/velo-sdk");

let veloModule: VeloModule | null | undefined;
async function loadVelo(): Promise<VeloModule | null> {
  if (veloModule !== undefined) return veloModule;
  try {
    veloModule = await import("@carts1024/velo-sdk");
  } catch {
    veloModule = null;
  }
  return veloModule;
}

/** Secret used to verify Velo webhooks. Without VELO_WEBHOOK_SECRET it is a random per-boot value, so nothing verifies. */
const generatedSecret = randomBytes(32).toString("hex");
export const webhookSecret = (): string => env("VELO_WEBHOOK_SECRET") ?? generatedSecret;
/** Signs and verifies simulated deliveries only. Never the real secret, so a simulated payment can't pass as Velo's. */
const simulatedSecret = randomBytes(32).toString("hex");
export const usingRealWebhookSecret = (): boolean => !!env("VELO_WEBHOOK_SECRET");
export const veloCheckoutConfigured = (): boolean => !!env("VELO_API_KEY");

export interface CheckoutSession {
  id: string;
  checkoutUrl: string | null;
  status: string;
  receiverAddress: string | null;
  simulated: boolean;
  amount: string;
  asset: string;
  createdAt: string;
}

/** Creates a real Velo checkout session when VELO_API_KEY is set; otherwise a clearly marked simulated one. */
export async function createCheckout(o: { invoiceId: string; amountXlm: string; description: string }): Promise<CheckoutSession> {
  const asset = env("VELO_CHECKOUT_ASSET") ?? "native";
  const createdAt = new Date().toISOString();
  const apiKey = env("VELO_API_KEY");
  if (!apiKey) {
    return { id: `pi_sim_${randomBytes(6).toString("hex")}`, checkoutUrl: null, status: "simulated", receiverAddress: null, simulated: true, amount: o.amountXlm, asset, createdAt };
  }
  const mod = await loadVelo();
  if (!mod) throw new Error("@carts1024/velo-sdk is not installed (run npm install)");
  const velo = new mod.Velo({ apiKey, environment: "testnet" } as never);
  const appUrl = env("APP_URL") ?? `http://localhost:${env("PORT") ?? 3000}`;
  // Cast through unknown: alpha SDK types vary between builds; fields below are the documented ones.
  const pi = (await (velo as unknown as { checkout: { sessions: { create: (p: unknown, opt?: unknown) => Promise<Record<string, unknown>> } } }).checkout.sessions.create(
    {
      amount: o.amountXlm,
      asset,
      description: o.description,
      successUrl: `${appUrl}/?paid=${o.invoiceId}`,
      cancelUrl: `${appUrl}/?cancelled=${o.invoiceId}`,
    },
    // One key per request (the SDK reuses it for its own retries). Not per invoice id: demo and portal ids overlap,
    // and a key tied to the id would hand back the same (possibly expired) session when a checkout is renewed.
    { idempotencyKey: `sailo-checkout:${o.invoiceId}:${randomBytes(8).toString("hex")}` },
  )) as Record<string, unknown>;
  const str = (k: string) => (typeof pi[k] === "string" ? (pi[k] as string) : null);
  const id = str("id") ?? str("paymentIntentId");
  if (!id) throw new Error("Velo checkout returned no payment intent id");
  return { id, checkoutUrl: str("checkoutUrl"), status: str("status") ?? "created", receiverAddress: str("receiverAddress"), simulated: false, amount: o.amountXlm, asset, createdAt };
}

export interface PaymentStatus {
  id: string;
  status: string;
  amount: string;
  asset: string;
  /** When the checkout stops accepting payment. Velo keeps the status at "created" after it passes. */
  expiresAt: string | null;
}

/** A checkout that can no longer be paid: closed by Velo, or past its expiry without a payment under way. */
export const checkoutClosed = (s: PaymentStatus, now = Date.now()): boolean =>
  ["expired", "cancelled", "failed"].includes(s.status) || (["created", "awaiting_route"].includes(s.status) && !!s.expiresAt && Date.parse(s.expiresAt) < now);

/**
 * Payment status straight from Velo (`velo.paymentIntents.retrieve`), the source of truth for whether a
 * checkout is paid. Returns null when there is no VELO_API_KEY (simulated checkouts have no real intent).
 */
export async function retrievePaymentStatus(paymentIntentId: string): Promise<PaymentStatus | null> {
  const apiKey = env("VELO_API_KEY");
  if (!apiKey) return null;
  const mod = await loadVelo();
  if (!mod) throw new Error("@carts1024/velo-sdk is not installed (run npm install)");
  const velo = new mod.Velo({ apiKey, environment: "testnet" });
  const pi = await velo.paymentIntents.retrieve(paymentIntentId);
  return { id: pi.id ?? pi.paymentIntentId, status: pi.status, amount: pi.amount, asset: pi.asset, expiresAt: pi.expiresAt ?? null };
}

export interface VerifiedEvent {
  id: string;
  type: string;
  paymentIntent: { id: string; amount: string; asset?: string; description?: string; txHash?: string } | null;
  raw: unknown;
  /** velo-status: no webhook was applied, so the payment intent's status was read from Velo directly. */
  verifiedBy: "velo-sdk" | "hmac-fallback" | "velo-status";
}

export class WebhookRejected extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "WebhookRejected";
  }
}

function manualVerify(payload: string, header: string, secret: string, toleranceSeconds: number): unknown {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=") as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) throw new WebhookRejected("malformed x-velo-signature");
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) throw new WebhookRejected("signature timestamp outside tolerance");
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(v1, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookRejected("signature mismatch");
  return JSON.parse(payload);
}

/** Verifies the raw body with the Velo SDK (HMAC fallback only if the SDK is not installed). */
export async function verifyWebhook(payload: string, signature: string | null, opts: { simulated?: boolean } = {}): Promise<VerifiedEvent> {
  if (!signature) throw new WebhookRejected("missing x-velo-signature");
  const secret = opts.simulated ? simulatedSecret : webhookSecret();
  // Authenticity first (same HMAC scheme as the SDK), so a shape problem below can't hide a forged request.
  const signed = manualVerify(payload, signature, secret, 300) as Record<string, unknown>;
  const mod = await loadVelo();
  let event: unknown = signed;
  let verifiedBy: VerifiedEvent["verifiedBy"] = "hmac-fallback";
  if (mod) {
    try {
      const V = mod.Velo as unknown as { webhooks: { verify: (o: unknown) => Promise<unknown> | unknown } };
      event = await V.webhooks.verify({ payload, signature, secret, toleranceSeconds: 300 });
      verifiedBy = "velo-sdk";
    } catch (e) {
      // The dashboard's "Send test event" is signed but flatter than the SDK's event shape: acknowledge it, move nothing.
      if (signed?.test === true) {
        console.warn("velo webhook: signed test event acknowledged without a payment intent:", e instanceof Error ? e.message : e);
        return { id: String(signed.id ?? ""), type: String(signed.type ?? ""), paymentIntent: null, raw: signed, verifiedBy };
      }
      throw new WebhookRejected(e instanceof Error ? `${e.name}: ${e.message}` : "signature verification failed");
    }
  }
  const ev = (event ?? {}) as Record<string, unknown>;
  const pi = (ev.paymentIntent ?? (ev.data as Record<string, unknown> | undefined)?.paymentIntent ?? null) as VerifiedEvent["paymentIntent"];
  return { id: String(ev.id ?? ""), type: String(ev.type ?? ""), paymentIntent: pi, raw: event, verifiedBy };
}

/** Builds a signed payment.succeeded delivery exactly like Velo would (demo insurance, PRD §15). */
export function signSimulatedDelivery(pi: { id: string; amount: string; asset: string; description: string }): { body: string; signature: string; deliveryId: string } {
  const deliveryId = `dlv_sim_${randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();
  const body = JSON.stringify({
    version: "1",
    id: `evt_sim_${randomBytes(6).toString("hex")}`,
    type: "payment.succeeded",
    test: true,
    sentAt: now,
    // The Velo SDK validates the event shape: project needs id, registryProjectId, name and slug.
    project: { id: "proj_sim_noirxvelo", registryProjectId: "sim", name: "noirxvelo", slug: "noirxvelo" },
    paymentIntent: { ...pi, status: "paid", merchantName: "VisMin Freight Factoring", createdAt: now, updatedAt: now },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", simulatedSecret).update(`${t}.${body}`).digest("hex");
  return { body, signature: `t=${t},v1=${v1}`, deliveryId };
}
