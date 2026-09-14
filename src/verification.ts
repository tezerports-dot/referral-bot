import type { Api } from "grammy";
import type { Env } from "./types";
import { getUserById, incrementVerifiedReferralCount, markQualified, tryClaimVerification } from "./db";

/**
 * Call this after any event that could complete a user's verification
 * (contact shared, or any of the three join-request flags set). Safe to
 * call redundantly -- it's a no-op unless this call is the one that
 * actually completes all conditions.
 */
export async function tryVerifyAndQualify(env: Env, api: Api, userId: number): Promise<void> {
  const claimed = await tryClaimVerification(env.DB, userId);
  if (!claimed) return;

  const user = await getUserById(env.DB, userId);
  const referrerId = user?.referred_by;
  if (!referrerId) return; // should be impossible given tryClaimVerification's WHERE clause

  const newCount = await incrementVerifiedReferralCount(env.DB, referrerId);

  if (newCount === 100) {
    await handleQualification(env, api, referrerId);
  }
}

async function handleQualification(env: Env, api: Api, referrerId: number): Promise<void> {
  const referrer = await getUserById(env.DB, referrerId);
  if (!referrer || referrer.qualified) return;

  let inviteLink: string;
  try {
    const invite = await api.createChatInviteLink(env.PREMIUM_GROUP_CHAT_ID, {
      name: `qualified-${referrerId}`,
      member_limit: 1,
    });
    inviteLink = invite.invite_link;
  } catch (err) {
    console.error(`Failed to create premium invite link for ${referrerId}:`, err);
    return; // Leave qualified=0 so this can be retried by a future call.
  }

  const wasNewlyQualified = await markQualified(env.DB, referrerId, inviteLink);
  if (!wasNewlyQualified) return; // someone else's concurrent call already handled this

  try {
    await api.sendMessage(
      referrerId,
      "🎉 Congratulations! You've reached 100 verified referrals and unlocked the Premium Opportunity.\n\n" +
        `Here is your personal, one-time invitation link to the Premium Group:\n${inviteLink}\n\n` +
        "This link is unique to you and can only be used once."
    );
  } catch (err) {
    console.error(`Failed to DM qualified user ${referrerId}:`, err);
  }

  const adminIds = (env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const draft =
    "📢 DRAFT ANNOUNCEMENT (review before posting to the official group/channel)\n\n" +
    `${referrer.first_name ?? "A user"} (id: ${referrerId}) just reached 100 verified referrals ` +
    "and qualified for the Premium Opportunity!";

  for (const adminId of adminIds) {
    try {
      await api.sendMessage(Number(adminId), draft);
    } catch (err) {
      // Admin may not have started the bot yet -- don't let this block qualification.
      console.error(`Failed to notify admin ${adminId}:`, err);
    }
  }
}
