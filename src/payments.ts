import type { Api, Context } from "grammy";
import type { Env } from "./types";
import { premiumPriceStars } from "./types";
import {
  clearPremiumPayment,
  getUserById,
  markPremiumPaid,
  setPremiumInviteLink,
} from "./db";

const PAYLOAD_PREFIX = "premium:";

/**
 * Invoice payloads are echoed back by Telegram on both pre_checkout_query and
 * successful_payment. Binding the user ID into the payload and re-checking it
 * against the authenticated sender means an invoice minted for one account
 * cannot be forwarded to and paid by another.
 */
export function buildPremiumPayload(userId: number): string {
  return `${PAYLOAD_PREFIX}${userId}`;
}

export function parsePremiumPayload(payload: string): number | null {
  if (!payload.startsWith(PAYLOAD_PREFIX)) return null;
  const id = Number(payload.slice(PAYLOAD_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Telegram chat IDs are numeric; anything else means the var is unconfigured. */
export function premiumChatIdOrNull(env: Env): string | null {
  const raw = (env.PREMIUM_GROUP_CHAT_ID || "").trim();
  return /^-?\d+$/.test(raw) ? raw : null;
}

/**
 * Sends the Telegram Stars invoice for premium access. Callable more than once
 * (e.g. the user runs /premium again after dismissing the first invoice) --
 * paying twice is prevented at pre-checkout, not here.
 */
export async function sendPremiumInvoice(env: Env, api: Api, userId: number): Promise<void> {
  const price = premiumPriceStars(env);
  await api.sendInvoice(
    userId,
    "Premium Opportunity Access",
    `One-time access to the Premium Group. ${price} Telegram Stars.`,
    buildPremiumPayload(userId),
    "XTR",
    // Stars invoices must carry exactly one price component.
    [{ label: "Premium access", amount: price }],
    { provider_token: "" }
  );
}

/**
 * Answers a pre_checkout_query. Telegram gives us ~10 seconds, so every check
 * here is a single indexed lookup. Rejecting with a reason shows that reason to
 * the user in the payment sheet.
 */
export async function handlePreCheckout(env: Env, ctx: Context): Promise<void> {
  const q = ctx.preCheckoutQuery;
  if (!q) return;

  const deny = (reason: string) => ctx.answerPreCheckoutQuery(false, { error_message: reason });

  const payloadUserId = parsePremiumPayload(q.invoice_payload);
  if (payloadUserId === null || payloadUserId !== q.from.id) {
    await deny("This invoice was not issued to your account.");
    return;
  }
  if (q.currency !== "XTR" || q.total_amount !== premiumPriceStars(env)) {
    await deny("This invoice is out of date. Send /premium to get a current one.");
    return;
  }

  const user = await getUserById(env.DB, q.from.id);
  if (!user || !user.qualified) {
    await deny("You have not unlocked the Premium Opportunity yet.");
    return;
  }
  if (user.premium_paid) {
    await deny("You have already paid for premium access.");
    return;
  }

  await ctx.answerPreCheckoutQuery(true);
}

/**
 * Handles successful_payment: records the charge idempotently, then issues the
 * invite link. Only the call that actually flips premium_paid 0->1 mints a
 * link, so a redelivered update cannot produce two links for one payment.
 */
export async function handleSuccessfulPayment(env: Env, api: Api, ctx: Context): Promise<void> {
  const payment = ctx.message?.successful_payment;
  const from = ctx.from;
  if (!payment || !from) return;

  const payloadUserId = parsePremiumPayload(payment.invoice_payload);
  if (payloadUserId !== from.id) {
    console.error(`Payment payload/user mismatch: payload=${payment.invoice_payload} from=${from.id}`);
    return;
  }

  const recorded = await markPremiumPaid(env.DB, from.id, payment.telegram_payment_charge_id);
  if (!recorded) return; // already processed; the user already has their link

  await issuePremiumInviteLink(env, api, from.id);
}

/**
 * Creates the single-use premium invite link and DMs it. Separate from payment
 * recording so it can be retried (/premium, or the admin's /resendpremium)
 * without taking a second payment if Telegram fails at this step.
 */
export async function issuePremiumInviteLink(env: Env, api: Api, userId: number): Promise<string | null> {
  const user = await getUserById(env.DB, userId);
  if (!user || !user.premium_paid) return null;

  if (user.premium_invite_link) {
    await dmInviteLink(api, userId, user.premium_invite_link).catch((err) =>
      console.error(`Failed to re-send premium link to ${userId}:`, err)
    );
    return user.premium_invite_link;
  }

  const chatId = premiumChatIdOrNull(env);
  if (!chatId) {
    console.error("PREMIUM_GROUP_CHAT_ID is not configured; cannot mint invite link.");
    await api
      .sendMessage(
        userId,
        "Your payment went through, but premium access isn't configured yet. " +
          "An admin has been notified and will send your link shortly."
      )
      .catch(() => {});
    await notifyAdmins(
      env,
      api,
      `⚠️ User ${userId} paid for premium but PREMIUM_GROUP_CHAT_ID is unset. Their payment is recorded; ` +
        `set the var, redeploy, then run /resendpremium ${userId}.`
    );
    return null;
  }

  let link: string;
  try {
    const invite = await api.createChatInviteLink(chatId, {
      name: `premium-${userId}`,
      member_limit: 1,
    });
    link = invite.invite_link;
  } catch (err) {
    console.error(`Failed to create premium invite link for ${userId}:`, err);
    await notifyAdmins(env, api, `⚠️ Could not mint a premium invite link for paid user ${userId}: ${err}`);
    return null;
  }

  await setPremiumInviteLink(env.DB, userId, link);
  await dmInviteLink(api, userId, link).catch((err) =>
    console.error(`Failed to DM premium link to ${userId}:`, err)
  );
  return link;
}

async function dmInviteLink(api: Api, userId: number, link: string): Promise<void> {
  await api.sendMessage(
    userId,
    "✅ Payment received. Here is your personal, one-time invitation link to the Premium Group:\n\n" +
      `${link}\n\n` +
      "This link is unique to you and can only be used once."
  );
}

/** Refunds a Stars payment and resets the user's premium state. */
export async function refundPremium(env: Env, api: Api, userId: number): Promise<string> {
  const user = await getUserById(env.DB, userId);
  if (!user) return "No such user.";
  if (!user.premium_paid || !user.premium_charge_id) return "That user has no recorded premium payment.";

  try {
    await api.refundStarPayment(userId, user.premium_charge_id);
  } catch (err) {
    return `Refund failed: ${err}`;
  }

  // Revoke the link before clearing state, otherwise a refunded user keeps a
  // working invite: pay, take the link, refund, keep access.
  let revoked = false;
  const chatId = premiumChatIdOrNull(env);
  if (user.premium_invite_link && chatId) {
    try {
      await api.revokeChatInviteLink(chatId, user.premium_invite_link);
      revoked = true;
    } catch (err) {
      console.error(`Failed to revoke premium link for ${userId}:`, err);
    }
  }

  await clearPremiumPayment(env.DB, userId);
  await api
    .sendMessage(userId, "Your premium payment has been refunded. Your premium invite link is no longer valid.")
    .catch(() => {});
  return (
    `Refunded ${userId}. Their premium state has been reset.\n` +
    (user.premium_invite_link
      ? revoked
        ? "Their invite link has been revoked."
        : "⚠️ Could not revoke their invite link — revoke it manually in the premium chat's invite-link list."
      : "They had no invite link to revoke.") +
    "\nIf they already joined the premium chat, remove them there as well — revoking a link does not remove existing members."
  );
}

export async function notifyAdmins(env: Env, api: Api, text: string): Promise<void> {
  const adminIds = (env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const adminId of adminIds) {
    try {
      await api.sendMessage(Number(adminId), text);
    } catch (err) {
      // An admin may not have started the bot yet -- never let this block flow.
      console.error(`Failed to notify admin ${adminId}:`, err);
    }
  }
}
