const fs = require('fs');
const path = require('path');

// BlastEME is a SENDER. It must never write to SEME flight tables or the Brevo
// revenue lane. It may ONLY: read shared user/suppression/email_logs data, write
// email_logs (shared tracking) and its own bulk_send_runs table, and insert
// deal-token rows into the shared flight_recipient_deals table with
// send_context_type='blasteme'. These tests enforce that boundary so a bug here
// can never regress SEME.

function readAllSrc() {
  const dir = path.resolve(__dirname, '../src');
  const out = {};
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) out[p] = fs.readFileSync(p, 'utf8');
    }
  })(dir);
  return out;
}

const src = readAllSrc();
const all = Object.values(src).join('\n');

describe('BlastEME boundary — cannot regress SEME', () => {
  test('never writes to smart_send flight tables', () => {
    expect(all).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+smart_send_flights/i);
    expect(all).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+smart_send_flight_recipients/i);
  });

  test('never imports SEME flight/engine modules', () => {
    expect(all).not.toMatch(/require\([^)]*smartSendFlights/);
    expect(all).not.toMatch(/require\([^)]*smartSendFlightRunner/);
    expect(all).not.toMatch(/require\([^)]*sendgridCleanerRun/);
  });

  test('never sends via Brevo', () => {
    expect(all).not.toMatch(/brevo/i);
    expect(all).not.toMatch(/require\(['"]@getbrevo/);
  });

  test('only writes flight_recipient_deals with blasteme send context', () => {
    // If it inserts into flight_recipient_deals at all, it must be as 'blasteme'.
    if (/INSERT INTO flight_recipient_deals/i.test(all)) {
      expect(all).toMatch(/'blasteme'/);
    }
  });

  test('applies the shared suppression + cooldown filter', () => {
    const audience = src[path.resolve(__dirname, '../src/engine/audience.js')];
    expect(audience).toMatch(/suppression_list/);
    expect(audience).toMatch(/list-suppressed/);
    expect(audience).toMatch(/24/); // cooldown hours
    expect(audience).toMatch(/sent_at >= NOW\(\) -/);
  });

  test('bounce ceiling includes failed (the SEME fix)', () => {
    const sender = src[path.resolve(__dirname, '../src/engine/sender.js')];
    expect(sender).toMatch(/'bounced', 'blocked', 'dropped', 'failed'/);
  });

  test('provider interleaving exists (throttle protection)', () => {
    const audience = src[path.resolve(__dirname, '../src/engine/audience.js')];
    expect(audience).toMatch(/interleaveByProvider/);
  });

  test('click links point at SEME tracking, not a parallel system', () => {
    const tracking = src[path.resolve(__dirname, '../src/engine/semeTracking.js')];
    expect(tracking).toMatch(/SEME_TRACKING_BASE_URL/);
    expect(tracking).toMatch(/\/r\?t=/);
  });
});
