import { Types } from 'mongoose';
import { vi } from 'vitest';
import { JobActionsService } from './job-actions.service.js';
import type { AdminActor } from '../admin/admin.types.js';

const jobId = new Types.ObjectId('64b000000000000000000001');
const userId = new Types.ObjectId('64b000000000000000000002');
const admin: AdminActor = {
  uid: 'support-admin',
  verifiedEmail: 'support@example.invalid',
  role: 'support',
  permissions: ['jobs.manage'],
  accessRevision: 0,
  authTimeSec: 1,
};
const session = { inTransaction: () => true };
const query = <T>(value: T) => ({
  session: () => query(value),
  lean: async () => value,
});

function actionsFixture() {
  const job = {
    _id: jobId,
    userId,
    status: 'queued',
    deletedAt: null,
    revision: 2,
    adminRevision: 3,
  };
  const jobs = {
    findOne: vi.fn(() => query(job)),
    findOneAndUpdate: vi.fn(() =>
      query({ ...job, status: 'cancelled', adminRevision: 4 }),
    ),
  };
  const transactions = { run: vi.fn() };
  const access = { assertActive: vi.fn().mockResolvedValue(undefined) };
  return {
    jobs,
    transactions,
    actions: new JobActionsService(
      jobs as never,
      transactions as never,
      access as never,
      {} as never,
      {} as never,
    ),
  };
}

describe('shared owner and administrator job authority', () => {
  it.each(['shared', 'private', 'completed', 'otherProducer'] as const)(
    'coordinates retry ownership with %s media',
    async (storageMode) => {
      const shared = storageMode !== 'private';
      const input = {
        key: shared
          ? `shared/url/${'a'.repeat(64)}/2f237a2e-031e-4b58-b9a7-9f9e7c0e31a9/input/source.mp3`
          : `users/${userId}/jobs/${jobId}/input/source.mp3`,
        bytes: 1024,
        sha256: Buffer.alloc(32, 2).toString('base64'),
        contentType: 'audio/mpeg',
        extension: 'mp3',
        durationSeconds: 30,
      };
      const recipeSnapshot = {
        recipeDigest: 'c'.repeat(64),
        trimEnabled: true,
      };
      const original = {
        _id: jobId,
        userId,
        logicalAudioId: jobId,
        deletedAt: null,
        revision: 3,
        status: 'failed',
        reservationCleanupScheduledAt: null,
        inputReservation: input,
        inputObject: { ...input, etag: '"original"' },
        recipeSnapshot,
        admissionSnapshot: {
          preparationProfileId: 'direct-input-v1',
          source: 'youtube',
        },
        sharedSourceKey: shared ? 'a'.repeat(64) : null,
        sharedResultKey: shared ? 'b'.repeat(64) : null,
      };
      const conflict =
        storageMode === 'completed' || storageMode === 'otherProducer';
      const rebind = vi.fn(async () => ({ modifiedCount: conflict ? 0 : 1 }));
      const jobs = {
        findOne: vi
          .fn()
          .mockReturnValueOnce(query(null))
          .mockReturnValueOnce(query(null))
          .mockReturnValueOnce(query(original)),
        updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
        create: vi.fn(async (records: Array<Record<string, unknown>>) => [
          { toObject: () => records[0] },
        ]),
        db: {
          model: vi.fn((name: string) =>
            name === 'SharedMediaResult'
              ? { updateOne: rebind }
              : { findOne: () => query(null) },
          ),
        },
      };
      const admission = {
        assertNewWork: vi.fn(async () => ({ maxInfrastructureAttempts: 3 })),
      };
      const actions = new JobActionsService(
        jobs as never,
        {
          run: (operation: (session: unknown) => Promise<unknown>) =>
            operation(session),
        } as never,
        { assertActive: vi.fn(async () => undefined) } as never,
        admission as never,
        {} as never,
      );

      const retry = actions.retry(
        userId.toHexString(),
        jobId.toHexString(),
        'f7df699a-356a-45b3-bf0d-9559b0a17324',
      );

      if (conflict) {
        await expect(retry).rejects.toMatchObject({
          response: { code: 'JOB_STATE_CONFLICT' },
        });
        expect(jobs.create).not.toHaveBeenCalled();
        return;
      }
      const result = await retry;

      expect(result).toMatchObject({
        status: 'queued',
        retryOfJobId: jobId.toHexString(),
      });
      expect(jobs.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            inputObject: original.inputObject,
            inputReservation: original.inputReservation,
            recipeSnapshot,
            sharedSourceKey: original.sharedSourceKey,
            sharedResultKey: original.sharedResultKey,
          }),
        ],
        expect.anything(),
      );
      if (shared) {
        const created = jobs.create.mock.calls[0][0][0];
        expect(rebind).toHaveBeenCalledWith(
          {
            _id: original.sharedResultKey,
            sourceKey: original.sharedSourceKey,
            'recipeSnapshot.recipeDigest': recipeSnapshot.recipeDigest,
            $or: [
              { state: 'failed' },
              { state: 'processing', producerJobId: original._id },
            ],
          },
          {
            $set: {
              state: 'processing',
              producerJobId: created._id,
              pendingOutput: null,
              outputObject: null,
              outputKey: null,
              publicationToken: null,
              publicationLeaseUntil: null,
              comparisonRanges: null,
              completedAt: null,
            },
          },
          { session, runValidators: true },
        );
        expect(rebind.mock.invocationCallOrder[0]).toBeLessThan(
          jobs.create.mock.invocationCallOrder[0],
        );
      } else expect(rebind).not.toHaveBeenCalled();
    },
  );

  it('rejects administrative entry without jobs.manage or an active supplied transaction', async () => {
    const f = actionsFixture();
    await expect(
      f.actions.cancelAsAdmin(
        { ...admin, permissions: [] },
        jobId.toString(),
        3,
        session as never,
      ),
    ).rejects.toMatchObject({ response: { code: 'PERMISSION_DENIED' } });
    await expect(
      f.actions.cancelAsAdmin(admin, jobId.toString(), 3, {
        inTransaction: () => false,
      } as never),
    ).rejects.toThrow();
    expect(f.jobs.findOne).not.toHaveBeenCalled();
  });

  it('rejects a stale administrative revision before changing state', async () => {
    const f = actionsFixture();
    await expect(
      f.actions.cancelAsAdmin(admin, jobId.toString(), 2, session as never),
    ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
    expect(f.jobs.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.transactions.run).not.toHaveBeenCalled();
  });
});
