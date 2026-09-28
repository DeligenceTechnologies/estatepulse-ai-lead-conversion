-- Calendly moves from per-agent to per-ORGANIZATION.
--
-- Every agent used to hold their own Calendly login and authorize it
-- themselves. That meant one OAuth grant, one refresh-token rotation and one
-- reconnect prompt per person on the roster, and it left Calendly's own team
-- features -- round robin above all -- unreachable, because a round-robin event
-- type belongs to the Calendly TEAM, not to any one member's token.
--
-- The office now connects ONE Calendly account, whose user is an owner/admin of
-- the Calendly organization. `GET /scheduled_events?organization=<uri>` then
-- returns every member's bookings from that single token, and each event names
-- its host in `event_memberships[].user`. Agents are invited into that Calendly
-- organization and set their availability there.
--
-- No new tables. `calendar_connections` already carries organization_id and was
-- only ever per-agent because agent_id was NOT NULL.

-- 1. An organization-level connection is a row with NO agent.
--
-- The column stays for the historical per-agent rows, which are kept: they are
-- what `appointments.calendar_connection_id` points at for every booking synced
-- before today, and dropping them would orphan real history.
ALTER TABLE calendar_connections
  ALTER COLUMN agent_id DROP NOT NULL;

-- 2. One live organization calendar per provider.
--
-- The sibling index calendar_connections_active_unique is (agent_id, provider)
-- WHERE status = 'active'. Postgres treats NULLs as DISTINCT, so it does not
-- constrain org rows at all -- every one of them has agent_id NULL and so never
-- collides. This index is what actually enforces the invariant now, and the
-- `agent_id IS NULL` predicate is what keeps the two from overlapping.
CREATE UNIQUE INDEX IF NOT EXISTS calendar_connections_org_active_unique
  ON calendar_connections (organization_id, provider)
  WHERE agent_id IS NULL AND status = 'active';

-- 3. Which Calendly member an agent is.
--
-- The join key from a synced event back to an agent_profiles row. It is the
-- Calendly user URI ("https://api.calendly.com/users/{uuid}") and NOT an email,
-- because the roster sync matches on email exactly once, when it links the two
-- -- after that an agent can change their address on either side without every
-- past appointment silently losing its host.
--
-- agent_profiles.calendly_url already exists and keeps its meaning: the public
-- booking page. This is the identity behind it.
ALTER TABLE agent_profiles
  ADD COLUMN IF NOT EXISTS calendly_user_uri TEXT;

-- Two agents cannot be the same Calendly member. Partial because NULL means
-- "not linked yet", which is the normal state for most of the roster.
CREATE UNIQUE INDEX IF NOT EXISTS agent_profiles_calendly_user_unique
  ON agent_profiles (organization_id, calendly_user_uri)
  WHERE calendly_user_uri IS NOT NULL;

-- 4. Retire the per-agent connections.
--
-- The connect flow that created these is gone, so an 'active' row here would be
-- a calendar the poller keeps sweeping with a token nobody can ever renew --
-- and, once the office connects, a SECOND source of the same events.
--
-- Deliberately NOT deleted, and the credential blob is deliberately left in
-- place: the row is what `appointments.calendar_connection_id` references, and
-- the stored token is the only thing that could still revoke that grant with
-- Calendly. Flipping the status is enough to take it out of every code path.
UPDATE calendar_connections
   SET status = 'inactive', updated_at = NOW()
 WHERE provider = 'calendly'
   AND agent_id IS NOT NULL
   AND status = 'active';
