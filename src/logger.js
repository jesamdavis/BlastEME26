// Minimal logger — stdout/stderr, timestamped.
function ts() { return new Date().toISOString(); }
module.exports = {
  info: (...a) => console.log(`[${ts()}] [blasteme]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] [blasteme] WARN`, ...a),
  error: (...a) => console.error(`[${ts()}] [blasteme] ERROR`, ...a),
};
