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

console.log("\nFull migration chain (v1 -> 0002 -> 0003 -> 0004 -> 0005 -> 0006)");

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
  "0006_join_request_status.sql",
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
  assert.ok(jr.includes("status"), "join_requests.status missing after the full chain");
  assert.ok(jr.includes("event_at"), "join_requests.event_at missing after the full chain");
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


console.log("\nMigration 0006: join-request status (pending / member / ended)");

const upTo0005 = [
  "0002_dynamic_requirements.sql",
  "0003_phone_lookup_and_referrer.sql",
  "0004_membership_and_rewards.sql",
  "0005_reward_snapshot.sql",
];
const m0006 = strip(readFileSync(new URL("../migrations/0006_join_request_status.sql", import.meta.url), "utf8"));

/** A database as it stands in production today: through 0005, populated. */
function productionDb() {
  const d = new DatabaseSync(":memory:");
  d.exec(v1Schema);
  // 1 = referrer, 2 = verified referral, 3 = mid-flow, 4 = verified then left one chat.
  d.prepare("INSERT INTO users (telegram_user_id, referral_code, contact_shared, verified, verified_referral_count, qualified, qualified_at) VALUES (1, 'r1', 1, 1, 2, 0, NULL)").run();
  d.prepare("INSERT INTO users (telegram_user_id, referral_code, referred_by, phone_number, contact_shared, verified) VALUES (2, 'r2', 1, '+911111111111', 1, 1)").run();
  d.prepare("INSERT INTO users (telegram_user_id, referral_code, referred_by, phone_number, contact_shared, verified) VALUES (3, 'r3', 1, '+912222222222', 1, 0)").run();
  d.prepare("INSERT INTO users (telegram_user_id, referral_code, referred_by, phone_number, contact_shared, verified) VALUES (4, 'r4', 1, '+913333333333', 1, 1)").run();
  for (const f of upTo0005) d.exec(strip(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8")));
  const ins = d.prepare("INSERT OR REPLACE INTO join_requests (telegram_user_id, chat_id, active, requested_at) VALUES (?, ?, ?, ?)");
  for (const c of [-1004493745060, -1004365591682, -1004309711460]) ins.run(2, c, 1, "2026-01-05 10:00:00");
  ins.run(3, -1004493745060, 1, "2026-02-01 09:00:00");
  ins.run(4, -1004493745060, 1, "2026-01-07 10:00:00");
  ins.run(4, -1004365591682, 0, "2026-01-07 10:01:00"); // left, recorded by the old chat_member handler
  ins.run(4, -1004309711460, 1, "2026-01-07 10:02:00");
  return d;
}

const snapshot = (d) => ({
  users: d.prepare("SELECT * FROM users ORDER BY telegram_user_id").all(),
  required: d.prepare("SELECT * FROM required_chats ORDER BY chat_id").all(),
  jr: d
    .prepare("SELECT telegram_user_id u, chat_id c, requested_at r, active a FROM join_requests ORDER BY 1, 2")
    .all(),
});

const before = (() => { const d = productionDb(); return { d, snap: snapshot(d) }; })();
before.d.exec(m0006);
const after = snapshot(before.d);

test("no user, referral count, verification state or chat row changes", () => {
  assert.deepEqual(after.users, before.snap.users, "users table must be byte-for-byte unchanged");
  assert.deepEqual(after.required, before.snap.required);
});

test("no join_requests row is lost, and the original columns are untouched", () => {
  assert.deepEqual(after.jr, before.snap.jr);
});

test("a row that was active (live, auto-approved) becomes 'member'", () => {
  const r = before.d.prepare("SELECT status FROM join_requests WHERE telegram_user_id = 2").all();
  assert.equal(r.length, 3);
  assert.ok(r.every((x) => x.status === "member"));
});

test("a row that was inactive (left) becomes 'ended'", () => {
  const r = before.d.prepare("SELECT status FROM join_requests WHERE telegram_user_id = 4 AND chat_id = -1004365591682").get();
  assert.equal(r.status, "ended");
});

test("existing rows carry event_at = 0 so the first live event wins", () => {
  const n = before.d.prepare("SELECT COUNT(*) c FROM join_requests WHERE event_at <> 0").get().c;
  assert.equal(n, 0);
});

test("users who were verified before the migration are still verified afterwards", () => {
  const v = before.d.prepare("SELECT telegram_user_id id, verified FROM users ORDER BY 1").all();
  assert.deepEqual(v.map((x) => x.verified), [1, 1, 0, 1]);
  assert.equal(before.d.prepare("SELECT verified_referral_count c FROM users WHERE telegram_user_id = 1").get().c, 2);
});

test("`active` still mirrors the new status for every migrated row", () => {
  const bad = before.d.prepare("SELECT COUNT(*) c FROM join_requests WHERE active <> (status <> 'ended')").get().c;
  assert.equal(bad, 0);
});

test("the status index exists and the old one is kept for rollback", () => {
  const idx = before.d.prepare("SELECT name FROM pragma_index_list('join_requests')").all().map((r) => r.name);
  assert.ok(idx.includes("idx_join_requests_status"));
  assert.ok(idx.includes("idx_join_requests_active"));
});

test("the CHECK constraint is enforced on a migrated database too", () => {
  assert.throws(
    () => before.d.prepare("INSERT INTO join_requests (telegram_user_id, chat_id, status) VALUES (9, -1, 'nope')").run(),
    /CHECK/i
  );
});

test("a migrated database has the same join_requests shape as a fresh install", () => {
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const shape = (d) =>
    d.prepare("SELECT name, type, \"notnull\" nn, dflt_value d, pk FROM pragma_table_info('join_requests') ORDER BY name").all();
  assert.deepEqual(shape(before.d), shape(fresh), "schema.sql and the migration chain have drifted apart");
});

test("running 0006 twice fails loudly instead of corrupting state", () => {
  assert.throws(() => before.d.exec(m0006), /duplicate column/i);
});

test("a legacy 'member' row still satisfies the requirement (nobody is un-verified)", () => {
  // The verification statement as shipped in src/db.ts, against migrated data.
  const src = readFileSync(new URL("../src/db.ts", import.meta.url), "utf8");
  const m = src.match(/`UPDATE users\s+SET verified = 1[\s\S]*?RETURNING referred_by`/);
  assert.ok(m, "could not find tryClaimVerification in src/db.ts");
  const claimSql = m[0].slice(1, -1);
  // User 3 is mid-flow: one chat done. Finish the other two as pending requests.
  before.d.prepare("INSERT INTO join_requests (telegram_user_id, chat_id, status, event_at) VALUES (3, -1004365591682, 'pending', 1)").run();
  assert.equal(before.d.prepare(claimSql).get(3, 3), undefined, "one chat still missing");
  before.d.prepare("INSERT INTO join_requests (telegram_user_id, chat_id, status, event_at) VALUES (3, -1004309711460, 'pending', 1)").run();
  const row = before.d.prepare(claimSql).get(3, 3);
  assert.ok(row, "legacy 'member' + new 'pending' rows together must verify");
  assert.equal(row.referred_by, 1);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
