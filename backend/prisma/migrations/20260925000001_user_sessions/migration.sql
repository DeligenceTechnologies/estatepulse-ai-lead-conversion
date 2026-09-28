-- Server-side sessions.
--
-- The JWT used to be the whole session: 24 hours of validity that nothing on
-- the server could shorten. The 30-minute idle timeout lived only in the
-- browser, so closing the tab and coming back hours later found a token the
-- API still accepted, logout did not end anything server-side, and a copied
-- token worked for its full day regardless.
--
-- One row per sign-in. The token carries this row's id as `jti`, and every
-- authenticated request checks the row, so the server now enforces:
--   revoked_at   logout ends the session for real
--   last_seen_at 30 minutes without user activity ends it (idle timeout)
--   expires_at   24 hours after sign-in ends it regardless (absolute timeout)
--
-- last_seen_at is moved only by POST /api/auth/heartbeat, which the browser
-- sends on real user input. Ordinary API calls do not move it: the dashboard's
-- live stream and refetches run with nobody at the keyboard, and counting them
-- would keep an unattended session alive forever.
--
-- Not tenant-scoped: a session belongs to a user, and the organization is still
-- resolved from organization_members on every request.
CREATE TABLE IF NOT EXISTS user_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   TIMESTAMPTZ(6) NOT NULL,
  revoked_at   TIMESTAMPTZ(6)
);

-- For the ON DELETE CASCADE from users, which otherwise scans the table.
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id);

-- Same as every other public table: the API connects as a role that bypasses
-- RLS, and with no policies nothing else (PostgREST's anon key) can read it.
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
