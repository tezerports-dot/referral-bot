// The referral requirement: a plain count of verified referrals, no money.
//
// Compiled from the real src/types.ts so the value under test is the value that
// ships. Also guards against a rupee figure creeping back in anywhere users or
// admins can see it.
//
// Run with: npm run test:requirement

import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), "requirement-"));
execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--noEmit", "false", "--outDir", out], {
  cwd: root,
  stdio: "pipe",
});
const types = await import(join(out, "types.js"));
const { qualifyThreshold, premiumPriceStars, DEFAULT_QUALIFY_THRESHOLD } = types;

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

console.log("\nThe requirement is 100 verified referrals");

test("the default requirement is 100", () => {
  assert.equal(DEFAULT_QUALIFY_THRESHOLD, 100);
  assert.equal(qualifyThreshold({}), 100);
});

test("QUALIFY_THRESHOLD in the environment is honoured", () => {
  assert.equal(qualifyThreshold({ QUALIFY_THRESHOLD: "100" }), 100);
  assert.equal(qualifyThreshold({ QUALIFY_THRESHOLD: "250" }), 250);
});

test("missing or junk config falls back to 100, never to 0", () => {
  for (const bad of ["abc", "-5", "0", "", "1.5", " "]) {
    assert.equal(qualifyThreshold({ QUALIFY_THRESHOLD: bad }), 100, `${JSON.stringify(bad)} must fall back to 100`);
  }
});

test("the shipped wrangler.toml sets the requirement to 100", () => {
  const toml = readFileSync(join(root, "wrangler.toml"), "utf8");
  const m = toml.match(/^QUALIFY_THRESHOLD\s*=\s*"(\d+)"/m);
  assert.ok(m, "QUALIFY_THRESHOLD is not set in wrangler.toml");
  assert.equal(Number(m[1]), 100);
});

test("the premium price is unchanged", () => {
  assert.equal(premiumPriceStars({}), 1500);
});

console.log("\nNo income figure anywhere");

test("wrangler.toml carries no per-referral rupee rate", () => {
  assert.doesNotMatch(readFileSync(join(root, "wrangler.toml"), "utf8"), /REFERRAL_REWARD_INR/);
});

test("src/types.ts exports no reward helpers", () => {
  for (const name of ["rewardInr", "rewardCapInr", "referralRewardInr", "DEFAULT_REFERRAL_REWARD_INR"]) {
    assert.equal(types[name], undefined, `${name} should not exist`);
  }
});

test("no rupee amount, reward variable or earnings helper remains in src/", () => {
  const hits = [];
  for (const f of readdirSync(join(root, "src")).filter((n) => n.endsWith(".ts"))) {
    const text = readFileSync(join(root, "src", f), "utf8");
    for (const pattern of [/₹/, /REFERRAL_REWARD_INR/, /rewardInr|rewardCapInr|referralRewardInr|earningsLine/, /reward_settled/]) {
      if (pattern.test(text)) hits.push(`${f}: ${pattern}`);
    }
  }
  assert.deepEqual(hits, []);
});

test("the README promises no rupee amount", () => {
  assert.doesNotMatch(readFileSync(join(root, "README.md"), "utf8"), /₹/);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("Failed: " + failures.join("; "));
  process.exit(1);
}
