import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

process.env.VELO_WEBHOOK_SECRET = "whsec_test_secret";
const { checkoutClosed, signSimulatedDelivery, verifyWebhook } = await import("./velo.js");

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

  it("rejects a stale delivery (signed more than 300 s ago), even with the right secret", async () => {
    const t = Math.floor(Date.now() / 1000) - 301;
    const sig = `t=${t},v1=${createHmac("sha256", "whsec_test_secret").update(`${t}.${dashboardTest}`).digest("hex")}`;
    await expect(verifyWebhook(dashboardTest, sig)).rejects.toThrow("tolerance");
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

describe("checkout expiry", () => {
  const at = Date.parse("2026-11-09T12:00:00Z");
  const s = (status: string, expiresAt: string | null) => ({ id: "pi", status, amount: "1", asset: "native", expiresAt });
  it("treats a created checkout past its expiry as closed (Velo keeps it at created)", () => {
    expect(checkoutClosed(s("created", "2026-11-09T11:29:33Z"), at)).toBe(true);
    expect(checkoutClosed(s("created", "2026-11-09T12:29:33Z"), at)).toBe(false);
  });
  it("never closes one with a payment under way or done", () => {
    expect(checkoutClosed(s("pending", "2026-11-09T11:00:00Z"), at)).toBe(false);
    expect(checkoutClosed(s("paid", "2026-11-09T11:00:00Z"), at)).toBe(false);
  });
  it("closes expired, cancelled and failed ones", () => {
    for (const st of ["expired", "cancelled", "failed"]) expect(checkoutClosed(s(st, null), at)).toBe(true);
  });
});

describe("checkout receiver", () => {
  it("warns when Velo would pay someone other than the treasury", async () => {
    const { receiverMismatch } = await import("./velo.js");
    expect(receiverMismatch({ receiverAddress: "GTREASURY", simulated: false }, "GTREASURY")).toBeNull();
    expect(receiverMismatch({ receiverAddress: null, simulated: true }, "GTREASURY")).toBeNull();
    expect(receiverMismatch({ receiverAddress: "GD2BT2HK6FAJGVD7YWOWGZY4WN3IWMQ6M42X3KCTHSAET5BQHK3UULDX", simulated: false }, "GDWRQZTREASURY")).toMatch(/not Sailo's treasury/);
  });
});
