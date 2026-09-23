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
  -- DEPRECATED and unused. Older builds froze a rupee figure here when a user
  -- qualified. Qualification is now a plain requirement with no money attached,
  -- so nothing writes or reads these; existing values are kept as history.
  reward_settled_inr       INTEGER,
  reward_settled_at        TEXT,
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
  -- 1 when the bot should approve join requests to this chat itself, instead of
  -- recording them and leaving them pending for an admin. Off by default, and
  -- set only by an admin running /autojoin.
  auto_approve INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  added_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  added_by    INTEGER,
  deactivated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_required_chats_active ON required_chats(active);

-- One row per (user, chat), and the single source of truth for where a Telegram
-- user ID stands with a required chat.
--
-- Independent of whether the user has registered with the bot yet, so a state
-- change that arrives before /start is never lost. The composite primary key
-- makes duplicate Telegram webhook deliveries (retries) idempotent.
--
-- `status` keeps two different facts apart that a single boolean used to blur:
--
--   pending  the user sent a join request that no admin has decided yet.
--            Set by chat_join_request. SATISFIES the requirement.
--   member   the user is actually in the chat. Set by chat_member, or by a
--            getChatMember lookup. SATISFIES the requirement.
--   ended    the user left, was removed, or their request was withdrawn.
--            Does NOT satisfy the requirement.
--
-- "Requirement satisfied" is therefore exactly:  status IN ('pending','member').
-- A requirement with no row at all is not satisfied either.
--
-- Telegram tells a bot nothing when an admin DECLINES a request, so a pending
-- row cannot be ended by a decline -- only by a later left/kicked event or by
-- the user requesting again. See README "Pending requests and declines".
CREATE TABLE IF NOT EXISTS join_requests (
  telegram_user_id INTEGER NOT NULL,
  chat_id          INTEGER NOT NULL,
  requested_at     TEXT NOT NULL DEFAULT (datetime('now')),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'member', 'ended')),
  -- Unix time (seconds) of the Telegram event that last set `status`. A state
  -- change is applied only if it is not older than this, so a redelivered or
  -- out-of-order update can neither resurrect an ended request nor end a newer
  -- one. 0 for rows that predate the column.
  event_at         INTEGER NOT NULL DEFAULT 0,
  -- DEPRECATED. Mirrors (status <> 'ended') so that rolling back to a build
  -- that still reads it behaves sensibly. The application never reads it.
  active           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (telegram_user_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_join_requests_active
  ON join_requests(telegram_user_id, active);

CREATE INDEX IF NOT EXISTS idx_join_requests_status
  ON join_requests(telegram_user_id, status);

CREATE INDEX IF NOT EXISTS idx_join_requests_chat ON join_requests(chat_id);
