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
}

export const DEFAULT_QUALIFY_THRESHOLD = 100;
export const DEFAULT_PREMIUM_PRICE_STARS = 1500;

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
