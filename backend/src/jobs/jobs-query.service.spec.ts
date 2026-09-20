import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  JobsQueryService,
} from './jobs-query.service.js';
import { Types } from 'mongoose';

describe('history cursor', () => {
  it('round trips stable date and object id', () => {
    const position = {
      createdAt: new Date('2026-09-09T00:00:00.000Z'),
      id: '0123456789abcdef01234567',
    };
    expect(decodeHistoryCursor(encodeHistoryCursor(position))).toEqual(
      position,
    );
  });
  it.each([
    '!',
    'e30',
    Buffer.from(JSON.stringify({ createdAt: 'bad', id: 'x' })).toString(
      'base64url',
    ),
    'a'.repeat(1025),
  ])('rejects invalid cursor %s', (cursor) => {
    expect(() => decodeHistoryCursor(cursor)).toThrow();
  });
});

describe('accounted result grants', () => {
  const requestId = 'de8be0bb-f574-4b90-b9c0-2adcc8f04c29';

  function fixture(available = true) {
    const userId = new Types.ObjectId();
    const jobId = new Types.ObjectId();
    const outputObject = {
      key: `users/${userId}/jobs/${jobId}/attempts/a/vocals.mp3`,
      versionId: 'output-v1',
      bytes: 2_048,
      sha256: 'B'.repeat(43) + '=',
      contentType: 'audio/mpeg',
    };
    const job: Record<string, any> = {
      _id: jobId,
      userId,
      status: 'ready',
      deletedAt: null,
      outputObject,
      inputObject: null,
    };
    const jobs = {
      findOne: vi.fn((filter: { userId?: Types.ObjectId }) => {
        const found = filter.userId?.equals(job.userId) ? job : null;
        return {
          lean: vi.fn().mockResolvedValue(found),
          session: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(found),
          }),
        };
      }),
    };
    const access = { assertActive: vi.fn().mockResolvedValue(undefined) };
    const storage = {
      isPinnedObjectAvailable: vi.fn().mockResolvedValue(available),
      createDownloadGrant: vi.fn().mockResolvedValue({
        url: 'https://storage.invalid/result',
        expiresAt: '2026-09-20T00:10:00.000Z',
      }),
    };
    const transactions = {
      run: vi.fn((operation: (session: object) => Promise<unknown>) =>
        operation({ transaction: true }),
      ),
    };
    const usage = {
      reserveDownloadGrant: vi.fn().mockResolvedValue({
        expiresAt: new Date('2026-09-20T00:10:00.000Z'),
      }),
    };
    const service = new JobsQueryService(
      jobs as never,
      access as never,
      storage as never,
      transactions as never,
      usage as never,
    );
    return { service, job, jobs, access, storage, usage };
  }

  it('checks the pinned result and reserves one account/service estimate before signing', async () => {
    const f = fixture();

    await expect(
      f.service.download(
        f.job.userId.toHexString(),
        f.job._id.toHexString(),
        'output',
        requestId,
      ),
    ).resolves.toMatchObject({ url: 'https://storage.invalid/result' });

    expect(f.usage.reserveDownloadGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: f.job.userId,
        jobId: f.job._id,
        scope: 'user_result',
        requestId,
        object: f.job.outputObject,
      }),
      expect.any(Object),
    );
    expect(f.storage.createDownloadGrant).toHaveBeenCalledWith(
      f.job.outputObject,
      new Date('2026-09-20T00:10:00.000Z'),
    );
  });

  it('does not charge or sign a missing pinned result', async () => {
    const f = fixture(false);

    await expect(
      f.service.download(
        f.job.userId.toHexString(),
        f.job._id.toHexString(),
        'output',
        requestId,
      ),
    ).rejects.toMatchObject({ response: { code: 'JOB_STATE_CONFLICT' } });
    expect(f.usage.reserveDownloadGrant).not.toHaveBeenCalled();
    expect(f.storage.createDownloadGrant).not.toHaveBeenCalled();
  });

  it('does not charge when immutable object metadata changes before accounting', async () => {
    const f = fixture();
    f.storage.isPinnedObjectAvailable.mockImplementation(async () => {
      f.job.outputObject = { ...f.job.outputObject, bytes: 4_096 };
      return true;
    });

    await expect(
      f.service.download(
        f.job.userId.toHexString(),
        f.job._id.toHexString(),
        'output',
        requestId,
      ),
    ).rejects.toMatchObject({ response: { code: 'JOB_STATE_CONFLICT' } });
    expect(f.usage.reserveDownloadGrant).not.toHaveBeenCalled();
    expect(f.storage.createDownloadGrant).not.toHaveBeenCalled();
  });

  it('does not expose or charge another account result', async () => {
    const f = fixture();

    await expect(
      f.service.download(
        new Types.ObjectId().toHexString(),
        f.job._id.toHexString(),
        'output',
        requestId,
      ),
    ).rejects.toMatchObject({ response: { code: 'JOB_NOT_FOUND' } });
    expect(f.usage.reserveDownloadGrant).not.toHaveBeenCalled();
    expect(f.storage.createDownloadGrant).not.toHaveBeenCalled();
  });

  it('does not charge a restricted or deleting account', async () => {
    const restricted = fixture();
    restricted.access.assertActive.mockRejectedValueOnce(
      new Error('account restricted'),
    );
    await expect(
      restricted.service.download(
        restricted.job.userId.toHexString(),
        restricted.job._id.toHexString(),
        'output',
        requestId,
      ),
    ).rejects.toThrow('account restricted');
    expect(restricted.usage.reserveDownloadGrant).not.toHaveBeenCalled();

    const deleting = fixture();
    deleting.job.deletedAt = new Date();
    await expect(
      deleting.service.download(
        deleting.job.userId.toHexString(),
        deleting.job._id.toHexString(),
        'output',
        requestId,
      ),
    ).rejects.toMatchObject({ response: { code: 'JOB_NOT_FOUND' } });
    expect(deleting.usage.reserveDownloadGrant).not.toHaveBeenCalled();
  });
});
