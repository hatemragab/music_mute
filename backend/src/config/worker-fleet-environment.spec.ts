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
  it('enables processing with paired registry credentials only and bounds waiters', () => {
    expect(
      validateEnvironment({ ...fixture, AUDIO_PROCESSING_ENABLED: true }),
    ).toMatchObject({ PROCESSING_WORKER_MAX_WAITERS: 32 });
    expect(validateEnvironment(fixture)).not.toHaveProperty(
      'PROCESSING_WORKER_AUTH_MODE',
    );
  });
  it.each([0, 1025, 1.5])('rejects invalid waiter ceiling %s', (limit) => {
    expect(() =>
      validateEnvironment({ ...fixture, PROCESSING_WORKER_MAX_WAITERS: limit }),
    ).toThrow();
  });
});
