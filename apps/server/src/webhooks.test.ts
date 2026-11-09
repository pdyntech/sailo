import { beforeEach, describe, expect, it, vi } from "vitest";

const velo = vi.hoisted(() => ({ verifyWebhook: vi.fn(), retrievePaymentStatus: vi.fn() }));
const demo = vi.hoisted(() => ({ applyPayment: vi.fn() }));

vi.mock("./velo.js", () => ({
  WebhookRejected: class WebhookRejected extends Error {
    status = 400;
  },
  verifyWebhook: velo.verifyWebhook,
  retrievePaymentStatus: velo.retrievePaymentStatus,
}));
vi.mock("./demo.js", () => ({ withDemo: (fn: () => unknown) => fn(), applyPayment: demo.applyPayment, viewState: async () => ({ checkout: { id: "pi_1" } }), BusyElsewhere: class extends Error {} }));
vi.mock("./db.js", () => ({ withDb: async (fn: () => unknown) => fn() }));
vi.mock("./kv.js", () => ({ kvEnabled: () => false, getRaw: vi.fn(), setNx: vi.fn() }));
vi.mock("./portal-chain.js", () => ({ hasCheckout: () => false, recordPayment: () => false, dueJobs: () => [], startJobs: vi.fn() }));
vi.mock("./env.js", () => ({ env: (k: string) => process.env[k] || undefined }));

const { handleVeloWebhook } = await import("./webhooks.js");

let n = 0;
const event = (amount = "1000") => ({ id: `evt_${++n}`, type: "payment.succeeded", paymentIntent: { id: "pi_1", amount, asset: "native" }, raw: {}, verifiedBy: "velo-sdk" });
const deliver = () => handleVeloWebhook("{}", "t=1,v1=x", `dlv_${n}`);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.VELO_CHECKOUT_ASSET;
  demo.applyPayment.mockResolvedValue({ status: 200, body: { ok: true } });
});

describe("Velo webhook: payment status is confirmed with Velo before money moves", () => {
  it("acknowledges a payment that isn't one of our checkouts (Velo's test event) without looking it up", async () => {
    velo.verifyWebhook.mockResolvedValue({ ...event(), paymentIntent: { id: "pi_test_123", amount: "1", asset: "native" } });
    expect(await deliver()).toEqual({ status: 200, body: { ok: true, ignored: "unknown payment intent" } });
    expect(velo.retrievePaymentStatus).not.toHaveBeenCalled();
    expect(demo.applyPayment).not.toHaveBeenCalled();
  });

  it("refuses a payment intent that Velo does not report as paid", async () => {
    velo.verifyWebhook.mockResolvedValue(event());
    velo.retrievePaymentStatus.mockResolvedValue({ id: "pi_1", status: "pending", amount: "1000", asset: "native" });
    expect((await deliver()).status).toBe(409);
    expect(demo.applyPayment).not.toHaveBeenCalled();
  });

  it("refuses a payment in another asset", async () => {
    velo.verifyWebhook.mockResolvedValue(event());
    velo.retrievePaymentStatus.mockResolvedValue({ id: "pi_1", status: "paid", amount: "1000", asset: "USDC" });
    expect((await deliver()).status).toBe(409);
    expect(demo.applyPayment).not.toHaveBeenCalled();
  });

  it("asks Velo to retry when the status lookup fails, and handles the retry", async () => {
    velo.verifyWebhook.mockResolvedValue(event());
    velo.retrievePaymentStatus.mockRejectedValueOnce(new Error("network"));
    expect((await deliver()).status).toBe(503);
    expect(demo.applyPayment).not.toHaveBeenCalled();
    velo.retrievePaymentStatus.mockResolvedValue({ id: "pi_1", status: "paid", amount: "1000", asset: "native" });
    expect((await deliver()).status).toBe(200); // same delivery id: not marked as seen by the failed attempt
    expect(demo.applyPayment).toHaveBeenCalledOnce();
  });

  it("uses Velo's amount, not the webhook body's", async () => {
    velo.verifyWebhook.mockResolvedValue(event("1000"));
    velo.retrievePaymentStatus.mockResolvedValue({ id: "pi_1", status: "paid", amount: "10", asset: "native" });
    await deliver();
    expect(demo.applyPayment.mock.calls[0]![0].paymentIntent.amount).toBe("10");
  });

  it("without VELO_API_KEY (no status to read) the verified webhook is used as is", async () => {
    velo.verifyWebhook.mockResolvedValue(event("1000"));
    velo.retrievePaymentStatus.mockResolvedValue(null);
    expect((await deliver()).status).toBe(200);
    expect(demo.applyPayment.mock.calls[0]![0].paymentIntent.amount).toBe("1000");
  });
});
