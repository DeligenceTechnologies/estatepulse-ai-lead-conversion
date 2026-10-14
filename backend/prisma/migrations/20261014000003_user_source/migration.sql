-- Where each user account was created: in EstatePulse itself ('web'), or by
-- adding a member of the connected Calendly ('calendly') or Cal.com ('cal').
CREATE TYPE "user_source" AS ENUM ('web', 'calendly', 'cal');

-- Existing users get 'web': nothing recorded how they were created, and
-- guessing from calendar e-mails would mislabel people who joined first.
ALTER TABLE "users" ADD COLUMN "source" "user_source" NOT NULL DEFAULT 'web';
