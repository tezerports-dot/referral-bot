import { generateReferralCode } from "./referralCode";

export interface UserRow {
  telegram_user_id: number;
  referral_code: string;
  referred_by: number | null;
  username: string | null;
  first_name: string | null;
  phone_number: string | null;
  phone_normalized: string | null;
  phone_tail: string | null;
  contact_shared: number;
  verified: number;
  verified_at: string | null;
  verified_referral_count: number;
  qualified: number;
  qualified_at: string | null;
  reward_settled_inr: number | null;
  reward_settled_at: string | null;
  premium_paid: number;
  premium_paid_at: string | null;
  premium_charge_id: string | null;
  premium_invite_link: string | null;
  created_at: string;
}

export interface RequiredChatRow {
  chat_id: number;
  title: string | null;
  kind: string;
  invite_link: string | null;
  active: number;
  added_at: string;
  added_by: number | null;
  deactivated_at: string | null;
}

export async function getUserById(db: D1Database, id: number): Promise<UserRow | null> {
  const row = await db.prepare("SELECT * FROM users WHERE telegram_user_id = ?").bind(id).first<UserRow>();
  return row ?? null;
}

export async function getUserByReferralCode(db: D1Database, code: string): Promise<UserRow | null> {
  const row = await db.prepare("SELECT * FROM users WHERE referral_code = ?").bind(code).first<UserRow>();
  return row ?? null;
}

/**
 * Creates the user if they don't already exist. Safe to call on every /start,
 * including repeated ones -- referred_by is only ever set at creation time and
 * is never overwritten, which is what guarantees a referred user can only ever
 * belong to one direct referrer.
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

  // If the referrer isn't a real registered user, drop the reference rather
  // than violate the foreign key constraint.
  if (referredBy !== null) {
    const referrer = await getUserById(db, referredBy);
    if (!referrer) referredBy = null;
  }

  // Referral codes are random; collisions are astronomically unlikely but we
  // still guard against them instead of trusting probability.
  let code = generateReferralCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await getUserByReferralCode(db, code);
    if (!clash) break;
    code = generateReferralCode();
  }

  // RETURNING hands back the new row in the same round trip. On a lost race the
  // conflict suppresses the insert and returns nothing, so we read the row that
  // actually won -- correctness preserved, one fewer query in the common path.
  const created = await db
    .prepare(
      `INSERT INTO users (telegram_user_id, referral_code, referred_by, username, first_name)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(telegram_user_id) DO NOTHING
       RETURNING *`
    )
    .bind(id, code, referredBy, username, firstName)
    .first<UserRow>();
  if (created) return created;

  const raced = await getUserById(db, id);
  if (!raced) throw new Error(`Failed to create or read user ${id}`);
  return raced;
}

export type ContactResult = "ok" | "phone_taken" | "no_user";

/**
 * Records a shared contact. The uniqueness check lives inside the UPDATE's
 * WHERE clause rather than in a separate SELECT, so two accounts submitting the
 * same phone number concurrently cannot both succeed. Re-sharing the same
 * number from the same account stays a successful no-op.
 */
export async function setContactShared(
  db: D1Database,
  id: number,
  phone: string,
  normalized: string,
  tail: string
): Promise<ContactResult> {
  const res = await db
    .prepare(
      `UPDATE users SET contact_shared = 1, phone_number = ?, phone_normalized = ?, phone_tail = ?
       WHERE telegram_user_id = ?
         AND NOT EXISTS (
               SELECT 1 FROM users other
               WHERE other.phone_normalized = ? AND other.telegram_user_id <> ?
             )`
    )
    .bind(phone, normalized, tail, id, normalized, id)
    .run();

  if ((res.meta.changes ?? 0) > 0) return "ok";
  return (await getUserById(db, id)) ? "phone_taken" : "no_user";
}

/**
 * Finds the account a phone number belongs to. Tries the full normalized
 * number first; falls back to the 10-digit tail so that someone who types
 * "9876543210" still matches a referrer stored as "919876543210". The tail
 * match is only honoured when it resolves to exactly one account -- an
 * ambiguous tail is reported rather than guessed, because guessing would
 * credit the wrong referrer.
 */
export async function getUserByPhone(
  db: D1Database,
  normalized: string,
  tail: string
): Promise<UserRow | "ambiguous" | null> {
  const exact = await db
    .prepare("SELECT * FROM users WHERE phone_normalized = ?")
    .bind(normalized)
    .first<UserRow>();
  if (exact) return exact;

  const res = await db
    .prepare("SELECT * FROM users WHERE phone_tail = ? LIMIT 2")
    .bind(tail)
    .all<UserRow>();
  const rows = res.results ?? [];
  if (rows.length === 1) return rows[0];
  if (rows.length > 1) return "ambiguous";
  return null;
}

/**
 * Sets a referrer exactly once. The guards live in the WHERE clause so two
 * concurrent attempts cannot both succeed: a referrer can only be set while
 * none is recorded and the user is not yet verified, never to the user
 * themselves, and only to an account that actually exists.
 */
export async function trySetReferrer(db: D1Database, userId: number, referrerId: number): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE users SET referred_by = ?
       WHERE telegram_user_id = ?
         AND referred_by IS NULL
         AND verified = 0
         AND telegram_user_id <> ?
         AND EXISTS (SELECT 1 FROM users r WHERE r.telegram_user_id = ?)`
    )
    .bind(referrerId, userId, referrerId, referrerId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---- Required chats (admin-managed, unlimited, rotatable) ----

export async function listRequiredChats(db: D1Database, activeOnly = true): Promise<RequiredChatRow[]> {
  const sql = activeOnly
    ? "SELECT * FROM required_chats WHERE active = 1 ORDER BY added_at ASC"
    : "SELECT * FROM required_chats ORDER BY active DESC, added_at ASC";
  const res = await db.prepare(sql).all<RequiredChatRow>();
  return res.results ?? [];
}

/**
 * Adds a chat to the required set, or reactivates one that was removed
 * earlier. Returns the row as it now stands.
 */
export async function addRequiredChat(
  db: D1Database,
  chatId: number,
  title: string | null,
  kind: string,
  addedBy: number
): Promise<RequiredChatRow | null> {
  await db
    .prepare(
      `INSERT INTO required_chats (chat_id, title, kind, active, added_by)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         active = 1,
         deactivated_at = NULL,
         title = COALESCE(excluded.title, required_chats.title),
         kind = excluded.kind`
    )
    .bind(chatId, title, kind, addedBy)
    .run();

  return db.prepare("SELECT * FROM required_chats WHERE chat_id = ?").bind(chatId).first<RequiredChatRow>();
}

/**
 * Deactivates a required chat. The row is kept (not deleted) so that existing
 * join_requests rows stay interpretable, and so re-adding the chat later
 * restores every user's prior progress for it automatically.
 */
export async function deactivateRequiredChat(db: D1Database, chatId: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE required_chats SET active = 0, deactivated_at = datetime('now') WHERE chat_id = ? AND active = 1")
    .bind(chatId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Positive-only cache of the active required chat IDs, held per isolate.
 *
 * chat_member fires for every membership change in every required chat, and
 * each one previously cost a D1 read to answer a question whose answer changes
 * about once a month. A hit now costs nothing.
 *
 * Only hits are trusted. A miss still falls through to the database, so a chat
 * added seconds ago is recognised immediately rather than being ignored until
 * the entry expires -- the cache can never cause a join request to be dropped.
 * A stale entry for a chat just removed is harmless: verification reads
 * required_chats live, so a lingering row cannot make anyone verified.
 */
const REQUIRED_CHAT_TTL_MS = 60_000;
let requiredChatCache: { ids: Set<number>; at: number } | null = null;

export function invalidateRequiredChatCache(): void {
  requiredChatCache = null;
}

export async function isRequiredChatCached(db: D1Database, chatId: number): Promise<boolean> {
  const now = Date.now();
  if (requiredChatCache && now - requiredChatCache.at <= REQUIRED_CHAT_TTL_MS) {
    if (requiredChatCache.ids.has(chatId)) return true;
  } else {
    const res = await db.prepare("SELECT chat_id FROM required_chats WHERE active = 1").all<{ chat_id: number }>();
    requiredChatCache = { ids: new Set((res.results ?? []).map((r) => r.chat_id)), at: now };
    return requiredChatCache.ids.has(chatId);
  }
  // Warm cache, no hit: confirm against the database before rejecting, so a
  // newly added chat is never ignored.
  return isRequiredChat(db, chatId);
}

export async function isRequiredChat(db: D1Database, chatId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM required_chats WHERE chat_id = ? AND active = 1")
    .bind(chatId)
    .first();
  return row !== null;
}

export interface RequiredChatStatus extends RequiredChatRow {
  /** 1 when the user currently holds a live membership in this chat. */
  joined: number;
}

/**
 * Every active required chat plus whether this user is in it, in one query.
 * Replaces the pair of calls that previously fetched the list and the missing
 * subset separately -- the caller needs both, and both came from the same rows.
 */
export async function getRequiredChatsWithStatus(
  db: D1Database,
  userId: number
): Promise<RequiredChatStatus[]> {
  const res = await db
    .prepare(
      `SELECT rc.*,
              EXISTS (
                SELECT 1 FROM join_requests jr
                WHERE jr.telegram_user_id = ? AND jr.chat_id = rc.chat_id AND jr.active = 1
              ) AS joined
       FROM required_chats rc
       WHERE rc.active = 1
       ORDER BY rc.added_at ASC`
    )
    .bind(userId)
    .all<RequiredChatStatus>();
  return res.results ?? [];
}

/** The active required chats this user has not yet sent a join request to. */
export async function getMissingRequiredChats(db: D1Database, userId: number): Promise<RequiredChatRow[]> {
  const res = await db
    .prepare(
      `SELECT rc.* FROM required_chats rc
       WHERE rc.active = 1
         AND NOT EXISTS (
               SELECT 1 FROM join_requests jr
               WHERE jr.telegram_user_id = ? AND jr.chat_id = rc.chat_id AND jr.active = 1
             )
       ORDER BY rc.added_at ASC`
    )
    .bind(userId)
    .all<RequiredChatRow>();
  return res.results ?? [];
}

// ---- Join requests ----

/**
 * Records that this Telegram user ID sent a join request to this chat ID.
 * Idempotent: Telegram may redeliver the same webhook update on retry, and the
 * (telegram_user_id, chat_id) primary key makes a duplicate a no-op. Rows are
 * written regardless of whether the user has registered with the bot yet, so a
 * join request sent before /start is never lost.
 */
export async function recordJoinRequest(db: D1Database, userId: number, chatId: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO join_requests (telegram_user_id, chat_id, active) VALUES (?, ?, 1)
       ON CONFLICT(telegram_user_id, chat_id) DO UPDATE SET active = 1`
    )
    .bind(userId, chatId)
    .run();
}

// ---- Verification ----

/**
 * Atomically checks every verification condition against the *current* active
 * required-chat set and flips verified 0->1 in a single statement.
 *
 * A referrer is NOT required: an organic user who finds the bot directly can
 * verify on their own. Referrals only matter for reaching the premium
 * threshold, which is counted on the referrer's side.
 *
 * Returns true only for the call that actually performed the transition.
 * Concurrent or duplicate calls (Telegram webhook retries racing each other)
 * see 0 rows changed and return false, which is what prevents a referrer's
 * count being incremented more than once for the same referred user.
 *
 * The `EXISTS` guard means an empty required set never auto-verifies everyone:
 * with no active chats the NOT EXISTS below would be vacuously true.
 */
export interface VerificationChange {
  changed: boolean;
  /** The referrer to credit or debit, read in the same statement. */
  referredBy: number | null;
}

export async function tryClaimVerification(db: D1Database, userId: number): Promise<VerificationChange> {
  const row = await db
    .prepare(
      `UPDATE users
       SET verified = 1, verified_at = datetime('now')
       WHERE telegram_user_id = ?
         AND verified = 0
         AND contact_shared = 1
         AND EXISTS (SELECT 1 FROM required_chats WHERE active = 1)
         AND NOT EXISTS (
               SELECT 1 FROM required_chats rc
               WHERE rc.active = 1
                 AND NOT EXISTS (
                       SELECT 1 FROM join_requests jr
                       WHERE jr.telegram_user_id = ? AND jr.chat_id = rc.chat_id AND jr.active = 1
                     )
             )
       RETURNING referred_by`
    )
    .bind(userId, userId)
    .first<{ referred_by: number | null }>();
  return { changed: row !== null, referredBy: row?.referred_by ?? null };
}

/** Marks a membership live or lost. Returns true if the state actually changed. */
export async function setJoinRequestActive(
  db: D1Database,
  userId: number,
  chatId: number,
  active: boolean
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE join_requests SET active = ? WHERE telegram_user_id = ? AND chat_id = ? AND active <> ?")
    .bind(active ? 1 : 0, userId, chatId, active ? 1 : 0)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * The mirror image of tryClaimVerification: drops verified 1->0 in one
 * statement when the user no longer holds a live membership in every active
 * required chat. Returns true only for the call that performed the
 * transition, so exactly one caller decrements the referrer -- the same
 * discipline that stops the increment double-counting.
 */
export async function tryRevokeVerification(db: D1Database, userId: number): Promise<VerificationChange> {
  const row = await db
    .prepare(
      `UPDATE users
       SET verified = 0, verified_at = NULL
       WHERE telegram_user_id = ?
         AND verified = 1
         AND EXISTS (
               SELECT 1 FROM required_chats rc
               WHERE rc.active = 1
                 AND NOT EXISTS (
                       SELECT 1 FROM join_requests jr
                       WHERE jr.telegram_user_id = ? AND jr.chat_id = rc.chat_id AND jr.active = 1
                     )
             )
       RETURNING referred_by`
    )
    .bind(userId, userId)
    .first<{ referred_by: number | null }>();
  return { changed: row !== null, referredBy: row?.referred_by ?? null };
}

/** Floored at zero, so a double-decrement can never drive a count negative. */
export async function decrementVerifiedReferralCount(db: D1Database, referrerId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET verified_referral_count = MAX(0, verified_referral_count - 1)
       WHERE telegram_user_id = ?`
    )
    .bind(referrerId)
    .run();
}

export async function incrementVerifiedReferralCount(db: D1Database, referrerId: number): Promise<void> {
  await db
    .prepare("UPDATE users SET verified_referral_count = verified_referral_count + 1 WHERE telegram_user_id = ?")
    .bind(referrerId)
    .run();
}

/**
 * Atomically claims qualification for a referrer who has reached the
 * threshold, and freezes the rupee figure in the same statement.
 *
 * Uses `>=` rather than an exact match and reads the count inside the same
 * statement that flips the flag, so a concurrent increment can never cause the
 * threshold crossing to be missed or double-counted.
 *
 * The snapshot is taken here rather than by a later read because this is the
 * instant the money is owed. Computing it in the same UPDATE means the count it
 * is based on cannot shift between the check and the capture, and because the
 * statement only ever fires once per user, the settled figure is written once
 * and never moves again -- even as the live figure erodes when referrals leave.
 */
export async function tryClaimQualification(
  db: D1Database,
  userId: number,
  threshold: number,
  rewardPerReferral: number
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE users SET qualified = 1, qualified_at = datetime('now'),
              reward_settled_inr = MIN(verified_referral_count, ?) * ?,
              reward_settled_at = datetime('now')
       WHERE telegram_user_id = ? AND qualified = 0 AND verified_referral_count >= ?`
    )
    .bind(threshold, rewardPerReferral, userId, threshold)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---- Premium payment ----

/** Idempotent: returns true only for the call that actually recorded payment. */
export async function markPremiumPaid(db: D1Database, userId: number, chargeId: string): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE users SET premium_paid = 1, premium_paid_at = datetime('now'), premium_charge_id = ?
       WHERE telegram_user_id = ? AND premium_paid = 0`
    )
    .bind(chargeId, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function setRequiredChatInviteLink(db: D1Database, chatId: number, link: string): Promise<void> {
  await db.prepare("UPDATE required_chats SET invite_link = ? WHERE chat_id = ?").bind(link, chatId).run();
}

export async function setPremiumInviteLink(db: D1Database, userId: number, link: string): Promise<void> {
  await db
    .prepare("UPDATE users SET premium_invite_link = ? WHERE telegram_user_id = ?")
    .bind(link, userId)
    .run();
}

/** Clears payment state so a refunded user must pay again for a new link. */
export async function clearPremiumPayment(db: D1Database, userId: number): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET premium_paid = 0, premium_paid_at = NULL, premium_charge_id = NULL,
                        premium_invite_link = NULL
       WHERE telegram_user_id = ?`
    )
    .bind(userId)
    .run();
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

export async function countPaidUsers(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) as c FROM users WHERE premium_paid = 1").first<{ c: number }>();
  return row?.c ?? 0;
}

export async function getDirectReferrals(db: D1Database, referrerId: number, limit = 100): Promise<UserRow[]> {
  const res = await db
    .prepare("SELECT * FROM users WHERE referred_by = ? ORDER BY created_at DESC LIMIT ?")
    .bind(referrerId, limit)
    .all<UserRow>();
  return res.results ?? [];
}

/** Keyset pagination (not OFFSET) so export performance doesn't degrade as the table grows. */
export async function getUsersPage(db: D1Database, afterId: number, pageSize: number): Promise<UserRow[]> {
  const res = await db
    .prepare("SELECT * FROM users WHERE telegram_user_id > ? ORDER BY telegram_user_id ASC LIMIT ?")
    .bind(afterId, pageSize)
    .all<UserRow>();
  return res.results ?? [];
}
