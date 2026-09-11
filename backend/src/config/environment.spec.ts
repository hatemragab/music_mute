import {
  AUTH_RATE_LIMIT_DEFAULTS,
  ADMIN_RATE_LIMIT_DEFAULTS,
  environmentFile,
  validateEnvironment,
} from './environment.js';

const local = {
  APP_ENV: 'local',
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/musicmute',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
  AWS_REGION: 'us-east-1',
  S3_BUCKET: 'musicmute-local',
  FIREBASE_PROJECT_ID: 'demo-musicmute',
  FIREBASE_WEB_API_KEY: 'local-fixture-api-key',
  RATE_LIMIT_HASH_SECRET: '0123456789abcdef0123456789abcdef',
};
const production = {
  ...local,
  APP_ENV: 'production',
  NODE_ENV: 'production',
  MONGODB_URI: 'mongodb+srv://user:secret@cluster.mongodb.net/musicmute',
  REDIS_URL:
    'rediss://default:a-long-example-password@redis.example.com:6380/0',
  FIREBASE_PROJECT_ID: 'musicmute-production',
  FIREBASE_WEB_API_KEY: 'production-fixture-api-key',
  RATE_LIMIT_HASH_SECRET: 'abcdef0123456789abcdef0123456789',
};
const testEnvironment = {
  ...local,
  APP_ENV: 'test',
  NODE_ENV: 'test',
};

describe('environment boundary', () => {
  it('selects exactly one file and rejects arbitrary paths', () => {
    expect(environmentFile('local')).toBe('.env.local');
    expect(environmentFile('production')).toBe('.env.production');
    expect(() => environmentFile('../other')).toThrow();
  });
  it('parses validated defaults', () => {
    expect(validateEnvironment(local)).toMatchObject({
      PORT: 3000,
      REDIS_URL: local.REDIS_URL,
      RATE_LIMIT: 60,
      APP_ANDROID_CURRENT_VERSION_NAME: '0.1.0',
      APP_ANDROID_CURRENT_BUILD_NUMBER: 1,
      APP_IOS_CURRENT_VERSION_NAME: '0.1.0',
      APP_IOS_CURRENT_BUILD_NUMBER: 1,
      ...AUTH_RATE_LIMIT_DEFAULTS,
      ...ADMIN_RATE_LIMIT_DEFAULTS,
    });
  });
  it.each([
    ['APP_ANDROID_CURRENT_VERSION_NAME', '1.0.0-beta'],
    ['APP_IOS_CURRENT_VERSION_NAME', '01.0.0'],
    ['APP_ANDROID_CURRENT_BUILD_NUMBER', 0],
    ['APP_IOS_CURRENT_BUILD_NUMBER', 2147483648],
  ])('rejects an invalid %s release baseline', (key, value) => {
    expect(() => validateEnvironment({ ...local, [key]: value })).toThrow(
      `Invalid environment: ${key}`,
    );
  });
  it.each(Object.keys(AUTH_RATE_LIMIT_DEFAULTS))(
    'rejects an invalid %s allowance',
    (key) => {
      expect(() => validateEnvironment({ ...local, [key]: 0 })).toThrow(
        `Invalid environment: ${key}`,
      );
    },
  );
  it.each(Object.keys(ADMIN_RATE_LIMIT_DEFAULTS))(
    'rejects an invalid %s administrator limit',
    (key) => {
      expect(() => validateEnvironment({ ...local, [key]: 0 })).toThrow(
        `Invalid environment: ${key}`,
      );
    },
  );
  it('rejects an administrator reauthentication age above 300 seconds', () => {
    expect(() =>
      validateEnvironment({ ...local, ADMIN_REAUTH_MAX_AGE_SECONDS: 301 }),
    ).toThrow('Invalid environment: ADMIN_REAUTH_MAX_AGE_SECONDS');
    expect(() =>
      validateEnvironment({ ...local, ADMIN_REAUTH_MAX_AGE_SECONDS: 60 }),
    ).not.toThrow();
  });
  it.each(['0', '-1', '3.5', 'abc', '65536'])(
    'rejects invalid port %s',
    (PORT) => {
      expect(() => validateEnvironment({ ...local, PORT })).toThrow();
    },
  );
  it('requires Atlas and Redis authentication in production', () => {
    expect(() => validateEnvironment(production)).not.toThrow();
    expect(() =>
      validateEnvironment({ ...production, MONGODB_URI: local.MONGODB_URI }),
    ).toThrow();
    expect(() =>
      validateEnvironment({ ...production, REDIS_URL: local.REDIS_URL }),
    ).toThrow();
  });
  it.each([
    'redis://127.0.0.1:6379',
    'redis://127.0.0.1:6379/2',
    'rediss://default:encoded%40password%3A12345@redis.example.com:6380/0',
  ])('accepts Redis URL %s', (REDIS_URL) => {
    expect(validateEnvironment({ ...local, REDIS_URL }).REDIS_URL).toBe(
      REDIS_URL,
    );
  });
  it.each([
    undefined,
    '',
    'https://redis.example.com',
    'redis://',
    'redis://host:65536',
    'redis://host/not-a-database',
    'redis://host/-1',
    'redis://host/0/1',
    'redis://host/0?password=secret',
    'rediss://host/0#secret',
    'redis://user:bad%escape@host/0',
  ])(
    'rejects invalid Redis configuration without exposing it (%s)',
    (REDIS_URL) => {
      expect(() => validateEnvironment({ ...local, REDIS_URL })).toThrow(
        'Invalid environment: REDIS_URL',
      );
    },
  );
  it('rejects production Redis placeholders and short passwords', () => {
    expect(() =>
      validateEnvironment({
        ...production,
        REDIS_URL: 'rediss://default:CHANGE_ME@host/0',
      }),
    ).toThrow('Configure production REDIS_URL');
    expect(() =>
      validateEnvironment({
        ...production,
        REDIS_URL: 'rediss://default:short@host/0',
      }),
    ).toThrow('Production requires a Redis password of at least 16 characters');
  });
  it.each([
    'tls=false',
    'ssl=false',
    'tlsAllowInvalidCertificates=true',
    'tlsInsecure=true',
  ])('rejects Atlas TLS downgrade %s', (query) => {
    expect(() =>
      validateEnvironment({
        ...production,
        MONGODB_URI: `${production.MONGODB_URI}?${query}`,
      }),
    ).toThrow();
  });
  it('rejects unsafe CORS and proxy settings', () => {
    for (const CORS_ORIGINS of [
      '*',
      'null',
      'https://site.test/path',
      'https://site.test,',
    ]) {
      expect(() => validateEnvironment({ ...local, CORS_ORIGINS })).toThrow();
    }
    expect(() =>
      validateEnvironment({ ...local, TRUST_PROXY: 'true' }),
    ).toThrow();
    expect(() =>
      validateEnvironment({ ...production, CORS_ORIGINS: 'http://site.test' }),
    ).toThrow();
  });
  it('does not expose invalid configuration values in errors', () => {
    expect(() =>
      validateEnvironment({ ...local, MONGODB_URI: 'private-secret' }),
    ).toThrow('Invalid environment: MONGODB_URI');
  });
  it('requires Firebase and rate-limit security configuration', () => {
    for (const key of [
      'FIREBASE_PROJECT_ID',
      'FIREBASE_WEB_API_KEY',
      'RATE_LIMIT_HASH_SECRET',
    ]) {
      const input = { ...local } as Record<string, unknown>;
      delete input[key];
      expect(() => validateEnvironment(input)).toThrow(
        `Invalid environment: ${key}`,
      );
    }
  });
  it('measures the rate-limit hash secret in UTF-8 bytes', () => {
    expect(() =>
      validateEnvironment({ ...local, RATE_LIMIT_HASH_SECRET: 'a'.repeat(31) }),
    ).toThrow('RATE_LIMIT_HASH_SECRET must be at least 32 UTF-8 bytes');
    expect(() =>
      validateEnvironment({ ...local, RATE_LIMIT_HASH_SECRET: 'é'.repeat(16) }),
    ).not.toThrow();
  });
  it('recognizes an external Application Default Credentials path', () => {
    expect(
      validateEnvironment({
        ...local,
        GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/firebase-admin.json',
      }),
    ).toMatchObject({
      GOOGLE_APPLICATION_CREDENTIALS: '/run/secrets/firebase-admin.json',
    });
  });
  it('allows only a loopback Firebase emulator for demo projects in test mode', () => {
    expect(() =>
      validateEnvironment({
        ...testEnvironment,
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      }),
    ).not.toThrow();
    expect(() =>
      validateEnvironment({
        ...testEnvironment,
        FIREBASE_AUTH_EMULATOR_HOST: 'firebase-emulator:9099',
      }),
    ).toThrow('Firebase Auth emulator must use a loopback host');
    expect(() =>
      validateEnvironment({
        ...testEnvironment,
        FIREBASE_PROJECT_ID: 'musicmute-production',
        FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099',
      }),
    ).toThrow('Firebase Auth emulator requires a demo- project ID');
  });
  it.each([
    ['local', local],
    ['production', production],
  ])('rejects the Firebase Auth emulator in %s', (_, environment) => {
    expect(() =>
      validateEnvironment({
        ...environment,
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      }),
    ).toThrow('Firebase Auth emulator is allowed only in test mode');
  });
  it.each([
    'FIREBASE_PROJECT_ID',
    'FIREBASE_WEB_API_KEY',
    'RATE_LIMIT_HASH_SECRET',
  ])('rejects the %s production placeholder', (key) => {
    expect(() =>
      validateEnvironment({ ...production, [key]: 'CHANGE_ME' }),
    ).toThrow(`Configure production ${key}`);
  });
  it('cannot load production with development semantics', () => {
    expect(() =>
      validateEnvironment({ ...production, NODE_ENV: 'development' }),
    ).toThrow();
    expect(() =>
      validateEnvironment({ ...local, NODE_ENV: 'production' }),
    ).toThrow();
  });
});
