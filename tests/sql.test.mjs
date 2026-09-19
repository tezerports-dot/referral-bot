// Exercises the atomic SQL from src/db.ts against real SQLite.
//
// The statements below are copied verbatim from src/db.ts; each one is also
// asserted to still be present in that file, so the tests fail loudly if the
// source drifts away from what is covered here.
//
// Run with: npm test

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const dbSource = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

const norm = (s) => s.replace(/\s+/g, " ").trim();

const SQL = {
  claimVerification: `UPDATE users
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
       RETURNING referred_by`,
  revokeVerification: `UPDATE users
       SET verified = 0, verified_at = NULL
       WHERE telegram_user_id = ?
         AND verified = 1
         AND EXISTS (
               SELECT 1 FROM required_chats rc
               WHERE rc.active = 1
                 AND NOT EXISTS (
                       SELECT 1 FROM join_requests jr
                       WHERE jr.telegram_user_id = ? AND jr.chat_id = rc.chat_id AND jr.status IN ('pending', 'member')
                     )
             )
       RETURNING referred_by`,
  requiredChatsWithStatus: `SELECT rc.*,
              EXISTS (
                SELECT 1 FROM join_requests jr
                WHERE jr.telegram_user_id = ? AND jr.chat_id = rc.chat_id AND jr.status IN ('pending', 'member')
              ) AS satisfied
       FROM required_chats rc
       WHERE rc.active = 1
       ORDER BY rc.added_at ASC`,
  missingChats: `SELECT rc.* FROM required_chats rc
       WHERE rc.active = 1
         AND NOT EXISTS (
               SELECT 1 FROM join_requests jr
               WHERE jr.telegram_user_id = ? AND jr.chat_id = rc.chat_id AND jr.status IN ('pending', 'member')
             )
       ORDER BY rc.added_at ASC`,
  recordJoinRequest: `INSERT INTO join_requests (telegram_user_id, chat_id, status, event_at, active)
       VALUES (?, ?, 'pending', ?, 1)
       ON CONFLICT(telegram_user_id, chat_id) DO UPDATE
         SET status = 'pending', event_at = excluded.event_at, active = 1
         WHERE excluded.event_at > join_requests.event_at`,
  markJoinMember: `INSERT INTO join_requests (telegram_user_id, chat_id, status, event_at, active)
       VALUES (?, ?, 'member', ?, 1)
       ON CONFLICT(telegram_user_id, chat_id) DO UPDATE
         SET status = 'member', event_at = excluded.event_at, active = 1
         WHERE excluded.event_at >= join_requests.event_at AND join_requests.status <> 'member'`,
  markJoinEnded: `UPDATE join_requests SET status = 'ended', event_at = ?, active = 0
       WHERE telegram_user_id = ? AND chat_id = ? AND status <> 'ended' AND ? >= event_at`,
  decrement: `UPDATE users SET verified_referral_count = MAX(0, verified_referral_count - 1)
       WHERE telegram_user_id = ?`,
  claimQualification: `UPDATE users SET qualified = 1, qualified_at = datetime('now'),
              reward_settled_inr = MIN(verified_referral_count, ?) * ?,
              reward_settled_at = datetime('now')
       WHERE telegram_user_id = ? AND qualified = 0 AND verified_referral_count >= ?`,
  setContactShared: `UPDATE users SET contact_shared = 1, phone_number = ?, phone_normalized = ?, phone_tail = ?
       WHERE telegram_user_id = ?
         AND NOT EXISTS (
               SELECT 1 FROM users other
               WHERE other.phone_normalized = ? AND other.telegram_user_id <> ?
             )`,
  markPremiumPaid: `UPDATE users SET premium_paid = 1, premium_paid_at = datetime('now'), premium_charge_id = ?
       WHERE telegram_user_id = ? AND premium_paid = 0`,
};

let pass = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

console.log("\nSQL drift check");
for (const [name, sql] of Object.entries(SQL)) {
  test(`${name} still matches src/db.ts`, () =>
    assert.ok(norm(dbSource).includes(norm(sql)), "statement not found in src/db.ts"));
}

function freshDb({ chats = [-101, -102, -103] } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  for (const id of chats) {
    db.prepare("INSERT INTO required_chats (chat_id, title, kind) VALUES (?, ?, 'group')").run(id, `chat${id}`);
  }
  return db;
}

let codeSeq = 0;
const digits = (p) => (p === null ? null : String(p).replace(/\D/g, ""));
const tailOf = (p) => (p === null ? null : digits(p).slice(-10));
function addUser(db, id, { referredBy = null, contact = false, phone = null } = {}) {
  db.prepare(
    `INSERT INTO users (telegram_user_id, referral_code, referred_by, contact_shared,
                        phone_number, phone_normalized, phone_tail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, `code${codeSeq++}`, referredBy, contact ? 1 : 0, phone, digits(phone), tailOf(phone));
}
function join(db, userId, chatId) {
  db.prepare("INSERT OR IGNORE INTO join_requests (telegram_user_id, chat_id) VALUES (?, ?)").run(userId, chatId);
}
// RETURNING yields a row only when the UPDATE matched, so presence of a row is
// the same signal .changes > 0 used to give -- and it carries the referrer too.
const claimRow = (db, id) => db.prepare(SQL.claimVerification).get(id, id);
const claim = (db, id) => claimRow(db, id) !== undefined;
const isVerified = (db, id) =>
  db.prepare("SELECT verified FROM users WHERE telegram_user_id = ?").get(id).verified === 1;

console.log("\nVerification against a dynamic required-chat set");

test("verifies once every active chat has a join request", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  for (const c of [-101, -102, -103]) join(db, 2, c);
  assert.equal(claim(db, 2), true);
  assert.equal(isVerified(db, 2), true);
});

test("does not verify while any active chat is missing", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  join(db, 2, -101);
  join(db, 2, -102);
  assert.equal(claim(db, 2), false);
  assert.equal(isVerified(db, 2), false);
});

test("does not verify without a shared contact", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: false });
  for (const c of [-101, -102, -103]) join(db, 2, c);
  assert.equal(claim(db, 2), false);
});

test("the claim returns the referrer to credit, in the same statement", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  for (const c of [-101, -102, -103]) join(db, 2, c);
  const row = claimRow(db, 2);
  assert.ok(row, "a successful claim must return a row");
  assert.equal(row.referred_by, 1, "the referrer to credit comes back with the flip, not from a second read");
});

test("a failed claim returns no row at all", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: false });
  assert.equal(claimRow(db, 2), undefined, "nothing changed, so nothing is returned");
});

test("verifies WITHOUT a referrer (referral is optional)", () => {
  const db = freshDb();
  addUser(db, 2, { referredBy: null, contact: true });
  for (const c of [-101, -102, -103]) join(db, 2, c);
  assert.equal(claim(db, 2), true, "an organic user must be able to verify on their own");
  assert.equal(isVerified(db, 2), true);
});

test("a newly added chat blocks users who have not joined it", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  for (const c of [-101, -102, -103]) join(db, 2, c);
  db.prepare("INSERT INTO required_chats (chat_id, kind) VALUES (-104, 'channel')").run();
  assert.equal(claim(db, 2), false, "should now be blocked by the 4th chat");
  join(db, 2, -104);
  assert.equal(claim(db, 2), true, "verifies after joining the 4th");
});

test("already-verified users keep verification when a chat is added (grandfathering)", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  for (const c of [-101, -102, -103]) join(db, 2, c);
  claim(db, 2);
  db.prepare("INSERT INTO required_chats (chat_id, kind) VALUES (-104, 'group')").run();
  assert.equal(isVerified(db, 2), true, "verification must be sticky across a rotation");
});

test("removing a chat unblocks users who only lacked that one", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  join(db, 2, -101);
  join(db, 2, -102);
  assert.equal(claim(db, 2), false);
  db.prepare("UPDATE required_chats SET active = 0 WHERE chat_id = -103").run();
  assert.equal(claim(db, 2), true);
});

test("re-adding a removed chat restores prior join-request progress", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  for (const c of [-101, -102, -103]) join(db, 2, c);
  db.prepare("UPDATE required_chats SET active = 0 WHERE chat_id = -103").run();
  db.prepare("UPDATE required_chats SET active = 1 WHERE chat_id = -103").run();
  assert.equal(claim(db, 2), true, "the old join_requests row still counts");
});

test("an empty required set never auto-verifies anyone", () => {
  const db = freshDb({ chats: [] });
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  assert.equal(claim(db, 2), false, "EXISTS guard must block the vacuous-truth case");
});

test("a set with every chat deactivated never auto-verifies anyone", () => {
  const db = freshDb();
  db.prepare("UPDATE required_chats SET active = 0").run();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  assert.equal(claim(db, 2), false);
});

test("claiming twice only succeeds once (webhook-retry safety)", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  for (const c of [-101, -102, -103]) join(db, 2, c);
  assert.equal(claim(db, 2), true);
  assert.equal(claim(db, 2), false, "second claim must not re-credit the referrer");
  assert.equal(claim(db, 2), false);
});

test("duplicate join requests are idempotent", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  for (const c of [-101, -102, -103]) {
    join(db, 2, c);
    join(db, 2, c);
  }
  const n = db.prepare("SELECT COUNT(*) c FROM join_requests WHERE telegram_user_id = 2").get().c;
  assert.equal(n, 3);
  assert.equal(claim(db, 2), true);
});

console.log("\nLeaving a chat stops the referral counting");

// Departure and rejoin go through the same statements the application runs.
// `at` is the Telegram event time; tests advance it so each event is "newer".
let clock = 1_000;
const tick = () => ++clock;
const leave = (db, userId, chatId, at = tick()) =>
  db.prepare(SQL.markJoinEnded).run(at, userId, chatId, at).changes > 0;
const rejoin = (db, userId, chatId, at = tick()) =>
  db.prepare(SQL.recordJoinRequest).run(userId, chatId, at).changes > 0;
const revokeRow = (db, id) => db.prepare(SQL.revokeVerification).get(id, id);
const revoke = (db, id) => revokeRow(db, id) !== undefined;
const decrement = (db, id) => db.prepare(SQL.decrement).run(id);
const countOf = (db, id) =>
  db.prepare("SELECT verified_referral_count c FROM users WHERE telegram_user_id = ?").get(id).c;

function verifiedPair(db) {
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  for (const c of [-101, -102, -103]) join(db, 2, c);
  assert.equal(claim(db, 2), true);
  db.prepare("UPDATE users SET verified_referral_count = 1 WHERE telegram_user_id = 1").run();
  return db;
}

test("the revoke returns the referrer to debit, in the same statement", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  for (const c of [-101, -102, -103]) join(db, 2, c);
  claim(db, 2);
  leave(db, 2, -102);
  const row = revokeRow(db, 2);
  assert.ok(row, "a successful revoke must return a row");
  assert.equal(row.referred_by, 1);
});

test("leaving one required chat revokes verification", () => {
  const db = verifiedPair(freshDb());
  leave(db, 2, -102);
  assert.equal(revoke(db, 2), true);
  assert.equal(isVerified(db, 2), false);
});

test("staying in every chat keeps verification", () => {
  const db = verifiedPair(freshDb());
  assert.equal(revoke(db, 2), false, "nothing is missing, so nothing to revoke");
  assert.equal(isVerified(db, 2), true);
});

test("revocation happens exactly once, so credit is taken back once", () => {
  const db = verifiedPair(freshDb());
  leave(db, 2, -102);
  assert.equal(revoke(db, 2), true);
  decrement(db, 1);
  assert.equal(revoke(db, 2), false, "a second revoke would double-decrement the referrer");
  assert.equal(countOf(db, 1), 0);
});

test("rejoining restores verification and the credit", () => {
  const db = verifiedPair(freshDb());
  leave(db, 2, -102);
  revoke(db, 2);
  decrement(db, 1);
  assert.equal(countOf(db, 1), 0);

  rejoin(db, 2, -102);
  assert.equal(claim(db, 2), true, "all memberships live again");
  assert.equal(isVerified(db, 2), true);
});

test("a departure before verifying never counted in the first place", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  join(db, 2, -101);
  join(db, 2, -102);
  join(db, 2, -103);
  leave(db, 2, -103);
  assert.equal(claim(db, 2), false, "an inactive membership must not satisfy the requirement");
});

test("the count can never go negative", () => {
  const db = freshDb();
  addUser(db, 1);
  assert.equal(countOf(db, 1), 0);
  decrement(db, 1);
  decrement(db, 1);
  assert.equal(countOf(db, 1), 0, "MAX(0, ...) must floor it");
});

console.log("\nPending request vs actual membership");

const setState = (db, u, c, state, at = tick()) => {
  if (state === "pending") return rejoin(db, u, c, at);
  if (state === "member") return db.prepare(SQL.markJoinMember).run(u, c, at).changes > 0;
  if (state === "ended") return leave(db, u, c, at);
  throw new Error(state);
};
const statusOf = (db, u, c) =>
  db.prepare("SELECT status, active, event_at FROM join_requests WHERE telegram_user_id = ? AND chat_id = ?").get(u, c);
const satisfiedOf = (db, u) =>
  Object.fromEntries(db.prepare(SQL.requiredChatsWithStatus).all(u).map((r) => [r.chat_id, r.satisfied]));
const missingOf = (db, u) => db.prepare(SQL.missingChats).all(u).map((r) => r.chat_id);

/** A referred user with contact shared and a state for each of -101..-103. */
function withStates(states) {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2, { referredBy: 1, contact: true });
  [-101, -102, -103].forEach((c, i) => states[i] && setState(db, 2, c, states[i]));
  return db;
}

test("a PENDING request satisfies the requirement", () => {
  const db = withStates(["pending", "pending", "pending"]);
  assert.equal(claim(db, 2), true, "verification must not wait for an admin");
  assert.deepEqual(satisfiedOf(db, 2), { [-101]: 1, [-102]: 1, [-103]: 1 });
  assert.deepEqual(missingOf(db, 2), []);
});

test("actual MEMBERSHIP satisfies the requirement", () => {
  const db = withStates(["member", "member", "member"]);
  assert.equal(claim(db, 2), true);
  assert.deepEqual(missingOf(db, 2), []);
});

test("pending and member can be mixed across chats", () => {
  const db = withStates(["pending", "member", "pending"]);
  assert.equal(claim(db, 2), true);
});

test("an ENDED request does not satisfy the requirement", () => {
  const db = withStates(["pending", "pending", "ended"]);
  assert.equal(claim(db, 2), false);
  assert.deepEqual(satisfiedOf(db, 2), { [-101]: 1, [-102]: 1, [-103]: 0 });
  assert.deepEqual(missingOf(db, 2), [-103]);
});

test("NO row at all does not satisfy the requirement", () => {
  const db = withStates(["pending", "pending", null]);
  assert.equal(claim(db, 2), false);
  assert.deepEqual(missingOf(db, 2), [-103]);
});

test("the three queries that ask 'is this satisfied' can never disagree", () => {
  // The user's instruction: one coherent definition, not one fixed query and
  // one left on the old meaning. Check every state against all three.
  for (const state of ["pending", "member", "ended", null]) {
    const db = withStates([state, "pending", "pending"]);
    const satisfied = satisfiedOf(db, 2)[-101] === 1;
    const missing = missingOf(db, 2).includes(-101);
    assert.equal(satisfied, !missing, `status=${state}: satisfied vs missing disagree`);
    assert.equal(claim(db, 2), satisfied, `status=${state}: claim disagrees with the status query`);
  }
});

test("the admin approving a pending request changes nothing for the referrer", () => {
  const db = withStates(["pending", "pending", "pending"]);
  assert.equal(claim(db, 2), true);
  // chat_member arrives: pending -> member. Both satisfy, so nothing to revoke.
  assert.equal(setState(db, 2, -102, "member"), true);
  assert.equal(revoke(db, 2), false, "approval must not un-verify or re-credit anyone");
  assert.equal(claim(db, 2), false, "already verified: no second credit");
  assert.equal(isVerified(db, 2), true);
});

test("a request that is later removed stops satisfying, and revokes once", () => {
  const db = withStates(["pending", "pending", "pending"]);
  claim(db, 2);
  assert.equal(setState(db, 2, -101, "ended"), true, "kicked/left while still requested");
  assert.equal(revoke(db, 2), true);
  assert.equal(revoke(db, 2), false);
});

test("re-requesting after an ended request satisfies again", () => {
  const db = withStates(["pending", "pending", "ended"]);
  assert.equal(claim(db, 2), false);
  assert.equal(setState(db, 2, -103, "pending"), true);
  assert.equal(claim(db, 2), true);
});

console.log("\nDuplicate and out-of-order webhook deliveries");

test("a duplicate join request changes nothing", () => {
  const db = freshDb();
  assert.equal(db.prepare(SQL.recordJoinRequest).run(2, -101, 500).changes, 1);
  assert.equal(db.prepare(SQL.recordJoinRequest).run(2, -101, 500).changes, 0, "same event again is a no-op");
  assert.equal(statusOf(db, 2, -101).status, "pending");
});

test("a stale duplicate request cannot demote an approved member", () => {
  const db = freshDb();
  db.prepare(SQL.recordJoinRequest).run(2, -101, 500);
  db.prepare(SQL.markJoinMember).run(2, -101, 600);
  assert.equal(db.prepare(SQL.recordJoinRequest).run(2, -101, 500).changes, 0);
  assert.equal(statusOf(db, 2, -101).status, "member");
});

test("a stale duplicate request cannot resurrect a departure", () => {
  const db = freshDb();
  db.prepare(SQL.recordJoinRequest).run(2, -101, 500);
  db.prepare(SQL.markJoinMember).run(2, -101, 600);
  db.prepare(SQL.markJoinEnded).run(700, 2, -101, 700);
  assert.equal(db.prepare(SQL.recordJoinRequest).run(2, -101, 500).changes, 0, "old request replayed");
  assert.equal(db.prepare(SQL.markJoinMember).run(2, -101, 600).changes, 0, "old approval replayed");
  assert.equal(statusOf(db, 2, -101).status, "ended");
});

test("a stale departure cannot end a request the user has since re-sent", () => {
  const db = freshDb();
  db.prepare(SQL.recordJoinRequest).run(2, -101, 500);
  db.prepare(SQL.markJoinEnded).run(600, 2, -101, 600);
  db.prepare(SQL.recordJoinRequest).run(2, -101, 700); // re-requests
  assert.equal(db.prepare(SQL.markJoinEnded).run(600, 2, -101, 600).changes, 0, "old 'left' replayed");
  assert.equal(statusOf(db, 2, -101).status, "pending");
});

test("a genuinely newer request after leaving is honoured", () => {
  const db = freshDb();
  db.prepare(SQL.recordJoinRequest).run(2, -101, 500);
  db.prepare(SQL.markJoinEnded).run(600, 2, -101, 600);
  assert.equal(db.prepare(SQL.recordJoinRequest).run(2, -101, 700).changes, 1);
  assert.equal(statusOf(db, 2, -101).status, "pending");
});

test("a duplicate membership event changes nothing", () => {
  const db = freshDb();
  assert.equal(db.prepare(SQL.markJoinMember).run(2, -101, 500).changes, 1);
  assert.equal(db.prepare(SQL.markJoinMember).run(2, -101, 500).changes, 0);
});

test("approval in the same second as the request still promotes it", () => {
  const db = freshDb();
  db.prepare(SQL.recordJoinRequest).run(2, -101, 500);
  assert.equal(db.prepare(SQL.markJoinMember).run(2, -101, 500).changes, 1);
  assert.equal(statusOf(db, 2, -101).status, "member");
});

test("a departure from a chat the user never touched records nothing", () => {
  const db = freshDb();
  assert.equal(db.prepare(SQL.markJoinEnded).run(500, 2, -101, 500).changes, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM join_requests").get().c, 0, "must not create a row");
});

test("a member who never sent a request through the bot is recognised", () => {
  const db = freshDb();
  assert.equal(db.prepare(SQL.markJoinMember).run(2, -101, 500).changes, 1);
  assert.equal(statusOf(db, 2, -101).status, "member");
});

test("a legacy row (event_at = 0) yields to the first real event", () => {
  const db = freshDb();
  db.prepare("INSERT INTO join_requests (telegram_user_id, chat_id, status) VALUES (2, -101, 'member')").run();
  assert.equal(statusOf(db, 2, -101).event_at, 0);
  assert.equal(db.prepare(SQL.markJoinEnded).run(500, 2, -101, 500).changes, 1);
});

console.log("\nSchema guarantees");

test("`active` stays a faithful mirror of (status <> 'ended') through every transition", () => {
  const db = freshDb();
  const seq = ["pending", "member", "ended", "pending", "ended", "member"];
  for (const st of seq) {
    setState(db, 2, -101, st);
    const r = statusOf(db, 2, -101);
    assert.equal(r.status, st);
    assert.equal(r.active, st === "ended" ? 0 : 1, `active drifted at ${st}`);
  }
});

test("an unknown status is rejected by the CHECK constraint", () => {
  const db = freshDb();
  assert.throws(
    () => db.prepare("INSERT INTO join_requests (telegram_user_id, chat_id, status) VALUES (2, -101, 'approved')").run(),
    /CHECK/i
  );
});

test("no application code reads the ambiguous `active` column of join_requests", () => {
  // Every statement that decides 'satisfied' must use status IN ('pending','member').
  // `jr.active` (or a bare join_requests.active read) means one path kept the old meaning.
  assert.ok(!/\bjr\.active\b/.test(dbSource), "src/db.ts still reads jr.active");
  const other = ["bot.ts", "verification.ts", "payments.ts", "index.ts"].map((f) =>
    readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")
  );
  for (const src of other) assert.ok(!/join_requests[\s\S]{0,80}\bactive\b/.test(src), "raw join_requests.active read outside db.ts");
  assert.ok(!/setJoinRequestActive/.test(dbSource), "the old boolean setter still exists");
});

test("every join_requests lookup in db.ts uses the one satisfied predicate", () => {
  // A subquery over `join_requests jr` that omits the predicate (or filters on
  // some other status) would silently redefine "satisfied" for that path.
  const lookups = dbSource.match(/FROM join_requests jr/g) ?? [];
  const predicate = dbSource.match(/jr\.status IN \('pending', 'member'\)/g) ?? [];
  assert.equal(lookups.length, 4, "status query, missing query, claim, revoke -- add a test if a fifth appears");
  assert.equal(predicate.length, lookups.length, "a join_requests lookup is missing the shared predicate");
  assert.ok(!/jr\.status\s*(=|<>|!=)/.test(dbSource), "a lookup compares status directly instead of using the predicate");
});

console.log("\nPhone-number uniqueness (anti-sybil)");

const shareContact = (db, id, phone) =>
  db.prepare(SQL.setContactShared).run(phone, digits(phone), tailOf(phone), id, digits(phone), id).changes > 0;

test("first account can claim a phone number", () => {
  const db = freshDb();
  addUser(db, 1);
  assert.equal(shareContact(db, 1, "+911234567890"), true);
});

test("a second account cannot reuse the same phone number", () => {
  const db = freshDb();
  addUser(db, 1);
  addUser(db, 2);
  assert.equal(shareContact(db, 1, "+911234567890"), true);
  assert.equal(shareContact(db, 2, "+911234567890"), false);
  assert.equal(
    db.prepare("SELECT contact_shared FROM users WHERE telegram_user_id = 2").get().contact_shared,
    0
  );
});

test("re-sharing the same number from the same account stays a no-op success", () => {
  const db = freshDb();
  addUser(db, 1);
  assert.equal(shareContact(db, 1, "+911234567890"), true);
  assert.equal(shareContact(db, 1, "+911234567890"), true);
});

test("the unique index blocks a duplicate phone written directly", () => {
  const db = freshDb();
  addUser(db, 1, { phone: "+911234567890" });
  assert.throws(() => addUser(db, 2, { phone: "+911234567890" }), /UNIQUE/i);
});

test("the same number written two different ways still collides", () => {
  const db = freshDb();
  addUser(db, 1, { phone: "+91 12345 67890" });
  // Different raw spelling, same digits -- the old raw-column index missed this.
  assert.throws(() => addUser(db, 2, { phone: "911234567890" }), /UNIQUE/i);
});

console.log("\nQualification and payment");

const qualify = (db, id, threshold, rate = 10) =>
  db.prepare(SQL.claimQualification).run(threshold, rate, id, threshold).changes > 0;
const settled = (db, id) =>
  db.prepare("SELECT reward_settled_inr i, reward_settled_at a FROM users WHERE telegram_user_id = ?").get(id);

test("does not qualify below the threshold", () => {
  const db = freshDb();
  addUser(db, 1);
  db.prepare("UPDATE users SET verified_referral_count = 199 WHERE telegram_user_id = 1").run();
  assert.equal(qualify(db, 1, 200), false);
});

test("qualifies at exactly the threshold", () => {
  const db = freshDb();
  addUser(db, 1);
  db.prepare("UPDATE users SET verified_referral_count = 200 WHERE telegram_user_id = 1").run();
  assert.equal(qualify(db, 1, 200), true);
});

test("still qualifies if the count overshot the threshold (the v1 bug)", () => {
  const db = freshDb();
  addUser(db, 1);
  // v1 only fired on `count === 100`, so a count that jumped past the
  // threshold stranded the user forever.
  db.prepare("UPDATE users SET verified_referral_count = 247 WHERE telegram_user_id = 1").run();
  assert.equal(qualify(db, 1, 200), true);
});

test("qualification is claimed exactly once", () => {
  const db = freshDb();
  addUser(db, 1);
  db.prepare("UPDATE users SET verified_referral_count = 500 WHERE telegram_user_id = 1").run();
  assert.equal(qualify(db, 1, 200), true);
  assert.equal(qualify(db, 1, 200), false);
});

test("a failed payout can be retried on the next referral", () => {
  const db = freshDb();
  addUser(db, 1);
  db.prepare("UPDATE users SET verified_referral_count = 200 WHERE telegram_user_id = 1").run();
  assert.equal(qualify(db, 1, 200), true);
  // Simulate the invite-link call failing: the app resets qualified so a later
  // attempt can retry. It must then succeed rather than being stranded.
  db.prepare("UPDATE users SET qualified = 0, qualified_at = NULL WHERE telegram_user_id = 1").run();
  db.prepare("UPDATE users SET verified_referral_count = 201 WHERE telegram_user_id = 1").run();
  assert.equal(qualify(db, 1, 200), true);
});

console.log("\nThe settled figure is frozen at qualification");

test("qualifying at exactly 200 settles ₹2000", () => {
  const db = freshDb();
  addUser(db, 1);
  db.prepare("UPDATE users SET verified_referral_count = 200 WHERE telegram_user_id = 1").run();
  assert.equal(qualify(db, 1, 200, 10), true);
  const { i, a } = settled(db, 1);
  assert.equal(i, 2000);
  assert.ok(a, "a settlement timestamp must be recorded");
});

test("the settled figure is capped even when the count overshot", () => {
  const db = freshDb();
  addUser(db, 1);
  db.prepare("UPDATE users SET verified_referral_count = 250 WHERE telegram_user_id = 1").run();
  qualify(db, 1, 200, 10);
  assert.equal(settled(db, 1).i, 2000, "250 referrals must still settle at the ₹2000 cap");
});

test("the settled figure does NOT erode when referrals later leave", () => {
  const db = freshDb();
  addUser(db, 1);
  db.prepare("UPDATE users SET verified_referral_count = 200 WHERE telegram_user_id = 1").run();
  qualify(db, 1, 200, 10);
  assert.equal(settled(db, 1).i, 2000);

  // Three referrals leave: the live count falls, the settlement must not.
  for (let n = 0; n < 3; n++) decrement(db, 1);
  assert.equal(countOf(db, 1), 197, "live count follows departures down");
  assert.equal(settled(db, 1).i, 2000, "the amount owed at qualification is fixed");
});

test("the snapshot is written once and never rewritten", () => {
  const db = freshDb();
  addUser(db, 1);
  db.prepare("UPDATE users SET verified_referral_count = 200 WHERE telegram_user_id = 1").run();
  qualify(db, 1, 200, 10);
  const first = settled(db, 1);

  db.prepare("UPDATE users SET verified_referral_count = 400 WHERE telegram_user_id = 1").run();
  assert.equal(qualify(db, 1, 200, 10), false, "already qualified");
  assert.deepEqual(settled(db, 1), first, "a second attempt must not restate the settlement");
});

test("below the threshold nothing is settled", () => {
  const db = freshDb();
  addUser(db, 1);
  db.prepare("UPDATE users SET verified_referral_count = 199 WHERE telegram_user_id = 1").run();
  assert.equal(qualify(db, 1, 200, 10), false);
  assert.equal(settled(db, 1).i, null, "no qualification, no settlement record");
});

test("the settled figure follows the configured rate", () => {
  const db = freshDb();
  addUser(db, 1);
  db.prepare("UPDATE users SET verified_referral_count = 200 WHERE telegram_user_id = 1").run();
  qualify(db, 1, 200, 25);
  assert.equal(settled(db, 1).i, 5000, "200 x ₹25");
});

const payPremium = (db, id, charge) => db.prepare(SQL.markPremiumPaid).run(charge, id).changes > 0;

test("a payment is recorded exactly once per user", () => {
  const db = freshDb();
  addUser(db, 1);
  assert.equal(payPremium(db, 1, "charge_abc"), true);
  assert.equal(payPremium(db, 1, "charge_abc"), false, "redelivered update must not mint a second link");
  assert.equal(
    db.prepare("SELECT premium_charge_id FROM users WHERE telegram_user_id = 1").get().premium_charge_id,
    "charge_abc"
  );
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("Failed: " + failures.join(", "));
  process.exit(1);
}
