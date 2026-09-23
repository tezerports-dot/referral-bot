-- Migration: let an admin designate a chat whose join requests are approved
-- automatically.
--
-- Every other chat keeps the manual rule: the bot records the request, leaves
-- it pending for an admin, and declines anyone who did not come through the
-- bot. Only a chat explicitly flagged here is approved by the bot.
--
-- Apply with:
--   npx wrangler d1 execute referral_bot_db --remote --file=./migrations/0007_auto_approve_chats.sql

ALTER TABLE required_chats ADD COLUMN auto_approve INTEGER NOT NULL DEFAULT 0;
