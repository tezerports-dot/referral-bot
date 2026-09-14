import type { Env } from "./types";

export function isAdmin(env: Env, userId: number | undefined): boolean {
  if (!userId) return false;
  const ids = (env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(String(userId));
}
