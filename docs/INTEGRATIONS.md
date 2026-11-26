# Integration Marketplace (Nango)

The **Integrations** page lists every provider in Nango's catalog. Each card
shows what the organization has connected and whether that provider can be
connected right now. Nango runs the consent screens, stores the credentials and
refreshes tokens. EstatePulse stores the Nango connection id and safe account
details only: no access token, refresh token or API key is ever written to our
database, logged, or sent to the browser.

## What "available" means

A provider is in one of four states. The backend works this out on every
request; the frontend has no list of its own.

| State | Meaning | Card shows |
|---|---|---|
| In Nango's catalog | `GET /providers` (Nango) lists it | Listed, "Not yet supported" |
| Configured in Nango | An integration exists for it in **our** Nango environment (`GET /integrations`), with `missing_fields` empty | — |
| Implemented by EstatePulse | An adapter exists in `backend/src/integrations/adapters/` | "Configuration required" until it is also configured |
| Connectable | Implemented **and** configured | "Ready to connect" |

The organization's accounts are counted on top: **Connected**, **N accounts**
or **Needs attention**.

### Current status (2026-11-26)

| Provider | Catalog | EstatePulse | What it does |
|---|---|---|---|
| Airtable | ✓ | **Fully supported, two-way** | You pick a base and a table, check the field mapping, and the table's rows are imported as leads. Lead changes made in EstatePulse are written back to the row. |
| HubSpot | ✓ | **Supported: contacts, two-way** | Contacts are imported as leads, and lead changes go back to the contact. Budget, bedrooms, timeline etc. can be mapped to your own contact properties. Companies and deals are not implemented yet. |
| Tally (`tally`) | ✓ | **Supported: form submissions, one-way** | The customer pastes a Tally API key in Nango's Connect UI, picks a form, and checks which question holds the name, email, phone, budget etc. Completed submissions are imported as leads; answers to other questions become custom fields. Read-only: nothing is written back to Tally. |
| Cal.com (`cal-com-v2`) | ✓ | **Supported: scheduling calendar** | The customer enters their Cal.com API key in Nango's Connect UI, then picks their own calendar or a team. That account becomes the organization's calendar: availability, booking links, the AI assistant booking on live calls, and meeting sync all use it. |
| Calendly (`calendly`) | ✓ | **Supported: scheduling calendar** | The customer signs in with Calendly (OAuth through Nango) and confirms their Calendly organization. They must be an owner or admin of it. It then works exactly like Cal.com: availability, booking links, AI booking on live calls, and meeting sync. Nango refreshes the 2-hour tokens. |
| Cal.com (v1 / OAuth) | ✓ | Not supported | Use **Cal.com (v2)**. |
| Everything else | ✓ | Not supported | Listed so customers can see what is possible; cannot be connected. |

Whether a provider is **configured** depends on your Nango environment; the
page shows it live.

## Nango dashboard setup

1. **Create an environment** (production, plus one per developer or staging).
2. **API key → `NANGO_SECRET_KEY`.** Environment Settings → API Keys.
3. **Webhooks.**
   - In Environment Settings → Webhooks, set the URL to `${PUBLIC_API_URL}/webhooks/nango`.
   - Enable the *auth* webhooks: creation, override, refresh and deletion.
   - Enable *sync* webhooks too, if you use Nango syncs.
   - Copy the **signing key** to `NANGO_WEBHOOK_SIGNING_KEY`. It is not the API key: environments created after 2026-04-20 have a separate one. Without it every webhook is refused (HTTP 503).
4. **Integrations.** Add one integration per provider you want connectable.
   - The integration key can be anything. Using the provider name (`airtable`, `hubspot`) is simplest.
   - If one provider has several integrations, EstatePulse prefers the one whose key equals the provider name and has no missing fields.

   | Provider | Auth | Scopes the integration must request |
   |---|---|---|
   | Airtable | OAuth 2 | `schema.bases:read data.records:read user.email:read`, plus **`data.records:write`** for two-way sync |
   | HubSpot | OAuth 2 | `oauth crm.objects.contacts.read`, plus **`crm.objects.contacts.write`** for two-way sync and **`crm.schemas.contacts.read`** for the optional field mapping |
   | Calendly | OAuth 2 (template **"Calendly"**, provider `calendly`) | No Nango scopes. Register an OAuth app in Calendly's developer portal with Nango's callback as its redirect URL, then paste its client id and secret into Nango. Webhooks for booking updates need a paid Calendly plan; without one, meetings sync every 5 minutes. |
   | Tally | API key (template **"Tally"**, provider `tally`) | None. Each customer creates a key at tally.so → Settings → API keys (`tly-…`) and pastes it into Connect UI. The key can see what its Tally user can see. Tally allows 100 requests/minute per key; a sync reads 500 submissions per request. |
| Cal.com | API key (template **"Cal.com (v2)"**, provider `cal-com-v2`) | None. No OAuth app: each customer pastes their own Cal.com API key into Connect UI. To book for a team, the key's owner must be an owner or admin of that team. |

   For each OAuth provider, create an OAuth app in that provider's developer
   console. Set its redirect URL to Nango's callback (`https://api.nango.dev/oauth/callback`,
   or your custom callback domain). Then paste the client id and secret into the Nango integration.

## Environment variables (backend)

| Variable | Required | Purpose |
|---|---|---|
| `NANGO_SECRET_KEY` | for connecting | Nango environment API key. Unset: the page lists the supported integrations as "configuration required" and nothing connects. |
| `NANGO_WEBHOOK_SIGNING_KEY` | for webhooks | Verifies `X-Nango-Hmac-Sha256`. |
| `NANGO_HOST` | self-hosted only | Nango API URL. It is also sent to the browser for Connect UI; it is not a secret. |
| `NANGO_CONNECT_UI_URL` | self-hosted only | Connect UI URL. |
| `INTEGRATION_WORKER_ENABLED` | no (true) | Runs the import worker on this instance. |
| `INTEGRATION_WORKER_CONCURRENCY` | no (2) | Imports processed at once. |
| `INTEGRATION_SYNC_MAX_RECORDS` | no (20000) | Records read per sync at most. The run is marked truncated if the limit is hit. |

The browser receives a Nango **connect session token** only. It is short-lived
and limited to one integration.

## Database

The migration is `backend/prisma/migrations/20261126000002_integration_connections`.
It is **additive**: three tables, three enums, and a partial unique index. Nothing
existing is changed.

- `integration_connections` holds one row per connected account.
  - `nango_connection_id` is unique.
  - Nothing is unique on (organization, provider), so an organization can connect any number of accounts of one provider.
  - It also stores the account name, email and id, safe metadata, provider settings (e.g. the Airtable base, table and field map), the lead source, the last sync, and the last error.
- `integration_sync_runs` holds one row per sync (status, counts, error).
  - `integration_sync_runs_one_active` allows one queued or running sync per connection.
- `integration_records` maps each external record id to the lead it became, plus a content hash. This makes re-syncs idempotent.

Apply it with:

```bash
cd backend
npx prisma migrate deploy   # production / any DB tracked by _prisma_migrations
npx prisma generate
```

It applies cleanly after `20261126000001_remove_integrations`.

Two-way sync adds `20261126000003_integration_two_way_sync`, also **additive**:
`write_back_enabled` / `write_back_error(_at)` on `integration_connections`, and
`sync_state`, `local_checked_at`, `pushed_at`, `push_error(_at)` (plus one index)
on `integration_records`. Existing accounts keep write-back **off** until an
owner switches it on; accounts connected after it is applied start with it on.

## How connecting works

1. **Connect.** The person clicks Connect.
   - The browser calls `POST /api/integrations/:providerId/connect`.
   - The server checks the provider is connectable.
   - It then creates a Nango connect session, limited to that integration and tagged with `organization_id` and `end_user_id` taken from the session. Nothing comes from the request body.
2. **Authorize.** The browser opens Nango's Connect UI with the session token, and the person authorizes.
3. **Confirm.** On Connect UI's `connect` event, the browser sends `POST /api/integrations/connections/confirm { providerConfigKey, connectionId }`. The server:
   - reads the connection from Nango;
   - refuses it unless its tags name the caller's organization (a connection id from the browser is never trusted on its own);
   - reads the account identity;
   - creates the row and a lead source;
   - writes an audit entry.
4. **Webhook backup.** Nango's `creation` webhook does the same linking. If the tab closed before step 3, the connection still appears. Both paths are idempotent.
5. **Import.**
   - HubSpot starts importing right away.
   - Airtable waits for the base, table and field-map setup, then imports.
   - Tally waits for the form and question-map setup, then imports.

Connecting another account repeats this flow and never touches the existing accounts.

**Reconnect.** `POST /connections/:id/reconnect` gives a Nango reconnect session for the same connection id. Confirming it restores the row to `connected`.

**Disconnect.**
- `POST /connections/:id/disconnect` deletes the connection in Nango first. If Nango cannot be reached, nothing changes locally.
- On success the row is marked `disconnected`, queued syncs are cancelled and the lead source is archived.
- **Imported leads stay.**

### Connection states

| State | Meaning |
|---|---|
| `connected` | Working. |
| `reauth_required` | Nango failed to refresh the grant (webhook), the provider rejected the token, or the connection was deleted in Nango. Shows **Reconnect**. |
| `error` | Our side is misconfigured for it. |
| `disconnected` | Removed by the organization. |

The UI also shows **Setup needed**, **Sync queued**, **Syncing**, the last sync
result, and the provider-level states listed above.

## API

All of these are under `/api`. They need a session plus `integration.read` (GET)
or `integration.update` (everything else), and they are always scoped to the
session's organization.

| Method | Path | |
|---|---|---|
| GET | `/integrations/providers?search=&category=&status=all\|connected\|not_connected\|supported&limit=&offset=` | Catalog with readiness, category facets and counts |
| GET | `/integrations/providers/:providerId` | Details, features, required scopes, missing Nango fields, the org's accounts |
| POST | `/integrations/:providerId/connect` | Connect session `{ sessionToken, expiresAt, providerConfigKey, apiURL, baseURL }` |
| POST | `/integrations/connections/confirm` | Link the connection Connect UI reported (verified with Nango) |
| GET | `/integrations/connections?provider=&status=&includeDisconnected=` | The org's accounts |
| GET | `/integrations/connections/:id` | One account |
| POST | `/integrations/connections/:id/reconnect` | Reconnect session |
| POST | `/integrations/connections/:id/disconnect` | Disconnect |
| GET | `/integrations/connections/:id/resources?kind=&parentId=` | Setup choices (Airtable: `bases`, `tables`) |
| PATCH | `/integrations/connections/:id/settings` | Save setup `{ settings }`, validated against the provider |
| POST | `/integrations/connections/:id/sync` | Queue a sync (202). Returns the active run if one is already queued or running. |
| GET | `/integrations/connections/:id/sync-runs` | Recent runs |
| PATCH | `/integrations/connections/:id/write-back` | Two-way sync on or off `{ enabled }`. Turning it on queues a sync so every linked record gets its base. |
| POST | `/webhooks/nango` (root, public, HMAC) | Nango webhooks |

## Syncs

- **Queue.** Syncs run on the `integration-sync` BullMQ queue. It is registered in `QueueModule` and uses the shared Redis and `QUEUE_PREFIX`. An HTTP request never waits on a provider.
- **Duplicate prevention.** The partial unique index allows one active run per connection. The job id is the run id. The worker skips a run that is no longer queued or running.
- **Retries.** 5 attempts with exponential backoff starting at 1 minute.
  - **Rate limited:** the job is delayed by `Retry-After` without spending an attempt. Nango's proxy also retries 429s and 5xx three times first.
  - **Revoked grant:** the connection becomes `reauth_required` and the run fails at once.
  - **Setup problem** (table deleted, bad mapping): the run fails at once with the reason.
- **Idempotency.**
  - An unchanged record (same content hash) costs no writes.
  - A new or changed record goes through `LeadIntakeService`, so a person already in EstatePulse is attached to that lead: blanks are filled and nothing is overwritten. They are never duplicated.
  - One bad record is counted as failed; it never sinks the run.
- **Lead safety.** A new imported lead is created `consent pending`, **paused**, and held for review ("Imported from <Provider> — awaiting owner approval"). The provider gives no consent for EstatePulse to call or text anyone, so an owner approves before outreach.
- **Automatic sync.** `INTEGRATION_SYNC_INTERVAL_SECONDS` (0 or unset = off) queues a sync of every connected, set-up account whose last sync ended at least that many seconds ago.
  - Accounts with a sync already running are skipped.
  - A failed account waits at least 5 minutes before the timer tries again.
  - Timer runs that find nothing new are not kept as run rows, not audited and not logged.
- **Stuck runs.** A run left `running` for 2 hours is released when the next sync is requested.

## Two-way sync

Airtable and HubSpot sync both ways. It is controlled per account by the **Two-way sync** switch on the Integrations page.

- **Base per field.** Every linked record keeps the last agreed value of each synced field, separately for each side (`integration_records.sync_state`). A side has changed a field when its value differs from its own base. The rules are pure functions in `backend/src/integrations/sync/two-way.ts`:
  - Changed only in the provider: the lead takes the new value.
  - Changed only in EstatePulse: the value is written to the provider.
  - Changed on both sides: **EstatePulse wins**, and its value is written back.
  - First time a record is linked: nothing is overwritten on either side. Only blanks on the lead are filled, as one-way import always did.
  - Formatting-only differences are not changes: email case, phone punctuation, and money below a cent.
- **Fields.**
  - Airtable: every mapped column. Formula, lookup, rollup, date and other read-only column types are never written. A full-name column is rebuilt from first + last name.
  - HubSpot: first and last name, email, phone (written to `mobilephone` if the number came from there, otherwise `phone`), and Message as motivation. Optionally, budget, bedrooms, timeline, location and motivation can be mapped to the portal's own writable properties ("Map fields").
- **When EstatePulse writes.** Writes are push jobs on the `integration-sync` queue. Each record has one pending job at a time, and edits within 5 s are coalesced. Jobs are queued two ways:
  - A `lead.updated` event (an edit in the app, a merge) queues within seconds.
  - A sweep every 2 minutes catches every other change, such as the AI assistant updating a lead during a call. It compares `leads.updated_at` with `local_checked_at`.

  An unchanged lead costs one database read, never an API call.
- **Never reverting.** A page read before our own write reached the provider is not merged (`pushed_at` is newer than the page read). Merges and writes lock the record row.
- **Failures never lose a change.** The base moves only after the provider accepted the write.
  - 403, no write access: write-back pauses for that account. The account shows which scope to add. Reconnecting, or switching it on again, resumes it.
  - 404 (record deleted) or 422 (value refused): shown on the record. The change stays in EstatePulse and is retried when the lead changes again, or after an hour.
  - Revoked grant: the account becomes `reauth_required`.
  - Rate limits and outages: retried by the queue.
- **Existing connections must reconnect** once the write scopes are added in Nango, because a grant only holds the scopes it was approved with. Until then, the first write pauses write-back with that message.

## Webhooks

- **Verification.** Each delivery is checked with `Nango#verifyIncomingWebhookRequest`: HMAC-SHA256 of the raw body, keyed with the signing key.
- **Deduplication.** A delivery is remembered in Redis by its body hash for 48 hours, so redeliveries are processed once. A processing failure forgets it, so Nango's retry is processed.
- **Organization.** For an existing connection, the organization always comes from our row, looked up by Nango connection id. For `creation`, it comes from the server-written tags, re-read through Nango's API.

| Event | Effect |
|---|---|
| `auth` creation / override (success) | Link or update the connection |
| `auth` refresh (failure) | `reauth_required` |
| `auth` refresh (success) | Back to `connected` |
| `auth` deletion | `reauth_required` ("removed from Nango"). A no-op if we disconnected it ourselves. |
| `sync` (success, records changed) | Queue an EstatePulse sync |

## Tally

- **Setup.** Choose a form (blank forms are hidden), then map questions to lead fields. Mapping uses Tally's question ids, so renaming a question in Tally keeps it mapped. Email and phone blocks are matched automatically; other fields are guessed from question titles. Email or phone must be mapped.
- **What is imported.** Only completed submissions (`filter=completed`); partial ones are skipped. Each submission is one record (`tally:<formId>`, external id = submission id), so a re-sync costs no writes for submissions already imported.
- **Answers.** Tally does not document the answer shape per question type, so the adapter takes a plain string/number answer as is, otherwise Tally's `formattedAnswer`, otherwise the text inside arrays/objects. Budget answers that are ranges ("50L – 75L") are not guessed as a number; they stay in the custom fields only if unmapped. File uploads, signatures and payments are not kept.
- **Errors.** A deleted form, or one the key can no longer see (404), fails the run with "choose another form". A revoked key (401) marks the account `reauth_required`. A mapped question that was deleted just leaves that lead field empty (logged).
- **No webhooks yet.** Submissions arrive with the manual **Sync** or the `INTEGRATION_SYNC_INTERVAL_SECONDS` timer. Tally's own webhooks could be added later for real-time leads.

## Cal.com, Calendly and the calendar module

Neither is imported as leads. Both are handled the same way (`CalendarAdapterBase`).
Cal.com is described below; Calendly differs only in where the credential comes
from: an OAuth access token instead of an API key.

- **Tokens.** The cached token is never used within 5 minutes of its expiry.
  If Calendly still refuses one, the calendar module asks Nango to force a
  refresh and retries the call once. Only if that also fails is the calendar
  parked for reconnecting. A refresh that Nango itself cannot do
  (`failed_to_refresh` / `invalid_credentials`) counts as "reconnect".
- **Workspace.** A Calendly account books into its current Calendly
  organization. Its user must be an owner or admin of that organization.
- **Revocation on disconnect.** Nango deletes the tokens. EstatePulse no longer
  holds the OAuth client secret, so it does not call Calendly's revoke endpoint.
  The access token expires on its own within two hours.

Cal.com is not imported as leads. It hands its connection to the calendar
module, which already does availability, booking, the AI's in-call booking tool,
meeting sync and Cal.com webhooks.

- **Credentials.** The `calendar_connections` row stores only a reference to the
  Nango connection (`nango:v1:[providerConfigKey, connectionId]`), never the key.
  The calendar module reads the key from Nango when it calls Cal.com and keeps it
  in memory for at most a minute. Because nothing is sealed, this path works
  without `INTEGRATION_ENCRYPTION_KEY`. Cal.com booking webhooks still need that
  key; without it, availability syncs every 5 minutes instead.
- **One calendar per organization.** Several Cal.com accounts can be connected,
  but choosing a calendar on one makes it the one in use. Any other Cal.com
  account goes back to "Set up", and a Calendly in use is switched off (kept,
  not deleted).
- **Broken key.** If Cal.com rejects the key, or the connection disappears from
  Nango, booking pauses, the account shows **Reconnect** on the Integrations
  page, and the owner gets the usual "connection broken" email, linking to
  `/integrations`. Reconnecting resumes booking after a fresh sync.
- **Disconnect.**
  - On the Integrations page: removes the Cal.com webhook (while the key still
    works), deletes the connection in Nango, then removes the calendar and its
    synced data.
  - In Settings → Calendar: removes the calendar only. The Cal.com account stays
    connected and goes back to "Set up".

## Adding a provider

1. **Write the adapter.** Create `backend/src/integrations/adapters/<provider>/<provider>.adapter.ts`, implementing `IntegrationAdapter`:
   - `provider` is Nango's catalog name (`ApiProvider.name`).
   - Add `displayName`, `description`, `features`, `capabilities`, `requiredScopes` and `leadSourceProvider`.
   - `identify()` and `validateConnection()` make cheap calls through `ctx.client` (Nango proxy).
   - Optional `setup`: `resourceKinds`, `state`, `listResources`, `saveSettings`. Validate every id against the provider.
   - Optional `import`: `sourceName` and `fetchPage(ctx, cursor)`, which returns `ImportedRecord`s and the next cursor. The engine handles idempotency, leads, retries and stats.
2. **Register it.** Add it to `ADAPTERS` in `integrations.module.ts`.
3. **Set up the frontend (only if setup is needed).** Add a setup panel to `SETUP_PANELS` in `frontend/src/components/integrations/marketplace/ConnectionRow.tsx`.
4. **Configure Nango.** Add the integration in the dashboard with the scopes the adapter lists.

An adapter that feeds another module rather than importing leads (like Cal.com
feeding the calendar) implements `lifecycle`: `beforeDisconnect`,
`disconnected`, `accessLost` and `accessRestored`. These are best-effort hooks
that the connection code calls at those moments.

For two-way sync, an importing adapter also implements `writeBack`:
- `writeScopes`
- `fields(settings)`: the lead fields it exchanges
- `writableFields(ctx)`
- `push(ctx, target, changes, current)`: one PATCH; throws `NangoError` or `WriteRefused`

The engine decides what changed; the adapter only knows how to write it.

Nothing else changes: catalog, cards, connect, accounts, sync queue and webhooks
are generic.

**Adding provider-specific sync behaviour** (e.g. HubSpot companies): give the
adapter another object type in `fetchPage` (or a second adapter capability),
map it to `ImportedRecord` with its own `objectType` (`hubspot:company`), add
the scope to `requiredScopes`, and update `features`.

## Local development

1. Create a development environment in Nango and put its keys in `backend/.env`.
2. Expose the API for webhooks, e.g. `cloudflared tunnel --url http://localhost:4000`. Set the Nango webhook URL to `<tunnel>/webhooks/nango`.
3. Run `npx prisma migrate deploy` against your own database.
4. Start the backend. The integration worker starts unless `INTEGRATION_WORKER_ENABLED=false`.

## Production checklist

- `NANGO_SECRET_KEY` and `NANGO_WEBHOOK_SIGNING_KEY` are set from the **production** Nango environment.
- The webhook URL is `https://<api>/webhooks/nango`. `/webhooks/*` has its own per-IP rate-limit bucket.
- Every provider's OAuth app has Nango's redirect URL, and it is approved for production by the provider where required (HubSpot marketplace, Airtable).
- The migrations have been applied (`…000002_integration_connections`, `…000003_integration_two_way_sync`).
- For two-way sync, the write scopes are added to the Airtable and HubSpot integrations in Nango, and existing accounts have reconnected.
- At least one instance runs the integration worker.
