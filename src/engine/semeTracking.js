const crypto = require('crypto');
const { query } = require('../db/pool');

/**
 * SEME tracking bridge.
 *
 * SEME is the brain + data center. BlastEME is just a sender. Clicks must land
 * in SEME's tracking, not a parallel system. SEME's click-tracking core is
 * already ESP-agnostic: flight_recipient_deals is keyed on a generic
 * (send_context_type, send_context_id, user_id, slot), and SEME's /r?t=<token>
 * endpoint resolves ANY token regardless of which sender created it.
 *
 * So BlastEME writes deal-slot rows via the SAME table + SAME schema SEME uses,
 * with send_context_type='blasteme', gets back per-slot click_tokens, and builds
 * /r?t=<token> links. Every click then flows into SEME's click_logs exactly like
 * a SEME send. This function mirrors SEME's assignRecipientDealSlots write shape
 * verbatim (same table, same columns, same ON CONFLICT immutability) so there is
 * one tracking source of truth.
 *
 * IMPORTANT: this is the ONLY SEME table BlastEME writes to, and it is the shared
 * tracking core, NOT a flight table. BlastEME never touches smart_send_flights,
 * smart_send_flight_recipients, or flight_recipient_deals via any flight code
 * path — it only inserts its own send-context rows into the shared deal-token
 * table, which is exactly what SEME intends ESPs to do.
 */

function generateClickToken() {
  return crypto.randomBytes(16).toString('hex');
}

function cleanText(value = '') {
  return String(value || '').trim();
}

/**
 * Mint per-slot click tokens for one recipient against a BlastEME campaign.
 * curatedSlots: [{ slot:'hero'|'1'..'6', affiliate_url, deal_title, product_title, category, deal_key }]
 * Returns { slot: click_token }. Idempotent per (blasteme, campaignId, userId, slot).
 */
async function mintRecipientTokens({ campaignId, userId, email, slots = [], templateId, subjectLabel }) {
  const tokenBySlot = {};
  if (!slots.length) return tokenBySlot;
  if (!campaignId || !userId || !cleanText(email)) {
    throw new Error('BlastEME token mint missing required scope: campaignId, userId, email');
  }

  for (const s of slots) {
    const token = generateClickToken();
    const { rows } = await query(
      `INSERT INTO flight_recipient_deals (
         send_context_type, send_context_id, esp_provider, provider_lane,
         user_id, email, slot, click_token, affiliate_url, deal_key,
         deal_title, product_title, category, template_id, subject_label, send_purpose
       )
       VALUES ('blasteme',$1,'sendgrid','blasteme_bulk',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'blasteme_bulk')
       ON CONFLICT (send_context_type, send_context_id, user_id, slot)
       DO UPDATE SET
         metadata = COALESCE(flight_recipient_deals.metadata, '{}'::jsonb) || jsonb_build_object(
           'immutable_rewrite_blocked_at', NOW(),
           'immutable_rewrite_blocked', true,
           'attempted_affiliate_url', EXCLUDED.affiliate_url
         )
       RETURNING click_token`,
      [
        String(campaignId), userId, cleanText(email), cleanText(s.slot),
        token, cleanText(s.affiliate_url), s.deal_key || null,
        s.deal_title || null, s.product_title || s.deal_title || null,
        s.category || null, templateId || null, subjectLabel || null,
      ]
    );
    tokenBySlot[s.slot] = rows.length ? rows[0].click_token : token;
  }
  return tokenBySlot;
}

/**
 * Build a SEME /r click-tracking URL for a token. Clicks resolve in SEME.
 */
function buildTrackingUrl(token) {
  const base = (process.env.SEME_TRACKING_BASE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('SEME_TRACKING_BASE_URL not set (must point at SEME /r host)');
  return `${base}/r?t=${encodeURIComponent(token)}`;
}

module.exports = { mintRecipientTokens, buildTrackingUrl, generateClickToken };
