import { validateEnvironment } from './environment.js';

const fixture = {
  APP_ENV: 'test',
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/fleet',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
  AWS_REGION: 'us-east-1',
  S3_BUCKET: 'fleet-fixture',
  FIREBASE_PROJECT_ID: 'demo-fleet',
  FIREBASE_WEB_API_KEY: 'fixture',
  RATE_LIMIT_HASH_SECRET: 'f'.repeat(32),
};

describe('fleet environment', () => {
  it('defaults to explicit legacy authentication and 32 waiters', () => {
    expect(validateEnvironment(fixture)).toMatchObject({
      PROCESSING_WORKER_AUTH_MODE: 'legacy',
      PROCESSING_WORKER_MAX_WAITERS: 32,
    });
  });
  it('requires the environment digest in enabled legacy mode only', () => {
    expect(() =>
      validateEnvironment({ ...fixture, AUDIO_PROCESSING_ENABLED: true }),
    ).toThrow();
    expect(() =>
      validateEnvironment({
        ...fixture,
        AUDIO_PROCESSING_ENABLED: true,
        PROCESSING_WORKER_AUTH_MODE: 'fleet',
      }),
    ).not.toThrow();
  });
  it.each([0, 1025, 1.5])('rejects invalid waiter ceiling %s', (limit) => {
    expect(() =>
      validateEnvironment({ ...fixture, PROCESSING_WORKER_MAX_WAITERS: limit }),
    ).toThrow();
  });
  it('rejects unknown authentication modes', () => {
    expect(() =>
      validateEnvironment({
        ...fixture,
        PROCESSING_WORKER_AUTH_MODE: 'fallback',
      }),
    ).toThrow();
  });
});
