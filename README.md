# BlastEME

A fast, provider-aware **bulk email sender** for revenue drops to proven,
already-profiled segments (Athleta openers, Alo engagers, 5K–20K at a time).

**SEME is the brain and data center. BlastEME is just a sender.**
Every click, open, suppression, unsubscribe, and engagement stat flows into
SEME's database. BlastEME owns nothing but the fast send loop and its
`bulk_send_runs` control table.

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
4. Supports both SEME-style deal slots and generic first-party `tracked_links`
   for event/editorial/affiliate templates. Generic links are exposed to the
   SendGrid template as `{{tracked_links.key}}` and `{{key_url}}`.
5. Sends via SendGrid `personalizations` (up to 1,000/call) and explicitly
   enables SendGrid click tracking as a **secondary validation/fallback layer**.
   SEME `/r` remains authoritative for configured first-party links.
6. Records one row per recipient in SEME's shared `email_logs`, stamped
   `blasteme_campaign_id`, so SEME metrics include bulk sends automatically.
7. Supports native scheduling with nullable `scheduled_at`. A 30-second in-app
   scheduler starts only `ready` runs whose scheduled time has arrived, using
   the same production-send gate, lock, audience, bounce ceiling, and send loop
   as a manual `/start`.

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
BLASTEME_ALLOW_PROD_SEND # must be true for manual OR scheduled live sends
PORT
```

## API
- `POST /api/bulk/runs` — create (does not send). Body: name, target_tag,
  template_id, subject_label, slots[], tracked_links{}, batch_size,
  inter_batch_delay_seconds, max_bounce_rate, max_total_recipients,
  `scheduled_at` (optional ISO-8601 timestamp).
- `POST /api/bulk/runs/:id/dry-run` — preview audience + domain mix, no send.
- `POST /api/bulk/runs/:id/start` — live send (DB-locked, one runner).
- `POST /api/bulk/runs/:id/stop` — kill switch (checked between batches).
- `GET  /api/bulk/runs/:id` — status.
- `GET  /selftest` — boot/config/scheduler check.

`slots` shape (SEME deal-style tracking):
```json
[{ "slot": "hero", "deal_title": "...", "image_url": "...", "affiliate_url": "..." },
 { "slot": "1", "deal_title": "...", "image_url": "...", "affiliate_url": "..." }]
```

`tracked_links` shape (generic first-party links for editorial/event/static-layout templates):
```json
{
  "intrepid": {
    "url": "https://intrepidmuseum.org/free-movie-night-series",
    "title": "Intrepid Movie Night",
    "category": "event"
  },
  "alo": {
    "url": "https://www.aloyoga.com/products/example",
    "title": "Alo Offer",
    "category": "shopping"
  }
}
```

Use the dynamic link in the SendGrid template instead of hard-coding the final
merchant URL:
```handlebars
<a href="{{tracked_links.intrepid}}">Movie details</a>
<a href="{{alo_url}}">Shop Alo</a>
```

This makes the click path:
`email -> SendGrid secondary click redirect -> SEME /r -> click log -> final URL`.
If an old template still contains a hard-coded link, SendGrid tracking remains a
secondary fallback, but SEME first-party attribution requires converting that
link to a `tracked_links` variable.

### Scheduling example
Creating a scheduled run does **not** send immediately:
```json
{
  "name": "NYC local Saturday drop",
  "target_tag": "list-nyc-engaged",
  "template_id": "d-example",
  "subject_label": "Saturday NYC deals",
  "scheduled_at": "2026-08-29T13:00:00-04:00"
}
```
The scheduler checks every 30 seconds. It only starts due rows with
`status='ready'`, and `startRun()` still enforces `BLASTEME_ALLOW_PROD_SEND=true`
and the existing DB lock.

## STAGING-FIRST test plan (do not skip)
1. Deploy this branch to Railway **staging**. Set `DATABASE_URL` to read SEME prod
   suppression/tracking (shared source of truth — confirmed decision).
   `SEME_TRACKING_BASE_URL` -> SEME prod (so tokens resolve).
2. `npm test` — boundary tests must pass.
3. Create a run targeting a tag containing ONLY seed addresses, with at least one
   `tracked_links` item. Confirm on your own inbox: delivered + open + click, and
   that the click lands in SEME `click_logs`.
4. Create a second seed-only run with `scheduled_at` a few minutes ahead. Confirm
   it remains `ready` before the due time, becomes `running`, then `completed`,
   exactly once.
5. Confirm suppression + 24h cooldown exclude correctly.
6. Dry-run a small real segment — check domain mix, no send.
7. Only then deploy/use for capped production sends.
