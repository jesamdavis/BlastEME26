const crypto = require('crypto');
const { query } = require('../db/pool');
const { selectAudience, interleaveByProvider } = require('./audience');
const { sendBatch, SENDGRID_MAX_PERSONALIZATIONS, FAILURE_STATUSES } = require('./sender');
const logger = require('../logger');

const activeRuns = new Map();

async function ensureTables() {
  // BlastEME owns ONLY this table. It never creates/alters any SEME table.
  await query(`
    CREATE TABLE IF NOT EXISTS bulk_send_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      target_tag TEXT NOT NULL,
      template_id TEXT NOT NULL,
      subject_label TEXT,
      slots JSONB NOT NULL DEFAULT '[]'::jsonb,
      batch_size INT NOT NULL DEFAULT 500,
      inter_batch_delay_seconds INT NOT NULL DEFAULT 120,
      max_bounce_rate NUMERIC NOT NULL DEFAULT 0.03,
      max_total_recipients INT,
      status TEXT NOT NULL DEFAULT 'ready',
      stop_requested BOOLEAN NOT NULL DEFAULT FALSE,
      stop_reason TEXT,
      sent_count INT NOT NULL DEFAULT 0,
      failed_count INT NOT NULL DEFAULT 0,
      lock_token UUID,
      lock_acquired_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  return true;
}

async function getRun(id) {
  const { rows } = await query(`SELECT * FROM bulk_send_runs WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function getRunHealth(campaignId) {
  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS attempted,
       COUNT(*) FILTER (WHERE status = ANY($2::text[]))::int AS failed
     FROM email_logs
     WHERE metadata->>'blasteme_campaign_id' = $1`,
    [String(campaignId), FAILURE_STATUSES]
  );
  const attempted = Number(rows[0]?.attempted || 0);
  const failed = Number(rows[0]?.failed || 0);
  return { attempted, failed, bounce_rate: attempted > 0 ? failed / attempted : 0 };
}

async function markStopped(id, status, reason) {
  await query(
    `UPDATE bulk_send_runs SET status=$2, stop_reason=$3, updated_at=NOW() WHERE id=$1`,
    [id, status, reason]
  );
}

const BOUNCE_SAMPLE_FLOOR = 100;
const LOCK_STALE_MINUTES = 30;

async function startRun(id) {
  const run = await getRun(id);
  if (!run) throw new Error('run not found');

  // Safety guard (default OFF): BlastEME runs against the PROD database, so a
  // /start would send REAL email to REAL people. This flag must be explicitly
  // set to 'true' in env before any live send is allowed. Prevents an accidental
  // real send while wiring up / testing. Set BLASTEME_ALLOW_PROD_SEND=true only
  // when you've confirmed the target tag and are ready to actually mail.
  if (String(process.env.BLASTEME_ALLOW_PROD_SEND || '').toLowerCase() !== 'true') {
    await markStopped(id, 'blocked', 'prod_send_disabled_set_BLASTEME_ALLOW_PROD_SEND_true');
    return { started: false, reason: 'prod_send_disabled', hint: 'set BLASTEME_ALLOW_PROD_SEND=true to enable live sending' };
  }

  const lockToken = crypto.randomUUID();
  const { rows: claimed } = await query(
    `UPDATE bulk_send_runs
     SET status='running', stop_requested=FALSE, stop_reason=NULL,
         lock_token=$2, lock_acquired_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND (lock_token IS NULL OR lock_acquired_at < NOW() - ($3 || ' minutes')::interval)
     RETURNING id`,
    [id, lockToken, String(LOCK_STALE_MINUTES)]
  );
  if (!claimed.length) return { started: false, reason: 'already_running' };

  const loop = runLoop(id, lockToken);
  activeRuns.set(String(id), loop);
  return { started: true };
}

async function releaseLock(id, lockToken) {
  await query(
    `UPDATE bulk_send_runs SET lock_token=NULL, lock_acquired_at=NULL, updated_at=NOW()
     WHERE id=$1 AND lock_token=$2`, [id, lockToken]
  ).catch(() => {});
}

async function runLoop(id, lockToken) {
  try {
    const run = await getRun(id);
    const campaign = {
      id: run.id,
      template_id: run.template_id,
      subject_label: run.subject_label,
      slots: run.slots || [],
    };
    const cap = run.max_total_recipients || null;
    const batchSize = Math.min(run.batch_size || 500, SENDGRID_MAX_PERSONALIZATIONS);

    // Pull the whole audience once, apply shared filters, interleave by provider.
    let audience = await selectAudience({ targetTag: run.target_tag, campaignId: run.id, limit: cap || 100000 });
    audience = interleaveByProvider(audience);
    if (cap) audience = audience.slice(0, cap);

    if (!audience.length) { await markStopped(id, 'completed', 'audience_empty'); return; }

    for (let i = 0; i < audience.length; i += batchSize) {
      const fresh = await getRun(id);
      if (fresh.stop_requested) { await markStopped(id, 'stopped', 'stop_requested_by_operator'); break; }

      // Bounce ceiling (includes 'failed', per the SEME fix).
      const health = await getRunHealth(id);
      if (health.attempted >= BOUNCE_SAMPLE_FLOOR && health.bounce_rate > Number(run.max_bounce_rate)) {
        await markStopped(id, 'paused', `bounce_rate_${health.bounce_rate.toFixed(4)}_exceeds_${run.max_bounce_rate}`);
        break;
      }

      const batch = audience.slice(i, i + batchSize);
      const res = await sendBatch({ campaign, recipients: batch });
      await query(
        `UPDATE bulk_send_runs SET sent_count=sent_count+$2, failed_count=failed_count+$3, updated_at=NOW() WHERE id=$1`,
        [id, res.sent, res.failed]
      );
      logger.info(`run ${id}: batch ${Math.floor(i / batchSize) + 1} sent=${res.sent} failed=${res.failed}`);

      if (i + batchSize < audience.length) {
        await new Promise(r => setTimeout(r, (run.inter_batch_delay_seconds || 120) * 1000));
      }
    }

    const final = await getRun(id);
    if (!final.stop_requested && final.status === 'running') {
      await markStopped(id, 'completed', 'audience_exhausted');
    }
  } catch (err) {
    logger.error(`run ${id} crashed: ${err.message}`);
    await markStopped(id, 'paused', `run_error: ${err.message}`).catch(() => {});
  } finally {
    await releaseLock(id, lockToken);
    activeRuns.delete(String(id));
  }
}

async function requestStop(id) {
  await query(`UPDATE bulk_send_runs SET stop_requested=TRUE, updated_at=NOW() WHERE id=$1`, [id]);
  return { stop_requested: true };
}

module.exports = { ensureTables, getRun, startRun, requestStop, getRunHealth };
