# Google Sheets lead import — configuration, rollout and recovery

An owner connects a Google account, picks a spreadsheet and tab, and maps its
columns to lead fields. Every importable row becomes a lead that waits in
**Import Review**, paused. Nobody is called or texted until the owner approves it.
After that, the sheet is re-read on a schedule. New rows are imported for review.
Edits to rows that have already been reviewed are flagged for the owner, never
written over the lead.

Code: `backend/src/modules/google-sheets/`, `frontend/src/components/sheets/`,
`frontend/src/components/views/ImportReviewView.tsx`.
Migration: `backend/prisma/migrations/20261012000001_google_sheets_import/`.

---

## 1. Safety model (what the code guarantees)

| Guarantee | Where it is enforced |
|---|---|
| Every imported lead is inserted with `automation_paused = true` and a review reason. | `SheetImportService` |
| Approving a lead releases it only when it is not DNC, has a dialable phone, is still `new` and has no human takeover. Approval never calls the outreach engine. The engine picks the lead up through its normal watcher. | `SheetReviewService.approve` |
| Rejecting a lead sets `status = closed`. The lead stays paused. | `SheetReviewService.reject` |
| A reviewed lead (approved or rejected) is never overwritten from the sheet. Changes are held for the owner, who chooses *apply* or *keep*. *Apply* never clears DNC and never unpauses a lead. | engine + `resolve` |
| A row is imported at most once. | unique `(lead_source_id, row_key)`; lead and tracking row written in one transaction |
| A row is marked missing only after a **complete** read. Leads are never deleted. | engine |
| One run per source at a time. | `FOR UPDATE SKIP LOCKED` lease, released only by its holder |
| Every send re-checks the lead before sending. | `EngineService.fireStep`, `FollowupRunner.execute` (the only two send paths) re-check `dnc_status` and `automation_paused` |
| Sheet values never set tenant, DNC, pause, status, assignment, temperature, score or `first_contact_at`. | sheet-mappable targets are limited in `sheet-rows.ts` |
| All routes are owner-only. The organization always comes from the session, never from the request. | `SessionGuard` → `OwnerGuard` → `SheetsEnabledGuard` |
| The server refresh token is encrypted (AES-256-GCM, bound to its row) and never reaches the browser. The browser's Picker token never reaches the server. | `GoogleConnectionsService` |

**Not enforced yet: consent.** By product decision, consent verification is
deferred to before the production launch. Imported leads are contacted after
owner approval, like leads from every other source. See §8.

---

## 2. Configuration

All variables go in `backend/.env`; `backend/.env.example` documents each one.

| Variable | Default | Meaning |
|---|---|---|
| `GOOGLE_SHEETS_ENABLED` | off | **Rollout flag.** Unless it is `1`, every Sheets route answers 404 (`GOOGLE_SHEETS_DISABLED`, even to owners), nothing syncs, and the Integrations card and the *Import Review* menu item are hidden. Turning it off changes no data. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | OAuth "Web application" client. If unset, the card says "not configured". |
| `GOOGLE_REDIRECT_URI` | `${PUBLIC_APP_URL}/oauth/google-callback.html` | Must match the Google console exactly. It is a static page on the **app** origin. |
| `GOOGLE_PICKER_API_KEY` / `GOOGLE_APP_ID` | unset | Browser-side Picker values. Restrict the API key to the app origin. `GOOGLE_APP_ID` is the Cloud project **number**. |
| `SHEETS_SYNC` | off | `1` turns on periodic sync. Owner actions (switch on, *Sync now*) run either way while the feature is enabled. |
| `SHEETS_POLL_MS` | `60000` | How often the scheduler looks for due sources. |
| `SHEETS_SYNC_INTERVAL_MS` | `300000` | How often each source is re-read. |
| `SHEETS_VERSION_PROBE` | off | `1` lets scheduled syncs skip a sheet whose Drive version has not moved. *Sync now* and *Switch on* always read the whole sheet, because Drive's version can lag an edit by several seconds. |
| `SHEETS_FULL_READ_MAX_AGE_MS` | `21600000` | With the probe on, a sheet is still fully re-read at least this often. |

The import also relies on the existing `ENCRYPTION_KEYS` / `ENCRYPTION_ACTIVE_KEY_ID` and `PUBLIC_APP_URL`.

**Google Cloud project setup:**

- Enable the Google Drive API, Google Sheets API and Google Picker API.
- Create an OAuth client of type *Web application*:
  - Authorized redirect URI: the callback page above.
  - Authorized JavaScript origin: the app origin, which the Picker needs.
- Scopes: `drive.file`, `openid` and `email` only. `drive.file` is non-sensitive. It covers only the files an owner picks.
- While the app is in **Testing** mode:
  - only the listed test users can connect;
  - Google expires refresh tokens after 7 days.
- Production needs the OAuth consent screen published (verification).

---

## 3. Limits

| Limit | Value | Behaviour at the limit |
|---|---|---|
| Data rows per tab | 10,000 | The run stops before writing anything (`SHEET_TOO_LARGE`) and the source pauses. |
| Columns read | 200 | Columns beyond 200 are not read. |
| Row ids per approve, reject or resolve request | 500 | The UI sends larger selections in batches. |
| Google read chunk | 2,000 rows | — |
| Database write batch | 500 rows | Each batch is one transaction of three statements. |
| Lease timeout | 10 min | A lease older than this is presumed dead and is taken over. |
| Backoff after a transient failure | 60 s × 2^failures, capped at 1 h, ±20% jitter | — |
| Google quota | 300 read requests per minute per project; 60 per minute per user | A full 10,000-row read costs 8 requests. |

Measured on the dev database (Postgres 16, remote) with a fake Google:

| Run | Time | DB statements | Google requests |
|---|---|---|---|
| 10,000 rows, first import | 8.9 s | 64 | 8 |
| 10,000 rows, unchanged sync | 1.0 s | 4 | 8 (1 with the version probe) |
| 10,000 rows, 10% edited | 4.7 s | 64 | 8 |
| Approving 2,000 rows (4 requests) | 1.8 s | constant per request | — |

---

## 4. Deploying

1. **Check the target database first. Never assume its schema.**
   ```bash
   cd backend
   npx prisma migrate status
   npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma
   ```
   The only pending migration should be `20261012000001_google_sheets_import`, and the diff should show only what it adds.

   **Known drift on the shared Supabase database:** `leads.follow_up_reason` was dropped out of band. Fix that with the team before deploying. It is not part of this feature.
2. **Back up the database** (a Supabase backup or `pg_dump`).
3. Deploy the backend with `GOOGLE_SHEETS_ENABLED` **unset**.
4. Apply the migration:
   ```bash
   npx prisma migrate deploy
   ```
   Never run `prisma migrate reset`, `prisma db push`, or `--force-reset`.

   The migration is additive only. It adds eight `lead_sources` columns plus a CHECK, two partial indexes, and the new `sheet_import_rows` table (RLS on). The integration suite asserts it contains no DROP, DELETE, RENAME or ALTER COLUMN.
5. Run `migrate status` again (expect "up to date") and the `migrate diff` again (expect "No difference detected").

---

## 5. Rollout

1. **Staging first.** Use a dedicated development database, a dedicated test organization and a test spreadsheet of fake leads using `555` numbers.
   - Keep `STRATEGY_ENGINE=0` while you validate imports, so no approved lead can be texted or called.
   - Run the manual checklist (§9).
2. **Production, flag off.** Deploy and migrate as in §4. Owners see nothing.
3. **Production, flag on:** `GOOGLE_SHEETS_ENABLED=1`, `SHEETS_SYNC=1`, then restart.
   - Connect a test organization and spreadsheet first.
   - Approve a few leads and confirm only those are contacted.
   - The flag is server-wide: once it is on, every owner can see the card. Gating per organization would be a small addition if it is wanted.
4. **Before live outreach to imported leads at scale:** settle the consent policy (§8).

---

## 6. Rollback

Rollback never drops tables or deletes imported leads.

- **Switch it off:** unset `GOOGLE_SHEETS_ENABLED` (or set it to `0`) and restart.
  - Routes answer 404 and nothing syncs.
  - Sources keep their state.
  - Pending leads stay paused in review.
  - Leads that were already approved are ordinary leads. To stop outreach to one, pause it like any other lead.
- **Roll back the code:** older code ignores the new columns and table, so the migration can stay. **Do not drop `sheet_import_rows`.** It remembers which rows were already imported. Without it, the next sync would import every row again as a new lead.
- **Remove one sheet:** the owner clicks *Remove* on its row.
  - The source is archived, not deleted, and stops syncing.
  - Its leads stay. The ones waiting for review stay in Import Review.
  - Adding the same tab again restores it with its mapping, and nothing is imported twice.
  - Disconnecting Google removes no sheet. Reconnecting the same account resumes them.
- **Revoke Google access:** the owner clicks *Disconnect*, which revokes the grant at Google and erases the stored token. Alternatively, the owner removes the app at <https://myaccount.google.com/permissions>.

---

## 7. Recovery — a source that stopped

The source row and **History** show the code.

**Permanent failures** pause the source (`ingest_status = PAUSED`) and are not retried:

| Code | Fix |
|---|---|
| `HEADERS_CHANGED` | A mapped column was renamed, removed or duplicated. Fix the heading in the sheet, or re-map. Then *Save mapping* and *Switch on*. |
| `GOOGLE_REAUTH_REQUIRED` | The grant was revoked or expired (7 days in Testing mode). *Reconnect Google*, then *Switch on*. After *Disconnect* and *Connect* with the **same** Google account, that account's sheets move to the new connection automatically. A sheet added under a **different** account stays on its old connection until it is picked again with *Add a spreadsheet*. |
| `GOOGLE_FILE_ACCESS_DENIED` | Pick the same file again with *Add a spreadsheet*. This re-grants access and returns the existing source. Then *Switch on*. |
| `GOOGLE_FILE_NOT_FOUND`, `TAB_MISSING`, `GOOGLE_NOT_A_SPREADSHEET` | Restore the file or tab. Otherwise the source stays paused; its leads are kept. |
| `SHEET_TOO_LARGE` | Split the tab so each part has 10,000 rows or fewer. |
| `NOT_CONFIGURED` | Map the columns. |

**Transient failures** retry on their own with backoff. *Sync now* retries immediately. Codes: `GOOGLE_RATE_LIMITED`, `GOOGLE_UNAVAILABLE`, `INTERNAL`.

**A sync that looks stuck:** `lead_sources.sync_locked_at` / `sync_locked_by` is set. A lease left by a crashed process expires after 10 minutes and is taken over automatically. Clear a lease by hand only when you are certain the process holding it is dead.

**A process that crashed mid-run:**
- Batches already committed stay.
- The retry completes the rest without duplicates.
- Nothing is marked missing, because missing-marking runs only after a complete read and write.
- The integration suite covers this case.

**Running more than one instance:**
- The lease makes concurrent workers safe.
- The OAuth single-use nonce and the access-token cache are per process. PKCE and Google's single-use authorization code back up the nonce.

**Where to look:**
- Logs: `[SheetImport]`, `[GoogleConnectionsService]`.
- `audit_logs` actions:
  - `sheet_sync.completed` and `sheet_sync.failed`. Quiet runs are not recorded, because the audit log is immutable; `last_success_at` shows them.
  - `sheet_source.*`
  - `sheet_import.approved`, `sheet_import.rejected`, `sheet_import.change_applied`, `sheet_import.change_kept`
- Run summaries carry row numbers and reason codes, never cell values.

---

## 8. Known limitations and open decisions

- **Consent is not verified** (product decision: deferred until production launch). Approved imported leads are contacted like any other lead.
- **STOP opt-out gap (pre-existing):** a STOP sets DNC only on the newest lead with that phone. A lead imported again from a sheet inherits DNC at import, but older duplicate leads do not.
- **The rollout flag is server-wide**, not per organization.
- **Fallback identity** (no ID column): changing a name, phone or email makes the row look new. It is imported again for review and the old row is marked missing. The owner must acknowledge this before saving the mapping.
- **Google Testing mode:** test users only, and refresh tokens last 7 days. Production needs a verified consent screen.
- **Not deployed to the shared Supabase database yet.** Its unrelated drift (§4) must be fixed first.

---

## 9. Manual end-to-end checklist

Run this on staging with fake data and `STRATEGY_ENGINE=0`.

1. **Flag off.** No Google Sheets card and no *Import Review* menu item. `GET /api/integrations/google-sheets/config` as owner returns 404.
2. **Flag on.** Restart the backend. The card and the menu item appear.
3. **Connect Google.** The account email appears.
4. **Revoke at Google, then use the card.** The card shows *Reconnect Google*. Reconnecting reuses the same connection.
5. **Add a spreadsheet.** Picker → choose a tab → mapping screen.
6. **Mapping.**
   - Samples are shown and the preview lists refused rows with reasons.
   - Choosing "no ID column" requires ticking *I understand*.
7. **Start importing.** Rows appear in *Import Review* as pending. None is contacted (`first_contact_at` stays empty).
8. **Approve a few leads.** The message says how many were released and why the rest are held: do-not-contact, no dialable phone, and so on.
9. **Reject one.** Its lead is *closed*.
10. **Edit an approved row in the sheet, then *Sync now*.**
    - The row appears under *Changed in the sheet*.
    - *Keep* leaves the lead as it is.
    - *Apply* updates it and keeps its status and pause.
11. **Delete a row and sync.** History shows "removed from the sheet" and the lead still exists.
12. **Rename a mapped heading and sync.** The source pauses with `HEADERS_CHANGED`. Fix the heading, save the mapping and switch on again.
13. **History** shows each run's counts and refused row numbers, and no names, phones or emails.
14. **Sign in as an agent.** No *Import Review* item; every Sheets route answers 403.
15. **Sign in as a different organization's owner.** None of these sources, rows or leads is visible.
16. **Tally / webhook sources still work.** The Lead Sources list and webhook card do not show Sheets sources.

---

## 10. Automated tests

```bash
cd backend
npm run lint && npm test          # unit: includes OAuth state, Google client, row building, tenancy guard, send gates
npm run test:sheet-import         # integration: REAL database + FAKE Google; needs a dedicated DB in backend/.env
cd ../frontend && npm test && npm run build
```

`test:sheet-import` writes test organizations to the database in `backend/.env`. Their audit rows are immutable, so those organizations cannot be removed. **Never point it at a shared or production database.** It sends no SMS and makes no calls: the outreach pollers are off and Google is faked.
