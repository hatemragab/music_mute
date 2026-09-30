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
  it('defaults URL imports to twenty active executions with a bounded waiting backlog', () => {
    expect(validateEnvironment(base)).toMatchObject({
      URL_IMPORT_CONCURRENCY: 20,
      URL_IMPORT_REQUESTS_PER_SECOND: 5,
      URL_IMPORT_MAX_OUTSTANDING: 100,
    });
  });
  it.each([
    ['URL_IMPORT_CONCURRENCY', 0],
    ['URL_IMPORT_CONCURRENCY', 21],
    ['URL_IMPORT_CONCURRENCY', 1.5],
    ['URL_IMPORT_REQUESTS_PER_SECOND', 0],
    ['URL_IMPORT_REQUESTS_PER_SECOND', 6],
    ['URL_IMPORT_REQUESTS_PER_SECOND', 1.5],
    ['URL_IMPORT_MAX_OUTSTANDING', 0],
    ['URL_IMPORT_MAX_OUTSTANDING', 101],
  ])('rejects invalid %s capacity %s', (key, value) => {
    expect(() => validateEnvironment({ ...base, [key]: value })).toThrow(key);
  });
  it('allows reducing shared URL import throughput', () => {
    expect(
      validateEnvironment({
        ...base,
        URL_IMPORT_CONCURRENCY: '2',
        URL_IMPORT_REQUESTS_PER_SECOND: '1',
        URL_IMPORT_MAX_OUTSTANDING: '20',
      }),
    ).toMatchObject({
      URL_IMPORT_CONCURRENCY: 2,
      URL_IMPORT_REQUESTS_PER_SECOND: 1,
      URL_IMPORT_MAX_OUTSTANDING: 20,
    });
  });
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
