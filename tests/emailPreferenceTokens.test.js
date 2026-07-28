describe('email preference tokens', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      EMAIL_PREFERENCE_TOKEN_SECRET: 'test-secret-value',
      EMAIL_PREFERENCES_BASE_URL: 'https://www.8coupons.com/email-preferences',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('builds a signed per-recipient URL without exposing email as a query parameter', () => {
    const { buildEmailPreferenceUrl } = require('../src/engine/emailPreferenceTokens');
    const url = new URL(buildEmailPreferenceUrl({
      userId: '11111111-1111-1111-1111-111111111111',
      email: 'Person@Example.com',
      nowMs: 1_700_000_000_000,
      ttlSeconds: 3600,
    }));

    expect(url.origin + url.pathname).toBe('https://www.8coupons.com/email-preferences');
    expect(url.searchParams.get('email')).toBeNull();
    expect(url.searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  test('returns a blank optional URL when the secret is not configured', () => {
    delete process.env.EMAIL_PREFERENCE_TOKEN_SECRET;
    const { buildEmailPreferenceUrl, hasConfiguredSecret } = require('../src/engine/emailPreferenceTokens');

    expect(hasConfiguredSecret()).toBe(false);
    expect(buildEmailPreferenceUrl({ userId: 'u1', email: 'a@example.com' })).toBe('');
  });
});
