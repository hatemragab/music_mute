const SAFE_STARTUP_MESSAGES = new Set([
  'APP_ENV must be local, production or test',
  'APP_ENV and NODE_ENV disagree',
  'RATE_LIMIT_HASH_SECRET must be at least 32 UTF-8 bytes',
  'Firebase Auth emulator is allowed only in test mode',
  'Firebase Auth emulator must use a loopback host',
  'Firebase Auth emulator requires a demo- project ID',
  'Invalid Redis URL',
  'Invalid environment: REDIS_URL',
  'Invalid environment: MONGODB_URI',
  'MONGODB_URI must include a database name',
  'Production requires an Atlas mongodb+srv URI',
  'Production MongoDB must verify TLS',
  'Production requires a Redis password of at least 16 characters',
  'Invalid CORS_ORIGINS',
  'CORS_ORIGINS must contain exact origins; production requires HTTPS',
  'Existing Firebase Admin app project does not match FIREBASE_PROJECT_ID',
  'Invalid FIREBASE_SERVICE_ACCOUNT_BASE64',
  'FIREBASE_SERVICE_ACCOUNT_BASE64 project does not match FIREBASE_PROJECT_ID',
  'Audio processing MongoDB capability check failed',
  'Audio processing requires a writable MongoDB replica set with sessions',
  'Audio processing schema initialization failed',
  'Storage bucket preflight failed',
]);

const SAFE_ENVIRONMENT_FAILURE =
  /^(?:Invalid environment: [A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*|Configure production [A-Z][A-Z0-9_]*)$/;

const SAFE_DEPENDENCY_STAGES = new Set([
  'Audio processing MongoDB capability check failed',
  'Audio processing schema initialization failed',
  'User schema initialization failed',
  'Device schema initialization failed',
  'Device installation owner schema initialization failed',
  'User identity fence schema initialization failed',
  ...[
    'GetBucketLocation',
    'GetBucketVersioning',
    'GetPublicAccessBlock',
    'GetBucketPolicyStatus',
    'GetBucketAcl',
    'GetBucketLifecycleConfiguration',
    'bucket region does not match AWS_REGION',
    'versioning must be Enabled',
    'all four public access blocks must be enabled',
    'bucket policy must be confirmed private',
    'bucket ACL must be confirmed private',
    'lifecycle configuration could not be verified',
    'lifecycle expiration rules are not allowed',
  ].map((step) => `Storage bucket preflight failed: ${step}`),
]);

const SAFE_PROVIDER_CODES = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'InvalidToken',
  'NoSuchBucket',
  'PermanentRedirect',
  'AuthorizationHeaderMalformed',
  'CredentialsProviderError',
  'TimeoutError',
  'AbortError',
  'NetworkingError',
  'RequestTimeout',
  'SlowDown',
  'ServiceUnavailable',
  'InternalError',
  'MongoServerError',
  'MongoNetworkError',
  'MongoServerSelectionError',
  'MongooseServerSelectionError',
  'MongoTopologyClosedError',
  'ECONNREFUSED',
  'EACCES',
  'EADDRINUSE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ECONNRESET',
]);

function safeProviderCodes(error: Error): string[] {
  const provider = error as Error & {
    code?: unknown;
  };
  const parts: string[] = [];
  if (SAFE_PROVIDER_CODES.has(provider.name)) parts.push(provider.name);
  if (
    typeof provider.code === 'string' &&
    SAFE_PROVIDER_CODES.has(provider.code) &&
    !parts.includes(provider.code)
  )
    parts.push(provider.code);
  return parts;
}

function providerSummary(error: unknown): string {
  if (!(error instanceof Error)) return 'unclassified provider error';
  const provider = error as Error & {
    code?: unknown;
    indexName?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const parts = safeProviderCodes(error);
  if (
    typeof provider.code === 'number' &&
    Number.isSafeInteger(provider.code) &&
    provider.code >= 0 &&
    provider.code <= 2_147_483_647
  )
    parts.push(`code ${provider.code}`);
  if (
    provider.code === 86 &&
    typeof provider.indexName === 'string' &&
    /^[A-Za-z0-9_.-]{1,128}$/.test(provider.indexName)
  )
    parts.push(`index ${provider.indexName}`);
  const status = provider.$metadata?.httpStatusCode;
  if (
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
  )
    parts.push(`HTTP ${status}`);
  return parts.join(', ') || 'unclassified provider error';
}

/** Only fixed stage labels and allowlisted provider codes may reach startup logs. */
export class StartupDependencyError extends Error {
  readonly #diagnostic: string;
  constructor(stage: string, provider?: unknown) {
    const diagnostic = SAFE_DEPENDENCY_STAGES.has(stage)
      ? stage +
        (provider === undefined ? '' : ` (${providerSummary(provider)})`)
      : 'Unexpected startup error';
    super(diagnostic);
    this.#diagnostic = diagnostic;
  }
  get diagnostic(): string {
    return this.#diagnostic;
  }
}

export function startupFailureReason(error: unknown): string {
  if (error instanceof StartupDependencyError) return error.diagnostic;
  if (!(error instanceof Error)) return 'Unknown startup error';
  if (
    SAFE_STARTUP_MESSAGES.has(error.message) ||
    SAFE_ENVIRONMENT_FAILURE.test(error.message)
  )
    return error.message;
  const safeCodes = safeProviderCodes(error);
  if (safeCodes.length > 0) return providerSummary(error);
  return 'Unexpected startup error';
}
