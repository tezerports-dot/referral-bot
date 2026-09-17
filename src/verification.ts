import type { Api } from "grammy";
import type { Env } from "./types";
import { qualifyThreshold } from "./types";
import {
  getUserById,
  incrementVerifiedReferralCount,
  tryClaimQualification,
  tryClaimVerification,
} from "./db";
import { notifyAdmins, sendPremiumInvoice } from "./payments";

/**
 * Call this after any event that could complete a user's verification (contact
 * shared, a referrer being set, or a join request to any active required
 * chat). Safe to call redundantly -- it is a no-op unless this specific call
 * is the one that completes every condition.
 */
export async function tryVerifyAndQualify(env: Env, api: Api, userId: number): Promise<void> {
  const claimed = await tryClaimVerification(env.DB, userId);
  if (!claimed) return;

  const user = await getUserById(env.DB, userId);
  const referrerId = user?.referred_by;

  // An organic user with no referrer is fully verified at this point; there is
  // simply nobody to credit. Referrals only matter for the premium threshold.
  if (!referrerId) return;

  await incrementVerifiedReferralCount(env.DB, referrerId);

  // Re-checked on every increment rather than on an exact threshold match, so a
  // referrer who somehow passes the threshold without this branch running (a
  // racing increment, a manual DB correction, a raised-then-lowered threshold)
  // still qualifies on their next referral instead of being stranded.
  const newlyQualified = await tryClaimQualification(env.DB, referrerId, qualifyThreshold(env));
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
