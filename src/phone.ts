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
 * The national part, used as a fallback when someone types "9876543210" but
 * their referrer registered as "+919876543210". Matching on this is only ever
 * accepted when it resolves to exactly one account -- see getUserByPhone.
 */
export function phoneTail(normalized: string | null): string | null {
  if (!normalized) return null;
  return normalized.length >= 10 ? normalized.slice(-10) : normalized;
}
