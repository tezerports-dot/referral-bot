-- Migration: fixed 3-chat requirement  ->  admin-managed, unlimited chat list.
-- Also adds Telegram Stars payment columns and the anti-sybil phone index.
--
-- Safe to run on a live v1 database. Apply with:
--   npx wrangler d1 execute referral_bot_db --remote --file=./migrations/0002_dynamic_requirements.sql

-- 1. New tables ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS required_chats (
  chat_id     INTEGER PRIMARY KEY,
  title       TEXT,
  kind        TEXT    NOT NULL DEFAULT 'group',
  invite_link TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  added_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  added_by    INTEGER,
  deactivated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_required_chats_active ON required_chats(active);
CREATE INDEX IF NOT EXISTS idx_join_requests_chat ON join_requests(chat_id);

-- 2. Seed the previously hard-coded chats -----------------------------------
-- These are the three IDs that were in wrangler.toml [vars] before this
-- migration. Adjust or remove if your deployment used different ones.

INSERT INTO required_chats (chat_id, title, kind) VALUES
  (-1004493745060, 'Group 1', 'group'),
  (-1004365591682, 'Group 2', 'group'),
  (-1004309711460, 'Channel', 'channel')
ON CONFLICT(chat_id) DO NOTHING;

-- 3. Premium payment columns ------------------------------------------------

ALTER TABLE users ADD COLUMN premium_paid      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN premium_paid_at   TEXT;
ALTER TABLE users ADD COLUMN premium_charge_id TEXT;

-- 4. Backfill join_requests from the old per-user boolean flags -------------
-- v1 wrote both, so this is normally a no-op; it exists so that a row whose
-- flag was set without a matching join_requests row still counts after the
-- switch to join_requests being the sole source of truth.

INSERT INTO join_requests (telegram_user_id, chat_id)
  SELECT telegram_user_id, -1004493745060 FROM users WHERE group1_request = 1
ON CONFLICT DO NOTHING;
INSERT INTO join_requests (telegram_user_id, chat_id)
  SELECT telegram_user_id, -1004365591682 FROM users WHERE group2_request = 1
ON CONFLICT DO NOTHING;
INSERT INTO join_requests (telegram_user_id, chat_id)
  SELECT telegram_user_id, -1004309711460 FROM users WHERE channel_request = 1
ON CONFLICT DO NOTHING;

-- 5. Anti-sybil phone uniqueness --------------------------------------------
-- If this fails, you already have duplicate phone numbers. Find them with:
--   SELECT phone_number, COUNT(*) c FROM users WHERE phone_number IS NOT NULL
--   GROUP BY phone_number HAVING c > 1;
-- and resolve before re-running.

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone
  ON users(phone_number) WHERE phone_number IS NOT NULL;

-- 6. Optional cleanup -------------------------------------------------------
-- The three boolean columns are no longer read by the application. Drop them
-- once you have confirmed the new flow works against real traffic. Kept
-- separate (and commented) because this is irreversible on a live database.
--
-- ALTER TABLE users DROP COLUMN group1_request;
-- ALTER TABLE users DROP COLUMN group2_request;
-- ALTER TABLE users DROP COLUMN channel_request;
