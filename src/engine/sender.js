const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');
const { query } = require('../db/pool');
const { mintRecipientTokens, buildTrackingUrl } = require('./semeTracking');
const { buildEmailPreferenceUrl } = require('./emailPreferenceTokens');
const logger = require('../logger');

const SENDGRID_MAX_PERSONALIZATIONS = 1000; // SendGrid hard limit per API call
const FAILURE_STATUSES = ['bounced', 'blocked', 'dropped', 'failed'];

function ensureApiKey() {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error('SENDGRID_API_KEY not set');
  sgMail.setApiKey(key);
}

/**
 * Send one SendGrid batch (<=1000 recipients) via personalizations. Each
 * recipient gets their own first_name + their own SEME tracking links minted
 * for this campaign. Records one email_logs row per recipient in the SHARED
 * SEME email_logs, stamped with blasteme_campaign_id so SEME metrics include it
 * and the campaign-dedup guard works.
 */
async function sendBatch({ campaign, recipients }) {
  ensureApiKey();
  if (recipients.length > SENDGRID_MAX_PERSONALIZATIONS) {
    throw new Error(`batch exceeds ${SENDGRID_MAX_PERSONALIZATIONS}`);
  }

  const personalizations = [];
  const logRows = [];

  for (const r of recipients) {
    // Mint SEME tracking tokens for this recipient's curated slots.
    const tokenBySlot = await mintRecipientTokens({
      campaignId: campaign.id,
      userId: r.user_id,
      email: r.email,
      slots: campaign.slots,
      templateId: campaign.template_id,
      subjectLabel: campaign.subject_label,
    });

    // Emit SEME's exact template contract so BlastEME can use SEME-style
    // templates unchanged (heroDeal*, dealSlotN*). Click URLs point at SEME's /r
    // tracking endpoint so every click flows into SEME. Also emits the ad-stripe
    // fields (email_url_encoded, sendid), location preference link, and first_name.
    const emailUrlEncoded = encodeURIComponent(r.email);
    const sendid = `blasteme-${campaign.id}`;
    const preferenceUrl = buildEmailPreferenceUrl({ userId: r.user_id, email: r.email });

    const dtd = {
      first_name: r.first_name || '',
      city: r.city || '',
      zip: r.zip || '',
      preference_url: preferenceUrl,
      email_preferences_url: preferenceUrl,
      subject: campaign.subject_label,
      email: r.email,
      email_url_encoded: emailUrlEncoded,
      sendid,
    };

    // Map each curated slot to SEME's field names. 'hero' -> heroDeal*,
    // numbered slots -> dealSlotN*.
    for (const s of campaign.slots) {
      const token = tokenBySlot[s.slot];
      const url = token ? buildTrackingUrl(token) : (s.affiliate_url || '');
      if (String(s.slot).toLowerCase() === 'hero') {
        dtd.heroDealTitle = s.deal_title || '';
        dtd.heroDealClickUrl = url;
        dtd.heroDealImageUrl = s.image_url || '';
        dtd.heroDealPriceText = s.price_text || '';
        dtd.heroDealDescription = s.description || '';
        dtd.heroDealBrand = s.brand || '';
        dtd.heroDealLogoUrl = s.logo_url || '';
      } else {
        const n = String(s.slot);
        dtd[`dealSlot${n}Title`] = s.deal_title || '';
        dtd[`dealSlot${n}ClickUrl`] = url;
        dtd[`dealSlot${n}ImageUrl`] = s.image_url || '';
        dtd[`dealSlot${n}PriceText`] = s.price_text || '';
      }
    }

    // Per-recipient unique id (fixes webhook matching): SendGrid echoes
    // custom_args back on EVERY event (delivered, block, bounce, spam, unsub),
    // so SEME can match an event to exactly one row instead of a shared batch
    // message-id. Purely additive — does not change how the send works.
    const sendUid = crypto.randomUUID();
    personalizations.push({
      to: [{ email: r.email }],
      subject: campaign.subject_label,
      dynamic_template_data: dtd,
      custom_args: { blasteme_send_uid: sendUid },
    });
    logRows.push({ user_id: r.user_id, email: r.email, send_uid: sendUid });
  }

  const msg = {
    from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME || '8coupons' },
    templateId: campaign.template_id,
    personalizations,
  };

  let sgMessageId = null;
  let sendError = null;
  try {
    const [response] = await sgMail.send(msg);
    sgMessageId = (response && response.headers && response.headers['x-message-id']) || null;
  } catch (err) {
    sendError = err.message || String(err);
    logger.error(`batch send failed: ${sendError}`);
  }

  // Record one email_logs row per recipient in the SHARED SEME table.
  for (const row of logRows) {
    await query(
      `INSERT INTO email_logs (user_id, template_key, sendgrid_message_id, subject, status, provider, sent_at, metadata)
       VALUES ($1,$2,$3,$4,$5,'sendgrid',NOW(),$6::jsonb)`,
      [
        row.user_id,
        `blasteme:${campaign.template_id}`,
        sgMessageId,
        campaign.subject_label,
        sendError ? 'failed' : 'sent',
        JSON.stringify({
          blasteme_campaign_id: String(campaign.id),
          blasteme_send_uid: row.send_uid,
          lane: 'blasteme_bulk',
          send_purpose: 'blasteme_bulk',
          ...(sendError ? { error: sendError } : {}),
        }),
      ]
    );
  }

  return { sent: sendError ? 0 : logRows.length, failed: sendError ? logRows.length : 0, sgMessageId };
}

module.exports = { sendBatch, SENDGRID_MAX_PERSONALIZATIONS, FAILURE_STATUSES };
