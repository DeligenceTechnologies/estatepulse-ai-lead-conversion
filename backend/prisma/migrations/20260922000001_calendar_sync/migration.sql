-- Calendar sync: an agent connects their own Calendly, and the bookings on it
-- that belong to one of our leads become `appointments` rows.
--
-- No new tables. `appointments`, `calendar_connections` and `agent_availability`
-- were designed for this in 0_init and have simply never been written to; this
-- migration only adds what polling needs on top of them.
--
-- Note what is NOT here: nothing touches leads_status_check. The live
-- constraint permits 'booked' (not 'appointment_booked', which
-- src/common/domain.ts wrongly claims), and correcting that vocabulary is a
-- separate change with its own blast radius.

-- Sync idempotency, and the reason the reconciler can be a single upsert.
--
-- Every poll re-reads the same window, so without a unique key the second tick
-- inserts a duplicate of every event. Deliberately NOT a partial index: Postgres
-- already treats NULLs as distinct, so a future appointment created by hand (no
-- external_event_id) never collides with another -- and unlike a partial index,
-- Prisma can model this one, which is what lets appointments.upsert() emit a
-- compound selector instead of a find-then-write race between two ticks.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_external_event_unique
  ON appointments (organization_id, provider, external_event_id);

-- The Calendly facts that have no column, and would otherwise be lost.
--
-- Carries the provider's own updated_at, which is what lets a tick skip the
-- per-event invitee request for an unchanged event -- 1 HTTP call instead of 41
-- over a steady-state window. Also the cancel/reschedule URLs, the cancellation
-- reason and who cancelled, the event-type name, and the reschedule chain
-- (Calendly models a reschedule as cancel-plus-new-event, so the new row has to
-- remember which event it replaced in order to inherit its lead).
--
-- One JSONB rather than six columns, matching calendar_connections.metadata:
-- these are provider-shaped details we read back and display, never join or
-- filter on.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- One live calendar per agent per provider.
--
-- Enforced here rather than in application code (contrast
-- telnyx/cred-store.service.ts, where one `integrations` table is shared by
-- every provider and a per-provider predicate would be wrong):
-- calendar_connections already carries `provider`, so this predicate is exact.
--
-- Only 'active' is constrained. calendar_connections_status_check permits
-- active | inactive | error, and an agent may accumulate several 'inactive'
-- rows -- one per past disconnect, plus any abandoned OAuth attempt -- so
-- constraining anything wider would reject a legitimate reconnect.
CREATE UNIQUE INDEX IF NOT EXISTS calendar_connections_active_unique
  ON calendar_connections (agent_id, provider) WHERE status = 'active';
