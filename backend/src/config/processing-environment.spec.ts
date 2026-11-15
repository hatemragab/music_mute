import { validateEnvironment } from './environment.js';

const base = {
  APP_ENV: 'test',
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/fixture',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
  AWS_REGION: 'us-east-1',
  S3_BUCKET: 'fixture-bucket',
  FIREBASE_PROJECT_ID: 'demo-fixture',
  FIREBASE_WEB_API_KEY: 'fixture-key',
  RATE_LIMIT_HASH_SECRET: 'x'.repeat(32),
};

describe('processing configuration', () => {
  it('keeps processing disabled by default', () => {
    expect(validateEnvironment(base).AUDIO_PROCESSING_ENABLED).toBe(false);
  });
  it('parses an enabled deployment with a bounded transfer default', () => {
    expect(
      validateEnvironment({
        ...base,
        AUDIO_PROCESSING_ENABLED: 'true',
      }),
    ).toMatchObject({
      AUDIO_PROCESSING_ENABLED: true,
      PROCESSING_URL_SECONDS: 600,
    });
  });
  it('rejects an invalid transfer lifetime', () => {
    const key = 'PROCESSING_URL_SECONDS';
    expect(() => validateEnvironment({ ...base, [key]: -1 })).toThrow(key);
    expect(() => validateEnvironment({ ...base, [key]: 601 })).toThrow(key);
  });
});
