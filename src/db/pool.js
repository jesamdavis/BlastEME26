const { Pool } = require('pg');

// BlastEME reads/writes the SAME Postgres as SEME (shared source of truth).
// DATABASE_URL points at the SEME production DB. BlastEME owns only its own
// bulk_send_runs table and NEVER writes to any smart_send_* / flight table.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };
