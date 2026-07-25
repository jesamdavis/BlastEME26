# BlastEME

A fast, provider-aware **bulk email sender** for revenue drops to proven,
already-profiled segments (Athleta openers, Alo engagers, 5K–20K at a time).

**SEME is the brain and data center. BlastEME is just a sender.**
Every click, open, suppression, unsubscribe, and engagement stat flows into
SEME's database. BlastEME owns nothing but the fast send loop.

## What it does
1. Pulls a tagged segment from SEME's `users`, applying the **identical**
   safety filters SEME uses: active status, exclude tags, `suppression_list`,
   and the **24h cross-lane cooldown** (reads all `email_logs.sent_at`, so it
   can't duplicate a SEME send).
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
DATABASE_URL            # SAME as SEME (shared source of truth)
SEME_TRACKING_BASE_URL  # SEME host, e.g. https://s-eme-cm26-production.up.railway.app
SENDGRID_API_KEY
SENDGRID_FROM_EMAIL     # deals@email.eightcoupons.com (reuse warmed subdomain)
SENDGRID_FROM_NAME
ADMIN_SECRET
PORT
```

## API
- `POST /api/bulk/runs` — create (does not send). Body: name, target_tag,
  template_id, subject_label, slots[], batch_size, inter_batch_delay_seconds,
  max_bounce_rate, max_total_recipients.
- `POST /api/bulk/runs/:id/dry-run` — preview audience + domain mix, no send.
- `POST /api/bulk/runs/:id/start` — live send (DB-locked, one runner).
- `POST /api/bulk/runs/:id/stop` — kill switch (checked between batches).
- `GET  /api/bulk/runs/:id` — status.
- `GET  /selftest` — boot/config check.

`slots` shape (BlastEME's own simple curated template — no slotting logic):
```json
[{ "slot": "hero", "deal_title": "...", "image_url": "...", "affiliate_url": "..." },
 { "slot": "1", "deal_title": "...", "image_url": "...", "affiliate_url": "..." }]
```

## STAGING-FIRST test plan (do not skip)
1. Deploy to Railway **staging**. Set `DATABASE_URL` to read SEME prod
   suppression/tracking (shared source of truth — confirmed decision).
   `SEME_TRACKING_BASE_URL` → SEME prod (so tokens resolve). `SENDGRID_FROM_EMAIL`
   → the warmed `email.eightcoupons.com`.
2. `npm test` — boundary tests must pass (no flight-table access).
3. Create a run targeting a tag containing ONLY your seed addresses. Confirm on
   your own inboxes: delivered + open + click, and that the click lands in SEME's
   `click_logs` (not a parallel table).
4. Confirm suppression + 24h cooldown exclude correctly (tag a suppressed seed;
   it must be skipped).
5. Dry-run a small real segment (100 Athleta openers) — check domain mix, no send.
6. Only then: capped real send, watching bounce + Postmaster.

## Build a template first
BlastEME needs its OWN simple SendGrid dynamic template (hero + N curated deals +
`{{first_name}}`, no slot-visibility gates). Click URLs inside come from
`slot_N_url` (SEME tracking links injected at send time).
```
```
