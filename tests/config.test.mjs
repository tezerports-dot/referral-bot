// Guards against committing credentials into wrangler.toml.
//
// Cloudflare's dashboard offers a "Update your Wrangler config with this
// configuration to keep deployments in sync" snippet that includes EVERY var,
// credentials included. Pasting that into wrangler.toml puts secrets in git
// permanently. This test fails before that can be committed.
//
// It also catches the inverse trap: a credential stored as a dashboard var
// rather than a secret is silently deleted by the next deploy, because the
// [vars] block in wrangler.toml replaces the whole dashboard var set.
//
// Run with: npm run test:config

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

/** Names that must only ever exist as `wrangler secret put` secrets. */
const SECRET_ONLY = ["BOT_TOKEN", "WEBHOOK_SECRET", "ADMIN_EXPORT_TOKEN"];

/** Value shapes that are credentials regardless of the key they sit under. */
const VALUE_PATTERNS = [
  [/\b\d{8,12}:AA[\w-]{30,}\b/, "a Telegram bot token"],
  [/=\s*"[0-9a-f]{32,}"/i, "a long hex string (generated secret?)"],
];

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

// Collect the [vars] block only. Walked line by line rather than matched with
// a regex: JavaScript has no \Z anchor, and a [vars] block that ends at EOF
// (the common case) silently captures nothing if you reach for one.
const varNames = (() => {
  const names = [];
  let inVars = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inVars = line === "[vars]";
      continue;
    }
    if (!inVars || line === "" || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) names.push(m[1]);
  }
  return names;
})();

// Fail loudly rather than silently pass if parsing found nothing at all.
if (varNames.length === 0) {
  console.error("  ✗ could not parse any keys from [vars] — the guard would pass vacuously");
  process.exit(1);
}

console.log("\nwrangler.toml credential guard");

for (const name of SECRET_ONLY) {
  test(`${name} is not in [vars]`, () =>
    assert.ok(
      !varNames.includes(name),
      `${name} must be set with \`wrangler secret put ${name}\`, never in wrangler.toml.\n` +
        `      Committing it leaks the credential into git history, and storing it as a\n` +
        `      dashboard var instead of a secret means the next deploy silently deletes it.`
    ));
}

for (const [re, what] of VALUE_PATTERNS) {
  test(`no value in wrangler.toml looks like ${what}`, () => {
    const hit = toml.match(re);
    assert.ok(!hit, `found ${what} in wrangler.toml — move it to a secret and rotate it`);
  });
}

test("[vars] contains only the expected non-secret keys", () => {
  const allowed = new Set([
    "BOT_USERNAME",
    "PREMIUM_GROUP_CHAT_ID",
    "ADMIN_IDS",
    "QUALIFY_THRESHOLD",
    "PREMIUM_PRICE_STARS",
  ]);
  const unexpected = varNames.filter((n) => !allowed.has(n));
  assert.deepEqual(
    unexpected,
    [],
    `unexpected key(s) in [vars]: ${unexpected.join(", ")}. If one is a credential, ` +
      `use \`wrangler secret put\`. If it is genuinely public config, add it to the allow-list here.`
  );
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
