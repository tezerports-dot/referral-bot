import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "./types";
import { premiumPriceStars, qualifyThreshold } from "./types";
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
  getUserByReferralCode,
  isRequiredChat,
  listRequiredChats,
  recordJoinRequest,
  setContactShared,
  setRequiredChatInviteLink,
  type RequiredChatRow,
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
 * Every reply in this bot is sent as plain text with no parse_mode. Chat
 * titles, first names and usernames all flow into these strings and are
 * attacker-controlled, so leaving Markdown/HTML parsing off removes the whole
 * class of injection-into-our-own-messages problems.
 */

function chatLabel(chat: RequiredChatRow): string {
  const name = chat.title?.trim() || `Chat ${chat.chat_id}`;
  return chat.invite_link ? `${name}\n   ${chat.invite_link}` : `${name} (ask an admin for the link)`;
}

/** Human-readable "what's left to do" for a user, built from live DB state. */
async function progressText(env: Env, userId: number): Promise<string> {
  const user = await getUserById(env.DB, userId);
  if (!user) return "Send /start first.";

  if (user.verified) {
    const threshold = qualifyThreshold(env);
    const remaining = Math.max(0, threshold - user.verified_referral_count);
    return (
      "✅ You are verified.\n\n" +
      `Verified referrals: ${user.verified_referral_count} / ${threshold}\n` +
      (user.qualified
        ? user.premium_paid
          ? "Premium: paid — your invite link has been sent. Use /premium to get it again."
          : `Premium: unlocked — send /premium to pay ${premiumPriceStars(env)} Stars and get your link.`
        : `${remaining} more to unlock the Premium Opportunity.`)
    );
  }

  const steps: string[] = [];
  if (!user.referred_by) {
    steps.push(
      "• Join through a referral link. This bot only verifies users who arrive " +
        "via someone's personal link — ask the person who invited you for theirs."
    );
  }
  if (!user.contact_shared) steps.push("• Share your contact using the button on /start.");

  const missing = await getMissingRequiredChats(env.DB, userId);
  for (const chat of missing) steps.push(`• Send a join request to: ${chatLabel(chat)}`);

  if (steps.length === 0) {
    return "Everything looks complete — verification should land within a moment. Try /status again.";
  }
  return "Verification not complete yet. Remaining:\n\n" + steps.join("\n");
}

export function createBot(env: Env, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(env.BOT_TOKEN, botInfo ? { botInfo } : undefined);

  // ---- User flow ----

  bot.command("start", async (ctx) => {
    const from = ctx.from;
    if (!from || ctx.chat?.type !== "private") return;

    const payload = ctx.match?.toString().trim();
    let referrerId: number | null = null;
    if (payload) {
      const referrer = await getUserByReferralCode(env.DB, payload);
      if (referrer) referrerId = referrer.telegram_user_id;
    }

    const user = await createUserIfNotExists(
      env.DB,
      from.id,
      referrerId,
      from.username ?? null,
      from.first_name ?? null
    );

    // Join requests are stored independently of registration, so anyone who
    // requested to join before pressing /start is already counted here.
    await tryVerifyAndQualify(env, bot.api, from.id);

    const required = await listRequiredChats(env.DB, true);
    const chatList = required.length
      ? required.map((c, i) => `${i + 1}. ${chatLabel(c)}`).join("\n")
      : "(no destinations configured yet — an admin needs to add them)";

    await ctx.reply(
      "Welcome! To complete verification:\n\n" +
        "1. Share your contact using the button below.\n" +
        "2. Send a join request to each of these:\n\n" +
        chatList +
        "\n\nYour personal referral link:\n" +
        `https://t.me/${env.BOT_USERNAME}?start=${user.referral_code}\n\n` +
        "Check your progress any time with /status.",
      {
        reply_markup: {
          keyboard: [[{ text: "📱 Share my contact", request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      }
    );
  });

  bot.command("status", async (ctx) => {
    if (!ctx.from || ctx.chat?.type !== "private") return;
    await ctx.reply(await progressText(env, ctx.from.id));
  });

  bot.command("premium", async (ctx) => {
    const from = ctx.from;
    if (!from || ctx.chat?.type !== "private") return;

    const user = await getUserById(env.DB, from.id);
    if (!user) {
      await ctx.reply("Send /start first.");
      return;
    }
    if (!user.qualified) {
      await ctx.reply(await progressText(env, from.id));
      return;
    }
    if (user.premium_paid) {
      const link = await issuePremiumInviteLink(env, bot.api, from.id);
      if (!link) await ctx.reply("Your payment is recorded but the link isn't ready yet. An admin has been notified.");
      return;
    }
    await sendPremiumInvoice(env, bot.api, from.id);
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

    const result = await setContactShared(env.DB, from.id, contact.phone_number);
    if (result === "no_user") {
      await ctx.reply("Send /start first.");
      return;
    }
    if (result === "phone_taken") {
      await ctx.reply(
        "That phone number is already linked to another account. Each phone number can verify only one account."
      );
      return;
    }

    await tryVerifyAndQualify(env, bot.api, from.id);
    await ctx.reply("Thanks! Contact received.\n\n" + (await progressText(env, from.id)));
  });

  bot.on("chat_join_request", async (ctx) => {
    const req = ctx.chatJoinRequest;
    // Checked against the live required set, so rotating the list takes effect
    // immediately without a redeploy.
    if (!(await isRequiredChat(env.DB, req.chat.id))) return;

    await recordJoinRequest(env.DB, req.from.id, req.chat.id);
    await tryVerifyAndQualify(env, bot.api, req.from.id);
  });

  // ---- Telegram Stars payments ----

  bot.on("pre_checkout_query", async (ctx) => {
    await handlePreCheckout(env, ctx);
  });

  bot.on("message:successful_payment", async (ctx) => {
    await handleSuccessfulPayment(env, bot.api, ctx);
  });

  // ---- Admin: chat list management ----

  /** Mints the approval-required invite link the bot shows to users. */
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
        "Usage:\n" +
          "• /addchat <chat_id> — from this DM\n" +
          "• /addchat — sent inside the group you want to add\n\n" +
          "The bot must already be an admin there with 'Invite Users via Link'."
      );
      return;
    }

    // Pull the real title/type from Telegram; also proves the bot can see the
    // chat at all before we start requiring users to join it.
    let title: string | null = null;
    let kind = "group";
    try {
      const chat = await bot.api.getChat(chatId);
      title = "title" in chat ? chat.title ?? null : null;
      kind = chat.type === "channel" ? "channel" : "group";
    } catch (err) {
      await ctx.reply(
        `Could not read chat ${chatId}. Add the bot as an administrator there first, then try again.\n\n${err}`
      );
      return;
    }

    await addRequiredChat(env.DB, chatId, title, kind, ctx.from!.id);

    const link = await mintJoinRequestLink(chatId);
    if (link) await setRequiredChatInviteLink(env.DB, chatId, link);

    await ctx.reply(
      `✅ Added ${title ?? chatId} (${kind}) to the required list.\n\n` +
        (link
          ? `Approval-required invite link (shown to users):\n${link}`
          : "⚠️ Could not create an invite link — give the bot 'Invite Users via Link' admin rights and re-run /addchat. " +
            "Users will not see a link for this chat until then.")
    );
  });

  bot.command("removechat", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;
    const arg = ctx.match?.toString().trim();
    const chatId = arg ? Number(arg) : NaN;
    if (!Number.isInteger(chatId)) {
      await ctx.reply("Usage: /removechat <chat_id>  (see /chats)");
      return;
    }
    const removed = await deactivateRequiredChat(env.DB, chatId);
    await ctx.reply(
      removed
        ? `✅ Removed ${chatId} from the required list.\n\nAlready-verified users keep their status. New users are no longer asked for it.`
        : `${chatId} was not in the active required list.`
    );
  });

  bot.command("chats", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;
    const chats = await listRequiredChats(env.DB, false);
    if (chats.length === 0) {
      await ctx.reply("No required chats configured. Add one with /addchat <chat_id>.");
      return;
    }
    const lines = chats.map(
      (c) =>
        `${c.active ? "🟢" : "⚪"} ${c.chat_id} — ${c.title ?? "(untitled)"} [${c.kind}]` +
        (c.invite_link ? `\n   ${c.invite_link}` : "\n   (no invite link)")
    );
    await ctx.reply(
      `Required chats (${chats.filter((c) => c.active).length} active):\n\n` +
        lines.join("\n") +
        "\n\n🟢 = required now, ⚪ = removed (kept for history)"
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
        `Total registered: ${total}\n` +
        `Verified: ${verified}\n` +
        `Qualified (${qualifyThreshold(env)}+): ${qualified}\n` +
        `Premium paid: ${paid}\n` +
        `Required chats: ${chats.length}\n` +
        `Premium price: ${premiumPriceStars(env)} ⭐`
    );
  });

  bot.command("referrals", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;
    const arg = ctx.match?.toString().trim();
    const targetId = Number(arg);
    if (!arg || !Number.isInteger(targetId)) {
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
        `Premium paid: ${user.premium_paid ? "yes" : "no"}\n` +
        `Direct referrals fetched: ${referrals.length} (verified among these: ${verifiedAmongThem})`
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
    await ctx.reply(link ? `Sent. Link: ${link}` : "Could not issue a link — check that the user has paid and that PREMIUM_GROUP_CHAT_ID is set.");
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

  // Tells admins the chat ID whenever the bot is added somewhere, so adding a
  // new destination never requires hunting for IDs by hand.
  bot.on("my_chat_member", async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status !== "administrator") return;
    const chat = ctx.myChatMember.chat;
    if (chat.type === "private") return;

    const actorId = ctx.myChatMember.from.id;
    if (!isAdmin(env, actorId)) return;

    await bot.api
      .sendMessage(
        actorId,
        `I was made an admin in "${chat.title}" (${chat.type}).\n\n` +
          `To require it for verification:\n/addchat ${chat.id}`
      )
      .catch(() => {});
  });

  return bot;
}
