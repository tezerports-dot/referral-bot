# Referral / Verification Bot

Cloudflare Workers + D1, built to the spec: 100 verified direct referrals per
user unlocks the Premium Opportunity, verification requires contact-sharing
plus join requests to Group 1, Group 2, and the Channel.

## 0. Prerequisites

- Node.js 18+ installed locally
- A free Cloudflare account (https://dash.cloudflare.com/sign-up)
- Your bot token from @BotFather
- Your own numeric Telegram user ID, from **@userinfobot** (you'll need this for admin commands)

## 1. Install

```bash
cd referral-bot
npm install
npx wrangler login
```

`wrangler login` opens a browser to connect your Cloudflare account.

## 2. Create the D1 database

```bash
npx wrangler d1 create referral_bot_db
```

This prints a `database_id`. Copy it into `wrangler.toml`, replacing
`REPLACE_AFTER_RUNNING_wrangler_d1_create`.

## 3. Apply the schema

```bash
npm run db:init:remote
```

(`npm run db:init` targets your local dev database instead, if you want to
test with `wrangler dev` first.)

## 4. Set the plain config values

Edit `wrangler.toml` `[vars]`:

- `BOT_USERNAME` — your bot's username, no `@` (used to build referral links)
- `ADMIN_IDS` — your numeric Telegram ID(s), comma-separated if more than one

Leave `GROUP1_CHAT_ID`, `GROUP2_CHAT_ID`, `CHANNEL_CHAT_ID`, and
`PREMIUM_GROUP_CHAT_ID` as `REPLACE_ME` for now — see step 7.

## 5. Set secrets

These must never go in `wrangler.toml` since that file can end up in git.

```bash
npx wrangler secret put BOT_TOKEN
# paste your BotFather token when prompted

npx wrangler secret put WEBHOOK_SECRET
# paste a random string, e.g. generate one with: openssl rand -hex 24

npx wrangler secret put ADMIN_EXPORT_TOKEN
# paste another random string (protects the CSV export endpoint)
```

## 6. Deploy

```bash
npm run deploy
```

Note the `https://referral-bot.<your-subdomain>.workers.dev` URL it prints.

## 7. Set up the three Telegram destinations

For **Group 1**, **Group 2**, and the **Channel**:

1. Make each one private (no public @username).
2. Create an invite link with **"Request Admin Approval"** turned on
   (Manage Chat → Invite Links → Create New Link). This is what makes
   Telegram fire `chat_join_request` events — privacy alone doesn't.
3. Add your bot as an admin with **"Invite Users via Link"** permission
   (full admin is simplest while you're setting this up).
4. Copy each chat's numeric ID (forward any message from the chat to
   **@userinfobot**, or check `chat.id` in the bot's logs after adding it).
5. Put those three IDs into `wrangler.toml` `[vars]`, and your **Premium
   Group**'s chat ID into `PREMIUM_GROUP_CHAT_ID` (the bot needs admin
   there too, to generate personal invite links later).
6. Re-deploy: `npm run deploy`.

Only ever share the one approval-required invite link per chat with users —
if a different, non-approval link leaks, it lets people bypass verification.

## 8. Register the webhook with Telegram

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/webhook/<WEBHOOK_SECRET>"
```

Replace `<BOT_TOKEN>`, `<your-worker>`, and `<WEBHOOK_SECRET>` with your
actual values. You should get back `{"ok":true,"result":true,...}`.

## 9. Test it

1. DM your bot `/start` — you should get the welcome message with your
   referral link and a "Share my contact" button.
2. Tap the button.
3. Send join requests to Group 1, Group 2, and the Channel via their
   approval-required links.
4. You should now be `verified` in the database. Test the referral chain
   by opening your `https://t.me/<bot>?start=<code>` link from a second
   Telegram account and repeating steps 1-3.
5. As an admin, DM the bot `/stats` and `/referrals <telegram_user_id>` to
   confirm counts are updating.

## Admin tools

- `/stats` — total registered, verified, qualified counts
- `/referrals <telegram_user_id>` — a user's verified count, qualified
  status, and their direct referrals
- `GET /admin/export.csv` (header `X-Admin-Token: <ADMIN_EXPORT_TOKEN>`) —
  streams every user as CSV:

  ```bash
  curl -H "X-Admin-Token: <your token>" \
    "https://<your-worker>.workers.dev/admin/export.csv" \
    -o users-export.csv
  ```

  This uses keyset pagination internally so it scales to the full ~1.5M
  users without loading them all into memory at once — Excel and Google
  Sheets both open CSV natively, so this covers the "Excel-compatible
  export" requirement directly.

### A note on full-database exports and true `.xlsx`

Building a real `.xlsx` workbook (not CSV) for ~1.5M rows inside a Worker
isn't a good idea on the free tier — Workers have a per-request memory/CPU
budget, and holding a spreadsheet that size in memory risks hitting it.
Two better options when you specifically need `.xlsx` rather than CSV:

1. Pull the CSV via the endpoint above, then convert locally with a small
   Node script (a few lines with the `xlsx` npm package) — happy to write
   that script whenever you want it.
2. For full raw backups, `wrangler d1 export referral_bot_db --remote
   --output=backup.sql` dumps the whole database directly from Cloudflare's
   side, no Worker involved.

## What's intentionally not built yet

- The **Premium Group** invite link generation, referrer DM, and admin
  draft-announcement all fire automatically at 100 verified referrals —
  but the announcement is only drafted and sent to admins, never
  auto-posted, per the spec.
- No web dashboard — admin access is via bot commands and the CSV
  endpoint. Say the word if you'd like a small password-protected HTML
  dashboard on top of these same D1 queries.
