-- Referral / verification system schema for Cloudflare D1 (SQLite).

CREATE TABLE IF NOT EXISTS users (
  telegram_user_id         INTEGER PRIMARY KEY,
  referral_code            TEXT NOT NULL UNIQUE,
  referred_by              INTEGER REFERENCES users(telegram_user_id),
  username                 TEXT,
  first_name               TEXT,
  phone_number             TEXT,
  contact_shared           INTEGER NOT NULL DEFAULT 0,
  group1_request           INTEGER NOT NULL DEFAULT 0,
  group2_request           INTEGER NOT NULL DEFAULT 0,
  channel_request          INTEGER NOT NULL DEFAULT 0,
  verified                 INTEGER NOT NULL DEFAULT 0,
  verified_at              TEXT,
  verified_referral_count  INTEGER NOT NULL DEFAULT 0,
  qualified                INTEGER NOT NULL DEFAULT 0,
  qualified_at             TEXT,
  premium_invite_link      TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- referral_code already has a UNIQUE constraint above; this index just
-- makes lookups by code (used on every /start with a payload) fast.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);

-- Used when listing a referrer's direct referrals and when incrementing counts.
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);

CREATE INDEX IF NOT EXISTS idx_users_qualified ON users(qualified);

-- One row per (user, required chat) join request. This is independent of
-- whether the user has registered with the bot yet, and is the source of
-- truth for "did this Telegram user ID send a chat_join_request to this
-- chat" -- it is also what makes duplicate Telegram webhook deliveries
-- (retries) safe to process more than once.
CREATE TABLE IF NOT EXISTS join_requests (
  telegram_user_id INTEGER NOT NULL,
  chat_id          INTEGER NOT NULL,
  requested_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (telegram_user_id, chat_id)
);
