const DEFAULT_GLOBAL_COOLDOWN_HOURS = 24;

const DISABLED_VALUES = new Set(['false', '0', 'off', 'no']);

function getGlobalCooldownConfig(env = process.env) {
  const rawEnabled = String(
    env.BLASTEME_ENFORCE_GLOBAL_COOLDOWN ?? 'true'
  ).trim().toLowerCase();
  const enabled = !DISABLED_VALUES.has(rawEnabled);

  const rawHours = Number(
    env.BLASTEME_GLOBAL_COOLDOWN_HOURS ?? DEFAULT_GLOBAL_COOLDOWN_HOURS
  );
  const hours = Number.isFinite(rawHours) && rawHours > 0
    ? rawHours
    : DEFAULT_GLOBAL_COOLDOWN_HOURS;

  return { enabled, hours };
}

module.exports = {
  DEFAULT_GLOBAL_COOLDOWN_HOURS,
  getGlobalCooldownConfig,
};
