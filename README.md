# Referral / Verification Bot

Cloudflare Workers + D1. Users verify by sharing contact and sending join
requests to an **admin-managed list of groups/channels** (any number, changeable
at runtime). **200** verified direct referrals unlock the Premium Opportunity,
which is then purchased with **200 Telegram Stars**.

## Upgrading from the previous version

**This repo auto-deploys.** A Cloudflare Workers Git integration builds every
push; merging to `main` ships to production. Two of the changes below are
breaking, so do them in this order — done in this sequence there is no
downtime, because each step is safe against the version still running.

**1. Migrate the database first.** It only adds tables and columns, so the
currently deployed code keeps working unchanged afterwards.

```bash
npm install
npm test                      # 36 checks, offline, no account needed
npm run db:migrate:remote
```

The migration seeds your three existing chat IDs into the new `required_chats`
table and backfills `join_requests` from the old boolean flags, so nothing
changes for users.

**2. Re-register the webhook, with `secret_token`.** The currently deployed
version ignores the header, so adding it now is harmless; the new version
*requires* it. Doing this before the deploy avoids a window where every update
is rejected.

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook\
?url=https://<your-worker>.workers.dev/webhook/<WEBHOOK_SECRET>\
&secret_token=<WEBHOOK_SECRET>\
&allowed_updates=[\"message\",\"chat_join_request\",\"pre_checkout_query\",\"my_chat_member\"]"
```

`allowed_updates` matters: `chat_join_request` and `my_chat_member` are **not**
delivered by default, and `pre_checkout_query` is needed for Stars payments.
Setting the list replaces it wholesale, so pass every type you need.

**3. Set `PREMIUM_GROUP_CHAT_ID`** in `wrangler.toml` — it ships as
`REPLACE_ME`, and until it holds the real chat ID nobody can receive a premium
invite link. Also confirm `QUALIFY_THRESHOLD` and `PREMIUM_PRICE_STARS`.

**4. Deploy** — merge the PR, or `npm run deploy` directly.

**5. Check `/chats` in a DM to the bot** to confirm the three migrated chats are
listed and active, then `/stats`.

If you deploy before step 1, queries hit columns that do not exist yet. If you
deploy before step 2, the bot rejects every Telegram update until the webhook
is re-registered — recoverable (Telegram retries), but avoidable.

### What changed for operators

`GROUP1_CHAT_ID`, `GROUP2_CHAT_ID` and `CHANNEL_CHAT_ID` no longer exist. The
required list is managed at runtime with `/addchat` and `/removechat` — no
redeploy to change it.

## Managing the required groups and channels

There is no fixed number and no redeploy needed. As an admin, DM the bot:

| Command | Effect |
|---|---|
| `/chats` | List every required chat, active and removed, with invite links |
| `/addchat <chat_id>` | Add (or re-activate) a chat |
| `/addchat` | Same, but sent *inside* the group you want to add |
| `/removechat <chat_id>` | Stop requiring a chat |

When you add a chat the bot calls `getChat` to confirm it can see it, then
mints an **approval-required invite link** itself (`creates_join_request`) and
shows that link to users on `/start` and `/status`. You never have to create or
circulate links by hand — which also closes the old failure mode where a
normal invite link leaking let people skip verification.

The bot must be an administrator in the chat with **Invite Users via Link**
before `/addchat` will work. Add it as an admin and it will DM you the chat ID
and a ready-to-paste `/addchat` command automatically.

### What happens when you rotate the list

- **Adding** a chat immediately applies to everyone not yet verified. Users who
  are **already verified stay verified** — verification is sticky, so rotating
  the list never wipes out earned referral counts.
- **Removing** a chat stops it being required immediately. The row is kept
  (shown as ⚪ in `/chats`), never deleted.
- **Re-adding** a chat restores every user's earlier progress for it, because
  join requests are recorded per `(user, chat)` independently of the current
  list.
- An **empty** list verifies nobody. This is deliberate — a bug that cleared
  the list would otherwise verify your entire user base at once.

## How verification works

A user becomes verified only when a single atomic `UPDATE` finds all of:

- they arrived through someone's referral link (`referred_by IS NOT NULL`)
- they shared their contact, and that phone number is not linked to any other
  account
- they have a join request recorded for **every currently active** required chat

Every condition is evaluated inside that one statement (`tryClaimVerification`
in `src/db.ts`), so there is no read-then-write window for a concurrent webhook
delivery to slip through. Only the call that actually flips `verified` 0→1
returns true, and only that call credits the referrer — which is what makes
Telegram's webhook retries safe.

Users can check where they stand at any time with `/status`.

## Premium: 200 referrals, 200 Stars

At `QUALIFY_THRESHOLD` verified referrals the referrer is marked qualified and
sent a Telegram Stars invoice for `PREMIUM_PRICE_STARS`. On successful payment
the bot mints a **single-use** invite link to `PREMIUM_GROUP_CHAT_ID` and DMs
it. Admins get a draft announcement to review — it is never auto-posted.

Both numbers are `[vars]` in `wrangler.toml`; change them and redeploy.

Qualification is claimed with `verified_referral_count >= threshold` inside the
same statement that sets the flag, so a count that overshoots the threshold (a
racing increment, a manual correction, a threshold you later lower) still
qualifies instead of being stranded. Payment is recorded idempotently against
the Telegram charge ID, so a redelivered `successful_payment` update cannot
mint a second invite link.

If link creation fails after a successful payment, the payment stays recorded
and admins are notified; `/premium` (user) or `/resendpremium <id>` (admin)
retries delivery without charging again.

## Admin commands

| Command | Effect |
|---|---|
| `/stats` | Registered / verified / qualified / paid counts, required-chat count, price |
| `/referrals <user_id>` | One user's count, qualified and paid status, direct referrals |
| `/chats`, `/addchat`, `/removechat` | Manage the required list (above) |
| `/resendpremium <user_id>` | Re-issue a paid user's invite link |
| `/refund <user_id>` | Refund their Stars payment and reset their premium state |

Plus `GET /admin/export.csv` with header `X-Admin-Token: <ADMIN_EXPORT_TOKEN>`:

```bash
curl -H "X-Admin-Token: <your token>" \
  "https://<your-worker>.workers.dev/admin/export.csv" -o users-export.csv
```

Keyset pagination internally, so memory stays flat at ~1.5M rows. **Phone
numbers are excluded by design.** Values that begin with `=`, `+`, `-` or `@`
are quoted so Excel and Sheets cannot execute them as formulas.

For full raw backups use Cloudflare's own dump instead, no Worker involved:

```bash
npx wrangler d1 export referral_bot_db --remote --output=backup.sql
```

## Fresh install

1. `npm install && npx wrangler login`
2. `npx wrangler d1 create referral_bot_db`, copy the `database_id` into
   `wrangler.toml`
3. `npm run db:init:remote`
4. Set `[vars]`: `BOT_USERNAME`, `ADMIN_IDS`, `PREMIUM_GROUP_CHAT_ID`,
   `QUALIFY_THRESHOLD`, `PREMIUM_PRICE_STARS`
5. Secrets — never put these in `wrangler.toml`:
   ```bash
   npx wrangler secret put BOT_TOKEN           # from @BotFather
   npx wrangler secret put WEBHOOK_SECRET      # openssl rand -hex 24
   npx wrangler secret put ADMIN_EXPORT_TOKEN  # openssl rand -hex 24
   ```
6. `npm run deploy`
7. Register the webhook (see the `curl` under *Upgrading*, step 2)
8. Add the bot as an admin to each group/channel, then `/addchat` each one

## Hardening notes

- Verification and qualification are each a single atomic statement — no
  check-then-act races.
- One phone number verifies at most one account, enforced by a partial unique
  index as well as in the `UPDATE`'s `WHERE` clause.
- Invoice payloads carry the buyer's user ID and are re-checked against the
  authenticated sender at pre-checkout, so an invoice cannot be paid by a
  different account.
- Webhook requests must match both the secret in the URL path and Telegram's
  `X-Telegram-Bot-Api-Secret-Token` header. Both comparisons are
  length-independent, as is the admin export token check.
- All bot replies are sent as plain text with no `parse_mode`, so
  attacker-controlled chat titles and names cannot inject markup.
- Required-chat mutations are admin-only and go through `getChat` first.

## Testing

```bash
npm test          # 36 assertions against real SQLite, offline
npm run typecheck
```

`tests/sql.test.mjs` runs the atomic statements from `src/db.ts` against
in-memory SQLite, covering rotation, grandfathering, the empty-list guard,
webhook-retry double-claims, phone reuse, and threshold overshoot.
`tests/migration.test.mjs` applies the migration to a populated v1 database and
checks nothing is lost. Both assert the SQL still matches `src/db.ts`, so they
fail if the source drifts.

## Not built

- **Aadhaar collection.** Requested, not implemented — see the note below.
- **No web dashboard.** Admin access is bot commands plus the CSV endpoint.

### On the Aadhaar requirement

A Telegram bot cannot verify that an Aadhaar number is real or that it belongs
to the person typing it. Aadhaar authentication and offline eKYC are only
available to entities licensed by UIDAI, so a free-text form would collect the
numbers without validating any of them — it would not establish the identity
link it is meant to establish.

Storing the numbers is the bigger problem. UIDAI requires Aadhaar numbers to be
held encrypted in a reference-keyed Aadhaar Data Vault by entities permitted to
store them at all, and *Puttaswamy* (2018) struck down the provision that let
private companies demand Aadhaar as a condition of service. A plaintext column
of Aadhaar numbers next to phone numbers and names is also a standing
identity-fraud risk for the users in it.

The workable shape, if you need real KYC, is a licensed provider (DigiLocker
offline eKYC, or a KYC vendor such as Signzy, Digio, Karza or HyperVerge): the
user completes verification on the provider's flow, and the bot stores only
`kyc_verified` plus the provider's reference ID — never the Aadhaar number.
That gates verification exactly as intended without the bot ever holding the
number. The verification gate in `src/db.ts` is already a single atomic
statement, so adding one more condition to it is a small change.
