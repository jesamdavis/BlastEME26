const sgMail = require('@sendgrid/mail');
const { query } = require('../db/pool');
const { mintRecipientTokens, buildTrackingUrl } = require('./semeTracking');
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

    // Build dynamic_template_data: curated content + per-slot SEME tracking URLs
    // + first_name. The template is BlastEME's own simple curated template; the
    // click URLs inside it point at SEME's /r so clicks land in SEME.
    const dtd = {
      first_name: r.first_name || '',
      subject: campaign.subject_label,
    };
    for (const s of campaign.slots) {
      const token = tokenBySlot[s.slot];
      dtd[`slot_${s.slot}_title`] = s.deal_title || '';
      dtd[`slot_${s.slot}_image`] = s.image_url || '';
      dtd[`slot_${s.slot}_url`] = token ? buildTrackingUrl(token) : (s.affiliate_url || '');
    }

    personalizations.push({ to: [{ email: r.email }], dynamic_template_data: dtd });
    logRows.push({ user_id: r.user_id, email: r.email });
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
