/**
 * Website API: accounts, the role portal, and the enquiry / newsletter forms.
 *
 * Accounts
 *   POST /api/auth/signup              {name, email, company?, role, password}  -> signs in, emails a verification link
 *   POST /api/auth/login               {email, password}
 *   POST /api/auth/logout
 *   GET  /api/auth/me                  {user | null, config}
 *   POST /api/auth/verify              {token}             from the emailed link
 *   POST /api/auth/verify/resend                           signed in
 *   POST /api/auth/forgot              {email}             always answers ok
 *   POST /api/auth/reset               {token, password}   from the emailed link; signs out other sessions
 *   POST /api/auth/password            {current, password} signed in; signs out other sessions
 *   POST /api/auth/profile             {name, company?}    signed in
 *   GET  /api/auth/sessions                                signed in
 *   POST /api/auth/sessions/sign-out-others                signed in
 *
 * Portal (signed in; money-moving actions need a verified email)
 *   GET  /api/portal
 *   POST /api/portal/invoices          shipowner tokenizes an invoice
 *   POST /api/portal/invoices/:id/fund investor funds the advance
 *   POST /api/portal/invoices/:id/pay  cargo owner pays after berthing (on-chain invoices: Velo checkout)
 *   POST /api/portal/invoices/:id/retry re-run a Stellar step that failed three times
 *
 * Forms
 *   POST /api/enquiry   {name, company?, role, email, msg?}
 *   POST /api/subscribe {email}
 *
 * Every POST must be JSON (see readJson), which keeps cookie-authenticated requests CSRF-safe.
 *
 * Each request runs inside withDb (latest data, under the db lock). The response is held until the data is
 * saved, so a client is never told "done" about a change that wasn't stored. Chain steps start afterwards.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import * as auth from "./accounts.js";
import { withDb } from "./db.js";
import { HttpError, readJson, send } from "./http.js";
import { LockTimeout } from "./kv.js";
import { createInvoice, fundInvoice, portalFor, preparePay, recordCheckout, retryInvoice, seedSamples } from "./portal.js";
import { dueJobs, startJobs } from "./portal-chain.js";
import { createCheckout, signSimulatedDelivery, verifyWebhook, type VerifiedEvent } from "./velo.js";

type Handler = (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray) => Promise<void> | void;

/** Collects a response so it can be sent after the data is saved. */
class HeldResponse {
  status = 200;
  headers: Record<string, string | string[]> = {};
  body: string | Buffer = "";
  writeHead(status: number, headers: Record<string, string | string[]> = {}) {
    this.status = status;
    this.headers = headers;
    return this;
  }
  end(body?: string | Buffer) {
    this.body = body ?? "";
  }
}

/** Routes that manage withDb themselves (they wait on the network between two short locked phases). */
const OWN_DB = new Set<Handler>();
const ownDb = (h: Handler): Handler => (OWN_DB.add(h), h);

const ok = (res: ServerResponse, body: unknown, status = 200, cookie?: string) => send(res, status, body, cookie ? { "set-cookie": cookie } : {});

const ROUTES: [method: string, path: RegExp, handler: Handler][] = [
  ["POST", /^\/api\/auth\/signup$/, async (req, res) => {
    const r = await auth.signup(req, await readJson(req));
    seedSamples(r.user);
    ok(res, { user: auth.publicUser(r.user), devLink: r.devLink }, 201, r.setCookie);
  }],
  ["POST", /^\/api\/auth\/login$/, async (req, res) => {
    const r = auth.login(req, await readJson(req));
    ok(res, { user: auth.publicUser(r.user) }, 200, r.setCookie);
  }],
  ["POST", /^\/api\/auth\/logout$/, (req, res) => ok(res, { ok: true }, 200, auth.logout(req))],
  ["GET", /^\/api\/auth\/me$/, (req, res) => {
    const u = auth.currentUser(req);
    ok(res, { user: u ? auth.publicUser(u) : null, config: auth.authConfig() });
  }],
  ["POST", /^\/api\/auth\/verify$/, async (req, res) => {
    const u = auth.verifyEmail(await readJson(req));
    const me = auth.currentUser(req);
    ok(res, { verified: true, email: u.email, user: me && me.id === u.id ? auth.publicUser(me) : null });
  }],
  ["POST", /^\/api\/auth\/verify\/resend$/, async (req, res) => {
    const u = auth.requireUser(req);
    await readJson(req);
    ok(res, { sent: true, ...(await auth.resendVerification(req, u)) });
  }],
  ["POST", /^\/api\/auth\/forgot$/, async (req, res) => ok(res, { ok: true, ...(await auth.forgotPassword(req, await readJson(req))) })],
  ["POST", /^\/api\/auth\/reset$/, async (req, res) => {
    const r = auth.resetPassword(req, await readJson(req));
    ok(res, { user: auth.publicUser(r.user) }, 200, r.setCookie);
  }],
  ["POST", /^\/api\/auth\/password$/, async (req, res) => {
    const u = auth.requireUser(req);
    ok(res, auth.changePassword(req, u, await readJson(req)));
  }],
  ["POST", /^\/api\/auth\/profile$/, async (req, res) => {
    const u = auth.requireUser(req);
    ok(res, { user: auth.publicUser(auth.updateProfile(u, await readJson(req))) });
  }],
  ["GET", /^\/api\/auth\/sessions$/, (req, res) => ok(res, { sessions: auth.sessionsFor(req, auth.requireUser(req)) })],
  ["POST", /^\/api\/auth\/sessions\/sign-out-others$/, async (req, res) => {
    const u = auth.requireUser(req);
    await readJson(req);
    ok(res, auth.signOutOthers(req, u));
  }],

  ["GET", /^\/api\/portal$/, (req, res) => {
    const u = auth.requireUser(req);
    ok(res, { user: auth.publicUser(u), ...portalFor(u) });
  }],
  ["POST", /^\/api\/portal\/invoices$/, async (req, res) => {
    const u = auth.requireUser(req);
    const body = await readJson(req);
    auth.requireVerified(u);
    ok(res, { invoice: createInvoice(u, body) }, 201);
  }],
  ["POST", /^\/api\/portal\/invoices\/([A-Za-z0-9-]{1,40})\/(fund|retry)$/, async (req, res, m) => {
    const u = auth.requireUser(req);
    await readJson(req);
    auth.requireVerified(u);
    ok(res, { invoice: m[2] === "fund" ? fundInvoice(u, m[1]) : retryInvoice(u, m[1]) });
  }],
  ["POST", /^\/api\/portal\/invoices\/([A-Za-z0-9-]{1,40})\/pay$/, ownDb(async (req, res, m) => {
    await readJson(req);
    const plan = await withDb(() => {
      const u = auth.requireUser(req);
      auth.requireVerified(u);
      return preparePay(u, m[1]);
    });
    if (plan.kind === "done") {
      ok(res, { invoice: plan.view, checkoutUrl: plan.view.checkoutUrl });
      startJobs(await withDb(() => dueJobs()));
      return;
    }
    // Outside the lock: create the Velo checkout (a network call). Without VELO_API_KEY it is simulated,
    // and the payment.succeeded event is signed and verified exactly like a real Velo delivery.
    const session = await createCheckout({ invoiceId: plan.invoiceId, amountXlm: plan.amountXlm, description: plan.description });
    let ev: VerifiedEvent | null = null;
    if (session.simulated) {
      const d = signSimulatedDelivery({ id: session.id, amount: session.amount, asset: session.asset, description: plan.description });
      ev = await verifyWebhook(d.body, d.signature, { simulated: true });
    }
    const r = await withDb(() => {
      const u = auth.requireUser(req);
      return { invoice: recordCheckout(u, m[1], session, ev), due: dueJobs() };
    });
    ok(res, { invoice: r.invoice, checkoutUrl: session.simulated ? null : session.checkoutUrl });
    startJobs(r.due);
  })],

  ["POST", /^\/api\/enquiry$/, async (req, res) => {
    auth.addEnquiry(req, await readJson(req));
    ok(res, { ok: true }, 201);
  }],
  ["POST", /^\/api\/subscribe$/, async (req, res) => {
    auth.subscribe(req, await readJson(req));
    ok(res, { ok: true }, 201);
  }],
];

/** Handles the request if it is a site route. Returns false when the path is not ours. */
export async function handleSite(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const method = req.method ?? "GET";
  for (const [m, re, handler] of ROUTES) {
    const match = re.exec(path);
    if (!match) continue;
    if (m !== method) continue;
    try {
      if (OWN_DB.has(handler)) {
        await handler(req, res, match);
        return true;
      }
      const held = new HeldResponse();
      let due: string[] = [];
      await withDb(async () => {
        await handler(req, held as unknown as ServerResponse, match);
        due = dueJobs();
      });
      res.writeHead(held.status, held.headers);
      res.end(held.body);
      startJobs(due);
    } catch (e) {
      if (res.headersSent) return true;
      if (e instanceof HttpError) send(res, e.status, { ok: false, error: e.message });
      else if (e instanceof LockTimeout) send(res, 503, { ok: false, error: "Sailo is busy. Please try again in a moment." }, { "retry-after": "2" });
      else {
        console.error("site api:", e);
        send(res, 500, { ok: false, error: "Something went wrong. Please try again." });
      }
    }
    return true;
  }
  return false;
}
