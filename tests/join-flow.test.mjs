// End-to-end behaviour of the join-request / verification / referral flow.
//
// Unlike sql.test.mjs (which runs copies of the SQL), this drives the REAL
// compiled handlers in src/bot.ts: updates go in through bot.handleUpdate, the
// database is real SQLite behind a D1-shaped wrapper, and Telegram is a fake
// that records every API call the bot makes and answers getChatMember from a
// script. Nothing about the bot is mocked -- only its two edges.
//
// Business rules under test:
//   * join requests are approved MANUALLY by an admin; the bot never approves
//   * a pending request satisfies the requirement, exactly like real membership
//   * verification (and the referrer's credit) does not wait for admin approval
//   * already-members are recognised; people with neither are not
//
// Run with: npm run test:flow

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// ---- compile the real source ------------------------------------------------

const root = new URL("..", import.meta.url).pathname;
const out = mkdtempSync(join(tmpdir(), "flow-"));
execFileSync("npx", ["tsc", "-p", "tsconfig.json", "--noEmit", "false", "--outDir", out], {
  cwd: root,
  stdio: "pipe",
});
// tsc keeps extensionless relative imports (the project targets a bundler);
// Node's ESM loader needs them, so add the extension in the emitted copy.
for (const f of readdirSync(out).filter((n) => n.endsWith(".js"))) {
  const file = join(out, f);
  writeFileSync(file, readFileSync(file, "utf8").replace(/from "(\.\/[^"]+)"/g, 'from "$1.js"'));
}
writeFileSync(join(out, "package.json"), '{"type":"module"}');
symlinkSync(join(root, "node_modules"), join(out, "node_modules")); // for `grammy`

const { createBot } = await import(join(out, "bot.js"));
const dbmod = await import(join(out, "db.js"));
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

// ---- one clock for the whole test ------------------------------------------
//
// Telegram stamps every event with its own time, and the bot stamps a
// getChatMember observation with Date.now(). In production those agree; here
// both follow this counter so each step is unambiguously later than the last.
let clock = 1_800_000_000;
const tick = () => ++clock;
Date.now = () => clock * 1000;

// ---- a D1-shaped wrapper over node:sqlite -----------------------------------

function d1(sqlite) {
  return {
    prepare(sql) {
      const st = sqlite.prepare(sql);
      let params = [];
      const q = {
        bind(...a) {
          params = a;
          return q;
        },
        async first() {
          return st.get(...params) ?? null;
        },
        async all() {
          return { results: st.all(...params) };
        },
        async run() {
          const r = st.run(...params);
          return { meta: { changes: Number(r.changes) } };
        },
      };
      return q;
    },
  };
}

// ---- the world: bot + database + scripted Telegram --------------------------

const BOT_INFO = {
  id: 424242,
  is_bot: true,
  first_name: "Test",
  username: "Testbot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
};

function makeWorld({ chats = [-101, -102] } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  for (const id of chats) {
    sqlite
      .prepare("INSERT INTO required_chats (chat_id, title, kind, invite_link) VALUES (?, ?, 'group', ?)")
      .run(id, `Chat${-id}`, `https://t.me/+link${-id}`);
  }
  dbmod.invalidateRequiredChatCache();

  const env = {
    DB: d1(sqlite),
    BOT_TOKEN: "1:test",
    WEBHOOK_SECRET: "s",
    ADMIN_EXPORT_TOKEN: "t",
    BOT_USERNAME: "Testbot",
    PREMIUM_GROUP_CHAT_ID: "-999",
    ADMIN_IDS: "999",
    QUALIFY_THRESHOLD: "200",
    PREMIUM_PRICE_STARS: "1500",
    REFERRAL_REWARD_INR: "10",
  };

  const w = {
    sqlite,
    env,
    calls: [],
    /** "<chat>:<user>" -> Telegram status returned by getChatMember (default "left"). */
    members: {},
    /** When true, getChatMember throws, like a Telegram outage or a bot without rights. */
    lookupsFail: false,
  };

  const bot = createBot(env, BOT_INFO);
  bot.api.config.use(async (_prev, method, payload) => {
    w.calls.push({ method, payload });
    if (method === "getChatMember") {
      if (w.lookupsFail) throw new Error("Bad Request: chat not found");
      const status = w.members[`${payload.chat_id}:${payload.user_id}`] ?? "left";
      const user = { id: payload.user_id, is_bot: false, first_name: `User${payload.user_id}` };
      return { ok: true, result: status === "restricted" ? { status, user, is_member: true } : { status, user } };
    }
    if (method === "sendMessage") {
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: payload.chat_id, type: "private" } } };
    }
    return { ok: true, result: true };
  });

  let updateId = 1;
  const person = (id) => ({ id, is_bot: false, first_name: `User${id}` });
  const dm = (id) => ({ id, type: "private", first_name: `User${id}` });
  const send = (update) => bot.handleUpdate({ update_id: updateId++, ...update });

  Object.assign(w, {
    tick,
    start: (uid, payload) =>
      send({
        message: {
          message_id: updateId,
          date: tick(),
          chat: dm(uid),
          from: person(uid),
          text: payload ? `/start ${payload}` : "/start",
          entities: [{ type: "bot_command", offset: 0, length: 6 }],
        },
      }),
    contact: (uid) =>
      send({
        message: {
          message_id: updateId,
          date: tick(),
          chat: dm(uid),
          from: person(uid),
          contact: { phone_number: `+91900000${String(uid).padStart(4, "0")}`, first_name: `User${uid}`, user_id: uid },
        },
      }),
    verify: (uid) =>
      send({
        callback_query: {
          id: `cb${updateId}`,
          from: person(uid),
          chat_instance: "ci",
          data: "verify",
          message: { message_id: 1, date: tick(), chat: dm(uid) },
        },
      }),
    joinRequest: (uid, chatId, date = tick()) =>
      send({
        chat_join_request: {
          chat: { id: chatId, type: "supergroup", title: `Chat${-chatId}` },
          from: person(uid),
          user_chat_id: uid,
          date,
        },
      }),
    chatMember: (uid, chatId, status, date = tick(), extra = {}) =>
      send({
        chat_member: {
          chat: { id: chatId, type: "supergroup", title: `Chat${-chatId}` },
          from: person(999),
          date,
          old_chat_member: { status: "left", user: person(uid) },
          new_chat_member: { status, user: person(uid), ...extra },
        },
      }),
  });

  const rows = (sql, ...a) => sqlite.prepare(sql).all(...a);
  Object.assign(w, {
    user: (id) => rows("SELECT * FROM users WHERE telegram_user_id = ?", id)[0],
    verified: (id) => w.user(id)?.verified === 1,
    count: (id) => w.user(id).verified_referral_count,
    state: (uid, chat) => rows("SELECT status FROM join_requests WHERE telegram_user_id = ? AND chat_id = ?", uid, chat)[0]?.status ?? null,
    called: (method) => w.calls.filter((c) => c.method === method),
    /** Text of every message the bot sent to this user, oldest first. */
    texts: (uid) => w.calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === uid).map((c) => c.payload.text),
    lastText: (uid) => w.texts(uid).at(-1) ?? "",
    satisfied: async (uid) =>
      Object.fromEntries((await dbmod.getRequiredChatsWithStatus(env.DB, uid)).map((c) => [c.chat_id, c.satisfied])),
  });

  return w;
}

/** A referrer (id 1) and a referred user (id 2) who has opened the referral link. */
async function referredUser(w) {
  await w.start(1);
  await w.start(2, w.user(1).referral_code);
  assert.equal(w.user(2).referred_by, 1, "the existing referral-code deep link must still set referred_by");
  return { A: 1, B: 2 };
}

// ---- harness ----------------------------------------------------------------

// The bot logs (rather than throws) when a Telegram lookup fails. The outage
// tests trigger that on purpose, so collect it instead of printing stack traces.
const logged = [];
console.error = (...args) => logged.push(args.map(String).join(" "));

let pass = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

// =============================================================================
console.log("\nTest 1 — join requests are NOT auto-approved");

await test("a join request is recorded as pending and approveChatJoinRequest is never called", async () => {
  const w = makeWorld();
  const { B } = await referredUser(w);
  await w.contact(B);
  await w.joinRequest(B, -101);
  assert.equal(w.state(B, -101), "pending", "the request must be recorded");
  assert.equal(w.called("approveChatJoinRequest").length, 0, "the bot must leave approval to the admin");
  assert.equal(w.called("declineChatJoinRequest").length, 0, "and must not reject a legitimate request either");
});

await test("no approval is issued even for the request that completes verification", async () => {
  const w = makeWorld();
  const { B } = await referredUser(w);
  await w.contact(B);
  await w.joinRequest(B, -101);
  await w.joinRequest(B, -102);
  assert.equal(w.verified(B), true, "precondition: this request completed the requirement");
  assert.equal(w.called("approveChatJoinRequest").length, 0);
});

await test("the tokens 'approveChatJoinRequest' / 'approve' never go out over the API for any flow", async () => {
  const w = makeWorld();
  const { B } = await referredUser(w);
  await w.contact(B);
  await w.joinRequest(B, -101);
  await w.chatMember(B, -101, "member");
  await w.verify(B);
  await w.start(B);
  assert.deepEqual(
    w.calls.filter((c) => /approve/i.test(c.method)).map((c) => c.method),
    []
  );
});

await test("a request from someone who never onboarded is declined and not recorded (existing gate kept)", async () => {
  const w = makeWorld();
  await w.joinRequest(555, -101); // never sent /start
  assert.equal(w.called("declineChatJoinRequest").length, 1);
  assert.equal(w.called("approveChatJoinRequest").length, 0);
  assert.equal(w.state(555, -101), null, "an outsider must not gain a satisfied requirement");
});

await test("a request for a chat that is not required is ignored entirely", async () => {
  const w = makeWorld();
  await w.start(2);
  await w.contact(2);
  await w.joinRequest(2, -777);
  assert.equal(w.state(2, -777), null);
  assert.equal(w.calls.filter((c) => /ChatJoinRequest/.test(c.method)).length, 0);
});

// =============================================================================
console.log("\nTest 2 — a pending request satisfies the requirement");

await test("with a pending request on every chat, each chat reports satisfied", async () => {
  const w = makeWorld();
  const { B } = await referredUser(w);
  await w.contact(B);
  await w.joinRequest(B, -101);
  assert.deepEqual(await w.satisfied(B), { [-101]: 1, [-102]: 0 });
  await w.joinRequest(B, -102);
  assert.deepEqual(await w.satisfied(B), { [-101]: 1, [-102]: 1 });
  assert.equal(w.state(B, -102), "pending", "still only PENDING -- nobody approved anything");
});

await test("pressing Verify succeeds on pending requests alone", async () => {
  const w = makeWorld();
  const { B } = await referredUser(w);
  await w.contact(B);
  // Record the requests without triggering the handler's own auto-verify, so
  // it is the Verify button doing the work.
  await dbmod.recordJoinRequest(w.env.DB, B, -101, w.tick());
  await dbmod.recordJoinRequest(w.env.DB, B, -102, w.tick());
  assert.equal(w.verified(B), false);
  await w.verify(B);
  assert.equal(w.verified(B), true, "verification must not require admin approval or chat_member");
  assert.match(w.lastText(B), /verified/i);
});

// =============================================================================
console.log("\nTest 3 — a pending request gives the referral credit, exactly once");

await test("B verifies before any admin approval and A is credited +1", async () => {
  const w = makeWorld();
  const { A, B } = await referredUser(w);
  assert.equal(w.count(A), 0);
  await w.contact(B);
  await w.joinRequest(B, -101);
  assert.equal(w.count(A), 0, "one chat outstanding: not yet");
  await w.joinRequest(B, -102);

  assert.equal(w.verified(B), true);
  assert.equal(w.count(A), 1, "credit is immediate -- it does not wait for the admin");
  assert.equal(w.called("approveChatJoinRequest").length, 0);
  assert.equal(w.called("chat_member").length, 0);
  assert.ok(w.user(B).verified_at, "verified_at is stamped");
});

await test("the referral relationship still comes from the referral code, unchanged", async () => {
  const w = makeWorld();
  await w.start(1);
  const code = w.user(1).referral_code;
  assert.match(code, /^[A-Za-z0-9]{8}$/, "an 8-character code, not a sequential number");
  await w.start(2, code);
  assert.equal(w.user(2).referred_by, 1);
  await w.start(3, code + "x"); // unknown payload
  assert.equal(w.user(3).referred_by, null);
  await w.start(1, code); // self-referral
  assert.equal(w.user(1).referred_by, null);
  await w.start(2, w.user(3).referral_code); // an existing user cannot be re-parented
  assert.equal(w.user(2).referred_by, 1, "referred_by is set once and never overwritten");
});

await test("an organic user (no referrer) still verifies on pending requests", async () => {
  const w = makeWorld();
  await w.start(7);
  await w.contact(7);
  await w.joinRequest(7, -101);
  await w.joinRequest(7, -102);
  assert.equal(w.verified(7), true);
});

// =============================================================================
console.log("\nTest 4 — repeated verification is idempotent");

await test("Verify x3, /start x2, duplicate requests and duplicate approvals credit A once", async () => {
  const w = makeWorld();
  const { A, B } = await referredUser(w);
  await w.contact(B);
  const t1 = w.tick();
  await w.joinRequest(B, -101, t1);
  await w.joinRequest(B, -102, w.tick());
  assert.equal(w.count(A), 1);

  for (let i = 0; i < 3; i++) await w.verify(B);
  await w.start(B);
  await w.start(B);
  await w.joinRequest(B, -101, t1); // Telegram redelivers the very same update
  assert.equal(w.count(A), 1, "repeat presses / redeliveries must not credit again");

  // The admin now approves both, and Telegram redelivers those too.
  const a1 = w.tick();
  const a2 = w.tick();
  await w.chatMember(B, -101, "member", a1);
  await w.chatMember(B, -101, "member", a1);
  await w.chatMember(B, -102, "member", a2);
  await w.chatMember(B, -102, "member", a2);
  await w.verify(B);

  assert.equal(w.verified(B), true);
  assert.equal(w.count(A), 1, "approval turns pending into member; it is not a second credit");
  assert.equal(w.state(B, -101), "member");
});

await test("membership reconciliation running repeatedly cannot double-credit", async () => {
  const w = makeWorld();
  const { A, B } = await referredUser(w);
  w.members = { [`-101:${B}`]: "member", [`-102:${B}`]: "member" };
  await w.contact(B);
  for (let i = 0; i < 4; i++) {
    await w.verify(B);
    await w.start(B);
  }
  assert.equal(w.count(A), 1);
});

await test("if the user leaves and returns, the credit is taken back once and restored once", async () => {
  const w = makeWorld();
  const { A, B } = await referredUser(w);
  await w.contact(B);
  await w.joinRequest(B, -101);
  await w.joinRequest(B, -102);
  assert.equal(w.count(A), 1);

  const left = w.tick();
  await w.chatMember(B, -102, "left", left);
  await w.chatMember(B, -102, "left", left); // duplicate delivery
  assert.equal(w.verified(B), false);
  assert.equal(w.count(A), 0, "taken back exactly once, never below zero");

  await w.joinRequest(B, -102); // asks again
  await w.joinRequest(B, -102, 1); // an old duplicate arriving late
  assert.equal(w.verified(B), true);
  assert.equal(w.count(A), 1, "restored exactly once");
});

// =============================================================================
console.log("\nTest 5 — an existing member is recognised");

await test("someone already in every required chat is not told to join", async () => {
  const w = makeWorld();
  const { A, B } = await referredUser(w);
  w.members = { [`-101:${B}`]: "member", [`-102:${B}`]: "administrator" };

  await w.start(B, w.user(A).referral_code);
  assert.match(w.lastText(B), /2️⃣ Send a join request to all 2 destinations\s+✅ done/, "/start must show the step as done");

  await w.contact(B);
  assert.equal(w.verified(B), true);
  assert.equal(w.count(A), 1);
  assert.equal(w.state(B, -101), "member", "recorded as ACTUAL membership, not as a pending request");
  assert.equal(w.state(B, -102), "member");
  assert.doesNotMatch(w.texts(B).join("\n"), /Send a join request to Chat/, "no 'you still need to join' anywhere");
});

await test("pressing Verify recognises membership that the database did not know about", async () => {
  const w = makeWorld();
  const { A, B } = await referredUser(w);
  w.lookupsFail = true; // Telegram is unreachable while they share their contact
  await w.contact(B);
  assert.equal(w.verified(B), false, "a failed lookup must not grant anything");

  w.lookupsFail = false;
  w.members = { [`-101:${B}`]: "member", [`-102:${B}`]: "member" }; // ...and it is back
  await w.verify(B);
  assert.equal(w.verified(B), true);
  assert.equal(w.count(A), 1);
  assert.match(w.lastText(B), /verified/i);
  assert.doesNotMatch(w.lastText(B), /Send a join request to/);
});

await test("a member of one chat with a pending request on the other is satisfied", async () => {
  const w = makeWorld();
  const { A, B } = await referredUser(w);
  w.members = { [`-101:${B}`]: "member" };
  await w.contact(B); // recognises -101, still needs -102
  assert.equal(w.verified(B), false);
  assert.match(w.lastText(B), /1\/2 done/);
  await w.joinRequest(B, -102);
  assert.equal(w.verified(B), true);
  assert.equal(w.state(B, -101), "member");
  assert.equal(w.state(B, -102), "pending");
  assert.equal(w.count(A), 1);
});

await test("a muted (restricted) user who is still in the chat counts as a member", async () => {
  const w = makeWorld({ chats: [-101] });
  await w.start(2);
  w.members = { "-101:2": "restricted" }; // getChatMember reports is_member: true
  await w.contact(2);
  assert.equal(w.verified(2), true);
});

// =============================================================================
console.log("\nTest 6 — no request and no membership fails");

await test("with neither, the chat is unsatisfied and verification does not complete", async () => {
  const w = makeWorld();
  const { A, B } = await referredUser(w);
  await w.contact(B);
  await w.verify(B);

  assert.equal(w.verified(B), false);
  assert.equal(w.count(A), 0, "the referrer gets nothing");
  assert.deepEqual(await w.satisfied(B), { [-101]: 0, [-102]: 0 });
  assert.match(w.lastText(B), /Send a join request to Chat101/);
  assert.match(w.lastText(B), /Send a join request to Chat102/);
});

await test("satisfied chats are never re-checked, so Telegram's ambiguous 'left' cannot erase a pending request", async () => {
  // getChatMember says 'left' both for someone whose request is pending and for
  // someone who never asked, so it cannot be trusted to END anything. The
  // guarantee is structural: reconcile only asks about chats the database has
  // not already satisfied, and only ever records membership it finds.
  const w = makeWorld();
  const { B } = await referredUser(w);
  await w.contact(B);
  await w.joinRequest(B, -101); // pending; -102 still outstanding
  w.members = {}; // Telegram would say 'left' for everything
  w.calls.length = 0;
  await w.verify(B);

  assert.deepEqual(
    w.called("getChatMember").map((c) => c.payload.chat_id),
    [-102],
    "only the unsatisfied chat is looked up; the pending one costs no API call"
  );
  assert.equal(w.state(B, -101), "pending", "and it is left exactly as it was");
});

await test("a user with nothing missing costs no Telegram lookups at all", async () => {
  const w = makeWorld();
  const { B } = await referredUser(w);
  await w.contact(B);
  await w.joinRequest(B, -101);
  await w.joinRequest(B, -102);
  w.calls.length = 0;
  await w.verify(B);
  await w.start(B);
  assert.equal(w.called("getChatMember").length, 0);
});

await test("an ended chat that Telegram says is 'left' stays ended; one it says is 'member' is restored", async () => {
  const w = makeWorld();
  const { A, B } = await referredUser(w);
  await w.contact(B);
  await w.joinRequest(B, -101);
  await w.joinRequest(B, -102);
  await w.chatMember(B, -102, "left"); // departs; un-verified, A back to 0
  assert.equal(w.count(A), 0);

  await w.verify(B); // Telegram still says 'left'
  assert.equal(w.state(B, -102), "ended");
  assert.equal(w.verified(B), false);

  w.members = { [`-102:${B}`]: "member" }; // they are back in the chat, and we never heard
  await w.verify(B);
  assert.equal(w.state(B, -102), "member");
  assert.equal(w.verified(B), true);
  assert.equal(w.count(A), 1, "stale-negative data is healed without a chat_member event");
});

await test("a failed Telegram lookup never counts as a pass", async () => {
  const w = makeWorld();
  const { B } = await referredUser(w);
  w.lookupsFail = true;
  logged.length = 0;
  await w.contact(B);
  await w.verify(B);
  assert.equal(w.verified(B), false);
  assert.equal(w.state(B, -101), null);
  assert.ok(logged.some((l) => /getChatMember failed/.test(l)), "the failure is logged, not silently swallowed");
});

await test("no contact shared: verification fails even with every request pending", async () => {
  const w = makeWorld();
  const { B } = await referredUser(w);
  await dbmod.recordJoinRequest(w.env.DB, B, -101, w.tick());
  await dbmod.recordJoinRequest(w.env.DB, B, -102, w.tick());
  await w.verify(B);
  assert.equal(w.verified(B), false);
});

await test("a chat that is not required cannot satisfy the requirement", async () => {
  const w = makeWorld();
  const { B } = await referredUser(w);
  await w.contact(B);
  await w.joinRequest(B, -101);
  w.members = { [`-777:${B}`]: "member" };
  await w.verify(B);
  assert.equal(w.verified(B), false, "-102 is still outstanding");
});

// =============================================================================
console.log("\nRejected / removed requests are not valid forever");

await test("a removal reported by Telegram ends a pending request and un-verifies, once", async () => {
  const w = makeWorld();
  const { A, B } = await referredUser(w);
  await w.contact(B);
  await w.joinRequest(B, -101);
  await w.joinRequest(B, -102);
  assert.equal(w.count(A), 1);

  await w.chatMember(B, -101, "kicked"); // banned while the request was pending
  assert.equal(w.state(B, -101), "ended");
  assert.equal(w.verified(B), false);
  assert.equal(w.count(A), 0);
  assert.deepEqual(await w.satisfied(B), { [-101]: 0, [-102]: 1 });
});

await test("a stale 'left' event cannot end a request the user re-sent afterwards", async () => {
  const w = makeWorld();
  const { A, B } = await referredUser(w);
  await w.contact(B);
  await w.joinRequest(B, -101, 100);
  await w.joinRequest(B, -102, 101);
  await w.chatMember(B, -101, "left", 200);
  await w.joinRequest(B, -101, 300);
  assert.equal(w.count(A), 1);
  await w.chatMember(B, -101, "left", 200); // the old departure, redelivered
  assert.equal(w.state(B, -101), "pending");
  assert.equal(w.verified(B), true);
  assert.equal(w.count(A), 1, "a redelivered old event must not cost the referrer a credit");
});

await test("an unclear status (a restricted non-member) leaves stored state alone", async () => {
  const w = makeWorld();
  const { B } = await referredUser(w);
  await w.contact(B);
  await w.joinRequest(B, -101);
  await w.chatMember(B, -101, "restricted", w.tick(), { is_member: false });
  assert.equal(w.state(B, -101), "pending");
});

await test("membership changes in a chat that is not required are ignored", async () => {
  const w = makeWorld();
  await w.start(2);
  await w.chatMember(2, -777, "member");
  assert.equal(w.state(2, -777), null);
});

// =============================================================================
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("Failed: " + failures.join("; "));
  process.exit(1);
}
