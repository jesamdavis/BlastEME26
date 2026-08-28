const express = require('express');
const { query } = require('../db/pool');
const { getRun, startRun, requestStop } = require('../engine/run');
const { selectAudience, interleaveByProvider } = require('../engine/audience');

const router = express.Router();

function requireAdmin(req, res, next) {
  const sec = req.get('x-admin-secret');
  if (!sec || sec !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function normalizeTrackedLinks(value) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tracked_links must be an object keyed by template variable name');
  }

  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      throw new Error(`tracked_links key "${key}" must contain only letters, numbers, or underscore`);
    }
    const item = typeof raw === 'string' ? { url: raw } : raw;
    if (!item || typeof item !== 'object' || !String(item.url || '').trim()) {
      throw new Error(`tracked_links.${key}.url is required`);
    }
    out[key] = {
      url: String(item.url).trim(),
      title: item.title || null,
      deal_key: item.deal_key || null,
      category: item.category || null,
    };
  }
  return out;
}

function normalizeScheduledAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('scheduled_at must be a valid ISO-8601 date/time');
  return d.toISOString();
}

// Create a run (does NOT send)
router.post('/runs', requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.target_tag || !b.template_id) return res.status(400).json({ error: 'target_tag and template_id required' });

  let trackedLinks;
  let scheduledAt;
  try {
    trackedLinks = normalizeTrackedLinks(b.tracked_links);
    scheduledAt = normalizeScheduledAt(b.scheduled_at);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const { rows } = await query(
    `INSERT INTO bulk_send_runs (name, target_tag, template_id, subject_label, slots,
       tracked_links, batch_size, inter_batch_delay_seconds, max_bounce_rate,
       max_total_recipients, scheduled_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11) RETURNING *`,
    [
      b.name || null, b.target_tag, b.template_id, b.subject_label || null,
      JSON.stringify(b.slots || []), JSON.stringify(trackedLinks), b.batch_size || 500,
      b.inter_batch_delay_seconds || 120, b.max_bounce_rate || 0.03,
      b.max_total_recipients || null, scheduledAt,
    ]
  );
  res.json({ success: true, run: rows[0] });
});

// Dry-run: preview audience (capped), no send, no token mint
router.post('/runs/:id/dry-run', requireAdmin, async (req, res) => {
  const run = await getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  const limit = Math.min(Number((req.body || {}).limit) || 100, 200);
  let audience = await selectAudience({ targetTag: run.target_tag, campaignId: run.id, limit });
  audience = interleaveByProvider(audience);
  const domains = {};
  for (const r of audience) domains[r.domain] = (domains[r.domain] || 0) + 1;
  res.json({
    candidate_count: audience.length,
    domain_mix: domains,
    sample: audience.slice(0, 5).map(r => ({ email: r.email, first_name: r.first_name })),
  });
});

router.post('/runs/:id/start', requireAdmin, async (req, res) => {
  const out = await startRun(req.params.id);
  const run = await getRun(req.params.id);
  res.json({ success: true, ...out, run });
});

router.post('/runs/:id/stop', requireAdmin, async (req, res) => {
  const out = await requestStop(req.params.id);
  res.json({ success: true, ...out });
});

router.get('/runs/:id', requireAdmin, async (req, res) => {
  const run = await getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json({ run });
});

module.exports = router;
