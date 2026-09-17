import type { Api } from "grammy";
import type { Env } from "./types";
import { qualifyThreshold, referralRewardInr } from "./types";
import {
  decrementVerifiedReferralCount,
  getUserById,
  incrementVerifiedReferralCount,
  tryClaimQualification,
  tryClaimVerification,
  tryRevokeVerification,
} from "./db";
import { notifyAdmins, sendPremiumInvoice } from "./payments";

/**
 * Call this after any event that could change whether a user meets every
 * requirement: contact shared, a referrer set, a join request approved, or a
 * membership lost. It moves verification in whichever direction the current
 * state calls for, and is a no-op unless this specific call is the one that
 * flips it.
 *
 * Qualification is deliberately NOT revoked when a count falls back below the
 * threshold: premium access, once paid for, stays paid for. The rupee figure
 * is derived from the live count instead, so it falls on its own.
 */
export async function tryVerifyAndQualify(env: Env, api: Api, userId: number): Promise<void> {
  const claim = await tryClaimVerification(env.DB, userId);
  if (claim.changed) {
    await creditReferrer(env, api, claim.referredBy, +1);
    return;
  }

  // Not newly verified. They may instead have just stopped qualifying -- a
  // membership they had is gone. Revoking is the exact mirror of claiming and
  // is equally single-shot, so only one caller ever takes the credit back.
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
