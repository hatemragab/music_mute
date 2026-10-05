import {
  AUTH_RATE_LIMIT_DEFAULTS,
  ADMIN_RATE_LIMIT_DEFAULTS,
  environmentFile,
  validateEnvironment,
} from './environment.js';
import { PUBLIC_POLICY_DEFAULTS } from './public-policy.js';

const local = {
  APP_ENV: 'local',
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/musicmute',
  REDIS_URL: 'redis://127.0.0.1:6379/0',
  STORAGE_PROVIDER: 'r2',
  STORAGE_ENDPOINT:
    'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  STORAGE_REGION: 'auto',
  STORAGE_ACCESS_KEY_ID: 'fixture-access-key',
  STORAGE_SECRET_ACCESS_KEY: 'fixture-secret-key',
  STORAGE_BUCKET: 'musicmute-local',
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
  it('keeps Desktop Google exchange disabled when both optional credentials are absent', () => {
    const config = validateEnvironment(local);
    expect(config.GOOGLE_DESKTOP_CLIENT_ID).toBeUndefined();
    expect(config.GOOGLE_DESKTOP_CLIENT_SECRET).toBeUndefined();
    expect(config.DESKTOP_GOOGLE_EXCHANGE_IP_PER_MINUTE).toBe(10);
    expect(config.DESKTOP_GOOGLE_EXCHANGE_SERVICE_PER_MINUTE).toBe(300);
  });
  it('accepts a fixed Desktop client pair without modifying existing Firebase settings', () => {
    expect(
      validateEnvironment({
        ...local,
        GOOGLE_DESKTOP_CLIENT_ID: '123-fixture.apps.googleusercontent.com',
        GOOGLE_DESKTOP_CLIENT_SECRET: 'fixture-only-client-secret',
      }),
    ).toMatchObject({
      GOOGLE_DESKTOP_CLIENT_ID: '123-fixture.apps.googleusercontent.com',
      FIREBASE_PROJECT_ID: local.FIREBASE_PROJECT_ID,
    });
  });
  it.each([
    { GOOGLE_DESKTOP_CLIENT_ID: '123-fixture.apps.googleusercontent.com' },
    { GOOGLE_DESKTOP_CLIENT_SECRET: 'fixture-only-client-secret' },
    {
      GOOGLE_DESKTOP_CLIENT_ID: 'https://private.invalid',
      GOOGLE_DESKTOP_CLIENT_SECRET: 'fixture-only-client-secret',
    },
    {
      GOOGLE_DESKTOP_CLIENT_ID: '123-fixture.apps.googleusercontent.com',
      GOOGLE_DESKTOP_CLIENT_SECRET: 'private\nsecret',
    },
    {
      GOOGLE_DESKTOP_CLIENT_ID: '123-fixture.apps.googleusercontent.com\n',
      GOOGLE_DESKTOP_CLIENT_SECRET: 'fixture-only-client-secret',
    },
    {
      GOOGLE_DESKTOP_CLIENT_ID: '123-fixture.apps.googleusercontent.com',
      GOOGLE_DESKTOP_CLIENT_SECRET: 'fixture-only-client-secret\n',
    },
  ])(
    'fails partial or malformed Desktop configuration with key-only errors',
    (config) => {
      let error: unknown;
      try {
        validateEnvironment({ ...local, ...config });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('GOOGLE_DESKTOP_CLIENT_');
      expect((error as Error).message).not.toContain(
        'fixture-only-client-secret',
      );
      expect((error as Error).message).not.toContain('private');
    },
  );
  it.each([
    'DESKTOP_GOOGLE_EXCHANGE_IP_PER_MINUTE',
    'DESKTOP_GOOGLE_EXCHANGE_SERVICE_PER_MINUTE',
  ])('centrally bounds %s', (key) => {
    for (const value of [0, -1, 1.5, 1_000_001])
      expect(() => validateEnvironment({ ...local, [key]: value })).toThrow(
        key,
      );
  });
  it('selects exactly one file and rejects arbitrary paths', () => {
    expect(environmentFile('local')).toBe('.env.local');
    expect(environmentFile('production')).toBe('.env.production');
    expect(() => environmentFile('../other')).toThrow();
  });
  it('parses validated defaults', () => {
    expect(validateEnvironment(local)).toMatchObject({
      PORT: 3000,
      STORAGE_PROVIDER: 'r2',
      STORAGE_REGION: 'auto',
      REDIS_URL: local.REDIS_URL,
      RATE_LIMIT: 60,
      APP_ANDROID_CURRENT_VERSION_NAME: '0.1.0',
      APP_ANDROID_CURRENT_BUILD_NUMBER: 1,
      APP_IOS_CURRENT_VERSION_NAME: '0.1.0',
      APP_IOS_CURRENT_BUILD_NUMBER: 1,
      APP_RELEASE_DOWNLOAD_SECONDS: 300,
      PUBLIC_SITE_ORIGIN: PUBLIC_POLICY_DEFAULTS.publicOrigin,
      PUBLIC_SUPPORT_EMAIL: PUBLIC_POLICY_DEFAULTS.supportEmail,
      PUBLIC_DEVELOPER_NAME: PUBLIC_POLICY_DEFAULTS.developerName,
      PUBLIC_DELETION_TIMEFRAME: PUBLIC_POLICY_DEFAULTS.deletionTimeframe,
      PUBLIC_RETENTION_NOTICE: PUBLIC_POLICY_DEFAULTS.retentionNotice,
      ...AUTH_RATE_LIMIT_DEFAULTS,
      ...ADMIN_RATE_LIMIT_DEFAULTS,
    });
  });
  it.each([
    'http://api.music-mute.com',
    'https://user:password@api.music-mute.com',
    'https://api.music-mute.com/privacy',
    'https://api.music-mute.com?source=play',
    'https://api.music-mute.com/#privacy',
  ])('rejects an unsafe public site origin %s', (PUBLIC_SITE_ORIGIN) => {
    expect(() => validateEnvironment({ ...local, PUBLIC_SITE_ORIGIN })).toThrow(
      'Invalid environment: PUBLIC_SITE_ORIGIN',
    );
  });
  it('accepts bounded public policy overrides', () => {
    expect(
      validateEnvironment({
        ...local,
        PUBLIC_SITE_ORIGIN: 'https://policy.example.test',
        PUBLIC_SUPPORT_EMAIL: 'privacy@example.test',
        PUBLIC_DEVELOPER_NAME: 'Example Developer',
        PUBLIC_DELETION_TIMEFRAME: 'Example deletion timeframe.',
        PUBLIC_RETENTION_NOTICE: 'Example retention notice.',
      }),
    ).toMatchObject({
      PUBLIC_SITE_ORIGIN: 'https://policy.example.test',
      PUBLIC_SUPPORT_EMAIL: 'privacy@example.test',
      PUBLIC_DEVELOPER_NAME: 'Example Developer',
      PUBLIC_DELETION_TIMEFRAME: 'Example deletion timeframe.',
      PUBLIC_RETENTION_NOTICE: 'Example retention notice.',
    });
  });
  it.each([
    'STORAGE_PROVIDER',
    'STORAGE_ENDPOINT',
    'STORAGE_REGION',
    'STORAGE_BUCKET',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
  ])('requires explicit %s without cloud credential fallbacks', (key) => {
    const config = { ...local, [key]: undefined };
    expect(() => validateEnvironment(config)).toThrow(
      `Invalid environment: ${key}`,
    );
  });
  it.each([
    'https://example.com',
    local.STORAGE_ENDPOINT + '/music-mute',
    local.STORAGE_ENDPOINT + '/',
    local.STORAGE_ENDPOINT + '?q=x',
    'http://localhost:9000',
    'https://user:secret@0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  ])('rejects non-account-root R2 endpoint %s', (STORAGE_ENDPOINT) => {
    expect(() => validateEnvironment({ ...local, STORAGE_ENDPOINT })).toThrow(
      'Invalid environment: STORAGE_ENDPOINT',
    );
  });
  it.each([
    ['STORAGE_PROVIDER', 's3'],
    ['STORAGE_REGION', 'WEUR'],
    ['AWS_REGION', 'eu-west-1'],
    ['AWS_ACCESS_KEY_ID', 'old-key'],
    ['S3_BUCKET', 'old-bucket'],
    ['S3_TRANSFER_ACCELERATION_ENABLED', false],
  ])('fails clearly on obsolete or invalid %s', (key, value) => {
    expect(() => validateEnvironment({ ...local, [key]: value })).toThrow(
      `Invalid environment: ${key}`,
    );
  });
  it('accepts only an absolute optional worker installation catalog path', () => {
    expect(
      validateEnvironment({
        ...local,
        WORKER_INSTALLATION_CATALOG_PATH: '/run/musicmute/worker-catalog.json',
      }).WORKER_INSTALLATION_CATALOG_PATH,
    ).toBe('/run/musicmute/worker-catalog.json');
    expect(() =>
      validateEnvironment({
        ...local,
        WORKER_INSTALLATION_CATALOG_PATH: 'worker-catalog.json',
      }),
    ).toThrow('Invalid environment: WORKER_INSTALLATION_CATALOG_PATH');
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
  it.each([59, 901, 120.5])(
    'rejects invalid APK download lifetime %s',
    (APP_RELEASE_DOWNLOAD_SECONDS) => {
      expect(() =>
        validateEnvironment({ ...local, APP_RELEASE_DOWNLOAD_SECONDS }),
      ).toThrow('Invalid environment: APP_RELEASE_DOWNLOAD_SECONDS');
    },
  );
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
