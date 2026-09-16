# EstatePulse AI — Lead Conversion System

An AI real-estate lead-conversion platform: form submissions arrive by webhook,
are normalized into leads, and are worked by an AI voice/SMS agent.

The repository is **three services**. They share one Postgres database (Supabase)
but are separate processes with separate dependencies, and each has its own
`.env`.

```
frontend/   Vite + React SPA              :3000   the dashboard
backend/    Express + TypeScript portal   :4000   auth, AI calling, the bridge
server/     NestJS ingestion service      :3001   form webhooks, mapping, worker
```

## How the three fit together

The browser only ever talks to the portal. It calls relative `/api/...` paths,
which the Vite dev server proxies to `:4000`.

```
browser ──▶ frontend :3000 ──▶ backend :4000 ──▶ server :3001
                                  │                  │
                                  │                  └─ form providers post
                                  │                     webhooks here directly
                                  └─ Postgres ◀────────┘
```

`backend` owns the session. A logged-in request to `/api/tally/*` is checked
against the JWT, and the bridge in `backend/src/tally/routes.ts` forwards it to
`server` with that organization's `x-api-key` attached server-side. The
ingestion key can read a whole tenant, so it must never reach the browser — and
because the organization comes from the session rather than from a key baked
into the build, two logged-in organizations never share one credential.

Inbound form webhooks are the one exception: providers post straight to
`server` on `:3001`, authenticated by the per-source token in the URL and, when
configured, an HMAC signature.

## Run locally

**Prerequisites:** Node.js 20+, and a Postgres database (Supabase).

Copy the three env files and fill them in — the root `.env.example` explains
what each one owns:

```bash
cp frontend/.env.example frontend/.env
cp backend/.env.example  backend/.env
cp server/.env.example   server/.env
```

`backend/.env` needs at minimum `DATABASE_URL`, `DIRECT_URL`, a `JWT_SECRET` of
32+ characters (`openssl rand -base64 48`) and an `ENCRYPTION_KEY` of exactly 64
hex characters (`openssl rand -hex 32`). The server refuses to boot otherwise.

Then, in three terminals:

```bash
cd server   && npm install && npx prisma generate && npm run dev   # :3001
cd backend  && npm install && npx prisma generate && npm run dev   # :4000
cd frontend && npm install && npm run dev                          # :3000
```

Open http://localhost:3000 and create an account.

Start `server` first: the portal's Tally bridge returns a clear
`TALLY_SERVICE_UNREACHABLE` if the ingestion service is down, but the Lead
Sources screen will be empty until it is up.

## Tests and type-checking

```bash
cd server   && npm test      # vitest — mapping, transforms, Tally adapter, crypto
cd backend  && npm test      # node:test — auth (needs a reachable database)
cd frontend && npm run lint  # tsc --noEmit
```

## What each service does

**`frontend/`** — the dashboard. Most sections are still the in-browser demo
store (`src/context/AppContext.tsx`, persisted to `localStorage`); the sections
backed by the real API are marked LIVE in the UI and never read or write that
store. Lead Sources, the connection panels, and the live half of the Leads view
go through `src/api/client.ts`. Auth goes through `src/lib/api.ts`. Sections that
are not built yet render `ComingSoonView` rather than prototype data.

**`backend/`** — the portal API. Signup/login/`me` with per-request role
resolution, the Telnyx bring-your-own-account integration, the outbound strategy
engine and call outcomes, a generic lead-ingestion webhook, and the authenticated
bridge to the ingestion service.

**`server/`** — the ingestion service. Receives form-provider webhooks, verifies
signatures against the raw request bytes, stores every delivery, and runs a
background worker that maps each submission's answers onto canonical lead fields
(name splitting, phone normalization to E.164, budget ranges, consent) before
creating the lead. Connecting a Tally form through its API installs the webhook
and pre-maps the form's fields before the first submission arrives. See
`TESTING-TALLY.md` for how to exercise it end to end.

## Production notes

`netlify.toml` builds and serves `frontend/` only. The two backends deploy
separately; point the SPA at the portal with `VITE_API_URL`, and list that origin
in the portal's `CORS_ORIGINS`. The portal reaches the ingestion service over
`TALLY_API_URL`, which should not be publicly routable except for the
`/ingest/...` paths that form providers must reach.
