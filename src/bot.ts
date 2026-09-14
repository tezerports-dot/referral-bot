import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "./types";
import {
  backfillJoinRequestFlags,
  countQualifiedUsers,
  countTotalUsers,
  countVerifiedUsers,
  createUserIfNotExists,
  getDirectReferrals,
  getUserById,
  getUserByReferralCode,
  recordJoinRequest,
  setContactShared,
  setRequestFlag,
  type RequestColumn,
} from "./db";
import { tryVerifyAndQualify } from "./verification";
import { isAdmin } from "./admin";

function requiredChatIds(env: Env) {
  return {
    group1: env.GROUP1_CHAT_ID ? Number(env.GROUP1_CHAT_ID) : null,
    group2: env.GROUP2_CHAT_ID ? Number(env.GROUP2_CHAT_ID) : null,
    channel: env.CHANNEL_CHAT_ID ? Number(env.CHANNEL_CHAT_ID) : null,
  };
}

function matchRequiredChat(env: Env, chatId: number): RequestColumn | null {
  const ids = requiredChatIds(env);
  if (ids.group1 !== null && chatId === ids.group1) return "group1_request";
  if (ids.group2 !== null && chatId === ids.group2) return "group2_request";
  if (ids.channel !== null && chatId === ids.channel) return "channel_request";
  return null;
}

export function createBot(env: Env, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(env.BOT_TOKEN, botInfo ? { botInfo } : undefined);

  bot.command("start", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    const payload = ctx.match?.toString().trim();
    let referrerId: number | null = null;
    if (payload) {
      const referrer = await getUserByReferralCode(env.DB, payload);
      if (referrer) referrerId = referrer.telegram_user_id;
    }

    const user = await createUserIfNotExists(env.DB, from.id, referrerId, from.username ?? null, from.first_name ?? null);

    // Covers the case where the user already sent join requests to the
    // three destinations before ever pressing /start.
    await backfillJoinRequestFlags(env.DB, from.id, requiredChatIds(env));
    await tryVerifyAndQualify(env, bot.api, from.id);

    await ctx.reply(
      "Welcome! To complete verification:\n\n" +
        "1. Share your contact using the button below.\n" +
        "2. Send a join request to Group 1, Group 2, and the Channel (links will be shared separately).\n\n" +
        `Your personal referral link:\nhttps://t.me/${env.BOT_USERNAME}?start=${user.referral_code}`,
      {
        reply_markup: {
          keyboard: [[{ text: "📱 Share my contact", request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      }
    );
  });

  bot.on("message:contact", async (ctx) => {
    const from = ctx.from;
    const contact = ctx.message.contact;
    if (!from || !contact) return;

    // The request_contact button always attaches the sender's own contact.
    // Reject anything else (e.g. a manually forwarded contact card).
    if (contact.user_id !== from.id) {
      await ctx.reply("Please use the button to share your own contact.");
      return;
    }

    await setContactShared(env.DB, from.id, contact.phone_number);
    await tryVerifyAndQualify(env, bot.api, from.id);

    await ctx.reply(
      "Thanks! Now make sure you've sent a join request to Group 1, Group 2, and the Channel -- " +
        "you'll be verified automatically once all three are in."
    );
  });

  bot.on("chat_join_request", async (ctx) => {
    const req = ctx.chatJoinRequest;
    const column = matchRequiredChat(env, req.chat.id);
    if (!column) return; // not one of our three required destinations

    await recordJoinRequest(env.DB, req.from.id, req.chat.id);
    await setRequestFlag(env.DB, req.from.id, column);
    await tryVerifyAndQualify(env, bot.api, req.from.id);
  });

  // ---- Admin commands ----

  bot.command("stats", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;
    const [total, verified, qualified] = await Promise.all([
      countTotalUsers(env.DB),
      countVerifiedUsers(env.DB),
      countQualifiedUsers(env.DB),
    ]);
    await ctx.reply(`📊 Stats\nTotal registered: ${total}\nVerified: ${verified}\nQualified (100+): ${qualified}`);
  });

  bot.command("referrals", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;
    const arg = ctx.match?.toString().trim();
    const targetId = Number(arg);
    if (!arg || Number.isNaN(targetId)) {
      await ctx.reply("Usage: /referrals <telegram_user_id>");
      return;
    }
    const user = await getUserById(env.DB, targetId);
    if (!user) {
      await ctx.reply("No such user.");
      return;
    }
    const referrals = await getDirectReferrals(env.DB, targetId, 100);
    const verifiedAmongThem = referrals.filter((r) => r.verified).length;
    await ctx.reply(
      `User ${targetId}\n` +
        `Verified referral count: ${user.verified_referral_count}\n` +
        `Qualified: ${user.qualified ? "yes" : "no"}\n` +
        `Direct referrals fetched: ${referrals.length} (verified among these: ${verifiedAmongThem})`
    );
  });

  return bot;
}
