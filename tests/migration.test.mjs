// Applies migrations/0002 to a populated v1 database and checks nothing is lost.
// Run with: npm run test:migration

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const v1Schema = readFileSync(new URL("./fixtures/v1-schema.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/0002_dynamic_requirements.sql", import.meta.url), "utf8");

// Strip SQL comments so the commented-out DROP COLUMN block stays inert.
const runnable = migration
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");

const db = new DatabaseSync(":memory:");
db.exec(v1Schema);

// A populated v1 database: one referrer plus two referred users, one fully
// verified under the old three-chat rules and one still partway through.
db.prepare(
  `INSERT INTO users (telegram_user_id, referral_code, contact_shared, verified, verified_referral_count)
   VALUES (1, 'refcode1', 1, 1, 2)`
).run();
db.prepare(
  `INSERT INTO users (telegram_user_id, referral_code, referred_by, phone_number, contact_shared,
                      group1_request, group2_request, channel_request, verified)
   VALUES (2, 'refcode2', 1, '+911111111111', 1, 1, 1, 1, 1)`
).run();
db.prepare(
  `INSERT INTO users (telegram_user_id, referral_code, referred_by, phone_number, contact_shared,
                      group1_request, group2_request, channel_request, verified)
   VALUES (3, 'refcode3', 1, '+912222222222', 1, 1, 0, 0, 0)`
).run();
// User 2's join_requests rows exist (v1 wrote both); user 3's are missing on
// purpose, to prove the backfill covers a flag without a matching row.
for (const c of [-1004493745060, -1004365591682, -1004309711460]) {
  db.prepare("INSERT INTO join_requests (telegram_user_id, chat_id) VALUES (2, ?)").run(c);
}

db.exec(runnable);

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

console.log("\nMigration 0002 against a populated v1 database");

test("all user rows survive", () =>
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users").get().c, 3));

test("verification status is preserved", () => {
  assert.equal(db.prepare("SELECT verified FROM users WHERE telegram_user_id = 2").get().verified, 1);
  assert.equal(db.prepare("SELECT verified FROM users WHERE telegram_user_id = 3").get().verified, 0);
});

test("referral counts are preserved", () =>
  assert.equal(
    db.prepare("SELECT verified_referral_count c FROM users WHERE telegram_user_id = 1").get().c,
    2
  ));

test("the three previously hard-coded chats are seeded and active", () => {
  const rows = db.prepare("SELECT chat_id FROM required_chats WHERE active = 1 ORDER BY chat_id").all();
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.chat_id).sort((a, b) => a - b),
    [-1004493745060, -1004365591682, -1004309711460].sort((a, b) => a - b)
  );
});

test("premium payment columns exist and default to unpaid", () =>
  assert.equal(db.prepare("SELECT premium_paid FROM users WHERE telegram_user_id = 1").get().premium_paid, 0));

test("backfill creates join_requests rows from old boolean flags", () => {
  const n = db.prepare("SELECT COUNT(*) c FROM join_requests WHERE telegram_user_id = 3").get().c;
  assert.equal(n, 1, "user 3 had group1_request = 1 with no join_requests row");
});

test("backfill does not duplicate rows that already existed", () =>
  assert.equal(db.prepare("SELECT COUNT(*) c FROM join_requests WHERE telegram_user_id = 2").get().c, 3));

test("a migrated part-way user can still complete verification", () => {
  const claim = `UPDATE users SET verified = 1, verified_at = datetime('now')
     WHERE telegram_user_id = ? AND verified = 0 AND contact_shared = 1 AND referred_by IS NOT NULL
       AND EXISTS (SELECT 1 FROM required_chats WHERE active = 1)
       AND NOT EXISTS (SELECT 1 FROM required_chats rc WHERE rc.active = 1
             AND NOT EXISTS (SELECT 1 FROM join_requests jr
                   WHERE jr.telegram_user_id = ? AND jr.chat_id = rc.chat_id))`;
  assert.equal(db.prepare(claim).run(3, 3).changes, 0, "still missing two chats");
  db.prepare("INSERT INTO join_requests (telegram_user_id, chat_id) VALUES (3, -1004365591682)").run();
  db.prepare("INSERT INTO join_requests (telegram_user_id, chat_id) VALUES (3, -1004309711460)").run();
  assert.equal(db.prepare(claim).run(3, 3).changes, 1, "should verify once all three are in");
});

test("the phone uniqueness index is live after migration", () => {
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO users (telegram_user_id, referral_code, phone_number) VALUES (9, 'x', '+911111111111')")
        .run(),
    /UNIQUE/i
  );
});

test("migration is idempotent enough to detect a double-run", () => {
  // ALTER TABLE ADD COLUMN is not idempotent; re-running must fail loudly
  // rather than silently corrupt state.
  assert.throws(() => db.exec(runnable), /duplicate column/i);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
