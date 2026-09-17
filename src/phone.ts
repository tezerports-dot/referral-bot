/**
 * Phone numbers reach us from three places that format them differently:
 * Telegram's `contact.phone_number` (usually bare digits, sometimes "+"),
 * a forwarded contact card, and a number the user typed by hand. They all have
 * to compare equal, so everything is reduced to digits before it is stored or
 * looked up.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  // Shortest plausible international number is ~7 digits; E.164 caps at 15.
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/**
 * The national part of a number.
 *
 * Nothing reads this today: referrers are set by referral link only, so there
 * is no lookup-by-phone path. The column is still populated so it never goes
 * stale, and dropping it would mean a destructive migration on a live database
 * for no gain. It is here if a phone lookup is ever wanted again.
 */
export function phoneTail(normalized: string | null): string | null {
  if (!normalized) return null;
  return normalized.length >= 10 ? normalized.slice(-10) : normalized;
}
