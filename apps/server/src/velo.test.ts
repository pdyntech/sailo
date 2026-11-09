import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

process.env.VELO_WEBHOOK_SECRET = "whsec_test_secret";
const { signSimulatedDelivery, verifyWebhook } = await import("./velo.js");

const sign = (body: string, secret = "whsec_test_secret") => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
};
// What velo-build.dev's "Send test event" delivers: signed, but flatter than the SDK's event shape.
const dashboardTest = JSON.stringify({ id: "314aae18", paymentIntentId: "pi_mock1234567890", projectId: "kh79", test: true, type: "payment.succeeded" });

describe("Velo webhook verification", () => {
  it("acknowledges the dashboard's signed test event without a payment intent", async () => {
    const ev = await verifyWebhook(dashboardTest, sign(dashboardTest));
    expect(ev).toMatchObject({ type: "payment.succeeded", paymentIntent: null, verifiedBy: "hmac-fallback" });
  });

  it("rejects a test event signed with the wrong secret", async () => {
    await expect(verifyWebhook(dashboardTest, sign(dashboardTest, "whsec_other"))).rejects.toThrow("signature mismatch");
  });

  it("rejects a non-test event the SDK can't validate, even if signed", async () => {
    const body = JSON.stringify({ id: "x", type: "payment.succeeded", paymentIntent: { id: "pi_1", amount: "1000" } });
    await expect(verifyWebhook(body, sign(body))).rejects.toThrow(/Invalid webhook event|VeloWebhook/);
  });

  it("verifies a full event with the SDK", async () => {
    const d = signSimulatedDelivery({ id: "pi_1", amount: "1000", asset: "native", description: "x" });
    const ev = await verifyWebhook(d.body, d.signature, { simulated: true });
    expect(ev).toMatchObject({ verifiedBy: "velo-sdk", paymentIntent: { id: "pi_1", amount: "1000" } });
  });
});
