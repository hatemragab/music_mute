import { describe, expect, it } from 'vitest';
import { validateEnvironment } from '../config/environment.js';

const base = {
  APP_ENV: 'test',
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/fixture',
  REDIS_URL: 'redis://127.0.0.1:6379',
  AWS_REGION: 'us-east-1',
  S3_BUCKET: 'fixture-private',
  FIREBASE_PROJECT_ID: 'demo-fixture',
  FIREBASE_WEB_API_KEY: 'synthetic-fixture-key',
  RATE_LIMIT_HASH_SECRET: 'synthetic-fixture-32-byte-secret-value',
};
describe('APK verifier configuration', () => {
  it('allows existing API operation without verifier configuration', () => {
    expect(validateEnvironment(base).APK_AAPT2_PATH).toBeUndefined();
  });
  it.each([
    { APK_AAPT2_PATH: 'aapt2' },
    { APK_APKSIGNER_PATH: 'bin/apksigner' },
    { APK_EXPECTED_PACKAGE_ID: 'not a package' },
    { APK_TRUSTED_SIGNER_SHA256: 'untrusted-uploaded-value' },
    { APK_MAX_MIN_SDK: 0 },
    { APK_MAX_MIN_SDK: 1.5 },
  ])('rejects unsafe verifier settings %j', (patch) => {
    expect(() => validateEnvironment({ ...base, ...patch })).toThrow();
  });
});
