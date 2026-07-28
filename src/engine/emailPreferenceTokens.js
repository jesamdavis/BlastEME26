const crypto = require('crypto');

const TOKEN_PURPOSE = 'email_location_preferences';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;

function getSecret() {
  const secret = String(process.env.EMAIL_PREFERENCE_TOKEN_SECRET || '').trim();
  if (!secret) throw new Error('EMAIL_PREFERENCE_TOKEN_SECRET not set');
  return secret;
}

function hasConfiguredSecret() {
  return Boolean(String(process.env.EMAIL_PREFERENCE_TOKEN_SECRET || '').trim());
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(encodedPayload) {
  return crypto.createHmac('sha256', getSecret()).update(encodedPayload).digest('base64url');
}

function mintEmailPreferenceToken({ userId, email, ttlSeconds = DEFAULT_TTL_SECONDS, nowMs = Date.now() }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!userId || !normalizedEmail) throw new Error('userId and email are required');

  const payload = {
    v: 1,
    purpose: TOKEN_PURPOSE,
    user_id: String(userId),
    email: normalizedEmail,
    exp: Math.floor(nowMs / 1000) + Math.max(300, Number(ttlSeconds) || DEFAULT_TTL_SECONDS),
  };
  const encoded = base64urlJson(payload);
  return `${encoded}.${sign(encoded)}`;
}

function buildEmailPreferenceUrl(input) {
  // Preference links are additive. A missing secret must not abort an otherwise
  // valid BlastEME batch; deployment checks still verify the variable exists.
  if (!hasConfiguredSecret()) return '';

  const token = mintEmailPreferenceToken(input);
  const base = String(process.env.EMAIL_PREFERENCES_BASE_URL || 'https://www.8coupons.com/email-preferences').trim();
  const url = new URL(base);
  url.searchParams.set('token', token);
  return url.toString();
}

module.exports = {
  TOKEN_PURPOSE,
  DEFAULT_TTL_SECONDS,
  hasConfiguredSecret,
  mintEmailPreferenceToken,
  buildEmailPreferenceUrl,
};
