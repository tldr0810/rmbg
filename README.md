# Cloudflare Worker Starter for Manyfold Agents

A Cloudflare Workers app template pre-wired with [Manyfold](https://manyfold.ai) AI-agent
connectivity. Deploy it in one click, connect your Manyfold agents from the page, verify the
wiring with a streaming chat — then build whatever you actually wanted to build on top of a
stack that already works.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/manyfold-open/cloudflare-worker-starter)

```
┌──────────────┐    ┌───────────────┐    ┌────────────────────┐    ┌──────────────────┐
│ 1. Deploy    │ →  │ 2. Open your  │ →  │ 3. Connect an      │ →  │ 4. Chat to       │
│  (button or  │    │    Worker URL │    │    agent (approve  │    │    verify, then  │
│  fork+Builds)│    │               │    │    on Manyfold)    │    │    build your app│
└──────────────┘    └───────────────┘    └────────────────────┘    └──────────────────┘
```

## What you get

- **Connect an agent** — a device-code handshake against Manyfold: a popup opens Manyfold's
  consent page, you compare the confirmation code, pick which agents to share, done. Bearer
  tokens land AES-GCM-encrypted in your D1 database and never reach the browser.
- **Chat** — a streaming chat (A2A `message/stream` over SSE) with each connected agent.
  Conversations persist in D1 and keep the agent-side `contextId`, so multi-turn context works
  across reloads.
- **Settings** — see every connected agent, re-run the (free, non-billing) connectivity probe,
  disconnect, or connect more. Re-approving an agent rotates its token in place.
- **A clean base to iterate on** — Vite + React 19 + Hono on one Worker, D1 with a
  zero-migration schema, ~no magic. Add a route, a table, a component, ship.

## Deploying

### Path A — Deploy to Cloudflare button (recommended)

> [!IMPORTANT]
> **Before clicking "Deploy" in the Cloudflare form, expand the "Advanced settings" section once.**
> As of August 2026 a Cloudflare dashboard bug leaves hidden form fields (build API token,
> non-production deploy command) uninitialized while that section is collapsed — the flow then
> stalls silently after creating the repository, with no error shown. Expanding the section
> auto-fills them and the deploy completes normally. This is a dashboard-side issue, not
> specific to this template.

Click the button above. Cloudflare will:

1. create a copy of this repository in your GitHub/GitLab account,
2. provision the D1 database declared in `wrangler.jsonc` and write the real `database_id`
   into your copy,
3. wire the repo to **Workers Builds** — every push to `main` builds (`npm run build`) and
   deploys (`npx wrangler deploy`) automatically.

No secrets are required. Open the Worker URL and you are at step 2 of the diagram.

### Path B — fork / use as template, connect Workers Builds yourself

1. Fork this repo (or "Use this template") on GitHub.
2. Create the database: `npx wrangler d1 create manyfold-app-db`, then paste the returned
   `database_id` into `wrangler.jsonc`.
3. In the Cloudflare dashboard: **Workers & Pages → Create → Connect to Git**, pick your fork,
   set build command `npm run build` and deploy command `npx wrangler deploy`.
4. Push to `main` — Workers Builds deploys it.

### After deploying (both paths)

Recommended once your URL is public — without a password anyone who finds the URL can chat
with (and bill) your agents:

```bash
npx wrangler secret put ADMIN_PASSWORD
```

Optional, keeps the credential-encryption key out of the database (see
[Security notes](#security-notes)):

```bash
npx wrangler secret put CONFIG_ENCRYPTION_KEY
```

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then uncomment MANYFOLD_API_BASE_URL / ENVIRONMENT
npm run dev
```

One command runs everything: Vite serves the React app with HMR while the Worker runs in
workerd with a **local D1 database emulated automatically** — the schema is applied on the
first request, so there is no migration step, ever.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server (app + worker + local D1) |
| `npm run check` | Typecheck, build, `wrangler deploy --dry-run` |
| `npm test` | Unit tests (vitest) |
| `npm run deploy` | Manual deploy (Workers Builds normally does this) |
| `npm run smoke -- <url>` | Smoke-test a deployment |

## How it is put together

```
Browser (React SPA, dist/client)
   │  /api/* (run_worker_first)             everything else → static assets
   ▼
Hono app (src/worker/index.ts)
   │ ensureSchema → origin check → admin gate
   ├─ /api/connect*   src/worker/connect.ts   Manyfold device-code handshake
   ├─ /api/agents*    src/worker/connect.ts   list / verify / disconnect
   ├─ /api/agents/:id/chat  src/worker/chat.ts  SSE passthrough + persistence
   ▼
D1 (settings, connect_sessions, agents, conversations, messages)
Manyfold A2A (message/stream, tasks/get)   ← per-agent bearer token, decrypted per call
```

| File | Purpose |
| --- | --- |
| `src/worker/index.ts` | Routes, middleware, error mapping |
| `src/worker/connect.ts` | The Manyfold handshake and connected-agent store |
| `src/worker/a2a.ts` | A2A JSON-RPC + SSE stream consumer, SSRF guard, secret redaction |
| `src/worker/chat.ts` | One chat turn: agent SSE in, app SSE out, D1 persistence |
| `src/worker/crypto.ts` | AES-GCM seal/unseal, constant-time compare |
| `src/worker/db.ts` | Schema (runtime-applied) and settings store |
| `src/shared/types.ts` | API types shared by worker and browser |
| `src/app/` | React app: chat + settings tabs, connect panel, password gate |

## Extending it

This template is a starting point, not a framework. The intended loop:

- **New API route** — add it in `src/worker/index.ts`; anything except `/api/health` and
  `/api/state` is automatically behind the admin password when one is set.
- **New table** — append a `CREATE TABLE IF NOT EXISTS …` to `SCHEMA` in `src/worker/db.ts`;
  it is created on the next request, locally and in production.
- **New page** — add a component and a tab in `src/app/App.tsx`.
- **Call your agent from server code** — `credentialFor(env, agentId)` in
  `src/worker/connect.ts` gives you `{ rpcUrl, token }` for any connected agent; see
  `src/worker/chat.ts` for a full streaming turn, or use non-streaming `message/send` +
  `tasks/get` for background work.

`AGENTS.md` lists the invariants to preserve while iterating — useful for both humans and
AI agents working on this codebase.

## Security notes

- **The device-code handshake is designed so credentials never touch the browser.** The
  browser sees an opaque `connectId`; the device code (the only thing that can redeem agent
  tokens) is encrypted in D1 and redeemed exactly once. The confirmation code shown in the
  page is the flow's anti-phishing check — the Manyfold consent page must show the same code.
- **Agent tokens are AES-GCM encrypted at rest** with a key derived from
  `CONFIG_ENCRYPTION_KEY`, or — so that one-click deploys work with zero setup — from a
  random key generated on first use and stored in the same database. The trade-off is
  honest: a generated key protects against partial exposure (logs, a table-scoped query) but
  not against a full database dump. Set the secret to remove that caveat.
- **The app is open by default.** Anyone with the URL can connect agents and chat until you
  set `ADMIN_PASSWORD`. All routes except `/api/health` and `/api/state` then require the
  password (compared in constant time; sent as a header, kept in sessionStorage).
- Agent RPC URLs are validated (https-only, private/loopback addresses rejected in
  production), verification uses a non-billing `tasks/get` probe rather than a real turn, and
  every error string is stripped of anything token-shaped before it can reach a log or the
  browser.

## Licence

[MIT](LICENSE)
