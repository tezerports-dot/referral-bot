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

export const DEFAULT_QUALIFY_THRESHOLD = 200;
export const DEFAULT_PREMIUM_PRICE_STARS = 200;

/** Parses a positive-integer var, falling back to `fallback` if unset/invalid. */
function positiveIntVar(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function qualifyThreshold(env: Env): number {
  return positiveIntVar(env.QUALIFY_THRESHOLD, DEFAULT_QUALIFY_THRESHOLD);
}

/** Telegram Stars invoices must be between 1 and 2500 XTR. */
export function premiumPriceStars(env: Env): number {
  const n = positiveIntVar(env.PREMIUM_PRICE_STARS, DEFAULT_PREMIUM_PRICE_STARS);
  return Math.min(n, 2500);
}
