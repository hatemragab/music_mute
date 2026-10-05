import { HttpException } from '@nestjs/common';
import { authError } from '../auth/auth.errors.js';
import { importError } from '../url-imports/import-errors.js';
import {
  safeProcessingFailure,
  safeTransactionDiagnostics,
} from './processing-diagnostics.js';

const acquisitionId = 'ca913ccb-9ee0-4c65-9df0-d4a5fced9b24';

describe('safe processing diagnostics', () => {
  it('allowlists MongoDB codes and transaction labels without their raw payload', () => {
    const failure = Object.assign(
      new Error('mongodb://private:password@host'),
      {
        name: 'MongoServerError',
        code: 112,
        codeName: 'private error name',
        errorLabels: [
          'private token',
          'TransientTransactionError',
          'TransientTransactionError',
          'UnknownTransactionCommitResult',
        ],
        errorResponse: { password: 'secret' },
        query: { userId: 'private-user' },
      },
    );
    expect(safeProcessingFailure(failure)).toEqual({
      error_type: 'MongoServerError',
      reason: 'write-conflict',
      code: 112,
      retry_labels: [
        'TransientTransactionError',
        'UnknownTransactionCommitResult',
      ],
    });
  });

  it.each([
    ['MongoOperationTimeoutError', undefined, 'timeout'],
    ['MongoServerError', 50, 'timeout'],
    ['MongoNetworkTimeoutError', undefined, 'timeout'],
    ['ValidationError', undefined, 'validation'],
    ['CastError', undefined, 'validation'],
    ['TypeError', undefined, 'runtime-type-error'],
    ['MongoServerSelectionError', undefined, 'network'],
    ['Error', 'ECONNRESET', 'network'],
    ['Error', undefined, 'unknown'],
  ])('classifies %s and code %s using fixed reasons', (name, code, reason) => {
    expect(
      safeProcessingFailure(
        Object.assign(new Error('private'), { name, code }),
      ),
    ).toEqual({
      error_type: name,
      reason,
      ...(typeof code === 'number' ? { code } : {}),
      retry_labels: [],
    });
  });

  it('logs only known public domain codes and HTTP status from an exception', () => {
    expect(
      safeProcessingFailure(importError('IMPORT_DEPENDENCY_FAILED')),
    ).toEqual({
      error_type: 'HttpException',
      reason: 'unknown',
      retry_labels: [],
      http_status: 503,
      domain_code: 'IMPORT_DEPENDENCY_FAILED',
    });
    expect(
      safeProcessingFailure(authError('ACCOUNT_DELETION_PENDING')),
    ).toHaveProperty('domain_code', 'ACCOUNT_DELETION_PENDING');
    const error = new HttpException(
      {
        code: 'PASSWORD_SECRET',
        message: 'https://private?token=secret',
        userId: 'secret-user',
      },
      503,
    );
    expect(safeProcessingFailure(error)).toEqual({
      error_type: 'HttpException',
      reason: 'unknown',
      retry_labels: [],
      http_status: 503,
    });
  });

  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
    1.5,
    'SECRET',
  ])('omits an invalid numeric error code %s', (code) => {
    expect(safeProcessingFailure({ name: 'Error', code })).not.toHaveProperty(
      'code',
    );
  });

  it('does not emit messages, stacks, arbitrary names or extra diagnostic fields', () => {
    const error = Object.assign(
      new Error('password=SECRET https://signed?token=TOKEN'),
      {
        name: 'PRIVATE_CREDENTIAL',
        code: 'PRIVATE_CREDENTIAL',
        errorLabels: ['PRIVATE_CREDENTIAL'],
        userId: 'PRIVATE_USER',
        acquisitionId: 'PRIVATE_ID',
        request: { Authorization: 'PRIVATE_HEADER' },
      },
    );
    const diagnostic = safeProcessingFailure(error);
    expect(diagnostic).toEqual({
      error_type: 'unknown',
      reason: 'unknown',
      retry_labels: [],
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /PRIVATE|SECRET|TOKEN|password|https|stack|message/,
    );
  });

  it('bounds nested causes and stops circular cause chains', () => {
    const distant = Object.assign(new Error('distant private error'), {
      name: 'MongoServerError',
      code: 112,
    });
    const third = new TypeError('private third', { cause: distant });
    const second = new Error('private second', { cause: third });
    const first = new Error('private first', { cause: second });
    const diagnostic = safeProcessingFailure(first);
    expect(diagnostic.cause?.cause).toEqual({
      error_type: 'TypeError',
      reason: 'runtime-type-error',
      retry_labels: [],
    });
    expect(diagnostic.cause?.cause?.cause).toBeUndefined();
    expect(JSON.stringify(diagnostic)).not.toContain('private');
    second.cause = first;
    expect(safeProcessingFailure(first).cause?.cause).toBeUndefined();
  });

  it('bounds label scanning and tolerates throwing accessors', () => {
    const labels = Array.from({ length: 20 }, () => 'private');
    labels.push('TransientTransactionError');
    Object.defineProperty(labels, 'includes', {
      get() {
        throw new Error('private');
      },
    });
    const error = { errorLabels: labels };
    for (const key of ['name', 'code', 'cause'])
      Object.defineProperty(error, key, {
        get() {
          throw new Error('private');
        },
      });
    expect(safeProcessingFailure(error)).toEqual({
      error_type: 'unknown',
      reason: 'unknown',
      retry_labels: [],
    });
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('private');
        },
      },
    );
    expect(() => safeProcessingFailure(proxy)).not.toThrow();
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(() =>
      safeProcessingFailure({ errorLabels: revoked.proxy }),
    ).not.toThrow();
  });

  it('uses only validated UUID correlation and a fixed handoff step', () => {
    expect(
      safeTransactionDiagnostics({
        operation: 'url-import-handoff',
        acquisitionId: acquisitionId.toUpperCase(),
        step: 'admission',
      }),
    ).toEqual({
      operation: 'url-import-handoff',
      acquisition_id: acquisitionId,
      step: 'admission',
    });
    expect(
      safeTransactionDiagnostics({
        operation: 'url-import-handoff',
        acquisitionId: 'password=secret',
        step: 'https://private',
        userId: 'private',
      } as never),
    ).toEqual({ operation: 'url-import-handoff', step: 'unknown' });
    expect(
      safeTransactionDiagnostics({ operation: 'password=secret' } as never),
    ).toBeUndefined();
    expect(safeTransactionDiagnostics(undefined)).toBeUndefined();
  });
});
