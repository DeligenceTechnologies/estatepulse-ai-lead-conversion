-- Cal.com alongside Calendly, as a second office-level scheduling provider.
--
-- Cal.com offers the same team features -- a shared roster and round-robin
-- assignment -- on a cheaper plan, so an office can run on it until a paid
-- Calendly account is worth it. The two are interchangeable, never concurrent:
-- see calendar_connections_org_one_active below.
--
-- No new tables. `calendar_connections` already carries `provider`, and its
-- `credentials_secret_ref` is an opaque encrypted blob -- Calendly stores an
-- OAuth token pair in it, Cal.com stores an API key, and common/crypto.ts
-- binds both to (organization_id, connection_id) with the same AAD.

-- 1. Which Cal.com user an agent is.
--
-- The sibling of agent_profiles.calendly_user_uri, and INTEGER rather than TEXT
-- because that is what Cal.com issues: a booking names its host as
-- `hosts[].id`, a number, and the team roster repeats it as
-- `memberships[].userId`. Storing it as text would mean every comparison
-- depended on both sides agreeing how to spell the same integer.
--
-- Only one of the two columns is ever populated, because only one provider can
-- be connected at a time. The other is what that office would use if it
-- switched -- keeping both means a switch back does not have to re-link
-- everybody by hand.
ALTER TABLE agent_profiles
  ADD COLUMN IF NOT EXISTS cal_user_id INTEGER;

-- Two agents cannot be the same Cal.com member. Partial, because NULL means
-- "not linked", which is the normal state for the whole roster of an office
-- that uses Calendly (or neither).
CREATE UNIQUE INDEX IF NOT EXISTS agent_profiles_cal_user_unique
  ON agent_profiles (organization_id, cal_user_id)
  WHERE cal_user_id IS NOT NULL;

-- 2. One live office calendar per organization, ACROSS providers.
--
-- Replaces calendar_connections_org_active_unique, which was keyed on
-- (organization_id, provider) and so permitted an active Calendly row and an
-- active Cal.com row side by side. That is not a harmless duplicate: both
-- would be swept, a lead who booked on both offices' calendars would produce
-- two appointments rows, and an agent linked on both sides would be counted
-- twice against their lead cap.
--
-- Dropping `provider` from the key is what makes "connect Cal.com" mean
-- "switch to Cal.com". The application retires the other row first; this index
-- is the backstop that makes a missed retirement an error instead of a slow
-- data problem nobody notices.
DROP INDEX IF EXISTS calendar_connections_org_active_unique;

CREATE UNIQUE INDEX IF NOT EXISTS calendar_connections_org_one_active
  ON calendar_connections (organization_id)
  WHERE agent_id IS NULL AND status = 'active';
