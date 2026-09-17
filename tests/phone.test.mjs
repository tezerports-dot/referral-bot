// Phone normalization, and the thing most likely to break silently: the SQL
// backfill in migrations/0003 must agree with normalizePhone() in src/phone.ts.
// If they diverge, existing rows become unfindable by the lookup that uses them.
//
// Run with: npm run test:phone

import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// Compile the real module rather than reimplementing it here.
const out = mkdtempSync(join(tmpdir(), "phone-"));
execFileSync("npx", ["tsc", "src/phone.ts", "--outDir", out, "--module", "es2022", "--target", "es2021"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "pipe",
});
const { normalizePhone, phoneTail } = await import(join(out, "phone.js"));

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

console.log("\nPhone normalization");

const SAMPLES = [
  ["+919876543210", "919876543210"],
  ["919876543210", "919876543210"],
  ["+91 98765 43210", "919876543210"],
  ["+91-98765-43210", "919876543210"],
  ["(91) 9876543210", "919876543210"],
  ["9876543210", "9876543210"],
];

for (const [raw, expected] of SAMPLES) {
  test(`"${raw}" normalizes to ${expected}`, () => assert.equal(normalizePhone(raw), expected));
}

test("rejects anything too short to be a number", () => {
  for (const bad of ["", "12345", "abc", null, undefined, "+1 23"]) {
    assert.equal(normalizePhone(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("rejects anything longer than E.164 allows", () =>
  assert.equal(normalizePhone("1234567890123456"), null));

test("the tail is the last 10 digits", () => {
  assert.equal(phoneTail("919876543210"), "9876543210");
  assert.equal(phoneTail("9876543210"), "9876543210");
});

test("a country-code number and a bare one share a tail", () =>
  assert.equal(phoneTail(normalizePhone("+919876543210")), phoneTail(normalizePhone("9876543210"))));

test("a short number keeps its whole value as the tail", () =>
  assert.equal(phoneTail("1234567"), "1234567"));

test("phoneTail passes null through", () => assert.equal(phoneTail(null), null));

console.log("\nSQL backfill agrees with normalizePhone()");

// Lift the backfill expression straight out of the migration so this test
// follows it if it is ever edited.
const migration = readFileSync(new URL("../migrations/0003_phone_lookup_and_referrer.sql", import.meta.url), "utf8");
const expr = migration
  .slice(migration.indexOf("SET phone_normalized ="))
  .slice("SET phone_normalized =".length);
const backfillExpr = expr.slice(0, expr.indexOf("WHERE")).trim();

const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE t (raw TEXT)");
for (const [raw] of SAMPLES) db.prepare("INSERT INTO t (raw) VALUES (?)").run(raw);

for (const [raw, expected] of SAMPLES) {
  test(`SQL backfill turns "${raw}" into ${expected}`, () => {
    const sqlResult = db
      .prepare(`SELECT ${backfillExpr.replace(/phone_number/g, "raw")} AS n FROM t WHERE raw = ?`)
      .get(raw).n;
    assert.equal(sqlResult, expected, "SQL backfill disagrees with normalizePhone()");
    assert.equal(sqlResult, normalizePhone(raw), "the two normalizers must stay in lockstep");
  });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
