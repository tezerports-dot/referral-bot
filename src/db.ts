import { generateReferralCode } from "./referralCode";

export interface UserRow {
  telegram_user_id: number;
  referral_code: string;
  referred_by: number | null;
  username: string | null;
  first_name: string | null;
  phone_number: string | null;
  contact_shared: number;
  group1_request: number;
  group2_request: number;
  channel_request: number;
  verified: number;
  verified_at: string | null;
  verified_referral_count: number;
  qualified: number;
  qualified_at: string | null;
  premium_invite_link: string | null;
  created_at: string;
}

export type RequestColumn = "group1_request" | "group2_request" | "channel_request";

export async function getUserById(db: D1Database, id: number): Promise<UserRow | null> {
  const row = await db.prepare("SELECT * FROM users WHERE telegram_user_id = ?").bind(id).first<UserRow>();
  return row ?? null;
}

export async function getUserByReferralCode(db: D1Database, code: string): Promise<UserRow | null> {
  const row = await db.prepare("SELECT * FROM users WHERE referral_code = ?").bind(code).first<UserRow>();
  return row ?? null;
}

/**
 * Creates the user if they don't already exist. Safe to call on every
 * /start, including repeated ones -- referred_by is only ever set at
 * creation time and is never overwritten, which is what guarantees a
 * referred user can only ever belong to one direct referrer.
 */
export async function createUserIfNotExists(
  db: D1Database,
  id: number,
  proposedReferrerId: number | null,
  username: string | null,
  firstName: string | null
): Promise<UserRow> {
  const existing = await getUserById(db, id);
  if (existing) return existing;

  // Self-referral guard.
  let referredBy: number | null = proposedReferrerId === id ? null : proposedReferrerId;

  // If the referrer isn't a real registered user, drop the reference
  // rather than violate the foreign key constraint.
  if (referredBy !== null) {
    const referrer = await getUserById(db, referredBy);
    if (!referrer) referredBy = null;
  }

  // Referral codes are random; collisions are astronomically unlikely but
  // we still guard against them instead of trusting probability.
  let code = generateReferralCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await getUserByReferralCode(db, code);
    if (!clash) break;
    code = generateReferralCode();
  }

  await db
    .prepare(
      `INSERT INTO users (telegram_user_id, referral_code, referred_by, username, first_name)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(telegram_user_id) DO NOTHING`
    )
    .bind(id, code, referredBy, username, firstName)
    .run();

  const created = await getUserById(db, id);
  if (!created) throw new Error(`Failed to create or read user ${id}`);
  return created;
}

export async function setContactShared(db: D1Database, id: number, phone: string): Promise<void> {
  await db
    .prepare("UPDATE users SET contact_shared = 1, phone_number = ? WHERE telegram_user_id = ?")
    .bind(phone, id)
    .run();
}

/**
 * Records that this Telegram user ID sent a join request to this chat ID.
 * Idempotent: Telegram may redeliver the same webhook update on retry, and
 * the (telegram_user_id, chat_id) primary key makes a duplicate a no-op.
 * This table is independent of whether the user has registered with the
 * bot yet, so a join request sent before /start is never lost.
 */
export async function recordJoinRequest(db: D1Database, userId: number, chatId: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO join_requests (telegram_user_id, chat_id) VALUES (?, ?)
       ON CONFLICT(telegram_user_id, chat_id) DO NOTHING`
    )
    .bind(userId, chatId)
    .run();
}

export async function hasJoinRequest(db: D1Database, userId: number, chatId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM join_requests WHERE telegram_user_id = ? AND chat_id = ?")
    .bind(userId, chatId)
    .first();
  return row !== null;
}

export async function setRequestFlag(db: D1Database, userId: number, column: RequestColumn): Promise<void> {
  // `column` only ever comes from the fixed RequestColumn union defined in
  // this file, never from user input, so this interpolation is safe.
  await db.prepare(`UPDATE users SET ${column} = 1 WHERE telegram_user_id = ?`).bind(userId).run();
}

/**
 * Backfills request flags for a user from any join_requests rows that
 * arrived before they ran /start (order of operations shouldn't matter).
 */
export async function backfillJoinRequestFlags(
  db: D1Database,
  userId: number,
  chatIds: { group1: number | null; group2: number | null; channel: number | null }
): Promise<void> {
  const checks: Array<[RequestColumn, number | null]> = [
    ["group1_request", chatIds.group1],
    ["group2_request", chatIds.group2],
    ["channel_request", chatIds.channel],
  ];
  for (const [column, chatId] of checks) {
    if (!chatId) continue;
    if (await hasJoinRequest(db, userId, chatId)) {
      await setRequestFlag(db, userId, column);
    }
  }
}

/**
 * Atomically checks every verification condition and flips verified 0->1
 * in a single statement. Returns true only for the call that actually
 * performed the transition -- concurrent/duplicate calls (e.g. Telegram
 * webhook retries racing each other) will see 0 rows changed and return
 * false, which is what prevents a referrer's count from being incremented
 * more than once for the same referred user.
 */
export async function tryClaimVerification(db: D1Database, userId: number): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE users
       SET verified = 1, verified_at = datetime('now')
       WHERE telegram_user_id = ?
         AND verified = 0
         AND contact_shared = 1
         AND referred_by IS NOT NULL
         AND group1_request = 1
         AND group2_request = 1
         AND channel_request = 1`
    )
    .bind(userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function incrementVerifiedReferralCount(db: D1Database, referrerId: number): Promise<number> {
  await db
    .prepare("UPDATE users SET verified_referral_count = verified_referral_count + 1 WHERE telegram_user_id = ?")
    .bind(referrerId)
    .run();
  const row = await getUserById(db, referrerId);
  return row?.verified_referral_count ?? 0;
}

/** Idempotent: only actually updates (and thus should only be acted on) the first time. */
export async function markQualified(db: D1Database, userId: number, inviteLink: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE users SET qualified = 1, qualified_at = datetime('now'), premium_invite_link = ?
       WHERE telegram_user_id = ? AND qualified = 0`
    )
    .bind(inviteLink, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---- Admin queries ----

export async function countTotalUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as c FROM users").first<{ c: number }>();
  return row?.c ?? 0;
}

export async function countVerifiedUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as c FROM users WHERE verified = 1").first<{ c: number }>();
  return row?.c ?? 0;
}

export async function countQualifiedUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as c FROM users WHERE qualified = 1").first<{ c: number }>();
  return row?.c ?? 0;
}

export async function getDirectReferrals(db: D1Database, referrerId: number, limit = 100): Promise<UserRow[]> {
  const res = await db
    .prepare("SELECT * FROM users WHERE referred_by = ? ORDER BY created_at DESC LIMIT ?")
    .bind(referrerId, limit)
    .all<UserRow>();
  return res.results ?? [];
}

export async function getQualifiedUsers(db: D1Database, afterId = 0, limit = 100): Promise<UserRow[]> {
  const res = await db
    .prepare(
      "SELECT * FROM users WHERE qualified = 1 AND telegram_user_id > ? ORDER BY telegram_user_id ASC LIMIT ?"
    )
    .bind(afterId, limit)
    .all<UserRow>();
  return res.results ?? [];
}

/** Keyset pagination (not OFFSET) so export performance doesn't degrade as the table grows toward ~1.5M rows. */
export async function getUsersPage(db: D1Database, afterId: number, pageSize: number): Promise<UserRow[]> {
  const res = await db
    .prepare("SELECT * FROM users WHERE telegram_user_id > ? ORDER BY telegram_user_id ASC LIMIT ?")
    .bind(afterId, pageSize)
    .all<UserRow>();
  return res.results ?? [];
}
