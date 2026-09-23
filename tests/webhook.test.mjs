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
console.log("\nTest 7 — the bot approves ONLY in a chat an admin designated with /autojoin");

// The rule used to be "the bot never approves, full stop". It is now narrower:
// approval is allowed in exactly one place, behind an explicit per-chat flag an
// admin sets with /autojoin. These tests pin that narrowing down rather than
// dropping the guarantee -- an approval call anywhere else still fails.

/** The chat_join_request handler body, and everything else, separately. */
function splitBot() {
  const code = stripComments(read("src/bot.ts"));
  const from = code.indexOf('bot.on("chat_join_request"');
  const to = code.indexOf("bot.on(", from + 1);
  assert.ok(from > -1 && to > from, "could not isolate the chat_join_request handler");
  return { handler: code.slice(from, to), rest: code.slice(0, from) + code.slice(to) };
}

test("approveChatJoinRequest appears in src/bot.ts and nowhere else", () => {
  const hits = srcFiles
    .filter((f) => /approveChatJoinRequest/.test(readFileSync(f, "utf8")))
    .map((f) => relative(root, f));
  assert.deepEqual(hits, ["src/bot.ts"]);
});

test("there is exactly one approval call, and it is behind the auto-approve guard", () => {
  const { handler } = splitBot();
  const approvals = [...handler.matchAll(/\bapproveChatJoinRequest\s*\(/g)];
  assert.equal(approvals.length, 1, "expected exactly one approval call in the handler");
  const guard = handler.indexOf("policy.autoApprove");
  assert.ok(guard > -1, "the handler must read policy.autoApprove");
  assert.ok(
    guard < approvals[0].index,
    "the approval must sit after the policy.autoApprove check, not on the normal path"
  );
});

test("nothing outside that handler approves anyone", () => {
  // setChatAutoApprove only writes the flag; it approves nobody.
  const CONFIG_ONLY = new Set(["setChatAutoApprove"]);
  const calls = [];
  for (const f of srcFiles) {
    const rel = relative(root, f);
    const scan = rel === "src/bot.ts" ? splitBot().rest : stripComments(readFileSync(f, "utf8"));
    for (const m of scan.matchAll(/\b(\w*[aA]pprove\w*)\s*\(/g)) {
      if (!CONFIG_ONLY.has(m[1])) calls.push(`${rel}: ${m[1]}(`);
    }
  }
  assert.deepEqual(calls, [], "approval must happen only in the designated-chat branch");
});

test("the manual path is intact: it still records and still declines", () => {
  const { handler } = splitBot();
  assert.ok(/recordJoinRequest/.test(handler), "the handler must record the request");
  assert.ok(/declineChatJoinRequest/.test(handler), "non-bot users must still be declined");
});

test("the docs promise automatic approval only for a designated chat", () => {
  // Checked per paragraph, not per line: prose wraps, and a promise qualified
  // in the sentence before is qualified. A bare promise in its own paragraph,
  // with no mention of the opt-in anywhere near it, is what this catches.
  const PROMISE = /approv\w*\s+automatically|automatically\s+approv|auto-approve/i;
  const QUALIFIER = /autojoin|designat|auto_approve|autoApprove|⚡/i;

  const unqualified = [];
  for (const rel of ["README.md", "src/bot.ts"]) {
    const text = read(rel);
    // Markdown wraps across lines, so judge a whole paragraph; a string literal
    // in source stands alone, so judge a line.
    const blocks = rel.endsWith(".md") ? text.split(/\n\s*\n/) : text.split("\n");
    for (const block of blocks) {
      if (!PROMISE.test(block)) continue;
      if (QUALIFIER.test(block)) continue;
      unqualified.push(`${rel}: ${block.trim().split("\n")[0]}`);
    }
  }
  assert.deepEqual(unqualified, [], "an unqualified promise of automatic approval is misleading");
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
