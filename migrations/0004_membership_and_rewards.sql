-- Migration: only members who STAY count as referrals.
--
-- Until now a join request was permanent evidence: once recorded, the user was
-- verified forever and their referrer keeped the credit even if the user left
-- the chat a minute later. join_requests.active makes membership revocable.
--
-- Apply with:
--   npx wrangler d1 execute referral_bot_db --remote --file=./migrations/0004_membership_and_rewards.sql

-- 1 while the user is in the chat, 0 once Telegram tells us they left or were
-- removed. Rows are kept rather than deleted so a rejoin restores the original
-- requested_at and the history stays auditable.
ALTER TABLE join_requests ADD COLUMN active INTEGER NOT NULL DEFAULT 1;

-- Everything recorded before this migration was a live membership as far as the
-- old code was concerned, so it keeps counting.
UPDATE join_requests SET active = 1 WHERE active IS NULL;

-- The verification check filters on (user, active); this index keeps that cheap.
CREATE INDEX IF NOT EXISTS idx_join_requests_active
  ON join_requests(telegram_user_id, active);
