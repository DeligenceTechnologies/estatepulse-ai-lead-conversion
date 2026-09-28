-- The follow-up runner: what `sequence_enrollments` needs before anything can
-- safely poll it.
--
-- The table already had the right shape for a drip (`current_step`,
-- `next_action_at`, `stopped_reason`) and no code had ever touched it. What it
-- lacked was everything needed to be a *queue*: a tenant, a lock, and a way to
-- stop one lead being enrolled twice.

-- 1. organization_id.
--
-- Not a convenience column. `sequence_enrollments` is on the tenancy guard's
-- scoped list (src/prisma/prisma.service.ts) but had no organization_id, so
-- every query on it other than by row id threw — the guard made the table
-- almost unusable. It is also what lets the runner report per-office.
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS organization_id UUID;

UPDATE sequence_enrollments e
   SET organization_id = l.organization_id
  FROM leads l
 WHERE l.id = e.lead_id
   AND e.organization_id IS NULL;

-- Safe: lead_id is ON DELETE CASCADE, so the backfill above cannot leave a null.
ALTER TABLE sequence_enrollments ALTER COLUMN organization_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sequence_enrollments_organization_id_fkey'
  ) THEN
    ALTER TABLE sequence_enrollments
      ADD CONSTRAINT sequence_enrollments_organization_id_fkey
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;

-- 2. The claim columns, mirroring webhook_events so the runner can copy the
-- FOR UPDATE SKIP LOCKED pattern already proven in
-- src/modules/processing/worker.service.ts: claim in a short transaction, do the
-- work outside it, requeue anything whose lock went stale because the process
-- died mid-step.
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS locked_by UUID;
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS last_error TEXT;

-- 3. One live enrollment per lead, enforced by the database.
--
-- The same trick as leads.first_contact_at in the strategy engine: make the
-- race impossible rather than checking for it. Two callers can enrol the same
-- lead concurrently — a qualification webhook and a retry, say — and without
-- this both succeed and the lead gets every message twice. A partial unique
-- index means the second INSERT fails and the caller swallows the conflict.
--
-- It covers every NON-TERMINAL status, not just 'active'. Narrowing it to
-- 'active' would leave a hole exactly the width of a step: the runner flips a
-- claimed row to 'processing', which would drop it out of the index, and an
-- enrolment arriving in that window would succeed. 'completed' and 'stopped'
-- are excluded deliberately — a lead that finished a sequence months ago can
-- be enrolled again.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_enrollments_one_active_per_lead
  ON sequence_enrollments (lead_id)
  WHERE status IN ('active', 'processing', 'paused');

-- 4. The runner's claim query. The existing (status, next_action_at) index
-- covers every status; this partial one is the size of the live queue rather
-- than of the whole history, which is what it stays as the table grows.
CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_due
  ON sequence_enrollments (next_action_at)
  WHERE status = 'active';

-- The stuck-lock sweep, which is otherwise a sequential scan on every tick.
CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_locked
  ON sequence_enrollments (locked_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_sequence_enrollments_org
  ON sequence_enrollments (organization_id);
