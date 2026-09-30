import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import type { StorageClient } from '../infrastructure/storage.module.js';
import { StoragePreflightService } from './storage-preflight.service.js';
import { startupFailureReason } from '../startup-error.js';

function fixture() {
  const send = vi.fn(
    async (
      _command: HeadBucketCommand,
      _options: { abortSignal: AbortSignal },
    ) => ({}),
  );
  const service = new StoragePreflightService(
    { send } as unknown as StorageClient,
    new ConfigService({ STORAGE_BUCKET: 'private-fixture-bucket' }),
  );
  return { service, send };
}
const denied = () =>
  Object.assign(new Error('private storage credentials and bucket detail'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });
afterEach(() => vi.useRealTimers());

describe('StoragePreflightService R2', () => {
  it('checks supported bucket access once and never rechecks for health reads/grants', async () => {
    const { service, send } = fixture();
    expect(service.snapshot()).toEqual({
      status: 'unknown',
      checkedAt: null,
      code: 'STORAGE_NOT_OBSERVED',
    });
    await service.assertReady();
    await service.assertReady();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadBucketCommand);
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: 'private-fixture-bucket',
    });
    expect(send.mock.calls[0][1]).toMatchObject({
      abortSignal: expect.any(AbortSignal),
    });
    expect(service.snapshot()).toMatchObject({
      status: 'healthy',
      checkedAt: expect.any(String),
      code: null,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('shares one in-flight startup request across concurrent callers', async () => {
    const { service, send } = fixture();
    let finish!: (value: object) => void;
    send.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let ready = false;
    const first = service.assertReady().then(() => {
      ready = true;
    });
    const second = service.assertReady();
    expect(send).toHaveBeenCalledOnce();
    expect(ready).toBe(false);
    finish({});
    await Promise.all([first, second]);
    expect(ready).toBe(true);
    await service.assertReady();
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not cache failed startup and reports the exact supported operation without secrets', async () => {
    const { service, send } = fixture();
    send.mockRejectedValueOnce(denied());
    const failure = await service
      .assertReady()
      .catch((error: unknown) => error);
    expect(startupFailureReason(failure)).toBe(
      'Storage bucket preflight failed: HeadBucket (AccessDenied, HTTP 403)',
    );
    expect(String(failure)).not.toContain('private storage');
    expect(service.snapshot()).toMatchObject({
      status: 'unavailable',
      code: 'STORAGE_UNAVAILABLE',
    });
    await service.assertReady();
    expect(send).toHaveBeenCalledTimes(2);
    expect(service.snapshot()).toMatchObject({ status: 'healthy', code: null });
  });

  it('marks old healthy observations unknown while retaining their real timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T00:00:00.000Z'));
    const { service, send } = fixture();
    await service.assertReady();
    vi.setSystemTime(new Date('2026-09-30T00:05:00.000Z'));
    expect(service.snapshot().status).toBe('healthy');
    vi.setSystemTime(new Date('2026-09-30T00:05:00.001Z'));
    expect(service.snapshot()).toEqual({
      status: 'unknown',
      checkedAt: '2026-09-30T00:00:00.000Z',
      code: 'STORAGE_OBSERVATION_STALE',
    });
    await service.assertReady();
    expect(send).toHaveBeenCalledOnce();
  });

  it('uses actual transfer success/failure observations without additional bucket operations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T00:00:00.000Z'));
    const { service, send } = fixture();
    service.recordFailure();
    expect(service.snapshot()).toEqual({
      status: 'unavailable',
      checkedAt: '2026-09-30T00:00:00.000Z',
      code: 'STORAGE_UNAVAILABLE',
    });
    vi.setSystemTime(new Date('2026-09-30T00:01:00.000Z'));
    service.recordSuccess();
    expect(service.snapshot()).toEqual({
      status: 'healthy',
      checkedAt: '2026-09-30T00:01:00.000Z',
      code: null,
    });
    expect(send).not.toHaveBeenCalled();
  });
});
