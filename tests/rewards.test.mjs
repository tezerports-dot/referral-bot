// The rupee figure and its cap. Compiled from the real src/types.ts so the
// arithmetic under test is the arithmetic that ships.
//
// Run with: npm run test:rewards

import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), "rewards-"));
execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--noEmit", "false", "--outDir", out], {
  cwd: root,
  stdio: "pipe",
});
const { rewardInr, rewardCapInr, referralRewardInr, qualifyThreshold } = await import(join(out, "types.js"));

const ENV = { QUALIFY_THRESHOLD: "200", PREMIUM_PRICE_STARS: "1500", REFERRAL_REWARD_INR: "10" };

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

console.log("\nReferral rewards");

test("the configured rate and threshold are read", () => {
  assert.equal(referralRewardInr(ENV), 10);
  assert.equal(qualifyThreshold(ENV), 200);
});

test("₹10 per counted referral", () => {
  assert.equal(rewardInr(ENV, 0), 0);
  assert.equal(rewardInr(ENV, 1), 10);
  assert.equal(rewardInr(ENV, 37), 370);
  assert.equal(rewardInr(ENV, 199), 1990);
});

test("200 referrals is exactly ₹2000", () => assert.equal(rewardInr(ENV, 200), 2000));

test("the cap is ₹2000 and referrals past 200 add nothing", () => {
  assert.equal(rewardCapInr(ENV), 2000);
  for (const n of [201, 250, 1000, 100000]) {
    assert.equal(rewardInr(ENV, n), 2000, `${n} referrals must still cap at ₹2000`);
  }
});

test("a count that falls back reduces the figure", () => {
  // A referral that leaves decrements the count, so the rupee value follows it
  // down. This is why the figure is derived rather than stored as a balance.
  assert.equal(rewardInr(ENV, 200), 2000);
  assert.equal(rewardInr(ENV, 199), 1990);
  assert.equal(rewardInr(ENV, 0), 0);
});

test("a negative count cannot produce a negative payout", () =>
  assert.equal(rewardInr(ENV, -5), 0));

test("the cap follows the threshold rather than being a separate number", () => {
  const bigger = { ...ENV, QUALIFY_THRESHOLD: "300" };
  assert.equal(rewardCapInr(bigger), 3000, "300 x ₹10");
  assert.equal(rewardInr(bigger, 300), 3000);
  const dearer = { ...ENV, REFERRAL_REWARD_INR: "25" };
  assert.equal(rewardCapInr(dearer), 5000, "200 x ₹25");
});

test("missing or junk config falls back to the defaults", () => {
  for (const bad of [{}, { REFERRAL_REWARD_INR: "abc" }, { REFERRAL_REWARD_INR: "-5" }, { REFERRAL_REWARD_INR: "0" }]) {
    assert.equal(referralRewardInr(bad), 10, `bad config ${JSON.stringify(bad)} should fall back to 10`);
  }
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
