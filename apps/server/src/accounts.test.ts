/**
 * Account security rules, tested against the real module with a throwaway data directory.
 * Run with `npm test` from the repo root.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "sailo-auth-"));
process.env.SMTP_URL = ""; // set (empty) so .env.local can't turn real email on in tests
vi.spyOn(console, "log").mockImplementation(() => undefined); // emails are logged when SMTP is off

type Auth = typeof import("./accounts.js");
let auth: Auth;
beforeAll(async () => {
  auth = await import("./accounts.js");
});

/** Minimal request: one browser (cookie jar) on one IP. */
function browser(ip = "10.0.0.1") {
  const jar: { cookie?: string } = {};
  const req = () =>
    ({ headers: { cookie: jar.cookie ?? "", "user-agent": "Mozilla/5.0 (Macintosh) Chrome/130" }, socket: { remoteAddress: ip } }) as unknown as IncomingMessage;
  const take = (setCookie: string) => {
    jar.cookie = setCookie.split(";")[0];
  };
  return { req, take };
}

const tokenOf = (link?: string) => /=([0-9a-f]{64})/.exec(link ?? "")![1]!;
let n = 0;
const email = () => `user${++n}-${Date.now()}@test.ph`;

async function newUser(password = "harbor-Light-42") {
  const b = browser();
  const e = email();
  const r = await auth.signup(b.req(), { name: "Test User", email: e, role: "Investor", password });
  b.take(r.setCookie);
  return { b, email: e, password, verifyLink: r.devLink, user: r.user };
}

describe("passwords", () => {
  it("rejects short, common and personal passwords", async () => {
    const b = browser("10.1.0.1");
    for (const password of ["short", "password", "11111111", "testuser"]) {
      await expect(auth.signup(b.req(), { name: "Test User", email: email(), role: "Investor", password })).rejects.toMatchObject({ status: 400 });
    }
  });

  it("stores a salted hash, never the password", async () => {
    const { user, password } = await newUser();
    expect(user.hash).not.toContain(password);
    expect(user.hash).toMatch(/^[0-9a-f]{128}$/);
    expect(user.salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it("treats emails case-insensitively and blocks duplicates", async () => {
    const { email: e } = await newUser();
    await expect(auth.signup(browser("10.1.0.2").req(), { name: "X Y", email: e.toUpperCase(), role: "Investor", password: "harbor-Light-42" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("sign in and sessions", () => {
  it("signs in with the right password only", async () => {
    const { email: e, password } = await newUser();
    expect(() => auth.login(browser().req(), { email: e, password: "wrong-pass-1" })).toThrow(/incorrect/);
    expect(auth.login(browser().req(), { email: e, password }).user.email).toBe(e);
  });

  it("locks the account after 10 failures, even for the right password", async () => {
    const { email: e, password } = await newUser();
    const b = browser("10.2.0.1");
    for (let i = 0; i < 10; i++) expect(() => auth.login(b.req(), { email: e, password: `nope-${i}-xx` })).toThrow();
    expect(() => auth.login(b.req(), { email: e, password })).toThrow(expect.objectContaining({ status: 429 }));
  });

  it("ends the session on logout", async () => {
    const { b } = await newUser();
    expect(auth.currentUser(b.req())).not.toBeNull();
    auth.logout(b.req());
    expect(auth.currentUser(b.req())).toBeNull();
  });

  it("ignores forged session cookies", () => {
    const req = { headers: { cookie: "sailo_sid=" + "a".repeat(64) }, socket: {} } as unknown as IncomingMessage;
    expect(auth.currentUser(req)).toBeNull();
  });
});

describe("email verification", () => {
  it("blocks money actions until verified, and links work once", async () => {
    const { b, verifyLink } = await newUser();
    const u = auth.requireUser(b.req());
    expect(() => auth.requireVerified(u)).toThrow(expect.objectContaining({ status: 403 }));
    auth.verifyEmail({ token: tokenOf(verifyLink) });
    expect(() => auth.requireVerified(u)).not.toThrow();
    expect(() => auth.verifyEmail({ token: tokenOf(verifyLink) })).toThrow(/invalid or has expired/);
  });

  it("a resent link replaces the old one", async () => {
    const { b, verifyLink } = await newUser();
    const again = await auth.resendVerification(b.req(), auth.requireUser(b.req()));
    expect(() => auth.verifyEmail({ token: tokenOf(verifyLink) })).toThrow();
    expect(auth.verifyEmail({ token: tokenOf(again.devLink) }).emailVerifiedAt).toBeTruthy();
  });
});

describe("password reset", () => {
  it("gives the same answer for unknown emails", async () => {
    const r = await auth.forgotPassword(browser("10.3.0.1").req(), { email: "nobody-" + email() });
    expect(r).toEqual({});
  });

  it("keeps the link alive when the new password is rejected, then works once and ends old sessions", async () => {
    const { b, email: e } = await newUser();
    const { devLink } = await auth.forgotPassword(browser("10.3.0.2").req(), { email: e });
    const token = tokenOf(devLink);
    const c = browser("10.3.0.3");
    expect(() => auth.resetPassword(c.req(), { token, password: "short" })).toThrow(expect.objectContaining({ status: 400 }));
    const r = auth.resetPassword(c.req(), { token, password: "brand-New-Pass-7" });
    expect(r.user.email).toBe(e);
    expect(auth.currentUser(b.req())).toBeNull(); // the old browser was signed out
    expect(() => auth.resetPassword(c.req(), { token, password: "brand-New-Pass-8" })).toThrow();
    expect(() => auth.login(browser("10.3.0.4").req(), { email: e, password: "harbor-Light-42" })).toThrow(/incorrect/);
  });
});

describe("change password", () => {
  it("needs the current password and signs out other devices", async () => {
    const { b, email: e, password } = await newUser();
    const other = browser("10.4.0.1");
    other.take(auth.login(other.req(), { email: e, password }).setCookie);
    const u = auth.requireUser(b.req());
    expect(() => auth.changePassword(b.req(), u, { current: "wrong-one-1", password: "fresh-Tide-55" })).toThrow(/incorrect/);
    expect(auth.changePassword(b.req(), u, { current: password, password: "fresh-Tide-55" }).signedOut).toBe(1);
    expect(auth.currentUser(other.req())).toBeNull();
    expect(auth.currentUser(b.req())).not.toBeNull();
  });
});
