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

console.log("\nFull migration chain (v1 -> 0002 -> 0003 -> 0004 -> 0005)");

const strip = (sql) =>
  sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const chainDb = new DatabaseSync(":memory:");
chainDb.exec(v1Schema);
chainDb.prepare(
  `INSERT INTO users (telegram_user_id, referral_code, contact_shared, verified, verified_referral_count)
   VALUES (1, 'chain1', 1, 1, 200)`
).run();

let chainOk = true;
for (const f of [
  "0002_dynamic_requirements.sql",
  "0003_phone_lookup_and_referrer.sql",
  "0004_membership_and_rewards.sql",
  "0005_reward_snapshot.sql",
]) {
  test(`${f} applies cleanly on top of the previous ones`, () => {
    try {
      chainDb.exec(strip(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8")));
    } catch (err) {
      chainOk = false;
      throw err;
    }
  });
}

test("the fully migrated schema has every column the code reads", () => {
  if (!chainOk) throw new Error("chain did not apply; earlier failure is the cause");
  const cols = chainDb.prepare("SELECT name FROM pragma_table_info('users')").all().map((r) => r.name);
  for (const c of [
    "phone_normalized",
    "phone_tail",
    "premium_paid",
    "premium_charge_id",
    "reward_settled_inr",
    "reward_settled_at",
  ]) {
    assert.ok(cols.includes(c), `users.${c} missing after the full chain`);
  }
  const jr = chainDb.prepare("SELECT name FROM pragma_table_info('join_requests')").all().map((r) => r.name);
  assert.ok(jr.includes("active"), "join_requests.active missing after the full chain");
});

test("a user who qualified BEFORE 0005 gets a backfilled settlement", () => {
  // The real upgrade scenario: they were already qualified when the migration
  // ran, so there is no snapshot to take -- only a backfill can give them one.
  const db2 = new DatabaseSync(":memory:");
  db2.exec(v1Schema);
  db2.prepare(
    `INSERT INTO users (telegram_user_id, referral_code, contact_shared, verified,
                        verified_referral_count, qualified, qualified_at)
     VALUES (7, 'early7', 1, 1, 240, 1, '2026-01-01 00:00:00')`
  ).run();
  for (const f of [
    "0002_dynamic_requirements.sql",
    "0003_phone_lookup_and_referrer.sql",
    "0004_membership_and_rewards.sql",
    "0005_reward_snapshot.sql",
  ]) {
    db2.exec(strip(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8")));
  }

  const r = db2.prepare("SELECT reward_settled_inr i, reward_settled_at a FROM users WHERE telegram_user_id = 7").get();
  assert.equal(r.i, 2000, "a pre-existing qualified user must not be left with a blank record");
  assert.equal(r.a, "2026-01-01 00:00:00", "stamped with their original qualification time, not now");
});

test("an unqualified user is left alone by the backfill", () => {
  const db3 = new DatabaseSync(":memory:");
  db3.exec(v1Schema);
  db3.prepare(
    "INSERT INTO users (telegram_user_id, referral_code, verified_referral_count) VALUES (8, 'early8', 50)"
  ).run();
  for (const f of [
    "0002_dynamic_requirements.sql",
    "0003_phone_lookup_and_referrer.sql",
    "0004_membership_and_rewards.sql",
    "0005_reward_snapshot.sql",
  ]) {
    db3.exec(strip(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8")));
  }
  const r = db3.prepare("SELECT reward_settled_inr i FROM users WHERE telegram_user_id = 8").get();
  assert.equal(r.i, null, "never qualified, so nothing is owed and nothing is recorded");
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
