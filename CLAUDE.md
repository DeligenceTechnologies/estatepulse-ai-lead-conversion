# EstatePulse AI — Claude Code Project Instructions

## 1. Project purpose

EstatePulse AI is a lead-conversion platform for real-estate teams.

Current stack:
- Frontend: React + Vite + TypeScript
- Backend: NestJS + TypeScript
- Database: PostgreSQL/Supabase
- ORM: Prisma
- Authentication: existing JWT/session-based authentication
- Multi-tenancy: organization-scoped access using the existing tenant-aware Prisma pattern
- Express exists only as the underlying HTTP adapter for NestJS. Do NOT add Express routers.

The repository is a real product codebase, not a throwaway prototype. Prefer small, safe, incremental changes.

---

## 2. Source of truth

For Milestone 2 work, use the supplied:
`EstatePulse AI — Milestone 2 Product Documentation.pdf`

Do not invent requirements that are not supported by the milestone.

Milestone 2 Feature 1 is:
**Lead Routing & Agent Handoff**

The relevant agent-management/routing requirements include:
- Agent roster management
- Add/edit/disable agents
- Name, email, phone, timezone, title
- Lead cap
- Territories
- Weekly working hours
- Agent assignment
- Geographic/text territory matching
- Working-hours evaluation in the agent's own timezone
- Capacity enforcement
- Longest-waiting/round-robin selection
- Assignment duplicate protection
- Assignment reason/audit trail
- Unassigned/unroutable states
- Agent SMS handoff
- Assigned-agent visibility
- Agent's own lead list
- Pre-call briefing

Do not implement later Milestone 2 features unless explicitly requested:
- Automated follow-up/nurture
- STOP/opt-out workflows
- Call recordings/transcripts
- Consultation booking
- CRM sync
- Numeric lead scoring
- Analytics/KPI systems

---

## 3. Current Agent Management state

Agent creation is already implemented.

Existing Agent Management includes:
- NestJS AgentsModule
- AgentsController
- AgentsService
- SessionGuard
- OwnerGuard
- Tenant-aware Prisma access
- GET /api/agents
- POST /api/agents
- PATCH /api/agents/:userId
- Owner-only agent creation/suspension
- Organization isolation
- Agent cards
- Add Agent modal
- Agent suspension/disable behavior

Do NOT rebuild or replace the existing Add Agent functionality unless the requested task specifically requires it.

The existing database tables include:
- users
- organizations
- organization_members
- agent_profiles
- agent_availability
- agent_territories
- lead_assignments
- calendar_connections
- leads
- audit_logs

Before adding anything, inspect the existing schema and code. Reuse existing tables when they already support the requirement.

---

## 4. Architecture rules

### NestJS only

All new backend application code MUST use NestJS:
- Controller
- Service/provider
- Module
- Guard
- DTO/schema
- Prisma service/provider

NEVER add:
- express.Router()
- Router()
- router.get/post/patch/etc.
- new standalone Express endpoints
- new Express middleware for feature logic

Express is only the underlying adapter/middleware layer.

### Tenant isolation

Always derive organization identity from the authenticated session/context.

NEVER trust:
- organizationId from request body
- organizationId from query parameters
- organizationId supplied by the frontend
- organizationId from arbitrary route parameters

Use the existing tenant-aware Prisma pattern (`TENANT_PRISMA`) for tenant tables.

Before changing Prisma queries, inspect how the existing tenancy guard works and preserve its expectations.

### Authorization

Preserve the existing:
- SessionGuard
- OwnerGuard
- agent-level authorization patterns

Never weaken authorization to make a feature work.

---

## 5. Database rules

Before changing the database:

1. Inspect the existing schema.
2. Inspect relevant Prisma models.
3. Inspect existing migrations.
4. Check whether an existing table/column already supports the requirement.
5. Reuse existing structures whenever possible.
6. Only add a migration when the requirement genuinely needs schema support.
7. Never delete existing production data.
8. Never reset the database.
9. Never use destructive SQL such as DROP TABLE, TRUNCATE, or database reset unless explicitly requested.
10. Do not create duplicate tables for concepts that already exist.

When running SQL against Supabase/Postgres:
- Prefer read-only inspection queries first.
- Show/verify the result before making a schema change.
- Keep schema changes minimal.
- Verify the final schema after migration.

---

## 6. General coding rules

Before editing:
- Inspect the relevant files.
- Understand existing patterns.
- Search for existing implementations before creating new ones.
- Reuse existing types, utilities, guards, components, API conventions, and design tokens.

Do NOT:
- rewrite large files unnecessarily
- refactor unrelated code
- rename unrelated files
- delete working functionality
- replace working architecture just because another approach looks cleaner
- introduce new dependencies without a strong reason
- create speculative abstractions
- create fake/demo data to make a UI look complete
- silently change product behavior outside the requested task

Follow YAGNI:
**Implement only what the current requirement needs.**

Prefer the smallest safe change.

---

## 7. UI/design rules

Preserve the existing EstatePulse visual language.

Do NOT redesign the application unless explicitly asked.

Preserve:
- existing dark theme
- spacing
- typography
- borders
- rounded corners
- existing colors/tokens
- icons
- responsive behavior
- existing loading/error/empty states

Do not replace real data with hardcoded/demo data.

If backend data does not exist yet:
- show an honest empty state
- do not invent values

Example:
- `0 active leads` is acceptable when backed by a real count.
- `No calendar connected` is acceptable when no calendar exists.
- `AVAILABLE` should not be displayed unless availability is actually backed by real data.

---

## 8. Do not break existing functionality

Before changing a shared component/API/schema:
- search all usages
- understand dependencies
- preserve existing consumers

After changes:
- run relevant tests
- run type checks
- run build
- inspect git diff
- check for unintended file changes

Never remove code merely because it appears unused without verifying its role.

---

## 9. Testing and verification

Every implementation task must finish with verification.

At minimum, run the relevant:
- backend type check/lint
- backend unit tests
- backend integration tests when DB credentials are available
- frontend lint/type check
- frontend build

For database-backed changes:
- run the real integration tests if `.env`/database access is available
- do not claim integration testing passed if it did not run

For routing/authorization changes, test:
- owner access
- agent access
- cross-organization isolation
- suspended users
- invalid input
- duplicate requests where relevant
- unauthorized requests

For assignment logic, test:
- territory match
- area mismatch fallback
- off-shift behavior
- capacity reached
- all agents at capacity
- round-robin/longest-waiting selection
- duplicate assignment protection
- assignment reason
- unassigned/unroutable state

---

## 10. Git rules

Do NOT:
- commit
- push
- merge
- rebase
- reset
- force push

unless the user explicitly asks.

Before finishing:
- show `git status`
- inspect `git diff --stat`
- inspect the relevant diff
- do not stage unrelated files

Never use `git add .` blindly.

---

## 11. Claude Code workflow

For every task follow this order:

### Step 1 — Understand
Restate the requested scope internally and identify affected areas.

### Step 2 — Inspect
Search the codebase before editing.

Inspect:
- relevant frontend files
- relevant backend files
- Prisma schema/models
- existing migrations
- existing API patterns
- existing tests

### Step 3 — Plan
Create a short implementation plan.

### Step 4 — Implement
Make the smallest safe changes.

### Step 5 — Verify
Run the relevant tests/type checks/build.

### Step 6 — Review
Check:
- git diff
- accidental deletions
- unrelated modifications
- architecture violations
- tenant isolation
- authorization
- fake/demo data
- regressions

### Step 7 — Report
Tell the user:
- what changed
- files changed
- tests/checks run
- anything blocked
- anything intentionally not implemented

Do not claim something was verified unless it was actually verified.

---

## 12. Current Milestone 2 agent implementation sequence

Implement these in order unless the user explicitly changes the order:

1. Agent Edit/Profile Configuration
   - title
   - phone
   - timezone
   - lead cap
   - other supported profile fields

2. Agent Territories
   - add/edit/remove territories
   - text-based matching

3. Working Hours
   - weekly schedule
   - agent timezone
   - on-shift/off-shift calculation

4. Lead Capacity
   - cap
   - current open lead count
   - eligibility

5. Assignment Engine
   - territory match
   - area mismatch fallback
   - shift check
   - capacity check
   - longest-waiting/round-robin selection

6. Assignment Safety
   - duplicate protection
   - transactional assignment
   - audit/reason

7. Agent Handoff
   - agent SMS
   - assigned-agent visibility
   - lead timeline
   - agent lead list

8. Pre-call Briefing
   - call summary
   - budget
   - timeline
   - motivation
   - recommended opening/action

Do not jump ahead to later Milestone 2 features unless explicitly requested.

---

## 13. Important product behavior

For routing:

1. Lead area matches an agent territory.
2. Evaluate working hours in that agent's own timezone.
3. Respect the agent's lead cap.
4. Among eligible agents, select the agent who has been assigned a lead longest ago.

Fallbacks:
- No territory match -> widen to office and record `area mismatch`.
- Agent off shift -> assignment may still happen and record `off shift`.
- Everyone at capacity -> do NOT silently override the cap; leave unassigned, alert owner, and expose an unroutable reason.

Unassigned leads must always have a visible reason.

Warm/cold leads do not receive an agent immediately. They enter nurture. A lead becomes an agent-assignment candidate when the milestone rules say it should route to an agent.

A request for a human during the AI call is treated as hot and routed to an agent.

---

## 14. Important naming/behavior rule

Do not confuse:
- Lead status: New, Contacting, Follow-up, Interested, Appointment requested, Appointment booked, Not interested, Closed, Invalid (follow-up carries a reason: No answer, Not ready, Callback requested, Needs time, Other)
- Lead temperature: Hot, Warm, Cold

Temperature describes lead intent.
Status describes the lead's position in the sales lifecycle.

Do not create a numeric lead score for Milestone 2. The milestone explicitly says numeric scoring is deferred.

---

## 15. Final safety rule

When uncertain:
1. Inspect first.
2. Reuse existing code/schema.
3. Ask only if a decision genuinely cannot be determined from the codebase or milestone.
4. Prefer the smallest reversible change.
5. Never invent product behavior.
6. Never break existing working functionality to satisfy a new feature.
