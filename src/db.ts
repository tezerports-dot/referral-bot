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
  auto_approve: number;
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
/** chat_id -> auto_approve, for every active required chat. */
let requiredChatCache: { chats: Map<number, boolean>; at: number } | null = null;

export function invalidateRequiredChatCache(): void {
  requiredChatCache = null;
}

export interface ChatPolicy {
  required: boolean;
  /** True only for a chat an admin designated with /autojoin. */
  autoApprove: boolean;
}

/**
 * The join-request policy for a chat, from the cache where possible.
 *
 * Carries auto_approve alongside membership so the join handler learns both
 * from one lookup. A policy change made on another isolate can take up to the
 * TTL to be seen there; /autojoin invalidates immediately on its own isolate.
 */
export async function getChatPolicy(db: D1Database, chatId: number): Promise<ChatPolicy> {
  const now = Date.now();
  const fresh = requiredChatCache !== null && now - requiredChatCache.at <= REQUIRED_CHAT_TTL_MS;

  if (!fresh) {
    const res = await db
      .prepare("SELECT chat_id, auto_approve FROM required_chats WHERE active = 1")
      .all<{ chat_id: number; auto_approve: number }>();
    requiredChatCache = {
      chats: new Map((res.results ?? []).map((r) => [r.chat_id, r.auto_approve === 1])),
      at: now,
    };
    // The whole active set was just loaded, so absence from it is authoritative.
    const loaded = requiredChatCache.chats.get(chatId);
    return loaded === undefined ? { required: false, autoApprove: false } : { required: true, autoApprove: loaded };
  }

  const hit = requiredChatCache!.chats.get(chatId);
  if (hit !== undefined) return { required: true, autoApprove: hit };

  // Warm cache, no hit: confirm against the database before rejecting, so a
  // chat added seconds ago is never ignored.
  const row = await db
    .prepare("SELECT auto_approve FROM required_chats WHERE chat_id = ? AND active = 1")
    .bind(chatId)
    .first<{ auto_approve: number }>();
  return row ? { required: true, autoApprove: row.auto_approve === 1 } : { required: false, autoApprove: false };
}

export async function isRequiredChatCached(db: D1Database, chatId: number): Promise<boolean> {
  return (await getChatPolicy(db, chatId)).required;
}

/** Turns /autojoin on or off for a chat. Returns false if the chat is not in the list. */
export async function setChatAutoApprove(db: D1Database, chatId: number, on: boolean): Promise<boolean> {
  const res = await db
    .prepare("UPDATE required_chats SET auto_approve = ? WHERE chat_id = ? AND active = 1")
    .bind(on ? 1 : 0, chatId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function isRequiredChat(db: D1Database, chatId: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM required_chats WHERE chat_id = ? AND active = 1")
    .bind(chatId)
    .first();
  return row !== null;
}

export interface RequiredChatStatus extends RequiredChatRow {
  /**
   * 1 when this chat's requirement is met for the user: they hold a pending
   * join request OR are an actual member. See join_requests.status in schema.sql.
   */
  satisfied: number;
}

/**
 * Every active required chat plus whether this user has satisfied it, in one
 * query. Replaces the pair of calls that previously fetched the list and the
 * missing subset separately -- the caller needs both, and both came from the
 * same rows.
 *
 * "Satisfied" is `status IN ('pending', 'member')` and is written out
 * identically in every statement below that asks the question. There is
 * deliberately one definition, so no path can disagree about it.
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
                WHERE jr.telegram_user_id = ? AND jr.chat_id = rc.chat_id AND jr.status IN ('pending', 'member')
              ) AS satisfied
       FROM required_chats rc
       WHERE rc.active = 1
       ORDER BY rc.added_at ASC`
    )
    .bind(userId)
    .all<RequiredChatStatus>();
  return res.results ?? [];
}

/** The active required chats this user has neither requested to join nor joined. */
export async function getMissingRequiredChats(db: D1Database, userId: number): Promise<RequiredChatRow[]> {
  const res = await db
    .prepare(
      `SELECT rc.* FROM required_chats rc
       WHERE rc.active = 1
         AND NOT EXISTS (
               SELECT 1 FROM join_requests jr
               WHERE jr.telegram_user_id = ? AND jr.chat_id = rc.chat_id AND jr.status IN ('pending', 'member')
             )
       ORDER BY rc.added_at ASC`
    )
    .bind(userId)
    .all<RequiredChatRow>();
  return res.results ?? [];
}

// ---- Join requests and membership ----
//
// Three transitions over join_requests.status (see schema.sql):
//
//   chat_join_request  ->  pending   recordJoinRequest
//   chat_member in     ->  member    markJoinMember   (also getChatMember)
//   chat_member out    ->  ended     markJoinEnded
//
// Each takes the Telegram timestamp of the event and applies only if the row has
// not already moved past it. Telegram may redeliver an update after a retry, and
// documents update_id as the way to "restore the correct update sequence, should
// they get out of order" -- an unguarded write would let a stale duplicate
// resurrect a request that has ended, or end one the user has since re-sent.
//
// Each returns true only when the row actually changed, so a duplicate delivery
// is a cheap no-op and the caller can skip re-evaluating verification.
//
// `active` is written alongside as a deprecated mirror (status <> 'ended'); no
// code in this repository reads it.

/**
 * Records that this Telegram user ID sent a join request to this chat ID.
 * Written regardless of whether the user has registered with the bot yet. The
 * request is PENDING until an admin decides it -- the bot never approves it --
 * and a pending request satisfies the requirement.
 *
 * Strictly newer than the stored event: a duplicate of the same request (same
 * timestamp) changes nothing, so it can never demote a row that has since
 * become 'member'.
 */
export async function recordJoinRequest(
  db: D1Database,
  userId: number,
  chatId: number,
  eventAt: number
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO join_requests (telegram_user_id, chat_id, status, event_at, active)
       VALUES (?, ?, 'pending', ?, 1)
       ON CONFLICT(telegram_user_id, chat_id) DO UPDATE
         SET status = 'pending', event_at = excluded.event_at, active = 1
         WHERE excluded.event_at > join_requests.event_at`
    )
    .bind(userId, chatId, eventAt)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Records that the user is actually in the chat: an admin approved their
 * request, they joined some other way, or a getChatMember lookup found them
 * there. Creates the row when there is none, so a member is recognised even if
 * they never went through this bot's join-request flow.
 */
export async function markJoinMember(
  db: D1Database,
  userId: number,
  chatId: number,
  eventAt: number
): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO join_requests (telegram_user_id, chat_id, status, event_at, active)
       VALUES (?, ?, 'member', ?, 1)
       ON CONFLICT(telegram_user_id, chat_id) DO UPDATE
         SET status = 'member', event_at = excluded.event_at, active = 1
         WHERE excluded.event_at >= join_requests.event_at AND join_requests.status <> 'member'`
    )
    .bind(userId, chatId, eventAt)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Records that the user left, was removed, or is otherwise no longer requested
 * or a member. Never creates a row: a departure from a chat this user never
 * touched is nothing to remember.
 */
export async function markJoinEnded(
  db: D1Database,
  userId: number,
  chatId: number,
  eventAt: number
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE join_requests SET status = 'ended', event_at = ?, active = 0
       WHERE telegram_user_id = ? AND chat_id = ? AND status <> 'ended' AND ? >= event_at`
    )
    .bind(eventAt, userId, chatId, eventAt)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

// ---- Verification ----

/**
 * Atomically checks every verification condition against the *current* active
 * required-chat set and flips verified 0->1 in a single statement.
 *
 * "Every required chat satisfied" means a pending join request OR actual
 * membership -- NOT admin approval. A user is verified, and their referrer is
 * credited, before any admin has looked at their request.
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
                       WHERE jr.telegram_user_id = ? AND jr.chat_id = rc.chat_id AND jr.status IN ('pending', 'member')
                     )
             )
       RETURNING referred_by`
    )
    .bind(userId, userId)
    .first<{ referred_by: number | null }>();
  return { changed: row !== null, referredBy: row?.referred_by ?? null };
}

/**
 * The mirror image of tryClaimVerification: drops verified 1->0 in one
 * statement when the user has LEFT (or been removed from) an active required
 * chat, i.e. this bot holds a recorded departure ('ended') for it. Returns true
 * only for the call that performed the transition, so exactly one caller
 * decrements the referrer -- the same discipline that stops the increment
 * double-counting.
 *
 * Deliberately NOT "the user fails to satisfy every active chat". That reading
 * would un-verify every already-verified user, and cost each of their referrers
 * a credit, the first time they opened the bot after an admin added or swapped
 * a required chat. It contradicts the promise that rotating the list never
 * strips earned status (see /removechat and the README). Claiming verification
 * still requires every active chat; keeping it requires only that they have not
 * left one.
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
               JOIN join_requests jr ON jr.chat_id = rc.chat_id
               WHERE rc.active = 1
                 AND jr.telegram_user_id = ?
                 AND jr.status = 'ended'
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
 * threshold. Qualifying is a plain requirement -- it unlocks the premium
 * opportunity -- and carries no monetary figure.
 *
 * Uses `>=` rather than an exact match and reads the count inside the same
 * statement that flips the flag, so a concurrent increment can never cause the
 * threshold crossing to be missed or double-counted. The statement only ever
 * fires once per user.
 */
export async function tryClaimQualification(
  db: D1Database,
  userId: number,
  threshold: number
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE users SET qualified = 1, qualified_at = datetime('now')
       WHERE telegram_user_id = ? AND qualified = 0 AND verified_referral_count >= ?`
    )
    .bind(userId, threshold)
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
