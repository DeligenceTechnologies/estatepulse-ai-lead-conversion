# Nango: credentials for every connected account

Nango holds the credentials of every third-party account an organization
connects: it runs the OAuth consent screens (Google, HubSpot, Airtable,
Calendly, Typeform) and refreshes those tokens, and its Connect window collects
the API keys (Tally, Telnyx, Cal.com). Our database keeps the account, the
business data, and `nango_connection_id` only — no token and no API key, and a
key is never typed into or sent through our own pages.
`INTEGRATION_ENCRYPTION_KEY` is still required: it seals webhook secrets, and
the old credentials of rows from before Nango.

## Nango dashboard

1. Create one integration per provider, with exactly these **Unique Keys**:

   | Unique key | Provider | Scopes | Notes |
   |---|---|---|---|
   | `google` | Google | `openid email https://www.googleapis.com/auth/drive.file` | Same OAuth client as `GOOGLE_CLIENT_ID` (the Picker uses it). Offline access. |
   | `hubspot` | HubSpot | `oauth crm.objects.contacts.read crm.objects.contacts.write` | Enable webhook forwarding (contact events). |
   | `airtable` | Airtable | `schema.bases:read data.records:read data.records:write schema.bases:write webhook:manage user.email:read` | Keep in step with `AIRTABLE_SCOPES`. |
   | `calendly` | Calendly | (app default) | |
   | `typeform` | Typeform | `accounts:read forms:read responses:read webhooks:read webhooks:write` | OAuth 2. |
   | `tally` | Tally | — | **API Key** auth. |
   | `telnyx` | Telnyx | — | **API Key** auth (the `KEY…` value). |
   | `cal-com` | Cal.com | — | **API Key** auth (`cal_live_…`). |

2. For the OAuth providers, in each developer console set the redirect URL to Nango's
   callback (`https://api.nango.dev/oauth/callback`, or your custom callback
   domain), replacing the old `/oauth/*-callback.html` and
   `/org-settings/calendar/calendly/callback` URLs.
3. Environment Settings → Webhooks: URL `${PUBLIC_API_URL}/webhooks/nango`,
   enable auth webhooks (creation, override, refresh, deletion).
4. Copy the **API key** to `NANGO_SECRET_KEY` and the **webhook signing key**
   (a different key) to `NANGO_WEBHOOK_SIGNING_KEY`. Neither ever goes to the
   frontend: the browser only gets a short-lived connect session token.

## How a connection is made

Every provider goes through one flow, `backend/src/connections/`
(`ConnectionsService` + one `ConnectionDefinition` per provider). There is no
per-provider connect, complete or disconnect route any more.

| Route | Does |
| --- | --- |
| `GET /v1/connections` | The catalog: every provider, whether it can be connected, and its accounts (`connected`, `needs_setup`, `broken`). |
| `POST /v1/connections/:provider/session { reconnectId? }` | A Nango Connect session tagged `organization_id` and `end_user_id`. With `reconnectId`, it repairs that connection. |
| `POST /v1/connections/:provider/complete { connectionId }` | Links what Nango returned (see below). |
| `DELETE /v1/connections/:id?force=` | Runs the provider's cleanup, revokes at the provider, deletes the Nango connection. |

`complete` reads the connection from Nango and refuses it unless its tags name
the caller's organization. Then the provider's definition identifies the
account (scopes, Calendly admin, Telnyx balance check), and the shared code
applies these rules:
- one account per organization, unless the provider allows several;
- the `integrations` row is created or updated;
- lead sources from an earlier connection of the same account are reattached;
- the provider's `connected` hook runs (the CRM's first import, the calendar row);
- an audit entry is written.

If the tab closes before `complete`, Nango's `creation` webhook finishes it two
minutes later from the queue.

Provider setup after connecting stays on the provider's own routes:
- Telnyx: `PUT /telnyx/credentials { accountId, fromNumber, publicKey }`,
  `POST /telnyx/numbers/lookup { accountId }`, then activate.
- Cal.com: `GET /org-settings/calendar/cal/teams`, then
  `PUT …/cal/workspace { teamId }`.
- Google sheets, Airtable bases and Tally/Typeform forms: same as before.

A Telnyx account waits as `needs_setup` until its number and public key are
saved.

Refresh failures (`refresh`, `success: false`) mark the connection broken and
email the owners, linking to `/integrations`; a later successful refresh clears
it. A connection deleted in the Nango dashboard is marked broken the same way.

In the UI, the Connections page (`/integrations`) shows every provider as the
same tile. Its drawer (`?manage=<provider>`) lists the provider's accounts, then
that provider's setup. Telnyx and the calendar moved there from Settings; the
old `?tab=telnyx` and `?tab=calendar` links redirect to it.

## Rolling out

1. Apply `backend/prisma/migrations/20261125000001_nango_connections`
   (additive: two nullable columns and one new table; nothing is dropped).
2. Configure Nango as above and deploy.
3. Connections made before this keep their rows, sheets, tables, imports and
   leads, but their old tokens are no longer used: each asks its owner to
   **Reconnect** once (the card and the "connection broken" email say so; a
   Telnyx account shows its key as rejected and asks for it again). A
   reconnect with the same account updates the same row, so everything
   attached carries on. Tokens are not copied into Nango automatically.
4. Once every organization has reconnected, the old sealed tokens left in
   `integrations.credentials` / `calendar_connections.credentials` for OAuth
   rows can be cleared; the app already clears each one on reconnect or
   disconnect.
