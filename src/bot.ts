import { Bot, InlineKeyboard } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "./types";
import { premiumPriceStars, qualifyThreshold } from "./types";
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
  getRequiredChatsWithStatus,
  getUserById,
  getUserByReferralCode,
  invalidateRequiredChatCache,
  getChatPolicy,
  isRequiredChatCached,
  setChatAutoApprove,
  listRequiredChats,
  markJoinEnded,
  markJoinMember,
  recordJoinRequest,
  setContactShared,
  setRequiredChatInviteLink,
  type RequiredChatRow,
  type UserRow,
} from "./db";
import { membershipOf, tryVerifyAndQualify } from "./verification";
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
  // One query returns every active chat and whether this user is in it; the
  // caller needs both, and both come from the same rows.
  const chats = await getRequiredChatsWithStatus(env.DB, user.telegram_user_id);
  const missing = chats.filter((c) => !c.satisfied);
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
    "An admin reviews each join request. You do not need to wait for that — tap “✅ Verify me” as soon as you have sent them.",
    "",
    `Your referral link:\nhttps://t.me/${env.BOT_USERNAME}?start=${user.referral_code}`,
  ];
  return { text: lines.filter((l) => l !== null).join("\n").trim(), kb: stepsKeyboard(chats, needsContact) };
}

/** Plain-text summary of where a user stands. */
async function progressText(env: Env, userId: number, preloaded?: UserRow | null): Promise<string> {
  // Callers that already hold the row pass it in rather than paying for a
  // second read of a value they just fetched.
  const user = preloaded ?? (await getUserById(env.DB, userId));
  if (!user) return "Send /start first.";

  const threshold = qualifyThreshold(env);
  if (user.verified) {
    const remaining = Math.max(0, threshold - user.verified_referral_count);
    return (
      "✅ You are verified.\n\n" +
      `Counted referrals: ${user.verified_referral_count} / ${threshold}\n` +
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

    // The only way to be credited to a referrer: their ?start=<code> link.
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
    await tryVerifyAndQualify(env, bot.api, from.id, { reconcile: true });

    const fresh = (await getUserById(env.DB, from.id)) ?? user;

    // Returning user who is already through the funnel gets the menu.
    if (fresh.verified) {
      await ctx.reply(
        `Welcome back, ${displayName(fresh)}.\n\nWhat would you like to see?`,
        { reply_markup: menuKeyboard(fresh) }
      );
      return;
    }

    // Referral is optional and link-only: arriving through someone's link sets
    // the referrer, arriving directly leaves it unset. Either way the next step
    // is identical, so nobody is stopped to answer a question first.
    const referrer = fresh.referred_by ? await getUserById(env.DB, fresh.referred_by) : null;
    const { text, kb } = await stepsMessage(
      env,
      fresh,
      referrer ? `✅ Referred by ${displayName(referrer)}.\n` : ""
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

  /** Sends the full steps message to a user. */
  async function sendSteps(ctx: { reply: (t: string, o?: object) => Promise<unknown> }, userId: number, prefix: string) {
    const user = await getUserById(env.DB, userId);
    if (!user) return;
    const { text, kb } = await stepsMessage(env, user, prefix);
    await ctx.reply(text, { reply_markup: kb });
  }

  bot.on("message:text", async (ctx, next) => {
    const from = ctx.from;
    const text = ctx.message.text.trim();
    if (!from || !priv(ctx) || text.startsWith("/")) return next();

    const user = await getUserById(env.DB, from.id);
    if (!user) {
      await ctx.reply("Send /start first.");
      return;
    }
    await ctx.reply(await progressText(env, from.id, user));
  });

  // ---- Contact sharing ----

  bot.on("message:contact", async (ctx) => {
    const from = ctx.from;
    const contact = ctx.message.contact;
    if (!from || !contact || !priv(ctx)) return;

    // No pre-read of the user here: setContactShared reports "no_user" for an
    // unregistered sender, so fetching the row first would only duplicate it.
    // The request_contact button always attaches the sender's own contact.
    // Anything else -- a forwarded contact card -- is rejected: a referrer can
    // only ever be set by arriving through a referral link.
    if (contact.user_id !== from.id) {
      await ctx.reply("Please use the button below to share your own contact.");
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

    await tryVerifyAndQualify(env, bot.api, from.id, { reconcile: true });
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
        await tryVerifyAndQualify(env, bot.api, from.id, { reconcile: true });
        const fresh = await getUserById(env.DB, from.id);
        if (fresh?.verified) {
          await ctx.answerCallbackQuery({ text: "✅ Verified!", show_alert: false });
          await ctx.reply("✅ You are verified!", { reply_markup: menuKeyboard(fresh) });
        } else {
          await ctx.answerCallbackQuery({ text: "Not complete yet — see below.", show_alert: false });
          await ctx.reply(await progressText(env, from.id, fresh));
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
            `Needed for premium: ${threshold}\n` +
            (user.qualified ? "Status: unlocked ⭐" : `Still needed: ${remaining}`) +
            "\n\nOnly people who stay in every required channel are counted. " +
            "If someone leaves, they stop counting."
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
          await ctx.reply(await progressText(env, from.id, user));
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

  // ---- Join requests: recorded here, approved by a human ----
  //
  // The bot NEVER approves a join request. A Telegram admin approves or rejects
  // each one. Sending the request is what satisfies this bot's requirement -- a
  // pending request counts -- so the user can verify (and their referrer is
  // credited) without waiting for that decision.

  bot.on("chat_join_request", async (ctx) => {
    const req = ctx.chatJoinRequest;
    const policy = await getChatPolicy(env.DB, req.chat.id);
    if (!policy.required) return;

    // A chat an admin designated with /autojoin approves every request itself,
    // including from people who never opened the bot. This is the only place
    // the bot approves anything; every other chat keeps the manual rule below.
    if (policy.autoApprove) {
      try {
        await bot.api.approveChatJoinRequest(req.chat.id, req.from.id);
      } catch (err) {
        console.error(`/autojoin: failed to approve join request from ${req.from.id}:`, err);
      }
      // Recorded regardless, so this chat's requirement is satisfied exactly as
      // a pending request would satisfy it. join_requests is keyed on the user
      // id and independent of registration, so a row written now still counts
      // if that person opens the bot later.
      await recordJoinRequest(env.DB, req.from.id, req.chat.id, req.date);
      await tryVerifyAndQualify(env, bot.api, req.from.id);
      return;
    }

    const user = await getUserById(env.DB, req.from.id);

    // Anyone who did not onboard through the bot is turned away, which is what
    // makes the bot the only route into these chats even if a link leaks. This
    // is the one automatic decision the bot still takes, and it is a refusal:
    // nothing here approves anyone.
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
            "Your request was declined because it did not come through the bot."
        )
        .catch(() => {});
      return;
    }

    await recordJoinRequest(env.DB, req.from.id, req.chat.id, req.date);
    // Runs even when the row was already recorded: if an earlier delivery wrote
    // it and then failed before verifying, Telegram's retry must still finish
    // the job. Verification is single-shot, so re-running it is harmless.
    await tryVerifyAndQualify(env, bot.api, req.from.id);
  });

  // ---- Membership changes: keeps "actual member" in step with Telegram ----
  //
  // Needs "chat_member" in the webhook's allowed_updates AND the bot to be an
  // admin of the chat, or Telegram never sends these. This is for TRACKING
  // membership (an approval, a departure); verification does not wait for it.

  bot.on("chat_member", async (ctx) => {
    const upd = ctx.chatMember;
    if (!(await isRequiredChatCached(env.DB, upd.chat.id))) return;

    const userId = upd.new_chat_member.user.id;
    const presence = membershipOf(upd.new_chat_member);
    if (presence === "unknown") return; // leave the stored state as-is

    const changed =
      presence === "present"
        ? await markJoinMember(env.DB, userId, upd.chat.id, upd.date)
        : await markJoinEnded(env.DB, userId, upd.chat.id, upd.date);
    if (!changed) return;

    // Re-evaluates in whichever direction the new state calls for: a departure
    // revokes verification and takes the referrer's credit back, a rejoin
    // restores both. Approving a pending request only turns 'pending' into
    // 'member' -- both satisfy -- so it changes nothing the referrer sees.
    await tryVerifyAndQualify(env, bot.api, userId);
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
        "Usage:\n• /addchat <chat_id> — from this DM (always use this form for a channel)\n• /addchat — sent inside a group you want to add\n\n" +
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
    invalidateRequiredChatCache();
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
    invalidateRequiredChatCache();
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
              (c.auto_approve ? "  ⚡ auto-approve" : "") +
              (c.invite_link ? `\n   ${c.invite_link}` : "\n   (no invite link)")
          )
          .join("\n")
    );
  });

  // ---- Admin: stats and support ----

  bot.command("autojoin", async (ctx) => {
    if (!isAdmin(env, ctx.from?.id)) return;

    const parts = (ctx.match?.toString().trim() ?? "").split(/\s+/).filter(Boolean);
    const mode = parts[0]?.toLowerCase();
    const inTargetChat = ctx.chat && ctx.chat.type !== "private";

    if (mode !== "on" && mode !== "off") {
      const chats = await listRequiredChats(env.DB, true);
      const on = chats.filter((c) => c.auto_approve);
      await ctx.reply(
        "Auto-approve join requests for one designated chat.\n\n" +
          "/autojoin on <chat_id>\n" +
          "/autojoin off <chat_id>\n" +
          "(or send /autojoin on inside the chat itself)\n\n" +
          (on.length
            ? "Currently on for:\n" + on.map((c) => `⚡ ${c.chat_id} — ${c.title ?? "(untitled)"}`).join("\n")
            : "Currently off for every chat — all join requests wait for an admin.") +
          "\n\nEvery other chat keeps the normal rule: requests are recorded and left " +
          "pending for you, and anyone who did not come through the bot is declined."
      );
      return;
    }

    // Second word is the chat id; without one, the chat this was sent in.
    const chatId = parts[1] ? Number(parts[1]) : inTargetChat ? ctx.chat!.id : NaN;
    if (!Number.isInteger(chatId)) {
      await ctx.reply("Usage: /autojoin on <chat_id>   (see /chats for the ids)");
      return;
    }

    const changed = await setChatAutoApprove(env.DB, chatId, mode === "on");
    invalidateRequiredChatCache();
    if (!changed) {
      await ctx.reply(`${chatId} is not in the active required list. Add it with /addchat first, then retry.`);
      return;
    }

    await ctx.reply(
      mode === "on"
        ? `⚡ /autojoin is ON for ${chatId}.\n\n` +
            "Every join request to that chat is now approved by the bot immediately, " +
            "including from people who never opened the bot.\n\n" +
            "Your other chats are unchanged: their requests are still recorded and left " +
            "pending for you, and non-bot users are still declined."
        : `/autojoin is OFF for ${chatId}.\n\n` +
            "Its join requests go back to waiting for an admin, and non-bot users are declined again."
    );
  });

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
