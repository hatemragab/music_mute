import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { AdminAccountRecoveryService } from './admin-account-recovery.service.js';

function query<T>(read: () => T) {
  const chain = {
    session: vi.fn(() => chain),
    lean: vi.fn(async () => read()),
  };
  return chain;
}

describe('administrative account recovery', () => {
  it('atomically restores account access without mutating independent controls', async () => {
    const userId = new Types.ObjectId();
    const requestId = new Types.ObjectId();
    const user = {
      _id: userId,
      firebaseUid: 'firebase-user',
      email: 'listener@example.test',
      displayName: 'Listener',
      status: 'deleting',
      deletionRequestId: 'deletion-one',
      deletionRequestedAt: new Date('2026-09-11T00:00:00.000Z'),
      deletionRecoverUntil: new Date('2099-12-11T00:00:00.000Z'),
      deletionPurgeStartedAt: null,
      deletionNextAt: new Date('2099-12-11T00:00:00.000Z'),
      deletionLeaseUntil: null,
      deletionLeaseToken: null,
      adminRevision: 4,
    };
    const recovery = {
      _id: requestId,
      userId,
      deletionRequestId: 'deletion-one',
      deletionRequestedAt: new Date('2026-09-11T00:00:00.000Z'),
      recoverUntil: new Date('2099-12-11T00:00:00.000Z'),
      reason: 'I changed my mind',
      status: 'pending',
      revision: 0,
      reviewedBy: null,
      reviewedAt: null,
      reviewReason: null,
      createdAt: new Date('2026-09-12T00:00:00.000Z'),
      updatedAt: new Date('2026-09-12T00:00:00.000Z'),
    };
    const requests = {
      init: vi.fn(),
      findById: vi.fn(() => query(() => recovery)),
      findOneAndUpdate: vi.fn((_filter, update) => {
        Object.assign(recovery, update.$set);
        recovery.revision += update.$inc.revision;
        return query(() => recovery);
      }),
    };
    const users = {
      findById: vi.fn(() => query(() => user)),
      findOneAndUpdate: vi.fn((_filter, update) => {
        Object.assign(user, update.$set);
        user.adminRevision += update.$inc.adminRevision;
        return query(() => user);
      }),
    };
    const identities = { unblock: vi.fn(async () => undefined) };
    const operations = {
      run: vi.fn(async (_actor, _command, mutate) => ({
        value: (await mutate({ inTransaction: () => true })).value,
        replayed: false,
      })),
    };
    const service = new AdminAccountRecoveryService(
      requests as never,
      users as never,
      identities as never,
      operations as never,
    );

    const result = await service.decide(
      {
        uid: 'support-admin',
        verifiedEmail: 'support@example.test',
        role: 'support',
        permissions: ['users.account-recovery.manage'],
        accessRevision: 1,
        authTimeSec: 1,
      },
      requestId.toHexString(),
      {
        expectedRevision: 0,
        operationId: '2ec3bbef-16c2-4d35-a5fb-dd5daffea216',
        reason: 'Authenticated request reviewed',
      },
      true,
    );

    expect(result).toMatchObject({ status: 'approved', revision: 1 });
    expect(user).toMatchObject({
      status: 'active',
      deletionRequestId: null,
      adminRevision: 5,
    });
    expect(identities.unblock).toHaveBeenCalledWith(
      'firebase-user',
      expect.anything(),
    );
  });

  it('counts only pending requests whose recovery deadline has not passed', async () => {
    const countDocuments = vi.fn(() => ({ maxTimeMS: async () => 2 }));
    const findOne = vi.fn(() => ({
      sort: () => ({
        select: () => ({
          maxTimeMS: () => ({
            lean: async () => ({
              createdAt: new Date('2026-09-11T00:00:00.000Z'),
            }),
          }),
        }),
      }),
    }));
    const service = new AdminAccountRecoveryService(
      { countDocuments, findOne } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const now = new Date('2026-09-12T00:00:00.000Z');

    await expect(service.summary(now)).resolves.toMatchObject({
      pendingCount: 2,
      highPriority: true,
    });
    const active = expect.objectContaining({
      status: 'pending',
      recoverUntil: expect.objectContaining({ $gt: now }),
    });
    expect(countDocuments).toHaveBeenCalledWith(active);
    expect(findOne).toHaveBeenCalledWith(active);
  });
});
