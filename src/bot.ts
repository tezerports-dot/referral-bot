import { Bot, InlineKeyboard } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "./types";
import { premiumPriceStars, qualifyThreshold, referralRewardInr, rewardCapInr, rewardInr } from "./types";
import { normalizePhone, phoneTail } from "./phone";
import {
  addRequiredChat,
  countPaidUsers,
  countQualifiedUsers,
  countTotalUsers,
  countVerifiedUsers,
  createUserIfNotExists,
  deactivateRequiredChat,
  getDirectReferrals,
  getMissingRequiredChats,
  getUserById,
  getUserByPhone,
  getUserByReferralCode,
  isRequiredChat,
  listRequiredChats,
  recordJoinRequest,
  setContactShared,
  setJoinRequestActive,
  setRequiredChatInviteLink,
  trySetReferrer,
  type RequiredChatRow,
  type UserRow,
} from "./db";
import { tryVerifyAndQualify } from "./verification";
import { isAdmin } from "./admin";
import {
  handlePreCheckout,
  handleSuccessfulPayment,
  issuePremiumInviteLink,
  refundPremium,
  sendPremiumInvoice,
} from "./payments";

/**
 * Every reply is plain text with no parse_mode. Chat titles, first names and
 * usernames all flow into these strings and are attacker-controlled, so
 * leaving Markdown/HTML parsing off removes that whole injection class.
 */

/** Built fresh per call: grammY's reply_markup type expects a mutable array. */
function contactKeyboard() {
  return {
    keyboard: [[{ text: "📱 Share my contact", request_contact: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

function displayName(u: UserRow | null): string {
  if (!u) return "that account";
  return u.first_name?.trim() || (u.username ? "@" + u.username : `user ${u.telegram_user_id}`);
}

/** Join buttons for every active chat, plus contact and verify actions. */
function stepsKeyboard(chats: RequiredChatRow[], needsContact: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (needsContact) kb.text("📱 Share my contact", "contact").row();
  for (const c of chats) {
    if (c.invite_link) kb.url(`➕ Join ${c.title?.trim() || "chat"}`, c.invite_link).row();
  }
  kb.text("✅ Verify me", "verify");
  return kb;
}

function menuKeyboard(user: UserRow): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("📊 My referrals", "menu:referrals")
    .row()
    .text("📋 My status", "menu:status")
    .row()
    .text("🔗 My referral link", "menu:link")
    .row();
  if (user.qualified && !user.premium_paid) kb.text("⭐ Get premium access", "menu:premium").row();
  if (user.premium_paid) kb.text("⭐ My premium link", "menu:premium").row();
  return kb;
}

/** The single "here is everything you need to do" message. */
async function stepsMessage(env: Env, user: UserRow, prefix = ""): Promise<{ text: string; kb: InlineKeyboard }> {
  const chats = await listRequiredChats(env.DB, true);
  const missing = await getMissingRequiredChats(env.DB, user.telegram_user_id);
  const needsContact = !user.contact_shared;

  const lines = [
    prefix,
    "Here is everything you need to do:",
    "",
    `1️⃣ Share your contact  ${needsContact ? "⬜ pending" : "✅ done"}`,
    `2️⃣ Send a join request to all ${chats.length} destination${chats.length === 1 ? "" : "s"}  ` +
      `${missing.length === 0 ? "✅ done" : `⬜ ${chats.length - missing.length}/${chats.length} done`}`,
    "3️⃣ Tap “✅ Verify me” when both are complete",
    "",
    "Join requests are approved automatically once you have shared your contact.",
    "",
    `Your referral link:\nhttps://t.me/${env.BOT_USERNAME}?start=${user.referral_code}`,
  ];
  return { text: lines.filter((l) => l !== null).join("\n").trim(), kb: stepsKeyboard(chats, needsContact) };
}

/** Plain-text summary of where a user stands. */
async function progressText(env: Env, userId: number): Promise<string> {
  const user = await getUserById(env.DB, userId);
  if (!user) return "Send /start first.";

  const threshold = qualifyThreshold(env);
  if (user.verified) {
    const remaining = Math.max(0, threshold - user.verified_referral_count);
    return (
      "✅ You are verified.\n\n" +
      `Counted referrals: ${user.verified_referral_count} / ${threshold}\n` +
      `Earned: ₹${rewardInr(env, user.verified_referral_count)} of ₹${rewardCapInr(env)}\n` +
      (user.qualified
        ? user.premium_paid
          ? "Premium: paid — your invite link has been sent."
          : `Premium: unlocked — ${premiumPriceStars(env)} ⭐ to get your link.`
        : `${remaining} more verified referral${remaining === 1 ? "" : "s"} to unlock premium.`)
    );
  }

  const steps: string[] = [];
  if (!user.contact_shared) steps.push("• Share your contact.");
  const missing = await getMissingRequiredChats(env.DB, userId);
  for (const c of missing) steps.push(`• Send a join request to ${c.title?.trim() || `chat ${c.chat_id}`}.`);

  if (steps.length === 0) return "Everything looks complete — tap “✅ Verify me” again in a moment.";
  return "Not verified yet. Remaining:\n\n" + steps.join("\n");
}

export function createBot(env: Env, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(env.BOT_TOKEN, botInfo ? { botInfo } : undefined);
  const priv = (ctx: { chat?: { type: string } }) => ctx.chat?.type === "private";

  // ---- /start ----

  bot.command("start", async (ctx) => {
    const from = ctx.from;
    if (!from || !priv(ctx)) return;

    // A referral-link payload still works and skips the "who referred you" step.
    const payload = ctx.match?.toString().trim();
    let referrerId: number | null = null;
    if (payload) {
      const referrer = await getUserByReferralCode(env.DB, payload);
      if (referrer && referrer.telegram_user_id !== from.id) referrerId = referrer.telegram_user_id;
    }

    const user = await createUserIfNotExists(
      env.DB,
      from.id,
      referrerId,
      from.username ?? null,
      from.first_name ?? null
    );
    await tryVerifyAndQualify(env, bot.api, from.id);

    const fresh = (await getUserById(env.DB, from.id)) ?? user;

    // Returning user who is already through the funnel gets the menu.
    if (fresh.verified) {
      await ctx.reply(
        `Welcome back, ${displayName(fresh)}.\n\nWhat would you like to see?`,
        { reply_markup: menuKeyboard(fresh) }
      );
      return;
    }

    // Brand new, no referrer yet: ask who referred them first.
    if (!fresh.referred_by) {
      await ctx.reply(
        "Welcome!\n\n" +
          "Who referred you?\n\n" +
          "Send the phone number of the person who invited you — with or without the " +
          "country code (for example 9876543210 or +91 98765 43210).\n\n" +
          "If nobody referred you, tap the button below — you can still join and verify.",
        { reply_markup: new InlineKeyboard().text("⏭ Nobody referred me", "skipref") }
      );
      return;
    }

    const referrer = await getUserById(env.DB, fresh.referred_by);
    const { text, kb } = await stepsMessage(
      env,
      fresh,
      `✅ Referred by ${displayName(referrer)}.\n`
    );
    await ctx.reply(text, { reply_markup: kb });
  });

  bot.command("status", async (ctx) => {
    if (!ctx.from || !priv(ctx)) return;
    await ctx.reply(await progressText(env, ctx.from.id));
  });

  bot.command("menu", async (ctx) => {
    const from = ctx.from;
    if (!from || !priv(ctx)) return;
    const user = await getUserById(env.DB, from.id);
    if (!user) {
      await ctx.reply("Send /start first.");
      return;
    }
    await ctx.reply("Your account:", { reply_markup: menuKeyboard(user) });
  });

  // ---- Referrer by phone number ----

  /** Resolves a typed or forwarded number to a referrer. Returns a user-facing reply. */
  async function claimReferrer(userId: number, raw: string): Promise<string> {
    const me = await getUserById(env.DB, userId);
    if (!me) return "Send /start first.";
    if (me.referred_by) return "Your referrer is already recorded and cannot be changed.";

    const normalized = normalizePhone(raw);
    const tail = phoneTail(normalized);
    if (!normalized || !tail) {
      return "That does not look like a phone number. Send it with or without the country code, e.g. 9876543210.";
    }
    if (me.phone_normalized && me.phone_normalized === normalized) {
      return "That is your own number. Send the number of the person who referred you, or tap “Nobody referred me”.";
    }

    const found = await getUserByPhone(env.DB, normalized, tail);
    if (found === "ambiguous") {
      return "More than one account matches that number. Send it with the full country code, e.g. +919876543210.";
    }
    if (!found) {
      return (
        "No account is registered with that number yet.\n\n" +
        "Ask the person who referred you to open this bot and share their contact first, then send their number again. " +
        "Or tap “Nobody referred me” to continue without a referrer."
      );
    }
    if (found.telegram_user_id === userId) return "You cannot refer yourself.";

    const ok = await trySetReferrer(env.DB, userId, found.telegram_user_id);
    if (!ok) return "Could not record that referrer. If you are already verified, the referrer can no longer be changed.";
    return `✅ Referred by ${displayName(found)}.\n`;
  }

  /** Sends the full steps message to a user who has just settled their referrer. */
  async function sendSteps(ctx: { reply: (t: string, o?: object) => Promise<unknown> }, userId: number, prefix: string) {
    const user = await getUserById(env.DB, userId);
    if (!user) return;
    const { text, kb } = await stepsMessage(env, user, prefix);
    await ctx.reply(text, { reply_markup: kb });
  }

  bot.on("message:text", async (ctx) => {
    const from = ctx.from;
    const text = ctx.message.text.trim();
    if (!from || !priv(ctx) || text.startsWith("/")) return;

    const user = await getUserById(env.DB, from.id);
    if (!user) {
      await ctx.reply("Send /start first.");
      return;
    }
    if (user.referred_by || user.verified) {
      await ctx.reply(await progressText(env, from.id));
      return;
    }

    const result = await claimReferrer(from.id, text);
    if (result.startsWith("✅")) {
      await tryVerifyAndQualify(env, bot.api, from.id);
      await sendSteps(ctx, from.id, result);
    } else {
      await ctx.reply(result);
    }
  });

  // ---- Contact sharing ----

  bot.on("message:contact", async (ctx) => {
    const from = ctx.from;
    const contact = ctx.message.contact;
    if (!from || !contact || !priv(ctx)) return;

    const user = await getUserById(env.DB, from.id);
    if (!user) {
      await ctx.reply("Send /start first.");
      return;
    }

    // A card for somebody else, while no referrer is set, nominates a referrer.
    if (contact.user_id !== from.id) {
      if (user.referred_by || user.verified) {
        await ctx.reply("Please use the button to share your own contact.");
        return;
      }
      const result = await claimReferrer(from.id, contact.phone_number);
      if (result.startsWith("✅")) {
        await tryVerifyAndQualify(env, bot.api, from.id);
        await sendSteps(ctx, from.id, result);
      } else {
        await ctx.reply(result);
      }
      return;
    }

    const normalized = normalizePhone(contact.phone_number);
    const tail = phoneTail(normalized);
    if (!normalized || !tail) {
      await ctx.reply("Telegram sent a phone number we could not read. Please try again.");
      return;
    }

    const result = await setContactShared(env.DB, from.id, contact.phone_number, normalized, tail);
    if (result === "no_user") {
      await ctx.reply("Send /start first.");
      return;
    }
    if (result === "phone_taken") {
      await ctx.reply(
        "That phone number is already linked to another account. Each number can verify only one account."
      );
      return;
    }

    await tryVerifyAndQualify(env, bot.api, from.id);
    const fresh = await getUserById(env.DB, from.id);
    if (fresh?.verified) {
      await ctx.reply("✅ Contact received — you are now fully verified!", { reply_markup: { remove_keyboard: true } });
      await ctx.reply("Your account:", { reply_markup: menuKeyboard(fresh) });
      return;
    }
    await ctx.reply("✅ Contact received.", { reply_markup: { remove_keyboard: true } });
    await sendSteps(ctx, from.id, "");
  });

  // ---- Inline button actions ----

  bot.on("callback_query:data", async (ctx) => {
    const from = ctx.from;
    const data = ctx.callbackQuery.data;
    if (!from) return;

    const user = await getUserById(env.DB, from.id);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "Send /start first.", show_alert: true });
      return;
    }

    switch (data) {
      case "skipref": {
        await ctx.answerCallbackQuery();
        await sendSteps(ctx, from.id, "Continuing without a referrer.\n");
        return;
      }
      case "contact": {
        await ctx.answerCallbackQuery();
        if (user.contact_shared) {
          await ctx.reply("You have already shared your contact.");
          return;
        }
        await ctx.reply("Tap the button below to share your contact.", { reply_markup: contactKeyboard() });
        return;
      }
      case "verify": {
        await tryVerifyAndQualify(env, bot.api, from.id);
        const fresh = await getUserById(env.DB, from.id);
        if (fresh?.verified) {
          await ctx.answerCallbackQuery({ text: "✅ Verified!", show_alert: false });
          await ctx.reply("✅ You are verified!", { reply_markup: menuKeyboard(fresh) });
        } else {
          await ctx.answerCallbackQuery({ text: "Not complete yet — see below.", show_alert: false });
          await ctx.reply(await progressText(env, from.id));
        }
        return;
      }
      case "menu:referrals": {
        await ctx.answerCallbackQuery();
        const threshold = qualifyThreshold(env);
        const remaining = Math.max(0, threshold - user.verified_referral_count);
        await ctx.reply(
          "📊 Your referrals\n\n" +
            `Counted referrals: ${user.verified_referral_count}\n` +
            `Earned: ₹${rewardInr(env, user.verified_referral_count)} of ₹${rewardCapInr(env)}\n` +
            `Rate: ₹${referralRewardInr(env)} per referral\n\n` +
            `Needed for premium: ${threshold}\n` +
            (user.qualified ? "Status: unlocked ⭐" : `Still needed: ${remaining}`) +
            "\n\nOnly members who stay in every group and channel are counted. " +
            `If someone leaves, they stop counting and ₹${referralRewardInr(env)} comes off. ` +
            `₹${rewardCapInr(env)} is the maximum any account can earn.`
        );
        return;
      }
      case "menu:status": {
        await ctx.answerCallbackQuery();
        await ctx.reply(
          "📋 Your account\n\n" +
            `Verified: ${user.verified ? "yes" : "no"}\n` +
            `Contact shared: ${user.contact_shared ? "yes" : "no"}\n` +
            `Referred by: ${user.referred_by ? displayName(await getUserById(env.DB, user.referred_by)) : "nobody"}\n` +
            `Counted referrals: ${user.verified_referral_count}\n` +
            `Earned: ₹${rewardInr(env, user.verified_referral_count)} of ₹${rewardCapInr(env)}\n` +
            `Premium: ${user.premium_paid ? "paid" : user.qualified ? "unlocked, not paid" : "locked"}\n` +
            `Joined: ${user.created_at}`
        );
        return;
      }
      case "menu:link": {
        await ctx.answerCallbackQuery();
        await ctx.reply(
          "🔗 Your referral link — share this, or give people your phone number:\n\n" +
            `https://t.me/${env.BOT_USERNAME}?start=${user.referral_code}`
        );
        return;
      }
      case "menu:premium": {
        await ctx.answerCallbackQuery();
        if (user.premium_paid) {
          const link = await issuePremiumInviteLink(env, bot.api, from.id);
          if (!link) await ctx.reply("Your payment is recorded but the link is not ready. An admin has been notified.");
          return;
        }
        if (!user.qualified) {
          await ctx.reply(await progressText(env, from.id));
          return;
        }
        await sendPremiumInvoice(env, bot.api, from.id);
        return;
      }
      default:
        await ctx.answerCallbackQuery();
        return;
    }
  });

  // ---- Join requests: only people who came through the bot get in ----

  bot.on("chat_join_request", async (ctx) => {
    const req = ctx.chatJoinRequest;
    if (!(await isRequiredChat(env.DB, req.chat.id))) return;

    const user = await getUserById(env.DB, req.from.id);

    // Anyone who did not onboard through the bot is turned away, which is what
    // makes the bot the only route into these chats even if a link leaks.
    if (!user || !user.contact_shared) {
      try {
        await bot.api.declineChatJoinRequest(req.chat.id, req.from.id);
      } catch (err) {
        console.error(`Failed to decline join request from ${req.from.id}:`, err);
      }
      await bot.api
        .sendMessage(
          req.from.id,
          `To join, start @${env.BOT_USERNAME} first and share your contact. ` +
            "Your request was not approved because it did not come through the bot."
        )
        .catch(() => {});
      return;
    }

    await recordJoinRequest(env.DB, req.from.id, req.chat.id);
    try {
      await bot.api.approveChatJoinRequest(req.chat.id, req.from.id);
    } catch (err) {
      console.error(`Failed to approve join request from ${req.from.id}:`, err);
    }
    await tryVerifyAndQualify(env, bot.api, req.from.id);
  });

  // ---- Membership changes: only people who STAY are counted ----

  bot.on("chat_member", async (ctx) => {
    const upd = ctx.chatMember;
    if (!(await isRequiredChat(env.DB, upd.chat.id))) return;

    const status = upd.new_chat_member.status;
    const present = status === "member" || status === "administrator" || status === "creator";
    const gone = status === "left" || status === "kicked";
    if (!present && !gone) return; // "restricted" etc. leave the state as-is

    const changed = await setJoinRequestActive(env.DB, upd.new_chat_member.user.id, upd.chat.id, present);
    if (!changed) return;

    // Re-evaluates in whichever direction the new state calls for: a departure
    // revokes verification and takes the referrer's credit back, a rejoin
    // restores both.
    await tryVerifyAndQualify(env, bot.api, upd.new_chat_member.user.id);
  });

  // ---- Telegram Stars payments ----

  bot.on("pre_checkout_query", async (ctx) => {
    await handlePreCheckout(env, ctx);
  });

  bot.on("message:successful_payment", async (ctx) => {
    await handleSuccessfulPayment(env, bot.api, ctx);
  });

  // ---- Admin: required chat list ----

  async function mintJoinRequestLink(chatId: number): Promise<string | null> {
    try {
      const invite = await bot.api.createChatInviteLink(chatId, {
        name: "verification",
        creates_join_request: true,
      });
      return invite.invite_link;
    } catch (err) {
      console.error(`Could not mint join-request link for ${chatId}:`, err);
      return null;
    }
  }

  bot.command("addchat", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;
    const arg = ctx.match?.toString().trim();
    const inTargetChat = ctx.chat && ctx.chat.type !== "private";
    const chatId = arg ? Number(arg) : inTargetChat ? ctx.chat!.id : NaN;

    if (!Number.isInteger(chatId)) {
      await ctx.reply(
        "Usage:\n• /addchat <chat_id> — from this DM\n• /addchat — sent inside the group you want to add\n\n" +
          "The bot must already be an admin there with 'Invite Users via Link'."
      );
      return;
    }

    let title: string | null = null;
    let kind = "group";
    try {
      const chat = await bot.api.getChat(chatId);
      title = "title" in chat ? chat.title ?? null : null;
      kind = chat.type === "channel" ? "channel" : "group";
    } catch (err) {
      await ctx.reply(`Could not read chat ${chatId}. Add the bot as an administrator there first.\n\n${err}`);
      return;
    }

    await addRequiredChat(env.DB, chatId, title, kind, ctx.from!.id);
    const link = await mintJoinRequestLink(chatId);
    if (link) await setRequiredChatInviteLink(env.DB, chatId, link);

    await ctx.reply(
      `✅ Added ${title ?? chatId} (${kind}).\n\n` +
        (link
          ? `Approval-required link:\n${link}`
          : "⚠️ Could not create an invite link — give the bot 'Invite Users via Link' and re-run /addchat.")
    );
  });

  bot.command("removechat", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;
    const chatId = Number(ctx.match?.toString().trim());
    if (!Number.isInteger(chatId)) {
      await ctx.reply("Usage: /removechat <chat_id>  (see /chats)");
      return;
    }
    const removed = await deactivateRequiredChat(env.DB, chatId);
    await ctx.reply(
      removed
        ? `✅ Removed ${chatId}. Already-verified users keep their status.`
        : `${chatId} was not in the active required list.`
    );
  });

  bot.command("chats", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;
    const chats = await listRequiredChats(env.DB, false);
    if (chats.length === 0) {
      await ctx.reply("No required chats. Add one with /addchat <chat_id>.");
      return;
    }
    await ctx.reply(
      `Required chats (${chats.filter((c) => c.active).length} active):\n\n` +
        chats
          .map(
            (c) =>
              `${c.active ? "🟢" : "⚪"} ${c.chat_id} — ${c.title ?? "(untitled)"} [${c.kind}]` +
              (c.invite_link ? `\n   ${c.invite_link}` : "\n   (no invite link)")
          )
          .join("\n")
    );
  });

  // ---- Admin: stats and support ----

  bot.command("stats", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;
    const [total, verified, qualified, paid, chats] = await Promise.all([
      countTotalUsers(env.DB),
      countVerifiedUsers(env.DB),
      countQualifiedUsers(env.DB),
      countPaidUsers(env.DB),
      listRequiredChats(env.DB, true),
    ]);
    await ctx.reply(
      "📊 Stats\n" +
        `Total registered: ${total}\nVerified: ${verified}\n` +
        `Qualified (${qualifyThreshold(env)}+): ${qualified}\nPremium paid: ${paid}\n` +
        `Required chats: ${chats.length}\nPremium price: ${premiumPriceStars(env)} ⭐`
    );
  });

  bot.command("referrals", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;
    const targetId = Number(ctx.match?.toString().trim());
    if (!Number.isInteger(targetId)) {
      await ctx.reply("Usage: /referrals <telegram_user_id>");
      return;
    }
    const user = await getUserById(env.DB, targetId);
    if (!user) {
      await ctx.reply("No such user.");
      return;
    }
    const referrals = await getDirectReferrals(env.DB, targetId, 100);
    await ctx.reply(
      `User ${targetId}\nCounted referrals: ${user.verified_referral_count}\n` +
        `Earned: ₹${rewardInr(env, user.verified_referral_count)} of ₹${rewardCapInr(env)}\n` +
        `Qualified: ${user.qualified ? "yes" : "no"}\nPremium paid: ${user.premium_paid ? "yes" : "no"}\n` +
        `Direct referrals fetched: ${referrals.length} (verified among these: ${referrals.filter((r) => r.verified).length})`
    );
  });

  bot.command("resendpremium", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;
    const targetId = Number(ctx.match?.toString().trim());
    if (!Number.isInteger(targetId)) {
      await ctx.reply("Usage: /resendpremium <telegram_user_id>");
      return;
    }
    const link = await issuePremiumInviteLink(env, bot.api, targetId);
    await ctx.reply(link ? `Sent. Link: ${link}` : "Could not issue a link — check the user has paid and PREMIUM_GROUP_CHAT_ID is set.");
  });

  bot.command("refund", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;
    const targetId = Number(ctx.match?.toString().trim());
    if (!Number.isInteger(targetId)) {
      await ctx.reply("Usage: /refund <telegram_user_id>");
      return;
    }
    await ctx.reply(await refundPremium(env, bot.api, targetId));
  });

  bot.on("my_chat_member", async (ctx) => {
    if (ctx.myChatMember.new_chat_member.status !== "administrator") return;
    const chat = ctx.myChatMember.chat;
    if (chat.type === "private") return;
    const actorId = ctx.myChatMember.from.id;
    if (!isAdmin(env, actorId)) return;
    await bot.api
      .sendMessage(actorId, `I am now an admin in "${chat.title}" (${chat.type}).\n\nTo require it:\n/addchat ${chat.id}`)
      .catch(() => {});
  });

  return bot;
}
