import { describe, expect, it, vi } from 'vitest';
import { Types, type Model } from 'mongoose';
import { AccountRecoveryRequest } from './account-recovery-request.schema.js';
import { AccountRecoveryService } from './account-recovery.service.js';
import type { User } from './user.schema.js';

function query<T>(value: T) {
  const chain = {
    lean: vi.fn(async () => value),
    sort: vi.fn(() => chain),
    session: vi.fn(() => chain),
  };
  return chain;
}

function fixture(
  recoverUntil: Date | null = new Date('2026-12-11T00:00:00.000Z'),
) {
  const user = {
    _id: new Types.ObjectId(),
    status: 'deleting',
    deletionRequestId: 'deletion-one',
    deletionRequestedAt: new Date('2026-09-11T00:00:00.000Z'),
    deletionRecoverUntil: recoverUntil,
  };
  let request: (AccountRecoveryRequest & { _id: Types.ObjectId }) | null = null;
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<unknown>) =>
      operation(),
    ),
    endSession: vi.fn(async () => undefined),
  };
  const users = {
    db: { startSession: vi.fn(async () => session) },
    findById: vi.fn(() => query(user)),
    updateOne: vi.fn(async (_filter, update) => {
      Object.assign(user, update.$set);
      return { modifiedCount: 1 };
    }),
  };
  const requests = {
    init: vi.fn(),
    findOne: vi.fn(() => query(request)),
    create: vi.fn(async ([input]) => {
      request = {
        ...input,
        _id: new Types.ObjectId(),
        status: 'pending',
        revision: 0,
        reviewedBy: null,
        reviewedAt: null,
        reviewReason: null,
        createdAt: new Date('2026-09-11T01:00:00.000Z'),
        updatedAt: new Date('2026-09-11T01:00:00.000Z'),
      } as AccountRecoveryRequest & { _id: Types.ObjectId };
      return [request];
    }),
  };
  return {
    session,
    users,
    requests,
    service: new AccountRecoveryService(
      users as unknown as Model<User>,
      requests as unknown as Model<AccountRecoveryRequest>,
    ),
  };
}

describe('account recovery requests', () => {
  it('creates one authenticated request with an optional reason', async () => {
    const f = fixture();
    const result = await f.service.request(
      new Types.ObjectId().toHexString(),
      {},
      new Date('2026-09-12T00:00:00.000Z'),
    );
    expect(result).toMatchObject({ status: 'pending', reason: null });
    expect(f.requests.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          deletionRequestId: 'deletion-one',
          reason: null,
        }),
      ],
      { session: f.session },
    );
  });

  it('returns the existing request instead of duplicating it', async () => {
    const f = fixture();
    const userId = new Types.ObjectId().toHexString();
    const first = await f.service.request(
      userId,
      { reason: 'Please restore my audio' },
      new Date('2026-09-12T00:00:00.000Z'),
    );
    const second = await f.service.request(
      userId,
      { reason: 'A different reason' },
      new Date('2026-09-12T00:00:00.000Z'),
    );
    expect(second).toEqual(first);
    expect(f.requests.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a request after the recovery deadline', async () => {
    const f = fixture(new Date('2026-09-11T00:00:00.000Z'));
    await expect(
      f.service.request(
        new Types.ObjectId().toHexString(),
        {},
        new Date('2026-09-12T00:00:00.000Z'),
      ),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_RECOVERY_EXPIRED' } });
    expect(f.requests.create).not.toHaveBeenCalled();
  });

  it('serializes creation with deletion cleanup ownership', async () => {
    const f = fixture();
    f.users.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });

    await expect(
      f.service.request(
        new Types.ObjectId().toHexString(),
        { reason: 'Please restore access' },
        new Date('2026-09-12T00:00:00.000Z'),
      ),
    ).rejects.toMatchObject({
      response: { code: 'ACCOUNT_RECOVERY_EXPIRED' },
    });
    expect(f.requests.create).not.toHaveBeenCalled();
  });

  it('backfills and exposes the grace deadline for a legacy deleting account', async () => {
    const f = fixture(null);
    const userId = new Types.ObjectId().toHexString();
    const beforeRequest = await f.service.status(
      userId,
      new Date('2026-09-12T00:00:00.000Z'),
    );
    expect(beforeRequest.deletion).toMatchObject({
      recoverUntil: '2026-12-11T00:00:00.000Z',
      recoveryAvailable: true,
    });

    await f.service.request(
      userId,
      { reason: 'Restore this legacy request' },
      new Date('2026-09-12T00:00:00.000Z'),
    );
    expect(f.users.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'deleting',
        deletionLeaseToken: null,
      }),
      expect.objectContaining({
        $set: {
          deletionRecoverUntil: new Date('2026-12-11T00:00:00.000Z'),
          deletionNextAt: new Date('2026-12-11T00:00:00.000Z'),
        },
      }),
      { session: f.session },
    );
  });

  it('presents an overdue pending request as expired', async () => {
    const f = fixture(new Date('2026-09-11T00:00:00.000Z'));
    await f.service.request(
      new Types.ObjectId().toHexString(),
      { reason: 'Please restore access' },
      new Date('2026-09-10T00:00:00.000Z'),
    );
    const result = await f.service.status(
      new Types.ObjectId().toHexString(),
      new Date('2026-09-12T00:00:00.000Z'),
    );
    expect(result.deletion?.recoveryAvailable).toBe(false);
    expect(result.request?.status).toBe('expired');
  });
});
