const {
  DEFAULT_GLOBAL_COOLDOWN_HOURS,
  getGlobalCooldownConfig,
} = require('../src/config/cooldown');

describe('BlastEME global cooldown configuration', () => {
  test('defaults to enabled for 24 hours', () => {
    expect(getGlobalCooldownConfig({})).toEqual({
      enabled: true,
      hours: DEFAULT_GLOBAL_COOLDOWN_HOURS,
    });
  });

  test.each(['false', '0', 'off', 'no', 'FALSE']) (
    'disables the cooldown for %s',
    value => {
      expect(getGlobalCooldownConfig({
        BLASTEME_ENFORCE_GLOBAL_COOLDOWN: value,
      }).enabled).toBe(false);
    }
  );

  test('accepts a positive cooldown-hour override', () => {
    expect(getGlobalCooldownConfig({
      BLASTEME_GLOBAL_COOLDOWN_HOURS: '6',
    })).toEqual({ enabled: true, hours: 6 });
  });

  test.each(['0', '-1', 'not-a-number']) (
    'falls back to 24 hours for invalid value %s',
    value => {
      expect(getGlobalCooldownConfig({
        BLASTEME_GLOBAL_COOLDOWN_HOURS: value,
      }).hours).toBe(DEFAULT_GLOBAL_COOLDOWN_HOURS);
    }
  );
});
