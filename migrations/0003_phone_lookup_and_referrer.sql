-- Migration: look up a referrer by phone number instead of only by referral link.
--
-- Apply with:
--   npx wrangler d1 execute referral_bot_db --remote --file=./migrations/0003_phone_lookup_and_referrer.sql

-- Digits-only form of phone_number, so numbers typed with spaces, dashes or a
-- leading "+" compare equal to the one Telegram gave us.
ALTER TABLE users ADD COLUMN phone_normalized TEXT;

-- Last 10 digits, for the common case of someone typing a national number when
-- the referrer registered with a country code. Deliberately NOT unique: two
-- countries can share a tail, and a lookup that hits more than one row is
-- rejected rather than guessed.
ALTER TABLE users ADD COLUMN phone_tail TEXT;

-- Backfill both from whatever is already stored.
UPDATE users
SET phone_normalized = REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
      phone_number, '+', ''), '-', ''), ' ', ''), '(', ''), ')', '')
WHERE phone_number IS NOT NULL;

UPDATE users
SET phone_tail = SUBSTR(phone_normalized, -10)
WHERE phone_normalized IS NOT NULL AND LENGTH(phone_normalized) >= 10;

UPDATE users
SET phone_tail = phone_normalized
WHERE phone_normalized IS NOT NULL AND LENGTH(phone_normalized) < 10;

-- Uniqueness moves to the normalized form: "+919..." and "919..." are the same
-- person and must collide. The old raw-column index would have let them both in.
DROP INDEX IF EXISTS idx_users_phone;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_normalized
  ON users(phone_normalized) WHERE phone_normalized IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_phone_tail
  ON users(phone_tail) WHERE phone_tail IS NOT NULL;
