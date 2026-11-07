/**
 * The request handler shared by the long-running server (index.ts) and the Vercel function (vercel.ts):
 * the demo API, the Velo webhook, the site/portal API, and the static frontend in apps/web.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { WEB_DIR, env } from "./env.js";
import * as demo from "./demo.js";
import { readBody, send, toJson } from "./http.js";
import { kvBackend, kvEnabled, LockTimeout } from "./kv.js";
import { handleSite } from "./site.js";
import { handleVeloWebhook } from "./webhooks.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

/** Actions run in the background; the UI follows progress over the event stream. */
const ACTIONS: Record<string, () => Promise<unknown>> = {
  "/api/tokenize": demo.tokenize,
  "/api/fund": demo.fund,
  "/api/depart": demo.depart,
  "/api/fast-forward": demo.fastForwardVoyage,
  "/api/checkout": demo.checkout,
  "/api/simulate-webhook": demo.simulateWebhook,
  "/api/guardrail": demo.guardrail,
  "/api/default": demo.simulateDefault,
  "/api/reset": demo.reset,
  "/api/mode/simulation": demo.useSimulation,
  "/api/mode/testnet": demo.useTestnet,
  "/api/run-demo": demo.runDemo,
};

/**
 * Operator-only actions. Switching chain modes changes what every visitor sees (real Testnet transactions or the
 * in-memory simulation), so it needs OPS_TOKEN, sent as the x-ops-token header. Every other action is a demo step
 * that anyone may run: each checks the demo's state, and only one runs at a time.
 */
const OPS_ONLY = new Set(["/api/mode/simulation", "/api/mode/testnet"]);
const deployed = (): boolean => env("NODE_ENV") === "production" || !!(process.env.VERCEL || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT);

function opsRefusal(req: IncomingMessage): { status: number; error: string } | null {
  const token = env("OPS_TOKEN");
  if (!token) return deployed() ? { status: 403, error: "Switching modes is turned off on this server (OPS_TOKEN is not set)." } : null;
  const given = req.headers["x-ops-token"];
  const digest = (v: string) => createHash("sha256").update(v).digest();
  if (typeof given === "string" && timingSafeEqual(digest(given), digest(token))) return null;
  return { status: 401, error: "Only the operator can switch modes." };
}

async function handleAction(path: string, res: ServerResponse): Promise<void> {
  const fn = ACTIONS[path]!;
  // withDemo takes the demo lease and loads the latest saved run before the step starts.
  const p = demo.withDemo(fn);
  // Wait briefly so quick validation errors come back in the response; long chain work continues.
  const outcome = await Promise.race([
    p.then(() => ({ done: true as const, error: null })).catch((e: unknown) => ({ done: true as const, error: e instanceof Error ? e.message : String(e) })),
    new Promise<{ done: false; error: null }>((r) => setTimeout(() => r({ done: false, error: null }), 400)),
  ]);
  p.catch(() => undefined); // errors are already recorded in state
  if (outcome.error) return send(res, /^Busy/.test(outcome.error) ? 409 : 400, { ok: false, error: outcome.error });
  send(res, 202, { ok: true, started: !outcome.done });
}

function stream(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let last = "";
  let closed = false;
  const write = async () => {
    if (closed) return;
    const s = await demo.viewState().catch(() => demo.getState());
    const text = toJson(s);
    if (text === last || closed) return;
    last = text;
    res.write(`data: ${text}\n\n`);
  };
  let pending = false;
  const push = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      void write();
    }, 120); // coalesce bursts of updates
  };
  void write();
  const off = demo.subscribe(push); // changes made on this instance
  const poll = setInterval(() => void write(), 1000); // changes made on another instance (shared store)
  const hb = setInterval(() => res.write(": hb\n\n"), 15000);
  req.on("close", () => {
    closed = true;
    off();
    clearInterval(poll);
    clearInterval(hb);
  });
}

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const rel = path === "/" ? "/index.html" : path;
  const file = resolve(WEB_DIR, "." + normalize(rel));
  if (!file.startsWith(WEB_DIR)) return send(res, 403, { error: "forbidden" });
  try {
    const st = await stat(file);
    const target = st.isDirectory() ? join(file, "index.html") : file;
    const body = await readFile(target);
    res.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    if (extname(rel)) return send(res, 404, { error: "not found" }); // missing asset, e.g. optional hero photo
    const body = await readFile(join(WEB_DIR, "index.html"));
    res.writeHead(200, { "content-type": MIME[".html"]! });
    res.end(body);
  }
}

export async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/api/health") {
      const s = await demo.viewState();
      return send(res, 200, { ok: true, status: s.status, chain: s.config.mode, storage: kvEnabled() ? kvBackend() : process.env.VERCEL ? "memory only: add a Redis store or data resets" : "local file", at: new Date().toISOString() });
    }
    if (req.method === "GET" && path === "/api/state") return send(res, 200, await demo.viewState());
    if (req.method === "GET" && path === "/api/stream") return stream(req, res);
    if (req.method === "POST" && path === "/api/webhooks/velo") {
      const raw = await readBody(req);
      const sig = req.headers["x-velo-signature"];
      const dlv = req.headers["x-velo-delivery"];
      const r = await handleVeloWebhook(raw, typeof sig === "string" ? sig : null, typeof dlv === "string" ? dlv : null);
      return send(res, r.status, r.body);
    }
    if (req.method === "POST" && path in ACTIONS) {
      const refused = OPS_ONLY.has(path) ? opsRefusal(req) : null;
      if (refused) return send(res, refused.status, { ok: false, error: refused.error });
      return handleAction(path, res);
    }
    if (path.startsWith("/api/") && (await handleSite(req, res, path))) return;
    if (path.startsWith("/api/")) return send(res, 404, { ok: false, error: "not found" });
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(path, res);
    send(res, 405, { ok: false, error: "method not allowed" });
  } catch (e) {
    if (res.headersSent) return;
    if (e instanceof LockTimeout) return send(res, 503, { ok: false, error: "Busy, please try again." }, { "retry-after": "2" });
    send(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Resolves once the demo state is loaded. Startup errors are logged, not thrown. */
export const ready: Promise<void> = demo.init().catch((e) => console.error("init:", e instanceof Error ? e.message : e));
