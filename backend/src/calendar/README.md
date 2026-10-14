# Calendar module

Each organization connects **one** Calendly or Cal.com account, once. Every
feature below reads from that one connection. All endpoints live under
`/org-settings/calendar` (`CALENDAR_ROUTE`); `calendar.routes.spec.ts` pins the
full list so a refactor can never move one.

| Folder           | Owns                                                                 | Endpoints |
| ---------------- | -------------------------------------------------------------------- | --------- |
| `providers/`     | HTTP to Calendly and Cal.com. `SchedulingProvider` is the only place that picks Calendly vs Cal.com (personal or team) for a read. | — |
| `connection/`    | Connect, switch, disconnect (`CalendarConnectionService`) and the one gate to stored credentials (`CalendarAccessService`): decrypt, refresh Calendly tokens, mark a connection broken when the provider rejects it. | `GET /`, `DELETE /`, `POST activate`, `POST calendly/authorize`, `GET calendly/callback`, `POST cal/teams`, `POST cal/connect` |
| `sync/`          | Pulls members and busy/free time into the database every 5 minutes and on webhooks. `freshConnection()` is how readers get synced data. | `POST /calendar-webhooks/:connectionId` |
| `members/`       | Calendar members (synced) and adding one as an agent (checked live). | `GET members`, `POST members/add-agent` |
| `meeting-types/` | Bookable event types and the meetings booked on them (who booked, join link), read live. Meetings cover the last 14 and next 30 days; if only they fail, event types still load with `meetingsError`. | `GET event-types` |
| `availability/`  | The free/busy day and week report.                                   | `GET availability`, `POST availability/sync` |

Dependencies only point downwards, so there are no cycles:

```
members · meeting-types · availability
              │
            sync
              │
     connection (access)
              │
          providers
```

A connection's `status` says whether it is in use and whether it works
(`connection/connection-state.ts`):

| `status`   | In use? | Meaning |
| ---------- | ------- | ------- |
| `active`   | yes     | Working; synced every 5 minutes and on webhooks. |
| `error`    | yes     | The provider rejects it; every screen asks to reconnect. |
| `inactive` | no      | Saved after switching to the other provider, so switching back needs no new sign-in. Not synced, no webhook, and its `lastError` (if any) means "reconnect" rather than "switch back". |

An organization has at most one connection in use. Switching (connect,
`activate`) happens under `lockOrganization`, switches the old one to
`inactive` and drops its webhook; switching back verifies the saved one first
and makes the next read wait for a fresh sync.

Rules that keep it safe:

- Never decrypt credentials or call a provider for an organization outside
  `CalendarAccessService.useActive()`. It handles a rejected key, an expired
  Calendly token, and someone reconnecting mid-request.
- Only `connection/` writes `calendar_connections` rows (sync writes only its
  own sync columns; the access service only parks a rejected one as `error`).
- Find the connection in use with `inUse(orgId)`, never by `status: 'active'`
  alone, or a broken connection would look like "not connected".
- Changing the connection needs `organization.update`; reading needs
  `organization.read`.
