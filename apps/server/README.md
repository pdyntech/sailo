# apps/server + apps/web

One Node process: the API, the Velo webhook receiver, the settlement agent runtime, and the static frontend in `apps/web` (no build step).

## Run locally

```bash
nvm use                   # Node 24.22.1 (.nvmrc). Older Node installs the retired agent-sdk 0.2.0
npm install               # at the repo root
npm run provision         # once: creates and funds the Testnet wallets in .env.local
npm start                 # http://localhost:3000
```

Press **▶ Run Demo** in the Ops panel. It runs the whole loop on Stellar Testnet in about 90 seconds:

1. `device_registry.register` and `agent_registry.register_agent` (cap 880 XLM) for the invoice hash
2. LP `fund_escrow` 850 XLM
3. The vessel departs. On the first underway AIS tick the agent decides **ADVANCE**, and the executor runs `authorize` + `claim` for the shipowner
4. Berthing rule (800 m Cebu geofence, ≤0.5 kn for 3 ticks): the agent signs a proof-of-delivery attestation
5. Velo checkout session, then a verified `payment.succeeded` webhook. Treasury `fund_escrow` 1,000 XLM
6. Guardrail: the agent tries one 1,000 XLM payout and Noir refuses it (`over_limit`, no tx, no fee)
7. The agent decides **SETTLE**: `authorize` LP 880, shipowner 115, treasury 5, then each payee claims. Escrow ends at 0

Every step is also a manual button in the Shipowner, Investor and Debtor views.

## Website, accounts and portal

`/` is the Sailo landing page (`apps/web/index.html`, `landing.css`, `site.js`, `portal.js`). `/app` is the live Testnet demo above.

- **Accounts.** "Get started" creates a Shipowner, Investor or Cargo owner account. The full route list is at the top of `src/site.ts`; the rules live in `src/accounts.ts` and are tested in `src/accounts.test.ts`.
  - Passwords are hashed with scrypt (per-user salt). Short, common or name/email passwords are refused.
  - Sessions are a random token in an HttpOnly, SameSite=Lax cookie (Secure over HTTPS). Only a hash is stored. They last 30 days; the Account tab lists devices and can sign out the others.
  - **Email verification:** sign-up emails a link (24 h). Tokenizing, funding and paying need a verified email.
  - **Password reset:** "Forgot password?" emails a one-time link (30 min). Resetting signs out every other device. The answer is the same whether or not the email has an account.
  - **Change password and profile** in the Account tab. Changing the password signs out other devices.
  - Rate limits on sign-in (account locks for 15 min after 10 failures), sign-up, resend and reset.
  - **Email delivery:** set `SMTP_URL` and `MAIL_FROM`. Without them, emails go to the server log, and outside production the link is also shown in the UI, labelled as a development link. A production deploy without `SMTP_URL` can't send links, so it doesn't require verification and logs a warning. Set `APP_URL` in production so links always point at your domain.
- **Portal.** One shared ledger, so the roles meet: a shipowner tokenizes an invoice (`POST /api/portal/invoices`), any investor funds it from the Marketplace (`.../:id/fund`), the agent checks and releases the 85% advance, the voyage runs, and the cargo owner named by email pays after berthing (`.../:id/pay`). The agent then settles. If no cargo owner email is given, payment is simulated after berthing. Amounts use the same integer payout math as the Testnet demo. When the Testnet wallets are configured, these invoices run on Stellar Testnet (`src/portal-chain.ts`): treasury registers the invoice and the agent policy, the investor's wallet funds the escrow, the agent's ADVANCE and SETTLE go through the same executor as the demo, and each payee's wallet claims. Each shipowner and investor gets a custodial Testnet wallet (funded by Friendbot, secret encrypted with AES-256-GCM, shown on the Account tab). The cargo owner pays through a Velo checkout (simulated and labelled without `VELO_API_KEY`), and treasury moves the payment into escrow. On-chain invoices are capped at ₱5,000,000 (5,000 test XLM). Every step's transactions link to Stellar Expert; a step that fails three times shows a Retry button and resumes without paying twice.
- **Sample data.** Each new account gets a few private sample invoices, always simulated and labelled, so the portal is never empty.
- **Forms.** The enquiry form (`POST /api/enquiry`) and newsletter (`POST /api/subscribe`) are saved on the server.

With a Redis store configured (`KV_REST_API_URL` + `KV_REST_API_TOKEN`, `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `REDIS_URL`; see `src/kv.ts`), everything lives there and every instance shares it. Otherwise it is stored in `apps/server/data/sailo.json` (git-ignored): set `DATA_DIR` to a persistent disk on Render or Railway, or accounts reset on each deploy. `PORTAL_VOYAGE_MS` (default 60000) sets how long a portal voyage takes. The vessel sails when the investor's funding lands, the agent releases the advance once AIS shows it under way, and it berths when the last 3 readings are at the quay at ≤ 0.5 kn.

## Environment

| Name | Needed | What it does |
| --- | --- | --- |
| `TREASURY_*`, `SHIPOWNER_*`, `LP_*`, `AGENT_*` (`_PUBLIC`, `_SECRET`) | yes | Testnet wallets from `npm run provision` |
| `VELO_API_KEY` | recommended | Real Velo checkout sessions. Without it, checkout is simulated and labeled |
| `VELO_WEBHOOK_SECRET` | recommended | Verifies real Velo webhooks. Without it, only self-signed simulated deliveries verify |
| `VELO_CHECKOUT_ASSET` | no | Default `native` (handbook example) |
| `APP_URL` | on deploy | Public URL, used for checkout success and cancel links |
| `LLM_API_KEY`, `LLM_MODEL`, `LLM_PROVIDER` | no | Gemini or Claude decides PROCEED or HOLD on each payout the rules permit. A Google key (`AIza…`) uses Gemini (default `gemini-flash-latest`), any other key Claude (default `claude-opus-5-5`); `LLM_PROVIDER` forces one. Without a key the rules decide. Amounts always come from code |
| `DEMO_TICK_MS` | no | AIS tick interval, default 1800 |
| `SIMULATE_CHAIN` | no | `1` runs the Noir contracts in memory (labelled "simulated", no Testnet). Also used automatically when wallet keys are missing; the dashboard can switch modes at runtime |

## Deploy

**Render or Railway (best for the live demo).** The demo keeps its state and the live event stream in one long-running process, so a host that keeps the process alive gives the most reliable demo.

- **Render:** New → Web Service → this repo. Build command `npm install --include=dev`, start command `npm start`, Node 24. Add the env vars above.
- **Railway:** New project from the repo. Start command `npm start`. Add the env vars above. Set `NIXPACKS_NODE_VERSION=24`.

**Vercel.** `vercel.json` and `npm run build` (`scripts/build-vercel.ts`) produce a [Build Output API](https://vercel.com/docs/build-output-api) deploy: `apps/web` is served as static files and the server is bundled into one function (`src/vercel.ts`) that handles `/api/*`. In the Vercel project settings use Framework Preset **Other**, leave Root Directory empty and don't override the build, install or output settings. Add the env vars above, and a Redis store: **Storage → Create Database → Upstash (Redis) → connect it to this project**. Without one, data lives in a single instance's memory and resets. With it:

- Accounts, sessions and portal invoices are loaded and saved under a short lock on every request (`withDb` in `src/db.ts`), so every instance sees the same data.
- The demo run is saved as a snapshot. One instance at a time holds the demo lease and runs steps; others show the snapshot and refuse a second step with "Busy". If the instance running a step disappears, the next visitor's instance takes the run over and resumes it (an interrupted voyage continues from its last AIS tick).
- Chain transactions take a per-account lock (`withAccount` in `src/wallets.ts`), so instances never race on a Stellar sequence number.
- Work after the response (transactions, voyages) runs through `waitUntil`, up to the 300 s function limit. The event stream reconnects every 5 minutes.

Then set the Velo webhook URL in the dashboard to `https://<your-host>/api/webhooks/velo`.

Health check: `GET /api/health`.

## API

`GET /api/state`, `GET /api/stream` (SSE), `POST /api/{tokenize|fund|depart|fast-forward|checkout|simulate-webhook|guardrail|default|reset|run-demo}`, `POST /api/webhooks/velo`.

## Where things live

- `src/demo.ts`: the state machine. Every chain call goes through one shared `NoirAgentClient`, one at a time
- `src/agent.ts`: decision policy (`AgentDecision`, roles only). It passes through `execute()` from `@noirxvelo/agent`
- `src/telemetry.ts`: AIS simulator and berthing rule
- `src/velo.ts`: checkout and webhook verification (`Velo.webhooks.verify`, raw body, 300 s tolerance, dedupe by `x-velo-delivery`)
- `../web`: frontend (role switcher, portals, voyage chart, decision stream, ops panel)
