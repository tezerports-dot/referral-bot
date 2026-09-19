// Static guards over the source tree and the documented webhook registration.
//
// Two things here cannot be caught by running a handler, because the failure is
// a line of text somewhere:
//
//   * something in the codebase approving join requests automatically
//   * the webhook's allowed_updates omitting a type the bot handles -- Telegram
//     simply never sends those updates, so the handler is dead code and nothing
//     errors. This is exactly how the chat_member handler went unused.
//
// The webhook is registered by hand (the README's curl); no code calls
// setWebhook. So the README IS the configuration, and it is what is checked.
//
// Run with: npm run test:webhook

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname;
const read = (rel) => readFileSync(join(root, rel), "utf8");

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

/** Every file under a directory, skipping dependencies and build output. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".git", "dist", ".wrangler"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Source with comments removed, so prose about approval is not mistaken for a call. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const srcFiles = walk(join(root, "src")).filter((f) => f.endsWith(".ts"));

// =============================================================================
console.log("\nTest 7 — join requests are never approved automatically");

test("approveChatJoinRequest does not appear anywhere in src/", () => {
  const hits = srcFiles.filter((f) => /approveChatJoinRequest/i.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits.map((f) => relative(root, f)), []);
});

test("no code in src/ calls any approve*() method or wrapper", () => {
  const calls = [];
  for (const f of srcFiles) {
    const code = stripComments(readFileSync(f, "utf8"));
    for (const m of code.matchAll(/\b(\w*[aA]pprove\w*)\s*\(/g)) calls.push(`${relative(root, f)}: ${m[1]}(`);
  }
  assert.deepEqual(calls, [], "something approves users; the admin must do that");
});

test("the chat_join_request handler makes no approval decision", () => {
  const bot = stripComments(read("src/bot.ts"));
  const start = bot.indexOf('bot.on("chat_join_request"');
  const end = bot.indexOf("bot.on(", start + 1);
  assert.ok(start > -1 && end > start, "could not isolate the chat_join_request handler");
  const handler = bot.slice(start, end);
  assert.ok(!/approve/i.test(handler), "the handler references approval");
  // What it MAY do: record the request, and refuse people who skipped the bot.
  assert.ok(/recordJoinRequest/.test(handler), "the handler must record the request");
});

test("the docs no longer promise automatic approval", () => {
  const promises = [];
  for (const rel of ["README.md", "src/bot.ts"]) {
    for (const line of read(rel).split("\n")) {
      if (/approv\w*\s+automatically|automatically\s+approv/i.test(line)) promises.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepEqual(promises, []);
});

// =============================================================================
console.log("\nTest 8 — webhook allowed_updates matches what the bot handles");

/** Update types the application registers handlers for, derived from src/bot.ts. */
function handledUpdateTypes() {
  const bot = stripComments(read("src/bot.ts"));
  const types = new Set();
  // bot.command(...) is a text message.
  if (/bot\.command\(/.test(bot)) types.add("message");
  // bot.on("message:text"), bot.on("callback_query:data"), bot.on("chat_member"), ...
  for (const m of bot.matchAll(/bot\.on\(\s*"([a-z_]+)(?::[a-z_:]+)?"/g)) types.add(m[1]);
  return types;
}

/** Every allowed_updates list written down anywhere in the repo's config, docs or code. */
function declaredLists() {
  const found = [];
  const files = walk(root).filter(
    (f) => !f.includes("/tests/") && /\.(md|ts|toml|json|sh|mjs)$/.test(f) && !f.endsWith("package-lock.json")
  );
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/allowed_updates[^\[\n]*\[([^\]]*)\]/g)) {
      found.push({ file: relative(root, f), types: new Set([...m[1].matchAll(/([a-z_]+)/g)].map((x) => x[1])) });
    }
  }
  return found;
}

test("the bot's handlers are found (guards against the parser going blind)", () => {
  const handled = handledUpdateTypes();
  for (const t of ["message", "callback_query", "chat_join_request", "chat_member", "my_chat_member", "pre_checkout_query"]) {
    assert.ok(handled.has(t), `expected a handler for ${t}`);
  }
});

test("the webhook registration in the README is found", () => {
  assert.ok(declaredLists().some((l) => l.file === "README.md"), "no allowed_updates list in README.md");
});

test("allowed_updates includes chat_member", () => {
  // The chat_member handler keeps `member` state in step with Telegram (approvals,
  // departures). Telegram only sends it when it is asked for by name.
  for (const l of declaredLists()) assert.ok(l.types.has("chat_member"), `${l.file} omits chat_member`);
});

test("allowed_updates includes every update type the bot handles", () => {
  const handled = handledUpdateTypes();
  for (const l of declaredLists()) {
    const missing = [...handled].filter((t) => !l.types.has(t));
    assert.deepEqual(missing, [], `${l.file} would leave these handlers dead: ${missing.join(", ")}`);
  }
});

test("allowed_updates lists nothing the bot does not handle", () => {
  const handled = handledUpdateTypes();
  for (const l of declaredLists()) {
    const extra = [...l.types].filter((t) => !handled.has(t));
    assert.deepEqual(extra, [], `${l.file} subscribes to unused update types: ${extra.join(", ")}`);
  }
});

test("every declared list agrees with every other", () => {
  const lists = declaredLists().map((l) => [...l.types].sort().join(","));
  assert.equal(new Set(lists).size, 1, "two places disagree about allowed_updates");
});

// =============================================================================
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("Failed: " + failures.join("; "));
  process.exit(1);
}
