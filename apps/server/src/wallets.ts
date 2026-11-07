/**
 * Stellar Testnet wallets for the portal, plus the per-account transaction lock.
 *
 * - Each shipowner and investor gets a custodial Testnet wallet the first time it is needed. Friendbot funds
 *   it with 10,000 test XLM. The secret is encrypted with AES-256-GCM (key: WALLET_ENCRYPTION_KEY, or one
 *   derived from TREASURY_SECRET) before it is stored. Wallets stored under the derived key stay readable after
 *   WALLET_ENCRYPTION_KEY is set. Testnet only: these wallets never hold real money.
 * - topUp() refills a wallet from Friendbot by funding a throwaway account and merging it into the target.
 * - withAccount() serialises transactions per source account across every server instance, so two instances
 *   never race on the same account's sequence number.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { ChainError, NoirAgentClient, horizonXlmBalance, keypairSigner, type NoirSigner } from "@noirxvelo/agent";
import { env } from "./env.js";
import { withLock } from "./kv.js";
import type { StoredWallet } from "./db.js";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const STROOPS = 10_000_000n;

const keyFrom = (k: string): Buffer => createHash("sha256").update(`sailo-wallets|${k}`).digest();
/** The key used before WALLET_ENCRYPTION_KEY existed (derived from the treasury secret). Still read, never written once a key is set. */
const legacyKey = (): Buffer => keyFrom(`derived:${env("TREASURY_SECRET") ?? "sailo-dev-only"}`);
/** Encrypts with WALLET_ENCRYPTION_KEY when set, so a leaked treasury secret no longer unlocks the wallets. */
const encKey = (): Buffer => {
  const k = env("WALLET_ENCRYPTION_KEY");
  return k ? keyFrom(k) : legacyKey();
};

if (!env("WALLET_ENCRYPTION_KEY") && process.env.NODE_ENV === "production") {
  console.warn("WALLET_ENCRYPTION_KEY is not set: portal wallet secrets are encrypted with a key derived from TREASURY_SECRET.");
}

export function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", encKey(), iv);
  const body = Buffer.concat([c.update(secret, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

export function decryptSecret(enc: string): string {
  const [v, iv, tag, body] = enc.split(".");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("wallet: unknown secret format");
  // Current key first, then the legacy one, so setting WALLET_ENCRYPTION_KEY keeps older wallets readable.
  const keys = [encKey(), legacyKey()];
  for (const key of keys) {
    try {
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      d.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
    } catch {
      /* wrong key: GCM authentication fails, try the next one */
    }
  }
  throw new Error("wallet: cannot decrypt this wallet secret (was WALLET_ENCRYPTION_KEY or TREASURY_SECRET changed?)");
}

export const walletSigner = (w: StoredWallet): NoirSigner => keypairSigner(decryptSecret(w.secretEnc));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Funds a brand-new account with Friendbot (10,000 test XLM). Retries briefly; Friendbot is sometimes slow. */
async function friendbot(pub: string): Promise<void> {
  let last = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${FRIENDBOT}/?addr=${encodeURIComponent(pub)}`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) return;
      const text = await res.text();
      // Already funded counts as done (a retry after a response we didn't see).
      if (/already|createAccountAlreadyExist|op_already_exists/i.test(text)) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(1500 * attempt);
  }
  throw new Error(`Friendbot could not fund ${pub.slice(0, 6)}… (${last}). Stellar Testnet may be busy; try again.`);
}

/** Creates and funds a new Testnet wallet. */
export async function createWallet(): Promise<StoredWallet> {
  const kp = Keypair.random();
  await friendbot(kp.publicKey());
  return { publicKey: kp.publicKey(), secretEnc: encryptSecret(kp.secret()), createdAt: new Date().toISOString() };
}

export const xlmBalance = (pub: string): Promise<bigint> => horizonXlmBalance(pub);

/**
 * Makes sure `pub` holds at least `minStroops`, refilling from Friendbot in 10,000 XLM steps
 * (fund a throwaway account, then merge it into `pub`).
 */
export async function topUp(pub: string, minStroops: bigint): Promise<number> {
  let added = 0;
  for (let i = 0; i < 6; i++) {
    const bal = await xlmBalance(pub);
    if (bal >= minStroops) return added;
    const tmp = Keypair.random();
    await friendbot(tmp.publicKey());
    const server = new Horizon.Server(HORIZON);
    const acct = await server.loadAccount(tmp.publicKey());
    const tx = new TransactionBuilder(acct, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.accountMerge({ destination: pub }))
      .setTimeout(60)
      .build();
    tx.sign(tmp);
    await server.submitTransaction(tx);
    added += 1;
  }
  const bal = await xlmBalance(pub);
  if (bal < minStroops) throw new Error(`Could not top up ${pub.slice(0, 6)}… to ${minStroops / STROOPS} XLM.`);
  return added;
}

/** One transaction at a time per source account, across instances (Stellar sequence numbers). */
export function withAccount<T>(pub: string, fn: () => Promise<T>): Promise<T> {
  return withLock(`acct:${pub}`, fn, { ttlMs: 60_000, waitMs: 180_000 });
}

/**
 * Retries a write whose transaction was included but failed on-chain (e.g. it was simulated against a ledger
 * the RPC hadn't caught up on, while another invoice touched the same entries), or that the network rejected
 * without including it. Either way nothing changed on-chain, so sending it again is safe. Contract refusals (over the cap, no escrow) fail in simulation with a
 * named error and are never retried; neither are errors where we can't tell whether the transaction landed.
 */
async function retryFailedOnChain<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // "failed on-chain": included but failed; "rejected by the network": never included (e.g. a stale sequence).
      if (attempt >= 3 || !/failed on-chain|rejected by the network/i.test(msg)) throw e;
      await sleep(3000 * attempt);
    }
  }
}

/** NoirAgentClient whose writes take the source account's lock first. */
export class LockedNoirClient extends NoirAgentClient {
  override registerDevice(s: NoirSigner, deviceHash: string, agent: string) {
    return withAccount(s.publicKey, () => retryFailedOnChain(() => super.registerDevice(s, deviceHash, agent)));
  }
  override registerAgent(s: NoirSigner, deviceHash: string, agent: string, maxAmount: bigint, asset?: string, expiresAt?: Date | null) {
    return withAccount(s.publicKey, () => retryFailedOnChain(() => super.registerAgent(s, deviceHash, agent, maxAmount, asset, expiresAt)));
  }
  override fundEscrow(s: NoirSigner, deviceHash: string, amount: bigint) {
    return withAccount(s.publicKey, () => retryFailedOnChain(() => super.fundEscrow(s, deviceHash, amount)));
  }
  override authorizePayment(p: Parameters<NoirAgentClient["authorizePayment"]>[0]) {
    return withAccount(p.agentSigner.publicKey, () => retryFailedOnChain(() => super.authorizePayment(p)));
  }
  /**
   * claim() pays out everything pending for the payee across all invoices, so two invoices settling at once
   * (the demo and a portal invoice both pay treasury) can leave the second claim with nothing to collect.
   * That surfaces as NothingToClaim, and no failing transaction is sent when the pending balance is already 0.
   */
  override claim(s: NoirSigner) {
    return withAccount(s.publicKey, async () => {
      const nothing = () => new ChainError("nothing pending: an earlier claim already paid this out", { errorName: "NothingToClaim", method: "claim" });
      const pendingIsZero = async () => (await this.pendingBalance(s.publicKey).catch(() => -1n)) === 0n;
      for (let attempt = 1; ; attempt++) {
        if (await pendingIsZero()) throw nothing();
        try {
          return await super.claim(s);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!/failed on-chain|rejected by the network/i.test(msg)) throw e;
          // The RPC can lag a ledger behind: wait, then see whether another claim already collected it.
          await sleep(3000 * attempt);
          if (attempt >= 3) {
            if (await pendingIsZero()) throw nothing();
            throw e;
          }
        }
      }
    });
  }
  override unlinkDevice(s: NoirSigner, deviceHash: string) {
    return withAccount(s.publicKey, () => super.unlinkDevice(s, deviceHash));
  }
}

let shared: LockedNoirClient | null = null;
/** The one Testnet client every chain call goes through (demo and portal). */
export const chainClient = (): LockedNoirClient => (shared ??= new LockedNoirClient());
