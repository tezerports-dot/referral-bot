// The required-chat cache, tested against a fake D1 that counts queries.
// The point of the cache is a cost claim, so the test measures cost directly
// rather than trusting that it works.
//
// Run with: npm run test:cache

import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), "cache-"));
execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--noEmit", "false", "--outDir", out], {
  cwd: root,
  stdio: "pipe",
});
// tsc keeps extensionless relative imports (the project targets a bundler);
// Node's ESM loader requires them, so add the extension in the emitted copy.
execFileSync("bash", [
  "-c",
  `find ${out} -name '*.js' -exec sed -i -E 's|from "(\\./[^"]+)"|from "\\1.js"|g' {} +`,
]);

const { isRequiredChatCached, invalidateRequiredChatCache } = await import(join(out, "db.js"));

/** Minimal D1 stand-in that records how many statements were executed. */
function fakeDb(activeChatIds) {
  const db = {
    queries: 0,
    prepare(sql) {
      const self = db;
      let bound = [];
      return {
        bind(...args) {
          bound = args;
          return this;
        },
        async all() {
          self.queries++;
          return { results: activeChatIds.map((c) => ({ chat_id: c })) };
        },
        async first() {
          self.queries++;
          return activeChatIds.includes(bound[0]) ? { 1: 1 } : null;
        },
      };
    },
  };
  return db;
}

let pass = 0;
const failures = [];
async function test(name, fn) {
  invalidateRequiredChatCache();
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

console.log("\nRequired-chat cache");

await test("the first lookup costs one query, and warms the cache", async () => {
  const db = fakeDb([-101, -102]);
  assert.equal(await isRequiredChatCached(db, -101), true);
  assert.equal(db.queries, 1);
});

await test("repeated lookups of a known chat cost nothing at all", async () => {
  const db = fakeDb([-101, -102]);
  await isRequiredChatCached(db, -101);
  const afterWarm = db.queries;
  for (let i = 0; i < 500; i++) await isRequiredChatCached(db, -101);
  assert.equal(db.queries, afterWarm, "500 further events must not touch the database");
});

await test("every required chat is served from one warm-up", async () => {
  const db = fakeDb([-101, -102, -103]);
  await isRequiredChatCached(db, -101);
  const afterWarm = db.queries;
  assert.equal(await isRequiredChatCached(db, -102), true);
  assert.equal(await isRequiredChatCached(db, -103), true);
  assert.equal(db.queries, afterWarm, "the warm-up loaded the whole set");
});

await test("a chat added after warm-up is recognised immediately, not after the TTL", async () => {
  const active = [-101];
  const db = fakeDb(active);
  await isRequiredChatCached(db, -101); // warm
  active.push(-999); // admin runs /addchat on another isolate
  assert.equal(
    await isRequiredChatCached(db, -999),
    true,
    "a miss must fall through to the database, or a real join request would be dropped"
  );
});

await test("a genuinely unrelated chat is rejected", async () => {
  const db = fakeDb([-101]);
  await isRequiredChatCached(db, -101);
  assert.equal(await isRequiredChatCached(db, -555), false);
});

await test("invalidating forces a fresh read", async () => {
  const db = fakeDb([-101]);
  await isRequiredChatCached(db, -101);
  const afterWarm = db.queries;
  invalidateRequiredChatCache();
  await isRequiredChatCached(db, -101);
  assert.ok(db.queries > afterWarm, "after /addchat or /removechat the set must be re-read");
});

await test("the saving is real: 1000 events, one query", async () => {
  const db = fakeDb([-101, -102, -103]);
  for (let i = 0; i < 1000; i++) await isRequiredChatCached(db, [-101, -102, -103][i % 3]);
  assert.equal(db.queries, 1, `1000 membership events cost ${db.queries} query, not 1000`);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
