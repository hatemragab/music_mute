import {
  StartupDependencyError,
  startupFailureReason,
} from './startup-error.js';

describe('startupFailureReason', () => {
  it('reports a provider code and status without raw diagnostics', () => {
    const error = new StartupDependencyError(
      'Storage bucket preflight failed: GetBucketVersioning',
      Object.assign(new Error('credentials and bucket details'), {
        name: 'AccessDenied',
        $metadata: { httpStatusCode: 403 },
      }),
    );
    error.message = 'mutated secret';
    expect(startupFailureReason(error)).toBe(
      'Storage bucket preflight failed: GetBucketVersioning (AccessDenied, HTTP 403)',
    );
  });

  it('reports MongoDB numeric codes without index values', () => {
    expect(
      startupFailureReason(
        new StartupDependencyError(
          'Audio processing schema initialization failed',
          Object.assign(new Error('private index values'), {
            name: 'MongoServerError',
            code: 85,
          }),
        ),
      ),
    ).toBe(
      'Audio processing schema initialization failed (MongoServerError, code 85)',
    );
  });

  it('does not trust arbitrary stage, provider names or status strings', () => {
    const provider = Object.assign(new Error('private'), {
      name: 'private-name',
      code: 'private-code',
      $metadata: { httpStatusCode: 'private-status' },
    });
    expect(
      startupFailureReason(
        new StartupDependencyError('private-stage', provider),
      ),
    ).toBe('Unexpected startup error');
    expect(
      startupFailureReason(
        new StartupDependencyError(
          'Audio processing schema initialization failed',
          provider,
        ),
      ),
    ).toBe(
      'Audio processing schema initialization failed (unclassified provider error)',
    );
  });

  it.each([
    'Audio processing MongoDB capability check failed',
    'Audio processing requires a writable MongoDB replica set with sessions',
    'Audio processing schema initialization failed',
    'Storage bucket preflight failed',
  ])('reports the safe processing prerequisite failure: %s', (message) => {
    expect(startupFailureReason(new Error(message))).toBe(message);
    expect(startupFailureReason(new Error(`${message}: private-secret`))).toBe(
      'Unexpected startup error',
    );
  });

  it('reports validated configuration failures without exposing values', () => {
    expect(
      startupFailureReason(
        new Error('Invalid environment: MONGODB_URI, REDIS_URL'),
      ),
    ).toBe('Invalid environment: MONGODB_URI, REDIS_URL');
  });

  it('does not expose credentials embedded in an unexpected error', () => {
    expect(
      startupFailureReason(
        new Error(
          'connect ECONNREFUSED rediss://admin:super-secret@example.com:6379/0',
        ),
      ),
    ).toBe('Unexpected startup error');
  });

  it.each([
    ['code', 'EACCES', 'listen permission denied'],
    ['code', 'EADDRINUSE', 'listen address already in use'],
    ['name', 'MongoServerSelectionError', 'private MongoDB topology details'],
  ])(
    'reports an allowlisted raw startup %s without its message: %s',
    (field, value, message) => {
      const error = new Error(message) as Error & { code?: string };
      error[field as 'name' | 'code'] = value;

      expect(startupFailureReason(error)).toBe(value);
    },
  );

  it('reports a numeric MongoDB code without the raw server message', () => {
    const error = Object.assign(new Error('private MongoDB server details'), {
      name: 'MongoServerError',
      code: 85,
    });

    expect(startupFailureReason(error)).toBe('MongoServerError, code 85');
  });

  it('reports a validated MongoDB index name for an index-key conflict', () => {
    const error = Object.assign(new Error('private MongoDB server details'), {
      name: 'MongoServerError',
      code: 86,
      indexName: 'users_deletion_due',
    });

    expect(startupFailureReason(error)).toBe(
      'MongoServerError, code 86, index users_deletion_due',
    );
    error.indexName = 'mongodb://admin:secret@example.com';
    expect(startupFailureReason(error)).toBe('MongoServerError, code 86');
  });

  it('does not trust a mutable error name', () => {
    const error = new Error('safe message');
    error.name = 'private-secret';

    expect(startupFailureReason(error)).toBe('Unexpected startup error');
  });

  it('handles non-error rejections without serializing their contents', () => {
    expect(startupFailureReason({ token: 'secret' })).toBe(
      'Unknown startup error',
    );
  });
});
