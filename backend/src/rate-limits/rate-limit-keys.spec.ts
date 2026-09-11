import { ConfigService } from '@nestjs/config';
import { RateLimitKeys } from './rate-limit-keys.js';

describe('RateLimitKeys', () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const keys = new RateLimitKeys(
    new ConfigService({
      FIREBASE_PROJECT_ID: 'demo-musicmute',
      RATE_LIMIT_HASH_SECRET: secret,
    }),
  );

  it('uses deterministic, project-scoped HMAC keys without exposing identifiers', () => {
    const first = keys.bucket('verify-email-day', 'private@example.test');
    const second = keys.bucket('verify-email-day', 'private@example.test');

    expect(first).toBe(second);
    expect(first).toMatch(
      /^musicmute:rate:\{[a-f0-9]{64}\}:verify-email-day:[a-f0-9]{64}$/,
    );
    expect(first).not.toContain('private');
    expect(first).not.toContain('example.test');
  });

  it('domain-separates scopes and projects', () => {
    expect(keys.bucket('verify-email-day', 'same')).not.toBe(
      keys.bucket('reset-email-day', 'same'),
    );
    const anotherProject = new RateLimitKeys(
      new ConfigService({
        FIREBASE_PROJECT_ID: 'another-project',
        RATE_LIMIT_HASH_SECRET: secret,
      }),
    );
    expect(anotherProject.bucket('verify-email-day', 'same')).not.toBe(
      keys.bucket('verify-email-day', 'same'),
    );
  });

  it('rejects unsafe namespaces and empty identifiers', () => {
    expect(() => keys.bucket('unsafe:{scope}', 'value')).toThrow();
    expect(() => keys.bucket('safe-scope', '')).toThrow();
  });
});
