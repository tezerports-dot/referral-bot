import type { Api } from "grammy";
import type { Env } from "./types";
import { qualifyThreshold, referralRewardInr } from "./types";
import {
  decrementVerifiedReferralCount,
  getMissingRequiredChats,
  getUserById,
  incrementVerifiedReferralCount,
  markJoinMember,
  tryClaimQualification,
  tryClaimVerification,
  tryRevokeVerification,
} from "./db";
import { notifyAdmins, sendPremiumInvoice } from "./payments";

/**
 * What a Telegram chat-member status says about being in the chat right now.
 *
 *   present  in the chat
 *   gone     not in the chat (left, or removed/banned)
 *   unknown  says nothing reliable -- a restricted user who is not a member may
 *            or may not have a pending request, so the stored state is kept
 *
 * Takes the structural bits of a ChatMember so it serves both a chat_member
 * update and a getChatMember reply.
 */
export function membershipOf(m: { status: string; is_member?: boolean }): "present" | "gone" | "unknown" {
  switch (m.status) {
    case "creator":
    case "administrator":
    case "member":
      return "present";
    case "restricted":
      return m.is_member ? "present" : "unknown";
    case "left":
    case "kicked":
      return "gone";
    default:
      return "unknown";
  }
}

/**
 * Asks Telegram whether the user is already IN each required chat the database
 * says they have not satisfied, and records the ones they are.
 *
 * This is what makes someone who was a member before the bot began tracking
 * them (or whose chat_member update was never delivered) count, instead of
 * being told to join a chat they are already in. Two properties keep it safe:
 *
 *  - It only ever ADDS membership. A "left" reply is ambiguous -- Telegram gives
 *    the same status to a user with a pending request and to one who never
 *    asked -- so it changes nothing, and an existing pending row is kept.
 *  - A failed lookup (bot not admin, chat unreachable, Telegram down) proves
 *    nothing, so it is logged and treated as "not satisfied", never as a pass.
 *
 * Chats already satisfied cost no API call, so a user with nothing missing
 * costs nothing. It is not run from the chat_member / chat_join_request
 * handlers, which fire for every membership change and already carry exact
 * state.
 */
export async function reconcileMembership(env: Env, api: Api, userId: number): Promise<void> {
  const missing = await getMissingRequiredChats(env.DB, userId);
  if (missing.length === 0) return;

  await Promise.all(
    missing.map(async (chat) => {
      // Stamped from before the question is asked: the answer can be no newer
      // than that, so a departure Telegram reports after this moment still wins.
      const observedAt = Math.floor(Date.now() / 1000);
      try {
        const member = await api.getChatMember(chat.chat_id, userId);
        if (membershipOf(member) === "present") {
          await markJoinMember(env.DB, userId, chat.chat_id, observedAt);
        }
      } catch (err) {
        console.error(`getChatMember failed for user ${userId} in chat ${chat.chat_id}:`, err);
      }
    })
  );
}

/**
 * Call this after any event that could change whether a user meets every
 * requirement: contact shared, a join request sent, membership gained or lost.
 * It moves verification in whichever direction the current state calls for, and
 * is a no-op unless this specific call is the one that flips it.
 *
 * `reconcile` additionally checks Telegram for chats the database thinks are
 * unsatisfied. Pass it from paths the user drives themselves (/start, sharing a
 * contact, tapping Verify); leave it off for webhook-driven paths.
 *
 * Qualification is deliberately NOT revoked when a count falls back below the
 * threshold: premium access, once paid for, stays paid for. The rupee figure
 * is derived from the live count instead, so it falls on its own.
 */
export async function tryVerifyAndQualify(
  env: Env,
  api: Api,
  userId: number,
  opts: { reconcile?: boolean } = {}
): Promise<void> {
  if (opts.reconcile) await reconcileMembership(env, api, userId);

  const claim = await tryClaimVerification(env.DB, userId);
  if (claim.changed) {
    await creditReferrer(env, api, claim.referredBy, +1);
    return;
  }

  // Not newly verified. They may instead have just stopped qualifying -- they
  // no longer have a pending request or membership somewhere. Revoking is the
  // exact mirror of claiming and is equally single-shot, so only one caller
  // ever takes the credit back.
  const revoke = await tryRevokeVerification(env.DB, userId);
  if (revoke.changed) await creditReferrer(env, api, revoke.referredBy, -1);
}

/**
 * Moves the referrer's counted total by one in either direction.
 *
 * The referrer id comes from the RETURNING clause of the statement that just
 * flipped verification, so no extra read is needed -- and it is necessarily the
 * value as of that flip, which a follow-up SELECT could not guarantee. A user
 * with no referrer is simply a no-op: referrals are optional.
 */
async function creditReferrer(
  env: Env,
  api: Api,
  referrerId: number | null,
  delta: 1 | -1
): Promise<void> {
  if (!referrerId) return;

  if (delta === -1) {
    await decrementVerifiedReferralCount(env.DB, referrerId);
    return;
  }

  await incrementVerifiedReferralCount(env.DB, referrerId);

  // Re-checked on every increment rather than on an exact threshold match, so a
  // referrer who somehow passes the threshold without this branch running (a
  // racing increment, a manual correction, a count that dipped and recovered)
  // still qualifies on their next referral instead of being stranded.
  const newlyQualified = await tryClaimQualification(
    env.DB,
    referrerId,
    qualifyThreshold(env),
    referralRewardInr(env)
  );
  if (newlyQualified) await announceQualification(env, api, referrerId);
}

async function announceQualification(env: Env, api: Api, referrerId: number): Promise<void> {
  const referrer = await getUserById(env.DB, referrerId);
  const threshold = qualifyThreshold(env);

  try {
    await api.sendMessage(
      referrerId,
      `🎉 Congratulations! You've reached ${threshold} verified referrals and unlocked the Premium Opportunity.\n\n` +
        "Complete the one-time payment below to receive your personal invite link to the Premium Group.\n\n" +
        "You can always return to this with /premium."
    );
    await sendPremiumInvoice(env, api, referrerId);
  } catch (err) {
    // Qualification stays recorded either way -- the user can run /premium to
    // get a fresh invoice, and an admin can run /resendpremium.
    console.error(`Failed to send premium invoice to ${referrerId}:`, err);
  }

  const draft =
    "📢 DRAFT ANNOUNCEMENT (review before posting to the official group/channel)\n\n" +
    `${referrer?.first_name ?? "A user"} (id: ${referrerId}) just reached ${threshold} verified referrals ` +
    "and qualified for the Premium Opportunity!";

  await notifyAdmins(env, api, draft);
}
