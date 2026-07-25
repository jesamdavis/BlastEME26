# Bulk Curated Sender — v1 Spec (working name: "BlastEME")
### 2026-07-25

A separate, dead-simple bulk email sender for FAST revenue drops to proven,
already-profiled segments (e.g. Athleta openers, Alo engagers, 5K–20K at a time).
Deliberately NOT part of SEME — isolation protects the personalized-drip engine
you've spent this session hardening.

**Core principle:** separate SENDER, shared SOURCE OF TRUTH. The sending code is
new and isolated; suppression, unsubscribe, 24h cooldown, and click-tracking all
read/write the SAME Postgres tables SEME uses, so the two systems never diverge
on who's mailable or where engagement data lives.

---

## 1. WHY SEPARATE (not a new SEME "mode")

Adding a bulk mode inside SEME risks reintroducing exactly the regression class
just eliminated (cross-lane mutation, reconcile bugs). A separate service gives
hard blast-radius isolation: a bug in the bulk sender CANNOT touch SEME flight
tables, the Brevo revenue lane, or the tracking just verified. Same lane-
isolation logic that made the SendGrid cleaner safe.

Different job, different tool:
- SEME = personalized-drip / EXPANSION engine (per-recipient tokens, scoring,
  planner, flight reconciliation). Heavy machinery, slow by design.
- BlastEME = REVENUE blast to proven segments. Almost none of that machinery.
  A few hundred lines: pull tagged list → SendGrid batch API → record webhooks.

---

## 2. THE SHARED vs SEPARATE BOUNDARY (the critical part)

### SHARED (same DB, single source of truth — MUST NOT duplicate)
BlastEME reads/writes the SAME production Postgres as SEME for:

1. **Suppression list** — reads `suppression_list` (email UNIQUE) AND the
   `users.tags` exclusion set (`list-suppressed`, `list-hard-bounce`,
   `list-unsubscribed`, `list-spam`, `list-suspected-bot-engagement`). A bulk
   send MUST apply the identical exclusion filter SEME uses. Never maintain a
   second suppression list.
2. **24h cooldown** — reads `email_logs.sent_at` across BOTH lanes. Same
   `NOT EXISTS (... sent_at >= NOW() - INTERVAL '24 hours')` guard. This is what
   prevents the cross-lane duplicate (the cunningham.regina bug) — cooldown must
   see SEME's sends and vice versa.
3. **Unsubscribe handling** — the unsubscribe endpoint/webhook writes to the
   same `users` (status + tags) and `suppression_list`. One unsubscribe removes
   the person from BOTH systems. Shared unsub link/token logic.
4. **Click/open tracking** — writes events to the SAME `email_logs` (status,
   opened_at, clicked_at, delivered_at, provider, metadata). Engagement data
   stays UNIFIED — your SEME_METRICS counts include bulk sends automatically.
   Reuse the existing click-token schema (`dealSlotTokens` / the `/r` redirect
   endpoint) so a click is tracked identically regardless of which sender sent it.

### SEPARATE (BlastEME owns, SEME must never be touched)
- The bulk send loop / batch-API call logic (new code).
- Its own run records (e.g. a `bulk_send_runs` table — do NOT reuse
  `sendgrid_cleaner_runs` or any `smart_send_*` table).
- **HARD RULE: zero write access to any SEME flight table**
  (`smart_send_flights`, `smart_send_flight_recipients`, flight_recipient_deals).
  Enforce with a boundary test like the cleaner's — CI fails if BlastEME imports
  a SEME flight module or references a flight table.

---

## 3. WHAT v1 DOES (minimal scope)

One job: "send tagged-list X with template Y via SendGrid batch API, tracked."

Flow:
1. Pull recipients: `users` where tag = X, status='active', apply the SHARED
   exclusion filter (suppression + tags + 24h cooldown).
2. Pre-mint click tokens for all recipients in ONE bulk insert (not per-send).
3. Build SendGrid `personalizations` payload — up to 1,000 recipients per API
   call, each with their own merge fields (first_name), own click-token links,
   own subject. Per-recipient personalization at bulk speed.
4. Fire ~N/1000 API calls (20K = 20 calls, minutes not hours).
5. SendGrid delivery/open/click webhooks land on the SHARED handler → write to
   `email_logs`. Engagement tracked per recipient, unified with SEME data.

Explicitly OUT of v1: no scoring, no planner, no flight reconciliation, no
approve-batch gate, no per-deal-slot rollups (campaign-level slot tracking is
fine for revenue sends). Keep it dumb.

---

## 4. SAFETY MECHANISMS (must be in place before any real send)

Non-negotiable, mirrored from SEME so nothing regresses:
- **Shared suppression filter** — identical exclusion set, applied at candidate
  selection AND re-checked at send time.
- **Shared 24h cooldown** — cross-lane, reads all `email_logs.sent_at`.
- **Kill switch** — stop endpoint checked between batches (like the cleaner).
- **Bounce/complaint ceiling** — halt on bounce rate > threshold (include
  `failed`, per the fix shipped today — don't repeat that bug).
- **Seed-only testing** — NEVER test on real customer emails. Own seeds only,
  each checked outside the 24h cooldown first.
- **Boundary test in CI** — fails build if BlastEME touches a SEME flight table.
- **Own sender subdomain OR shared** — decide: reuse `email.eightcoupons.com`
  (shares warmed reputation, but couples the two) or a new subdomain (cleaner
  isolation, needs its own warm-up + the same bounce-return-path DNS fix). Lean
  toward reusing the warmed one for revenue sends to proven openers.

---

## 5. BUILD PLAN — STAGING FIRST

You have a Railway STAGING environment (was slated for deletion — now it has a
purpose). Build and prove here before production data.

1. Scaffold BlastEME on staging (separate Railway service, points at a staging
   DB copy OR read-only to prod suppression — decide).
2. Implement: candidate query (shared filter) → bulk token mint → SendGrid
   personalizations batch send → webhook recording.
3. Prove on seed addresses only: confirm delivered + open + click tracked in
   `email_logs`, confirm suppression + 24h cooldown exclude correctly, confirm
   the boundary test blocks flight-table access.
4. Dry-run against a small real segment (e.g. 100 Athleta openers) on staging.
5. Only then: point at production, send the first real revenue drop (Athleta/Alo
   openers), capped, watching bounce + Postmaster.

---

## 6. OPEN DECISIONS (resolve before build)
- Staging DB: copy of prod, or BlastEME reads prod suppression read-only? (Shared
  source of truth argues for reading prod suppression/tracking directly, even
  from staging compute.)
- Sender subdomain: reuse warmed `email.eightcoupons.com` vs new isolated one.
- Where the unsubscribe + click endpoints live: shared with SEME (same `/r` and
  unsub routes) is cleanest for unified data — likely reuse SEME's, meaning
  BlastEME only owns the SEND, and SEME's existing tracking endpoints handle the
  rest. (This is the leanest split: BlastEME = a sender; SEME already owns
  tracking + suppression + unsub.)

---

## 7. THE LONGER ARC
This isn't throwaway. BlastEME's batch-API send IS the pattern SEME's own sends
should eventually adopt (per-recipient personalization at bulk speed). Proving it
in an isolated service de-risks later folding the technique back into SEME's
expansion lane — without gambling SEME's stability to learn it. Two speeds,
eventually one hardened engine, reached safely.

---

## 8. PROVIDER-AWARE PACING (deliverability intelligence)

Confirmed decisions: staging reads prod suppression/tracking directly (shared
source of truth), and BlastEME reuses the warmed `email.eightcoupons.com`
subdomain.

The sender must NOT drop 1,000 same-provider emails (e.g. all Gmail) in one
window — that's what triggers per-provider throttling/deferrals. Solution:
provider-interleaving + optional per-provider caps.

### Lever 1 — Interleave within each batch (v1, DO THIS FIRST)
Bucket candidates by provider domain, then round-robin draw so every batch is a
MIX, never provider-dominated:
- `batch ≈ [gmail, yahoo, hotmail, gmail, yahoo, aol, ...]`
- A 1,000-send batch becomes ~300 gmail + 250 yahoo + 200 hotmail + 250 other,
  so each provider sees only a fraction per window.
- Cheap: bucket-and-round-robin the candidate list before batching. ~80% of the
  throttle protection for ~20% of the effort.

### Lever 2 — Per-provider rolling caps (add if deferrals appear)
Track a rolling per-domain send count; hold a provider back if it's about to
exceed a window cap (e.g. "max 200 gmail / 2-min window"), fill the batch with
other providers instead.

### Lever 3 — Adaptive caps (the learning version, later)
Read SendGrid deferred/throttle webhook events per provider. If gmail deferrals
stay ~0, auto-raise gmail's cap; if they climb, auto-lower. Sender learns each
provider's real-time tolerance. Turns "are we throttled?" into a feedback loop.

### Throttle vs block reminder
- Deferred (421/451) = temporary "slow down"; SendGrid auto-retries over hours,
  still delivers, does NOT spike `bounced`. This is what pacing prevents.
- Blocked = receiver refuses (reputation/spam); volume rarely causes this on a
  warmed domain. Pacing helps avoid the reputation damage that leads here.
- SendGrid meters actual SMTP delivery from a 1,000-personalizations call, so
  you're not slamming 1,000 into one provider at once — but interleaving +
  spacing batches a few minutes apart is still the safe pattern.

**v1 ship list for pacing:** Lever 1 (interleave) + inter-batch spacing (few min)
+ honor the bounce/complaint ceiling. Levers 2–3 are follow-ups gated on seeing
real deferrals.
