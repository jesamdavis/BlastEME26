const { query } = require('../db/pool');

// SHARED with SEME — identical exclusion set. Do NOT diverge. If SEME adds an
// exclude tag, mirror it here (or better, factor to a shared module later).
const EXCLUDE_TAGS = [
  'list-hard-bounce',
  'list-blocked',
  'list-suppressed',
  'list-unsubscribed',
  'list-spam',
  'list-suspected-bot-engagement',
];

// SHARED cross-lane cooldown. Reads ALL email_logs.sent_at, so a BlastEME send
// respects SEME sends and vice-versa — this is what prevents cross-lane
// duplicates (the reason cohorts must dedupe across BOTH lanes).
const GLOBAL_COOLDOWN_HOURS = 24;

/**
 * Pull sendable recipients for a tagged segment, applying the SAME safety
 * filters SEME uses: active status, exclude tags, suppression_list, 24h
 * cross-lane cooldown, and (BlastEME-specific) not already sent in THIS campaign.
 */
async function selectAudience({ targetTag, campaignId, limit = 100000 }) {
  const { rows } = await query(
    `SELECT u.id AS user_id,
            LOWER(u.email) AS email,
            COALESCE(NULLIF(BTRIM(u.first_name),''), '') AS first_name,
            LOWER(SPLIT_PART(u.email,'@',2)) AS domain
     FROM users u
     WHERE $1 = ANY(COALESCE(u.tags,'{}'::text[]))
       AND u.status = 'active'
       AND COALESCE(NULLIF(BTRIM(u.email),''), NULL) IS NOT NULL
       AND NOT (COALESCE(u.tags,'{}'::text[]) && $2::text[])
       AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE LOWER(s.email) = LOWER(u.email))
       AND NOT EXISTS (
         SELECT 1 FROM email_logs el
         WHERE el.user_id = u.id AND el.sent_at >= NOW() - ($3 || ' hours')::interval
       )
       AND NOT EXISTS (
         SELECT 1 FROM email_logs el
         WHERE el.user_id = u.id AND el.metadata->>'blasteme_campaign_id' = $4
       )
     ORDER BY u.id
     LIMIT $5`,
    [targetTag, EXCLUDE_TAGS, String(GLOBAL_COOLDOWN_HOURS), String(campaignId), limit]
  );
  return rows;
}

/**
 * Provider-interleave: bucket recipients by provider domain, then round-robin
 * draw so every downstream batch is a MIX — no single provider (e.g. Gmail)
 * dominates any window. This is the v1 throttle protection (Lever 1).
 */
function interleaveByProvider(recipients) {
  const buckets = new Map();
  for (const r of recipients) {
    const key = r.domain || 'unknown';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const queues = [...buckets.values()];
  const out = [];
  let anyLeft = true;
  while (anyLeft) {
    anyLeft = false;
    for (const q of queues) {
      if (q.length) { out.push(q.shift()); anyLeft = true; }
    }
  }
  return out;
}

module.exports = { selectAudience, interleaveByProvider, EXCLUDE_TAGS, GLOBAL_COOLDOWN_HOURS };
