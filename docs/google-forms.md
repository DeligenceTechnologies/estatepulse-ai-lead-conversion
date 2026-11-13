# Google Forms as a lead source

Apps Script delivers; polling only recovers.

A Google Form has no webhook field, so the owner pastes a generated Apps
Script into their form once. That script posts every response to
`POST /ingest/v1/google-forms/:token`, which is an ordinary EstatePulse ingest
route — the same table, dedupe key, worker, mapping and review rules that Tally
and Typeform deliveries go through. Nothing about Google Forms creates a lead
on its own.

Backend polling of `forms.responses.list` exists only to pick up responses the
script never managed to deliver (its retries ran out, the trigger was deleted,
or we were down). It writes the delivery the script would have written and
stops there.

## Flow

```
Google Form ──submit──> Apps Script ──HTTPS POST + HMAC──> /ingest/v1/google-forms/:token
                             │                                      │
                             │ bounded retry (6 tries, 5→160 min)   ▼
                             │                              ingest_events row
                             └──gives up──> ... FormsPollService ──> (same row, same dedupe key)
                                                                     │
                                                                     ▼
                                                            ProcessingWorker ──> Lead
```

## OAuth scope: `drive.file` is enough

**No new scope, no new consent screen, no re-verification.** Google Forms reuses
the Google connection Google Sheets already makes, with the scopes
`openid email https://www.googleapis.com/auth/drive.file`.

`drive.file` grants per-file access to files the user picked in the Google
Picker — which is exactly how a form gets connected here.

Verified on 2026-11-12 against Google's live API discovery document
(`https://forms.googleapis.com/$discovery/rest?version=v1`), which is Google's
own machine-readable statement of the scopes each method accepts:

| Method                  | Accepted scopes include                                        |
| ----------------------- | -------------------------------------------------------------- |
| `forms.get`             | `drive`, **`drive.file`**, `drive.readonly`, `forms.body`, `forms.body.readonly` |
| `forms.responses.list`  | `drive`, **`drive.file`**, `drive.readonly`, `forms.responses.readonly` |

Reproduce it with:

```sh
curl -s "https://forms.googleapis.com/\$discovery/rest?version=v1" \
  | jq '.resources.forms.methods.get.scopes,
        .resources.forms.resources.responses.methods.list.scopes'
```

### Prerequisite: enable the Forms API on the Cloud project

**The Google Forms API is a separate API and must be switched on for the same
Google Cloud project that owns `GOOGLE_CLIENT_ID`.** Enabling Drive and Sheets
does not enable it. Until it is on, every `forms.get` and
`forms.responses.list` returns:

```
HTTP 403  status: PERMISSION_DENIED  reason: SERVICE_DISABLED
"Google Forms API has not been used in project <N> before or it is disabled."
```

Enable it once, per project:
<https://console.developers.google.com/apis/api/forms.googleapis.com/overview>

This 403 is **not** a scope problem and **not** a file-permission problem, so
it is classified apart from them: `GoogleClient.apiError()` maps
`reason: SERVICE_DISABLED` to the kind `API_DISABLED`, which surfaces as HTTP
503 `GOOGLE_API_DISABLED`. The owner-facing message says an administrator must
enable it, because telling them to pick the file again would loop forever.

### What was verified live (2026-11-13)

Against the active connection on `estate_manish`
(`a0af7484-413d-4308-a829-63eda004323a`, `manish.deligence@gmail.com`), with a
refresh token minted from the stored credentials:

| Check | Result |
| --- | --- |
| Granted scopes on the live token | `openid`, `…/auth/userinfo.email`, `…/auth/drive.file` — unchanged, nothing widened |
| Picker grant reaches Forms files | **Yes.** `drive/v3/files` listed 3 `application/vnd.google-apps.form` files picked by the owner |
| `forms.get` under `drive.file` | **HTTP 200**, real form body (title + questions) for two different picked forms |
| `forms.responses.list` under `drive.file` | **HTTP 200**, including a form with a real `responseId` and `createTime` |

Before the Forms API was enabled, both calls returned 403 `SERVICE_DISABLED` —
the scope check was never what blocked them. **`drive.file` is therefore
confirmed sufficient by live authorized calls, not by the discovery document
alone, and no scope was widened to get there.**

### What is still NOT verified

End-to-end delivery through the Apps Script — the owner pasting the generated
script, `estatePulseSetup` creating the installable trigger, and a real
submission arriving at `/ingest/v1/google-forms/:token` — has not been run.
Steps 4–6 of [the live check](#live-check) cover it.

### If the live check ever fails

Do not widen the scope quietly. The minimum alternatives, in order of cost:

| Option | Scope | Cost |
| --- | --- | --- |
| Read schema only | `forms.body.readonly` | Re-consent for every connected org; a **restricted** scope, so Google app verification (security assessment) is required |
| Read responses only | `forms.responses.readonly` | Same: re-consent + restricted-scope verification |

Both are restricted scopes and would put the whole Google integration —
including the working Sheets import — back through Google's verification. The
Apps Script path needs none of them: it runs as the owner, under their own
authorization, and posts to us. So a scope failure degrades the integration to
"Apps Script only, no recovery poll" rather than breaking it.

### The Apps Script's own consent is separate — and always shows a warning

Running `estatePulseSetup` makes Google ask the owner for a **second,
unrelated** authorization. It has nothing to do with EstatePulse's OAuth client:
the pasted script lives in the owner's own Apps Script project, under their own
Google account, and Google is asking them to authorize their own code.

Because that project has no published consent screen, Google always shows:

> ⚠️ **Google hasn't verified this app** — the app is requesting access to
> sensitive info in your Google Account.

**This is expected, for every owner, forever.** The `Allow` button is hidden
behind *Advanced* → *Go to … (unsafe)*, and the only button on screen is
*Back to safety*, so the setup instructions must spell the path out — they do,
in the generated script's header comment and in step 3 of the setup modal.

What triggers it is `script.external_request` (the `UrlFetchApp` call that posts
to us), which Google classes as sensitive. It cannot be avoided: posting to us
is the entire job. The script is otherwise already at the narrowest scopes —
`FormApp.getActiveForm()` asks for `forms.currentonly` (this form only), not
full `forms` access.

**Deligence does not need to verify anything with Google for this.** Each owner
is the developer of their own copy, so the unverified-app limits (the 100-user
cap, the verification queue) never apply to us.

## Payload contract

`POST /ingest/v1/google-forms/:token`
Header `X-EstatePulse-Signature: sha256=<base64 HMAC-SHA256 of the raw body>`

```json
{
  "source": "google_forms",
  "version": 1,
  "sourceId": "<lead_sources.id>",
  "formId": "<Google form id>",
  "formTitle": "Buyer enquiry",
  "responseId": "<Google response id>",
  "submittedAt": "2026-11-12T10:00:00.000Z",
  "questions": [
    { "key": "q_full_name", "itemId": "101", "title": "Full name", "type": "TEXT", "values": ["Manish Baghel"] },
    { "key": "q_areas", "itemId": "102", "title": "Areas", "type": "CHECKBOXES", "values": ["Bandra", "Juhu"] },
    { "key": "q_budget", "itemId": "103", "title": "Budget", "type": "TEXT", "values": [] }
  ]
}
```

Every question is sent, answered or not — that is what lets an owner map a
question nobody has filled in yet. The flat `{"fields": {"Full name": "..."}}`
shape is also accepted, for anyone posting this contract by hand.

Responses:

| Status | Meaning |
| --- | --- |
| `202 {received, deliveryId}` | Stored, queued |
| `202 {received, paused}` | Stored, held until the owner switches the form on |
| `200 {received, duplicate}` | Already had this response id |
| `400 invalid_payload` | Not a readable response; the script must not retry |
| `401` | Signature missing or wrong |
| `404 not_found` | Unknown token, wrong route, or the feature is off |
| `410 source_archived` | The form was removed — delete the script |
| `503` + `Retry-After` | We could not store it; please retry |

### Field keys

A question's key is derived from its **title**, in document order, with `__2`,
`__3` for repeated titles — `fieldKey()` in
`backend/src/google-forms/forms-schema.ts`, mirrored byte for byte in the
generated script.

It cannot be Google's own id: `forms.get` returns the Forms API `questionId`
(hex), while Apps Script's `Item.getId()` returns a different numeric item id,
and nothing in Apps Script exposes the API's id. Keying on either would make
the webhook and the poller disagree about every question.
`apps-script.spec.ts` asserts the two implementations agree, including on
emoji, punctuation and 200-character titles.

A renamed question therefore gets a new key: the old mapping stops matching,
the answer lands in custom fields rather than the wrong lead column, and the
schema fingerprint changes, which flags the mapping for review.

## Idempotency

`ingest_events.dedupe_key = "GOOGLE_FORMS:<responseId>"`, unique together with
`lead_source_id`. Since a source belongs to one organization and one form, that
is `organizationId + formId + responseId`. The webhook and the poller build the
same key, and `skipDuplicates` makes the database — not a check-then-write race
— the thing that refuses the second copy.

An **edited** response keeps its id, so it can never become a second lead. It is
detected and the existing lead is flagged (`needsReview`, `automationPaused`),
never overwritten:

- webhook path — the signed body hashes differently from the stored one;
- poll path — Google's `lastSubmittedTime` is later than the stored submit time.

The two signals are not interchangeable: a poll-rebuilt payload never hashes
identically to the script's own body, so the hash comparison is applied only
when the stored delivery also came from the script.

## Lifecycle and lead safety

| State | What happens to a response |
| --- | --- |
| `NEEDS_MAPPING`, inactive | Held (`outcome_reason = awaiting_mapping`, far-future `available_at`) |
| mapped, `PAUSED` | Held |
| `ACTIVE` | Becomes a lead through the shared worker |

Switching the form on releases the held backlog as `captured_during_setup`, and
the worker gives each of those leads `needsReview` + `automationPaused` — they
arrived before anybody had checked the mapping, so nothing calls, texts or
emails them until an owner approves them. This is the custom webhook's
mechanism, reused unchanged.

## Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `GOOGLE_FORMS_ENABLED` | `false` | Off: every route (including the ingest one) answers 404 and the card is hidden. No data changes |
| `FORMS_POLL_MS` | `60000` | How often the poller looks for due forms |
| `FORMS_SYNC_INTERVAL_MS` | `900000` | How long after a poll a form is due again |

The OAuth client, picker key and app id are the Google Sheets ones
(`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_PICKER_API_KEY`,
`GOOGLE_APP_ID`) — there is nothing extra to register.

## Troubleshooting: responses only appear after "Check now"

That means **push is dead and the recovery poll is carrying the integration**.
It is working as designed — no response is lost — but every lead is up to
`FORMS_SYNC_INTERVAL_MS` (15 min default) late instead of instant.

Confirm it in one query. If every row is `google_forms.recovered` and none is
`google_forms.response`, the script has never delivered:

```sql
SELECT event_type, count(*), max(received_at)
  FROM ingest_events
 WHERE lead_source_id = '<source id>'
 GROUP BY event_type;
```

The usual cause in development: **`PUBLIC_API_URL` points at a `trycloudflare`
quick tunnel, whose hostname changes every time `cloudflared` restarts.** The
URL is baked into the generated script when the owner copies it, so the moment
the tunnel restarts, every installed form posts to a hostname that no longer
resolves. Nothing reaches the server, so there is no failed delivery to show —
only silence.

```bash
curl -sS -o /dev/null -w '%{http_code}\n' "$PUBLIC_API_URL/health"   # 200, or the tunnel is gone
```

Fix: bring the tunnel up, put its current hostname in `PUBLIC_API_URL`, restart
the backend, then **re-copy the script into the form and run `estatePulseSetup`
again** — regenerating it is what rewrites the baked-in URL. Production is not
exposed to this; `PUBLIC_API_URL` there is a stable hostname.

Other causes worth checking, in order:

| Symptom | Cause |
| --- | --- |
| Apps Script → Executions shows no runs at all | `estatePulseSetup` never completed — the owner stopped at Google's unverified-app warning |
| Executions show `estatePulseOnSubmit` failing with a DNS or timeout error | The webhook host is unreachable (above) |
| Deliveries arrive but are rejected | Signature mismatch — the script was copied from a different source, or the secret was rotated after copying |
| Route answers `{"message":"Cannot POST …"}` | The ingest path is missing from `ROOT_ROUTES` in `server.ts`, so it is served under `/api` |

"Test connection" distinguishes these: it counts only `google_forms.response`
events as proof the script works, and reports poll-recovered ones separately.

## Live check

Not yet run — see [What is still NOT verified](#what-is-still-not-verified).
It stays blocked until the Forms API is enabled on the Cloud project.

1. Set `GOOGLE_FORMS_ENABLED=1` in `backend/.env` and restart the backend.
2. Integrations → Google Forms → **Connect Google** (reconnects Sheets too; one
   account per organization).
3. **Add a form** and pick a Google Form in the Picker. This is the call that
   proves `drive.file` reaches `forms.get`: if the scope were insufficient, the
   source would fail to create with a Google 403 and the message would name it.
4. Map the questions, then follow the setup steps and run `estatePulseSetup` in
   Apps Script. Google shows **“Google hasn’t verified this app”** here — that
   is expected and not an EstatePulse problem (see below); click *Advanced* →
   *Go to … (unsafe)* → *Allow*.
5. Submit a response. It should appear as a delivery within seconds.
6. Submit a second one with the backend stopped, start it again, and use
   **Check now** — the recovery poll is what proves
   `forms.responses.list` works under `drive.file`.
