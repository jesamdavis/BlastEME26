const express = require('express');
const { ensureTables } = require('./engine/run');
const routes = require('./api/routes');
const logger = require('./logger');

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ ok: true, service: 'blasteme' }));
app.get('/selftest', (req, res) => res.json({
  ok: true,
  service: 'blasteme',
  started_at: START_TIME,
  seme_tracking_base_url_set: Boolean(process.env.SEME_TRACKING_BASE_URL),
  sendgrid_from: process.env.SENDGRID_FROM_EMAIL || null,
  prod_send_enabled: String(process.env.BLASTEME_ALLOW_PROD_SEND || '').toLowerCase() === 'true',
}));

app.use('/api/bulk', routes);

const START_TIME = new Date().toISOString();
const PORT = process.env.PORT || 3000;

ensureTables()
  .then(() => app.listen(PORT, () => logger.info(`BlastEME listening on ${PORT}`)))
  .catch(err => { logger.error(`boot failed: ${err.message}`); process.exit(1); });
