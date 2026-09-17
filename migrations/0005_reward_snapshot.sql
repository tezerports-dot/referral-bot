-- Migration: freeze the rupee figure at the moment a user qualifies.
--
-- The live figure is derived from the current referral count, so it erodes if
-- referrals later leave. That is correct for "what are they worth now", but
-- wrong as a settlement record: the amount owed is whatever it was when they
-- hit the threshold, and that must not move afterwards.
--
-- Apply with:
--   npx wrangler d1 execute referral_bot_db --remote --file=./migrations/0005_reward_snapshot.sql

ALTER TABLE users ADD COLUMN reward_settled_inr INTEGER;
ALTER TABLE users ADD COLUMN reward_settled_at  TEXT;

-- Anyone already qualified before this migration never had a snapshot taken.
-- Backfill them at the capped amount, which is what qualifying means, and
-- stamp it with their original qualification time rather than now.
UPDATE users
SET reward_settled_inr = 2000,
    reward_settled_at  = COALESCE(qualified_at, datetime('now'))
WHERE qualified = 1 AND reward_settled_inr IS NULL;
