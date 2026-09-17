export interface Env {
  // Bindings
  DB: D1Database;

  // Secrets (set with `wrangler secret put <NAME>`)
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_EXPORT_TOKEN: string;

  // Plain vars (set in wrangler.toml [vars])
  BOT_USERNAME: string;
  PREMIUM_GROUP_CHAT_ID: string;
  ADMIN_IDS: string;            // comma-separated Telegram numeric user IDs
  QUALIFY_THRESHOLD?: string;   // verified referrals needed to qualify
  PREMIUM_PRICE_STARS?: string; // Telegram Stars charged for premium access
  REFERRAL_REWARD_INR?: string; // rupees credited per counted referral
}

export const DEFAULT_QUALIFY_THRESHOLD = 200;
export const DEFAULT_PREMIUM_PRICE_STARS = 1500;
export const DEFAULT_REFERRAL_REWARD_INR = 10;

/** Parses a positive-integer var, falling back to `fallback` if unset/invalid. */
function positiveIntVar(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function qualifyThreshold(env: Env): number {
  return positiveIntVar(env.QUALIFY_THRESHOLD, DEFAULT_QUALIFY_THRESHOLD);
}

/**
 * Price in Telegram Stars (XTR). Only the positive-integer shape is enforced
 * here; Telegram is the authority on the accepted range and rejects an
 * out-of-range invoice at sendInvoice, which is logged and surfaced to the user
 * as "send /premium again". Clamping locally would silently charge a different
 * amount than configured, which is worse than a visible failure.
 */
export function premiumPriceStars(env: Env): number {
  return positiveIntVar(env.PREMIUM_PRICE_STARS, DEFAULT_PREMIUM_PRICE_STARS);
}

export function referralRewardInr(env: Env): number {
  return positiveIntVar(env.REFERRAL_REWARD_INR, DEFAULT_REFERRAL_REWARD_INR);
}

/**
 * Rupees earned for a given number of counted referrals.
 *
 * The cap is the threshold times the rate (200 x 10 = 2000 by default) rather
 * than a separate number, so the two can never drift apart. Referrals past the
 * threshold add nothing.
 *
 * This is computed from the live count on every read rather than stored as a
 * balance: a referral that later leaves stops counting, and a stored balance
 * would have to be unwound to match. Deriving it means the figure is always
 * consistent with the count it is based on.
 */
export function rewardInr(env: Env, countedReferrals: number): number {
  const capped = Math.min(Math.max(0, countedReferrals), qualifyThreshold(env));
  return capped * referralRewardInr(env);
}

export function rewardCapInr(env: Env): number {
  return qualifyThreshold(env) * referralRewardInr(env);
}
