-- Migration: separate "sent a join request" from "is actually a member".
--
-- Until now join_requests.active meant both. That was tolerable while the bot
-- approved every request itself (a request became a membership within the same
-- webhook), but requests are now approved manually by a Telegram admin, so the
-- two facts diverge: a user can hold a PENDING request without being in the
-- chat. Both satisfy the bot's requirement; they are not the same thing.
--
--   status = 'pending'  request sent, no admin decision yet   (satisfies)
--   status = 'member'   actually in the chat                  (satisfies)
--   status = 'ended'    left / removed / request withdrawn    (does not)
--
-- Apply ONCE, before deploying the matching code:
--   npx wrangler d1 execute referral_bot_db --remote --file=./migrations/0006_join_request_status.sql
--
-- Nothing is deleted and no user, referral or verification row is touched.

-- 'pending' is only the column default for rows written by an older build
-- during the deploy window; the UPDATE below assigns every existing row.
ALTER TABLE join_requests ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'member', 'ended'));

-- Telegram time of the event that last set `status`; 0 = "before we tracked it".
-- Any real event is newer, so the first live update always wins over old data.
ALTER TABLE join_requests ADD COLUMN event_at INTEGER NOT NULL DEFAULT 0;

-- Backfill from the old meaning. `active` was documented as "1 while the user
-- is in the chat, 0 once they leave", and the old code approved every request
-- the moment it arrived -- so an active row was a live membership and an
-- inactive one is a departure. Either way, rows that counted before still
-- count and rows that did not still do not, so no verification changes.
UPDATE join_requests
SET status = CASE WHEN active = 1 THEN 'member' ELSE 'ended' END;

-- `active` is left in place as a deprecated mirror (status <> 'ended') rather
-- than dropped: dropping is irreversible and would break a rollback.

CREATE INDEX IF NOT EXISTS idx_join_requests_status
  ON join_requests(telegram_user_id, status);
