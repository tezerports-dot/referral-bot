export interface Env {
  // Bindings
  DB: D1Database;

  // Secrets (set with `wrangler secret put <NAME>`)
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_EXPORT_TOKEN: string;

  // Plain vars (set in wrangler.toml [vars])
  BOT_USERNAME: string;
  GROUP1_CHAT_ID: string;
  GROUP2_CHAT_ID: string;
  CHANNEL_CHAT_ID: string;
  PREMIUM_GROUP_CHAT_ID: string;
  ADMIN_IDS: string; // comma-separated Telegram numeric user IDs
}
