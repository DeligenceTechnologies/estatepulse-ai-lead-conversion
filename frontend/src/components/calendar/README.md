# Calendar

The organization connects **one** Calendly or Cal.com account, once, in
Settings → Calendar. Everything else only reads from that account.

| Folder           | Job                                                        | Used by                          |
| ---------------- | ---------------------------------------------------------- | -------------------------------- |
| `connect/`       | Connect, reconnect, switch or disconnect the calendar. Nothing else. | Settings → Calendar (`ConnectCalendar`) |
| `availability/`  | Who is free and who is busy: the day/week timeline.        | Sidebar → Team Availability      |
| `meeting-types/` | The meetings leads can book, with their booking links, and who booked them (with the join link). | Sidebar → Meeting Types          |
| `members/`       | People in the calendar workspace; add them as agents.      | Sidebar → Calendar Members       |
| `shared/`        | Provider names and colours, buttons, notices, the panel card and list loader. | All of the above |

The three sidebar pages share one page shell, `views/CalendarView.tsx`, which
checks the connection and shows a "Connect a calendar" prompt when there is none.
All API calls live in `utils/calendarApi.ts`.
