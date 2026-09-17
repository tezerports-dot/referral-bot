-- Referral / verification system schema for Cloudflare D1 (SQLite).
--
-- Fresh installs: apply this file.
-- Existing databases: apply migrations/0002_dynamic_requirements.sql instead,
-- which migrates a v1 database in place without losing data.

CREATE TABLE IF NOT EXISTS users (
  telegram_user_id         INTEGER PRIMARY KEY,
  referral_code            TEXT NOT NULL UNIQUE,
  referred_by              INTEGER REFERENCES users(telegram_user_id),
  username                 TEXT,
  first_name               TEXT,
  phone_number             TEXT,
  -- Digits-only form, so "+91 98765 43210" and "919876543210" compare equal.
  phone_normalized         TEXT,
  -- Last 10 digits, for matching a number typed without its country code.
  phone_tail               TEXT,
  contact_shared           INTEGER NOT NULL DEFAULT 0,
  verified                 INTEGER NOT NULL DEFAULT 0,
  verified_at              TEXT,
  verified_referral_count  INTEGER NOT NULL DEFAULT 0,
  qualified                INTEGER NOT NULL DEFAULT 0,
  qualified_at             TEXT,
  premium_paid             INTEGER NOT NULL DEFAULT 0,
  premium_paid_at          TEXT,
  premium_charge_id        TEXT,
  premium_invite_link      TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
CREATE INDEX IF NOT EXISTS idx_users_qualified ON users(qualified);

-- Anti-sybil: one phone number can back at most one account. Enforced on the
-- normalized form so that two spellings of the same number still collide.
-- Partial, so the many users who have not shared contact yet do not clash.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_normalized
  ON users(phone_normalized) WHERE phone_normalized IS NOT NULL;

-- Non-unique: two countries can share a 10-digit tail. A lookup that matches
-- more than one row is rejected rather than guessed.
CREATE INDEX IF NOT EXISTS idx_users_phone_tail
  ON users(phone_tail) WHERE phone_tail IS NOT NULL;

-- The set of groups/channels a user must send a join request to in order to
-- verify. Admin-managed at runtime (/addchat, /removechat) -- there is no
-- fixed number of them, and the list can be rotated freely.
--
-- Rows are never deleted, only deactivated, so that historical evidence in
-- join_requests stays interpretable after a rotation.
CREATE TABLE IF NOT EXISTS required_chats (
  chat_id     INTEGER PRIMARY KEY,
  title       TEXT,
  kind        TEXT    NOT NULL DEFAULT 'group',   -- 'group' | 'channel'
  -- Approval-required invite link ("creates_join_request"), minted by the bot
  -- when the chat is added. This is what users are shown, so a plain invite
  -- link that would bypass verification never has to be circulated.
  invite_link TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  added_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  added_by    INTEGER,
  deactivated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_required_chats_active ON required_chats(active);

-- One row per (user, chat) join request, and the single source of truth for
-- "did this Telegram user ID request to join this chat".
--
-- Independent of whether the user has registered with the bot yet, so a join
-- request that arrives before /start is never lost. The composite primary key
-- makes duplicate Telegram webhook deliveries (retries) idempotent.
CREATE TABLE IF NOT EXISTS join_requests (
  telegram_user_id INTEGER NOT NULL,
  chat_id          INTEGER NOT NULL,
  requested_at     TEXT NOT NULL DEFAULT (datetime('now')),
  -- 1 while the user is in the chat, 0 once they leave or are removed. Only
  -- live memberships satisfy a requirement, so a member who joins and then
  -- leaves stops counting for their referrer.
  active           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (telegram_user_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_join_requests_active
  ON join_requests(telegram_user_id, active);

CREATE INDEX IF NOT EXISTS idx_join_requests_chat ON join_requests(chat_id);
