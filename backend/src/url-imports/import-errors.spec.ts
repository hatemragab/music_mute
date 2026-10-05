import { HttpException } from '@nestjs/common';
import { authError } from '../auth/auth.errors.js';
import { jobError, type JobHttpErrorCode } from '../jobs/job-errors.js';
import { importError, safeImportError } from './import-errors.js';

describe('safe import failure classification', () => {
  const permanentCodes: JobHttpErrorCode[] = [
    'PROCESSING_POLICY_INCOMPATIBLE',
    'MEDIA_TOO_LONG',
    'MEDIA_TOO_LARGE',
    'MEDIA_UNSUPPORTED',
    'MEDIA_DURATION_UNKNOWN',
    'UPLOAD_ATTEMPT_LIMIT_REACHED',
    'JOB_NOT_FOUND',
    'JOB_STATE_CONFLICT',
    'PROCESSING_ALLOWANCE_EXHAUSTED',
    'IDEMPOTENCY_CONFLICT',
  ];
  it.each(permanentCodes)(
    'preserves canonical permanent job code %s without private details',
    (code) => {
      const injected = new HttpException(
        {
          code,
          message: 'private signed URL and credentials',
          stack: 'private stack',
        },
        503,
      );
      const canonical = jobError(code).getResponse() as {
        code: string;
        message: string;
      };
      expect(safeImportError(injected)).toEqual({
        code,
        message: canonical.message,
      });
      expect(JSON.stringify(safeImportError(injected))).not.toContain(
        'private',
      );
    },
  );
  it('preserves canonical auth input validation instead of manufacturing a retry', () => {
    const canonical = authError('INVALID_INPUT').getResponse() as {
      message: string;
    };
    expect(
      safeImportError(
        new HttpException(
          { code: 'INVALID_INPUT', message: 'private source URL' },
          400,
        ),
      ),
    ).toEqual({ code: 'INVALID_INPUT', message: canonical.message });
  });
  it.each([
    new Error('mongodb://private-password@example.test/db'),
    Object.assign(new Error('private upstream URL'), {
      name: 'MongoOperationTimeoutError',
    }),
    new HttpException(
      { code: 'VENDOR_AUTH_FAILURE', message: 'private token' },
      502,
    ),
    new HttpException('private upstream content', 503),
    null,
  ])('redacts unknown and dependency failure %#', (failure) => {
    expect(safeImportError(failure)).toEqual(
      safeImportError(importError('IMPORT_DEPENDENCY_FAILED')),
    );
  });
});
