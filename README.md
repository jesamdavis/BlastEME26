# BlastEME

A fast, provider-aware **bulk email sender** for revenue drops to proven,
already-profiled segments (Athleta openers, Alo engagers, 5K–20K at a time).

**SEME is the brain and data center. BlastEME is just a sender.**
Every click, open, suppression, unsubscribe, and engagement stat flows into
SEME's database. BlastEME owns nothing but the fast send loop.

## What it does
1. Pulls a tagged segment from SEME's `users`, applying active-status,
   exclusion-tag and suppression-list safety filters. Its cross-lane cooldown
   defaults to **enabled for 24 hours** and reads all `email_logs.sent_at`, so a
   BlastEME send normally cannot duplicate a recent SEME or BlastEME send.
2. **Interleaves by provider** so no single provider (e.g. Gmail) gets a flood
   in one window (throttle protection).
3. Mints per-recipient click tokens via SEME's shared `flight_recipient_deals`
   core (`send_context_type='blasteme'`), builds `/r?t=<token>` links that
   resolve in **SEME's** `/r` endpoint.
4. Sends via SendGrid `personalizations` (up to 1,000/call) — personalized
   per recipient, at bulk speed (20K in ~20 calls, minutes not hours).
5. Records one row per recipient in SEME's shared `email_logs`, stamped
   `blasteme_campaign_id`, so SEME metrics include bulk sends automatically.

## What it will NOT do (enforced by tests/boundary.test.js)
- Never writes to `smart_send_flights` / `smart_send_flight_recipients`.
- Never imports SEME flight/cleaner engine modules.
- Never sends via Brevo.
- Only touches the shared tracking table with `send_context_type='blasteme'`.

## Environment
```
DATABASE_URL                         # SAME as SEME (shared source of truth)
SEME_TRACKING_BASE_URL               # SEME production tracking host
SENDGRID_API_KEY
SENDGRID_FROM_EMAIL                  # warmed sending address
SENDGRID_FROM_NAME
ADMIN_SECRET
BLASTEME_ALLOW_PROD_SEND             # must be true for live sends
BLASTEME_ENFORCE_GLOBAL_COOLDOWN      # default true; false/0/off/no disables it
BLASTEME_GLOBAL_COOLDOWN_HOURS        # default 24; positive number when enabled
PORT
```

`BLASTEME_ENFORCE_GLOBAL_COOLDOWN=false` disables only the recent-send
exclusion. Suppression-list checks, exclusion tags, active-user checks and the
same-campaign deduplication check always remain enforced. Use the override only
for an explicitly approved cohort because it permits repeat sends inside the
normal cooldown window.

`GET /selftest` reports `global_cooldown_enabled` and
`global_cooldown_hours`, allowing operators to verify the effective setting
after deployment and before a send.

## API
- `POST /api/bulk/runs` — create (does not send). Body: name, target_tag,
  template_id, subject_label, slots[], batch_size, inter_batch_delay_seconds,
  max_bounce_rate, max_total_recipients.
- `POST /api/bulk/runs/:id/dry-run` — preview audience + domain mix, no send.
- `POST /api/bulk/runs/:id/start` — live send (DB-locked, one runner).
- `POST /api/bulk/runs/:id/stop` — kill switch (checked between batches).
- `GET  /api/bulk/runs/:id` — status.
- `GET  /selftest` — boot/config check.

`slots` shape:
```json
[{ "slot": "hero", "deal_title": "...", "image_url": "...", "affiliate_url": "..." },
 { "slot": "1", "deal_title": "...", "image_url": "...", "affiliate_url": "..." }]
```

## STAGING-FIRST test plan (do not skip)
1. Deploy to Railway **staging** with the cooldown left enabled.
2. Run `npm test`.
3. Verify `/selftest` reports `global_cooldown_enabled: true` and
   `global_cooldown_hours: 24`.
4. Confirm suppression and the enabled cooldown exclude correctly.
5. In staging only, set `BLASTEME_ENFORCE_GLOBAL_COOLDOWN=false`, redeploy and
   verify the cooldown-only recipient returns while suppression still excludes.
6. Restore the production value to `true` unless a specific repeat-send has
   been explicitly approved.

## Build a template first
BlastEME needs its own SendGrid dynamic template. Click URLs inside come from
the dynamic slot URL fields injected at send time.
