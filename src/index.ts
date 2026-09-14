import { webhookCallback } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "./types";
import { createBot } from "./bot";
import { getUsersPage } from "./db";

// Cached across warm invocations of the same isolate so we don't call
// Telegram's getMe on every single webhook request. If the isolate is
// evicted this just gets refetched once on the next cold start.
let cachedBotInfo: UserFromGetMe | undefined;

async function getBot(env: Env) {
  const bot = createBot(env, cachedBotInfo);
  if (cachedBotInfo === undefined) {
    await bot.init();
    cachedBotInfo = bot.botInfo;
  }
  return bot;
}

const CSV_COLUMNS = [
  "telegram_user_id",
  "referral_code",
  "referred_by",
  "username",
  "first_name",
  "contact_shared",
  "group1_request",
  "group2_request",
  "channel_request",
  "verified",
  "verified_at",
  "verified_referral_count",
  "qualified",
  "qualified_at",
  "created_at",
] as const;

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Streams all users as CSV using keyset pagination, so memory use stays
 * constant regardless of whether the table has 1,000 or 1,500,000 rows.
 * Phone numbers are deliberately excluded -- see README for the export
 * approach recommended for that data.
 */
function streamUsersCsv(env: Env): Response {
  const encoder = new TextEncoder();
  const PAGE_SIZE = 1000;

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(CSV_COLUMNS.join(",") + "\n"));
      let afterId = 0;
      for (;;) {
        const page = await getUsersPage(env.DB, afterId, PAGE_SIZE);
        if (page.length === 0) break;

        let chunk = "";
        for (const row of page) {
          chunk += CSV_COLUMNS.map((c) => csvEscape((row as unknown as Record<string, unknown>)[c])).join(",") + "\n";
        }
        controller.enqueue(encoder.encode(chunk));

        afterId = page[page.length - 1].telegram_user_id;
        if (page.length < PAGE_SIZE) break;
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="users-export-${Date.now()}.csv"`,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === `/webhook/${env.WEBHOOK_SECRET}`) {
      const bot = await getBot(env);
      return webhookCallback(bot, "cloudflare-mod")(request);
    }

    if (request.method === "GET" && url.pathname === "/admin/export.csv") {
      const token = request.headers.get("X-Admin-Token");
      if (!token || token !== env.ADMIN_EXPORT_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
      return streamUsersCsv(env);
    }

    return new Response("Not found", { status: 404 });
  },
};
