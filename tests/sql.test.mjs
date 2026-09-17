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
         AND referred_by IS NOT NULL
         AND EXISTS (SELECT 1 FROM required_chats WHERE active = 1)
         AND NOT EXISTS (
               SELECT 1 FROM required_chats rc
               WHERE rc.active = 1
                 AND NOT EXISTS (
                       SELECT 1 FROM join_requests jr
                       WHERE jr.telegram_user_id = ? AND jr.chat_id = rc.chat_id
                     )
             )`,
  claimQualification: `UPDATE users SET qualified = 1, qualified_at = datetime('now')
       WHERE telegram_user_id = ? AND qualified = 0 AND verified_referral_count >= ?`,
  setContactShared: `UPDATE users SET contact_shared = 1, phone_number = ?
       WHERE telegram_user_id = ?
         AND NOT EXISTS (
               SELECT 1 FROM users other
               WHERE other.phone_number = ? AND other.telegram_user_id <> ?
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
function addUser(db, id, { referredBy = null, contact = false, phone = null } = {}) {
  db.prepare(
    "INSERT INTO users (telegram_user_id, referral_code, referred_by, contact_shared, phone_number) VALUES (?, ?, ?, ?, ?)"
  ).run(id, `code${codeSeq++}`, referredBy, contact ? 1 : 0, phone);
}
function join(db, userId, chatId) {
  db.prepare("INSERT OR IGNORE INTO join_requests (telegram_user_id, chat_id) VALUES (?, ?)").run(userId, chatId);
}
const claim = (db, id) => db.prepare(SQL.claimVerification).run(id, id).changes > 0;
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

test("does not verify without a referrer", () => {
  const db = freshDb();
  addUser(db, 2, { referredBy: null, contact: true });
  for (const c of [-101, -102, -103]) join(db, 2, c);
  assert.equal(claim(db, 2), false);
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

console.log("\nPhone-number uniqueness (anti-sybil)");

const shareContact = (db, id, phone) =>
  db.prepare(SQL.setContactShared).run(phone, id, phone, id).changes > 0;

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

console.log("\nQualification and payment");

const qualify = (db, id, threshold) => db.prepare(SQL.claimQualification).run(id, threshold).changes > 0;

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
