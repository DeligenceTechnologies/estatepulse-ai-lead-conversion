# Calendar

The organization connects **one** Calendly or Cal.com account, once, in
Settings → Calendar. Everything else only reads from that account.

| Folder           | Job                                                        | Used by                          |
| ---------------- | ---------------------------------------------------------- | -------------------------------- |
| `connect/`       | Connect, reconnect, switch or disconnect the calendar. Nothing else. | Settings → Calendar (`ConnectCalendar`) |
| `availability/`  | Who is free and who is busy: the day/week timeline.        | Sidebar → Team Availability      |
| `meetings/`      | Every booked meeting (who, when, join link); the Events drawer lists the event types leads can book, with their links. | Sidebar → Meetings               |
| `members/`       | People in the calendar workspace; add them to the team.    | Team Members → Calendar members drawer |
| `shared/`        | Provider names and colours, buttons, notices, the panel card, drawer, list loader and the one Sync button. | All of the above |

The two sidebar pages share one page shell (with the page's one Sync button), `views/CalendarView.tsx`, which
checks the connection and shows a "Connect a calendar" prompt when there is none.
All API calls live in `utils/calendarApi.ts`.
