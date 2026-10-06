# EstatePulse AI — Lead Conversion System

An AI real-estate lead-conversion platform: form submissions arrive by webhook,
are normalized into leads, and are worked by an AI voice/SMS agent.

```
frontend/   Vite + React SPA   :3000   the dashboard
backend/    Node + TypeScript  :4000   everything server-side
```

## The backend is one NestJS application

`backend/` is a single NestJS app. Express appears only as the HTTP adapter
(`@nestjs/platform-express`, which is what every Nest app on this adapter uses)
and as three pieces of middleware — helmet, CORS and a rate limiter. There are
no hand-written routers: every endpoint is a controller, every dependency is
injected, and there is one way to do each thing.

| area | module |
|---|---|
| auth (JWT, signup/login/me) | `src/auth` |
| AI calling — Telnyx, assistant, numbers, strategy, engine | `src/telnyx` |
| the portal's simple lead webhook | `src/ingest` |
| form-provider ingestion, mapping, the delivery worker | `src/modules` |

### Two things to know before adding code

**Write new backend code as NestJS.** A controller, a provider, a module. If you
find yourself reaching for `express.Router`, that is the signal to write a
controller instead.

**Route paths are declared in full** (`@Controller('api/auth')`) rather than via
`setGlobalPrefix`. That is deliberate: the portal webhook and the provider
webhook both declare `ingest/v1/tally/:token`, and a prefix exclusion matches on
the declared path — it would silently unprefix both and collapse them onto one
route.

## Multi-tenancy

There is no row-level security: the API connects as a privileged role, so the
tenancy guard in `src/prisma/prisma.service.ts` **is** the isolation boundary
between customers. It refuses any read or write against a tenant-scoped table
that has no organization id (or globally-unique key) in its `where`.

Two clients, one connection pool:

- **`TENANT_PRISMA`** — the guarded client. Inject this. Almost everything does.
- **`PrismaService`** — unguarded. Injecting it directly is a deliberate,
  reviewable act, correct only for system processes that sweep every tenant by
  design: the delivery worker, the lead watcher, and the two credential lookups
  that resolve *which* tenant is calling. Each one carries a comment saying so.

The organization is always derived from the presented credential — an
`X-Api-Key` or the session token — and never from a request body.

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
cd backend  && npm test            # vitest — 85 unit tests: mapping, transforms, Tally, crypto
cd backend  && npm run test:auth   # node:test — 22 auth tests against the real database
cd backend  && npm run lint        # tsc --noEmit
cd frontend && npm run lint        # tsc --noEmit
```

`test:auth` compiles to `dist-test/` before running, and has to: it boots the
Nest container, and Nest's dependency injection needs `emitDecoratorMetadata`,
which esbuild-based loaders (tsx, and so vitest's default transform) cannot
emit. A test that boots Nest must run compiled, or every injected dependency
arrives as `undefined`.

## Request timing (`PERF_TIMING`)

Optional, dev-only instrumentation for finding slow endpoints. Off by default,
and refused when `NODE_ENV=production` (the server logs a warning instead).

```bash
cd backend && PERF_TIMING=1 STRATEGY_ENGINE=0 WORKER_ENABLED=false npm run dev
```

Each request then prints one line, and each SQL statement one `[perf:sql]` line:

```
[perf] GET /api/dashboard 200 total=307ms queries=3 db=410ms guard=150ms
```

- `queries` / `db` — statements Prisma sent and their summed engine time
  (parallel queries can make `db` exceed `total`).
- `guard` — time spent in `SessionGuard` / `TenantGuard` authentication.

Queries are attributed to whichever request is in flight, so the numbers are
only accurate with one request at a time and the background pollers off
(`STRATEGY_ENGINE=0`, `WORKER_ENABLED=false`), as above. The SQL lines include
statement text — keep them out of shared logs.

## What each part does

**`frontend/`** — the dashboard. Most sections are still the in-browser demo
store (`src/context/AppContext.tsx`, persisted to `localStorage`); the sections
backed by the real API are marked LIVE and never read or write that store. Lead
Sources, the connection panels and the live half of the Leads view go through
`src/api/client.ts`; auth goes through `src/lib/api.ts`. Sections that are not
built yet render `ComingSoonView` rather than prototype data.

**`backend/src/{auth,telnyx,ingest}/`** — the portal. Signup/login/`me` with
per-request role resolution, the Telnyx bring-your-own-account integration, the
outbound strategy engine and call outcomes, and a generic lead webhook. The
engine's scheduler is in-process (`setTimeout`), so a restart drops pending
steps; enrollment is idempotent and the lead watcher re-enrols anything still
untouched, but this is the piece that wants a durable queue before real volume.

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
