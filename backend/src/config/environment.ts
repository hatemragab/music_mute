import Joi from 'joi';

export const AUTH_RATE_LIMIT_DEFAULTS = {
  AUTH_UID_PER_MINUTE: 120,
  PROFILE_UID_PER_MINUTE: 5,
  PROFILE_IP_PER_MINUTE: 10,
  DEVICE_UID_PER_MINUTE: 10,
  LOGOUT_UID_PER_HOUR: 3,
  PROCESSING_CREATE_UID_PER_MINUTE: 30,
  PROCESSING_READ_UID_PER_MINUTE: 60,
  PROCESSING_GRANT_UID_PER_MINUTE: 60,
  PROCESSING_MUTATION_UID_PER_MINUTE: 60,
  PROCESSING_OPERATION_IP_PER_MINUTE: 120,
  PROCESSING_ENDPOINT_PER_MINUTE: 600,
  PROCESSING_SERVICE_PER_MINUTE: 2_000,
  ACCOUNT_DELETION_UID_PER_HOUR: 3,
  ACCOUNT_RECOVERY_UID_PER_HOUR: 60,
  VERIFY_COOLDOWN_SECONDS: 60,
  VERIFY_UID_PER_DAY: 3,
  VERIFY_EMAIL_PER_DAY: 3,
  VERIFY_IP_PER_HOUR: 10,
  VERIFY_PROJECT_PER_DAY: 200,
  RESET_COOLDOWN_SECONDS: 60,
  RESET_EMAIL_PER_DAY: 3,
  RESET_IP_PER_HOUR: 5,
  RESET_PROJECT_PER_DAY: 50,
} as const;

export const ADMIN_RATE_LIMIT_DEFAULTS = {
  ADMIN_READS_PER_MINUTE: 120,
  ADMIN_WRITES_PER_MINUTE: 30,
  ADMIN_MEDIA_GRANTS_PER_MINUTE: 20,
  ADMIN_SENSITIVE_OPERATIONS_PER_MINUTE: 5,
  ADMIN_EXPORTS_PER_HOUR: 5,
  ADMIN_REAUTH_MAX_AGE_SECONDS: 300,
  ADMIN_OPERATION_IP_PER_MINUTE: 60,
  ADMIN_ENDPOINT_PER_MINUTE: 300,
  ADMIN_SERVICE_PER_MINUTE: 1_000,
} as const;

export const WORKER_RATE_LIMIT_DEFAULTS = {
  WORKER_PREAUTH_IP_PER_MINUTE: 300,
  WORKER_PREAUTH_SERVICE_PER_MINUTE: 3_000,
  WORKER_MACHINE_PER_MINUTE: 300,
  WORKER_INSTALLATION_PER_MINUTE: 120,
  WORKER_ENROLLMENT_PER_MINUTE: 20,
  WORKER_STANDARD_PER_MINUTE: 120,
  WORKER_POLL_PER_MINUTE: 240,
  WORKER_TRANSFER_PER_MINUTE: 30,
  WORKER_TELEMETRY_PER_MINUTE: 30,
  WORKER_ENDPOINT_PER_MINUTE: 1_200,
  WORKER_SERVICE_PER_MINUTE: 3_000,
} as const;

const allowance = (defaultValue: number) =>
  Joi.number().integer().min(1).max(1_000_000).default(defaultValue);

export function environmentFile(environment = 'local'): string {
  if (!['local', 'production', 'test'].includes(environment))
    throw new Error('APP_ENV must be local, production or test');
  return `.env.${environment}`;
}

const schema = Joi.object({
  APP_ENV: Joi.string().valid('local', 'production', 'test').default('local'),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  HOST: Joi.string().hostname().default('127.0.0.1'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  MONGODB_URI: Joi.string()
    .pattern(/^mongodb(?:\+srv)?:\/\//)
    .required(),
  REDIS_URL: Joi.string().required(),
  AWS_REGION: Joi.string()
    .pattern(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
    .required(),
  S3_BUCKET: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .required(),
  WORKER_INSTALLATION_CATALOG_PATH: Joi.string()
    .pattern(/^\//)
    .max(4096)
    .optional(),
  FIREBASE_PROJECT_ID: Joi.string().trim().min(1).required(),
  FIREBASE_WEB_API_KEY: Joi.string().trim().min(1).required(),
  FIREBASE_SERVICE_ACCOUNT_BASE64: Joi.string().trim().base64().optional(),
  RATE_LIMIT_HASH_SECRET: Joi.string().required(),
  GOOGLE_APPLICATION_CREDENTIALS: Joi.string().min(1).optional(),
  FIREBASE_AUTH_EMULATOR_HOST: Joi.string().min(1).optional(),
  AUDIO_PROCESSING_ENABLED: Joi.boolean().default(false),
  APK_AAPT2_PATH: Joi.string().pattern(/^\//).max(4096).optional(),
  APK_APKSIGNER_PATH: Joi.string().pattern(/^\//).max(4096).optional(),
  APK_EXPECTED_PACKAGE_ID: Joi.string()
    .pattern(/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/)
    .max(255)
    .optional(),
  APK_TRUSTED_SIGNER_SHA256: Joi.string()
    .pattern(/^[a-f0-9]{64}(?:,[a-f0-9]{64}){0,9}$/)
    .optional(),
  APK_MAX_MIN_SDK: Joi.number().integer().min(1).max(100).default(26),
  APP_UPDATES_ENABLED: Joi.boolean().default(false),
  APP_RELEASE_DOWNLOAD_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(600)
    .default(300),
  APP_ANDROID_CURRENT_VERSION_NAME: Joi.string()
    .pattern(/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/)
    .max(64)
    .default('0.1.0'),
  APP_ANDROID_CURRENT_BUILD_NUMBER: Joi.number()
    .integer()
    .min(1)
    .max(2147483647)
    .default(1),
  APP_IOS_CURRENT_VERSION_NAME: Joi.string()
    .pattern(/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/)
    .max(64)
    .default('0.1.0'),
  APP_IOS_CURRENT_BUILD_NUMBER: Joi.number()
    .integer()
    .min(1)
    .max(2147483647)
    .default(1),
  IOS_APP_STORE_ID: Joi.string()
    .pattern(/^[1-9][0-9]{4,19}$/)
    .optional(),
  RELEASE_LANDING_BASE_URL: Joi.string()
    .uri({ scheme: ['https'] })
    .optional(),
  PROCESSING_URL_SECONDS: Joi.number().integer().min(60).max(600).default(600),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  PUBLIC_SUPPORT_EMAIL: Joi.string()
    .email({ tlds: { allow: false } })
    .max(254)
    .optional(),
  PUBLIC_DEVELOPER_NAME: Joi.string().trim().min(1).max(160).optional(),
  PUBLIC_DELETION_TIMEFRAME: Joi.string().trim().min(1).max(1000).optional(),
  PUBLIC_RETENTION_NOTICE: Joi.string().trim().min(1).max(4000).optional(),
  TRUST_PROXY: Joi.string().valid('false', '1').default('false'),
  RATE_LIMIT: Joi.number().integer().min(1).max(10000).default(60),
  PUBLIC_RELEASE_GRANTS_PER_MINUTE: allowance(300),
  RATE_IP_CEILING_PER_MINUTE: allowance(600),
  RATE_TTL_MS: Joi.number().integer().min(1000).max(3600000).default(60000),
  AUTH_UID_PER_MINUTE: allowance(AUTH_RATE_LIMIT_DEFAULTS.AUTH_UID_PER_MINUTE),
  PROCESSING_READ_UID_PER_MINUTE: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.PROCESSING_READ_UID_PER_MINUTE,
  ),
  PROFILE_UID_PER_MINUTE: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.PROFILE_UID_PER_MINUTE,
  ),
  PROFILE_IP_PER_MINUTE: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.PROFILE_IP_PER_MINUTE,
  ),
  DEVICE_UID_PER_MINUTE: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.DEVICE_UID_PER_MINUTE,
  ),
  LOGOUT_UID_PER_HOUR: allowance(AUTH_RATE_LIMIT_DEFAULTS.LOGOUT_UID_PER_HOUR),
  PROCESSING_CREATE_UID_PER_MINUTE: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.PROCESSING_CREATE_UID_PER_MINUTE,
  ),
  PROCESSING_GRANT_UID_PER_MINUTE: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.PROCESSING_GRANT_UID_PER_MINUTE,
  ),
  PROCESSING_MUTATION_UID_PER_MINUTE: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.PROCESSING_MUTATION_UID_PER_MINUTE,
  ),
  PROCESSING_OPERATION_IP_PER_MINUTE: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.PROCESSING_OPERATION_IP_PER_MINUTE,
  ),
  PROCESSING_ENDPOINT_PER_MINUTE: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.PROCESSING_ENDPOINT_PER_MINUTE,
  ),
  PROCESSING_SERVICE_PER_MINUTE: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.PROCESSING_SERVICE_PER_MINUTE,
  ),
  ACCOUNT_DELETION_UID_PER_HOUR: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.ACCOUNT_DELETION_UID_PER_HOUR,
  ),
  ACCOUNT_RECOVERY_UID_PER_HOUR: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.ACCOUNT_RECOVERY_UID_PER_HOUR,
  ),
  VERIFY_COOLDOWN_SECONDS: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.VERIFY_COOLDOWN_SECONDS,
  ),
  VERIFY_UID_PER_DAY: allowance(AUTH_RATE_LIMIT_DEFAULTS.VERIFY_UID_PER_DAY),
  VERIFY_EMAIL_PER_DAY: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.VERIFY_EMAIL_PER_DAY,
  ),
  VERIFY_IP_PER_HOUR: allowance(AUTH_RATE_LIMIT_DEFAULTS.VERIFY_IP_PER_HOUR),
  VERIFY_PROJECT_PER_DAY: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.VERIFY_PROJECT_PER_DAY,
  ),
  RESET_COOLDOWN_SECONDS: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.RESET_COOLDOWN_SECONDS,
  ),
  RESET_EMAIL_PER_DAY: allowance(AUTH_RATE_LIMIT_DEFAULTS.RESET_EMAIL_PER_DAY),
  RESET_IP_PER_HOUR: allowance(AUTH_RATE_LIMIT_DEFAULTS.RESET_IP_PER_HOUR),
  RESET_PROJECT_PER_DAY: allowance(
    AUTH_RATE_LIMIT_DEFAULTS.RESET_PROJECT_PER_DAY,
  ),
  ADMIN_READS_PER_MINUTE: allowance(
    ADMIN_RATE_LIMIT_DEFAULTS.ADMIN_READS_PER_MINUTE,
  ),
  ADMIN_WRITES_PER_MINUTE: allowance(
    ADMIN_RATE_LIMIT_DEFAULTS.ADMIN_WRITES_PER_MINUTE,
  ),
  ADMIN_MEDIA_GRANTS_PER_MINUTE: allowance(
    ADMIN_RATE_LIMIT_DEFAULTS.ADMIN_MEDIA_GRANTS_PER_MINUTE,
  ),
  ADMIN_SENSITIVE_OPERATIONS_PER_MINUTE: allowance(
    ADMIN_RATE_LIMIT_DEFAULTS.ADMIN_SENSITIVE_OPERATIONS_PER_MINUTE,
  ),
  ADMIN_EXPORTS_PER_HOUR: allowance(
    ADMIN_RATE_LIMIT_DEFAULTS.ADMIN_EXPORTS_PER_HOUR,
  ),
  ADMIN_OPERATION_IP_PER_MINUTE: allowance(
    ADMIN_RATE_LIMIT_DEFAULTS.ADMIN_OPERATION_IP_PER_MINUTE,
  ),
  ADMIN_ENDPOINT_PER_MINUTE: allowance(
    ADMIN_RATE_LIMIT_DEFAULTS.ADMIN_ENDPOINT_PER_MINUTE,
  ),
  ADMIN_SERVICE_PER_MINUTE: allowance(
    ADMIN_RATE_LIMIT_DEFAULTS.ADMIN_SERVICE_PER_MINUTE,
  ),
  ADMIN_REAUTH_MAX_AGE_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(300)
    .default(ADMIN_RATE_LIMIT_DEFAULTS.ADMIN_REAUTH_MAX_AGE_SECONDS),
  ...Object.fromEntries(
    Object.entries(WORKER_RATE_LIMIT_DEFAULTS).map(([key, value]) => [
      key,
      allowance(value),
    ]),
  ),
  BODY_LIMIT_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(1048576)
    .default(65536),
}).unknown(true);

export function validateEnvironment(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result = schema.validate(input, { abortEarly: false });
  if (result.error) {
    // Report keys only: Joi messages can contain submitted secrets.
    throw new Error(
      `Invalid environment: ${result.error.details.map((detail) => detail.path.join('.')).join(', ')}`,
    );
  }
  const env = result.value as Record<string, unknown>;
  const production = env.APP_ENV === 'production';
  if (production !== (env.NODE_ENV === 'production'))
    throw new Error('APP_ENV and NODE_ENV disagree');
  if (production) {
    for (const key of [
      'MONGODB_URI',
      'REDIS_URL',
      'S3_BUCKET',
      'FIREBASE_PROJECT_ID',
      'FIREBASE_WEB_API_KEY',
      'RATE_LIMIT_HASH_SECRET',
    ]) {
      if (/CHANGE_ME/i.test(String(env[key])))
        throw new Error(`Configure production ${key}`);
    }
  }
  if (Buffer.byteLength(String(env.RATE_LIMIT_HASH_SECRET), 'utf8') < 32)
    throw new Error('RATE_LIMIT_HASH_SECRET must be at least 32 UTF-8 bytes');
  if (env.FIREBASE_AUTH_EMULATOR_HOST !== undefined) {
    if (env.APP_ENV !== 'test')
      throw new Error('Firebase Auth emulator is allowed only in test mode');
    const emulator = String(env.FIREBASE_AUTH_EMULATOR_HOST);
    const loopback = /^(?:localhost|127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/.exec(
      emulator,
    );
    if (!loopback || Number(loopback[1]) > 65535)
      throw new Error('Firebase Auth emulator must use a loopback host');
    if (!String(env.FIREBASE_PROJECT_ID).startsWith('demo-'))
      throw new Error('Firebase Auth emulator requires a demo- project ID');
  }
  let redis: URL;
  try {
    const value = String(env.REDIS_URL);
    redis = new URL(value);
    if (
      !/^rediss?:\/\//.test(value) ||
      /\s/.test(value) ||
      !redis.hostname ||
      (redis.port && (Number(redis.port) < 1 || Number(redis.port) > 65535)) ||
      !/^\/(?:\d+)?$|^$/.test(redis.pathname) ||
      (redis.pathname.length > 1 &&
        !Number.isSafeInteger(Number(redis.pathname.slice(1)))) ||
      value.includes('?') ||
      value.includes('#')
    )
      throw new Error('Invalid Redis URL');
    decodeURIComponent(redis.username);
    decodeURIComponent(redis.password);
  } catch {
    throw new Error('Invalid environment: REDIS_URL');
  }
  let database: URL;
  try {
    database = new URL(String(env.MONGODB_URI));
  } catch {
    throw new Error('Invalid environment: MONGODB_URI');
  }
  if (!database.hostname || database.pathname.length < 2)
    throw new Error('MONGODB_URI must include a database name');
  if (production) {
    if (
      database.protocol !== 'mongodb+srv:' ||
      !database.hostname.endsWith('.mongodb.net')
    )
      throw new Error('Production requires an Atlas mongodb+srv URI');
    for (const [key, value] of database.searchParams) {
      const option = key.toLowerCase();
      if (
        (['tls', 'ssl'].includes(option) && value.toLowerCase() !== 'true') ||
        option.startsWith('tlsallow') ||
        option === 'tlsinsecure'
      )
        throw new Error('Production MongoDB must verify TLS');
    }
    if (decodeURIComponent(redis.password).length < 16)
      throw new Error(
        'Production requires a Redis password of at least 16 characters',
      );
  }
  for (const origin of String(env.CORS_ORIGINS)
    ? String(env.CORS_ORIGINS).split(',')
    : []) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('Invalid CORS_ORIGINS');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== origin ||
      (production && url.protocol !== 'https:')
    )
      throw new Error(
        'CORS_ORIGINS must contain exact origins; production requires HTTPS',
      );
  }
  return env;
}
