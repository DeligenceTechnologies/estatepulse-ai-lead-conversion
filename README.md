# EstatePulse AI — Lead Conversion System

An AI real-estate lead-conversion platform: form submissions arrive by webhook,
are normalized into leads, and are worked by an AI voice/SMS agent.

```
frontend/   Vite + React SPA   :3000   the dashboard
backend/    Node + TypeScript  :4000   everything server-side
```

## The backend is one process, two frameworks

`backend/` serves two route families from a single Express instance:

| | framework | what it owns |
|---|---|---|
| **portal** | Express routers | auth (JWT), Telnyx AI calling, the strategy engine, a simple lead webhook |
| **ingestion** | NestJS modules | form-provider webhooks, signature verification, field mapping, the processing worker |

They are different frameworks because they were built separately, and rewriting
either would have meant rewriting working, tested code. They share one HTTP
listener, one middleware chain, one database connection and one deployment, so
the split costs nothing at runtime.

`src/server.ts` composes them, and **the order is load-bearing** — NestJS
registers a catch-all 404 during `init()`, so the Express routes must be mounted
before it. `src/app.ts` documents the sequence.

### Routes

```
/api/auth/*           portal — signup, login, me
/api/telnyx/*         portal — AI voice agent, numbers, assistants
/api/leads, /api/strategy, /api/ingest/sources
/api/v1/*             ingestion — lead-sources, integrations, leads
/ingest/v1/tally/:token   public form webhook (no /api prefix, see below)
```

The browser calls relative `/api/...` paths; Vite proxies them to `:4000` in
development and `VITE_API_URL` points at the backend in production.

Two things worth knowing:

- **One credential story.** The ingestion routes accept either an `X-Api-Key`
  (machine callers) or the portal's session token (the dashboard). Both resolve
  to an organization id, and tenancy is never read from a request body. The
  browser therefore holds no API key — an ingestion key can read a whole tenant.
- **The form webhook is deliberately outside `/api`.** Its URL is already
  installed on forms at the provider, so moving it would silently break every
  connected form until each was reinstalled.

## Run locally

**Prerequisites:** Node.js 20+, and a Postgres database (Supabase).

```bash
cp frontend/.env.example frontend/.env
cp backend/.env.example  backend/.env
```

`backend/.env` needs at minimum `DATABASE_URL`, `DIRECT_URL`, a `JWT_SECRET` of
32+ characters (`openssl rand -base64 48`), and `ENCRYPTION_KEYS`. **Back up
`ENCRYPTION_KEYS`** — losing it makes every stored provider credential and
webhook signing secret unreadable.

Two terminals:

```bash
cd backend  && npm install && npx prisma generate && npm run dev   # :4000
cd frontend && npm install && npm run dev                          # :3000
```

Open http://localhost:3000 and create an account.

## Tests and type-checking

```bash
cd backend  && npm test       # vitest — 85 unit tests: mapping, transforms, Tally, crypto
cd backend  && npm run test:auth   # node:test — auth, against the real database
cd backend  && npm run lint   # tsc --noEmit
cd frontend && npm run lint   # tsc --noEmit
```

## What each part does

**`frontend/`** — the dashboard. Most sections are still the in-browser demo
store (`src/context/AppContext.tsx`, persisted to `localStorage`); the sections
backed by the real API are marked LIVE and never read or write that store. Lead
Sources, the connection panels and the live half of the Leads view go through
`src/api/client.ts`; auth goes through `src/lib/api.ts`. Sections that are not
built yet render `ComingSoonView` rather than prototype data.

**`backend/src/{auth,telnyx,ingest}/`** — the portal. Signup/login/`me` with
per-request role resolution, the Telnyx bring-your-own-account integration, the
outbound strategy engine and call outcomes, and a generic lead webhook.

**`backend/src/modules/`** — the ingestion service. Receives form-provider
webhooks, verifies signatures against the raw request bytes, stores every
delivery, and runs a background worker that maps each submission's answers onto
canonical lead fields (name splitting, phone normalization to E.164, budget
ranges, consent) before creating the lead. Connecting a Tally form through its
API installs the webhook and pre-maps the form's fields before the first
submission arrives. See `TESTING-TALLY.md` to exercise it end to end.

## Production notes

`netlify.toml` builds and serves `frontend/` only. The backend deploys
separately; point the SPA at it with `VITE_API_URL` and list that origin in
`CORS_ORIGINS`. `PUBLIC_API_BASE_URL` must be a host form providers can reach.
