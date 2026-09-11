import { HttpException, ValidationPipe } from '@nestjs/common';
import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { Job } from '../jobs/job.schema.js';
import type { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import type { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import { ClientErrorDto } from './client-error.dto.js';
import type { ClientError } from './client-error.schema.js';
import type { AccountAccessService } from '../users/account-access.service.js';
import { ClientErrorsService } from './client-errors.service.js';

const ownerId = new Types.ObjectId();
const jobId = new Types.ObjectId();
const eventId = '9f37ef7f-45ba-43d3-b234-0ac6c34738c6';
const operationId = '519a84b5-45de-4b0d-a45e-b554748b0d63';

const report: ClientErrorDto = {
  eventId,
  operationId,
  stage: 'UPLOADING_INPUT',
  code: 'NETWORK',
  retryable: true,
  platform: 'ios',
  appVersion: '1.0.0',
  osVersion: '26.0',
  occurredAt: '2026-09-10T08:15:00.000Z',
  httpStatus: 503,
};

function queryResult<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

function setup(options?: {
  existing?: Record<string, unknown> | null;
  job?: Record<string, unknown> | null;
  allowed?: boolean;
}) {
  const errors = {
    findOne: vi.fn().mockReturnValue(queryResult(options?.existing ?? null)),
    create: vi.fn().mockImplementation(async (value) => ({
      toObject: () => ({ _id: new Types.ObjectId(), ...value }),
    })),
  };
  const jobs = {
    findOne: vi.fn().mockReturnValue(queryResult(options?.job ?? null)),
  };
  const limits = {
    reserve: vi.fn().mockResolvedValue({
      allowed: options?.allowed ?? true,
      retryAfterSeconds: options?.allowed === false ? 17 : 0,
    }),
  };
  const keys = { bucket: vi.fn().mockReturnValue('owner-rate-key') };
  const service = new ClientErrorsService(
    errors as unknown as Model<ClientError>,
    jobs as unknown as Model<Job>,
    limits as unknown as RateBudgetService,
    keys as unknown as RateLimitKeys,
    {
      runActive: async (
        _uid: string,
        action: (session: unknown) => Promise<unknown>,
      ) => action({}),
    } as unknown as AccountAccessService,
  );
  return { service, errors, jobs, limits, keys };
}

describe('ClientErrorsService', () => {
  it.each([
    [{ ...report, stage: 'SIGNED_URL' }],
    [{ ...report, code: 'Bearer secret-value' }],
    [{ ...report, appVersion: 'v'.repeat(33) }],
    [{ ...report, osVersion: '26.0\nAuthorization: secret' }],
    [{ ...report, occurredAt: '2026-02-31T08:15:00.000Z' }],
    [{ ...report, httpStatus: 999 }],
    [
      {
        ...report,
        exception: 'raw exception',
        token: 'secret-value',
        signedUrl: 'https://storage.invalid/?signature=secret',
        sourceUrl: 'https://source.invalid/private',
        audioPath: '/private/audio/input.wav',
      },
    ],
    [{ ...report, receivedAt: '2026-09-10T08:16:00.000Z' }],
  ])(
    'rejects invalid, oversized, or unexpected diagnostic fields',
    async (body) => {
      const pipe = new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      await expect(
        pipe.transform(body, { type: 'body', metatype: ClientErrorDto }),
      ).rejects.toBeInstanceOf(HttpException);
    },
  );

  it('accepts a pre-reservation report without a job ID', async () => {
    const f = setup();

    await expect(
      f.service.report(ownerId.toHexString(), report),
    ).resolves.toEqual({ eventId });

    expect(f.errors.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          userId: ownerId,
          eventId,
          operationId,
          jobId: null,
          receivedAt: expect.any(Date),
        }),
      ],
      { session: {} },
    );
  });

  it('links an existing owned operation and rejects a mismatched attached job', async () => {
    const linked = setup({
      job: { _id: jobId, userId: ownerId, requestId: operationId },
    });
    await linked.service.report(ownerId.toHexString(), report);
    expect(linked.errors.create).toHaveBeenCalledWith(
      [expect.objectContaining({ jobId })],
      { session: {} },
    );

    const mismatch = setup({ job: null });
    await expect(
      mismatch.service.report(ownerId.toHexString(), {
        ...report,
        jobId: jobId.toHexString(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(mismatch.errors.create).not.toHaveBeenCalled();
  });

  it('returns the same acknowledgement for an identical event replay', async () => {
    const first = setup();
    await first.service.report(ownerId.toHexString(), report);
    const inserted = first.errors.create.mock.calls[0]![0][0] as Record<
      string,
      unknown
    >;
    const replay = setup({ existing: inserted });

    await expect(
      replay.service.report(ownerId.toHexString(), report),
    ).resolves.toEqual({ eventId });
    expect(replay.errors.create).not.toHaveBeenCalled();
  });

  it('rejects reuse of an event ID with different safe fields', async () => {
    const first = setup();
    await first.service.report(ownerId.toHexString(), report);
    const inserted = first.errors.create.mock.calls[0]![0][0] as Record<
      string,
      unknown
    >;
    const replay = setup({ existing: inserted });

    await expect(
      replay.service.report(ownerId.toHexString(), {
        ...report,
        code: 'TIMEOUT',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('limits reports per authenticated owner to 30 per minute', async () => {
    const f = setup({ allowed: false });

    await expect(
      f.service.report(ownerId.toHexString(), report),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HttpException &&
        error.getStatus() === 429 &&
        (error as HttpException & { retryAfterSeconds?: number })
          .retryAfterSeconds === 17,
    );
    expect(f.limits.reserve).toHaveBeenCalledWith([
      { key: 'owner-rate-key', limit: 30, windowMs: 60_000 },
    ]);
    expect(f.keys.bucket).toHaveBeenCalledWith(
      'client-errors',
      ownerId.toHexString(),
    );
    expect(f.errors.create).not.toHaveBeenCalled();
  });
});
