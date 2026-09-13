# Future Plan: Railway → Oracle Cloud Ampere (Always Free)

Keep this for whenever Railway's trial credit runs low, or you just want a
permanent free home instead of paying $5+/month. Oracle's Always Free Ampere
VM (2 OCPU / 12GB RAM) never expires and never bills you as long as you stay
within its limits — a big step up in headroom from the Railway trial's 1GB.

This plan assumes you're moving **from** the Railway combined deployment.
You can go straight to the split (multi-service) setup on Oracle since you'll
have all the RAM for it — no need to stay merged.

---

## Phase 1 — Build the Oracle server (do this anytime, no rush)
Follow **`SETUP_GUIDE.md` Parts 3 and 4** exactly as written:
- Create the Oracle Cloud account + Ampere VM (Part 3)
- Open ports 80/443, install Docker (Part 4)

You can do this days or weeks before you actually move — an idle Oracle VM
costs nothing, so there's no downside to having it ready early.

## Phase 2 — Get a domain ready
Decide now whether you'll use:
- **Free DuckDNS subdomain** (`SETUP_GUIDE.md`'s "Going live" section), or
- **A real domain** you own, pointed at the Oracle VM's IP via an A record.

Either way, get this pointed at the Oracle VM's IP **before** migration day,
so DNS has time to propagate quietly in the background with zero user-facing
impact (the old Railway deployment is still live and unaffected while DNS
propagates — nothing switches over until you update `BOT_WEBHOOK_URL`).

## Phase 3 — Deploy the app on Oracle, but keep it dark
1. Upload/unzip this project on the VM (`SETUP_GUIDE.md` Part 5).
2. Copy `.env.example` to `.env` and fill it in — same values as Railway,
   EXCEPT:
   ```
   MAINTENANCE_MODE=true
   DATABASE_URL=postgresql://referral:referral_password@postgres:5432/referral_platform
   ```
   (this points at the *new*, empty Postgres the docker-compose file will
   create for you — not Railway's).
3. `docker compose up -d --build` (`SETUP_GUIDE.md` Part 7). This starts the
   **split** setup — separate `bot`, `worker`, `web`, `postgres` containers,
   since you have plenty of RAM now. No code changes needed to go from
   Railway's combined mode back to split mode; it's the same codebase.
4. Confirm `docker compose ps` shows everything "Up," but leave
   `MAINTENANCE_MODE=true` — don't register real users yet.

## Phase 4 — Migrate the data
Follow `MIGRATION_GUIDE.md` exactly, with:
- **OLD_DATABASE_URL** = Railway's Postgres connection string (from Railway's
  Postgres service → Variables tab)
- **NEW_DATABASE_URL** = `postgresql://referral:referral_password@YOUR_VM_IP:5432/referral_platform`
  (temporarily expose port 5432 to your own IP only for the migration, or
  run the script *from* the Oracle VM itself over SSH so it's local — safer,
  since you won't need to open the DB port to the internet at all)

## Phase 5 — Add HTTPS and go live
Follow `SETUP_GUIDE.md`'s "Going live with a free subdomain" section (or the
"buy a real domain" variant) to get Certbot + nginx running with HTTPS.
Then:
1. Update `.env`: `BOT_WEBHOOK_URL` and `NEXT_PUBLIC_SITE_URL` → your new
   domain.
2. `docker compose up -d --build` to apply it.
3. Set `MAINTENANCE_MODE=false`, rebuild again.

## Phase 6 — Decommission Railway
Same rule as any migration: don't delete anything for a day. Leave the
Railway service paused (or just stop paying, it'll pause itself) once you've
confirmed the Oracle deployment is stable for 24 hours.

---

## Why this is worth planning even though it's "later"
- Oracle capacity in busy regions (e.g. Mumbai) sometimes shows "Out of host
  capacity" — see `SETUP_GUIDE.md` Part 3 for the workaround (try a
  different region, or switch to Pay-As-You-Go billing which is still $0
  unless you exceed free limits). Worth discovering this *before* you're in
  a hurry, not during a live migration.
- Splitting back into separate services (instead of staying combined) means
  a crash in the bot doesn't take down your website or worker — a real
  reliability upgrade you get "for free" just by having Oracle's extra RAM.
- Because both deployments run from the exact same codebase and the same
  `docker-compose.yml`/Dockerfiles, this move is code-change-free — the only
  moving parts are environment variables, DNS, and the data itself, exactly
  the things `MIGRATION_GUIDE.md` is built to handle safely.
