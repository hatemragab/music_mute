import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { AccountDeletionCleanupService } from './account-deletion-cleanup.service.js';

function fixture(jobList: unknown[] = []) {
  const user = {
    _id: new Types.ObjectId(),
    firebaseUid: 'test-user',
    status: 'deleting',
    deletionRequestedAt: new Date('2025-01-01T00:00:00.000Z'),
    deletionRecoverUntil: new Date('2025-04-01T00:00:00.000Z'),
    deletionNextAt: new Date('2025-04-01T00:00:00.000Z'),
    deletionLeaseToken: 'lease',
  };
  const users = {
    findOneAndUpdate: vi.fn((_filter, update) => ({
      lean: async () => {
        Object.assign(user, update.$set);
        return user;
      },
    })),
    updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    deleteOne: vi.fn(),
  };
  const jobs = {
    find: vi.fn(() => ({
      sort: () => ({ limit: () => ({ lean: async () => jobList }) }),
    })),
    exists: vi.fn(async () => null),
  };
  const auth = {
    revokeRefreshTokens: vi.fn(async () => undefined),
    updateUser: vi.fn(async () => undefined),
    deleteUser: vi.fn(async () => undefined),
  };
  const actions = { cancelForAccountDeletion: vi.fn() };
  const deletion = { delete: vi.fn(), cleanupDue: vi.fn() };
  const collection = {
    findOne: vi.fn(async () => null),
    find: vi.fn(() => ({
      project: () => ({ limit: () => ({ toArray: async () => [] }) }),
    })),
    deleteMany: vi.fn(),
  };
  const connection = { collection: vi.fn(() => collection) };
  const service = new AccountDeletionCleanupService(
    users as never,
    jobs as never,
    connection as never,
    actions as never,
    deletion as never,
    auth as never,
    { complete: vi.fn(async () => undefined) } as never,
  );
  return { service, user, users, jobs, auth, actions, deletion, collection };
}

describe('account deletion cleanup', () => {
  it('does not perform external operations without an acquired durable lease', async () => {
    const f = fixture();
    f.users.findOneAndUpdate.mockReturnValue({
      lean: async () => null,
    } as never);
    expect(await f.service.advanceDeletion()).toBe(false);
    expect(f.auth.revokeRefreshTokens).not.toHaveBeenCalled();
  });
  it('requests cancellation and never deletes active work', async () => {
    const job = { _id: new Types.ObjectId(), status: 'processing' };
    const f = fixture([job]);
    await f.service.advanceDeletion();
    expect(f.actions.cancelForAccountDeletion).toHaveBeenCalledWith(
      f.user._id.toHexString(),
      job._id.toHexString(),
    );
    expect(f.deletion.delete).not.toHaveBeenCalled();
    expect(f.auth.deleteUser).not.toHaveBeenCalled();
  });
  it('backfills the grace deadline before purging a legacy deleting account', async () => {
    const f = fixture();
    f.user.deletionRequestedAt = new Date('2026-01-31T12:00:00.000Z');
    f.user.deletionRecoverUntil = null as never;
    f.user.deletionNextAt = new Date('2026-02-01T00:00:00.000Z');

    await f.service.advanceDeletion(new Date('2026-02-01T00:00:00.000Z'));

    expect(f.user.status).toBe('deleting');
    expect(f.user.deletionRecoverUntil).toEqual(
      new Date('2026-04-30T12:00:00.000Z'),
    );
    expect(f.user.deletionNextAt).toEqual(new Date('2026-04-30T12:00:00.000Z'));
    expect(f.user.deletionLeaseToken).toBeNull();
    expect(f.auth.revokeRefreshTokens).not.toHaveBeenCalled();
  });
  it('retains intent when Firebase is unavailable', async () => {
    const f = fixture();
    f.auth.revokeRefreshTokens.mockRejectedValue(new Error('unavailable'));
    await f.service.advanceDeletion();
    expect(f.user.status).toBe('purging');
    expect(f.users.deleteOne).not.toHaveBeenCalled();
    expect(f.users.updateOne).toHaveBeenCalled();
  });
  it('never treats expired worker ownership as proof the process stopped', async () => {
    const f = fixture();
    f.jobs.exists.mockResolvedValue({ _id: f.user._id } as never);
    f.collection.findOne.mockResolvedValue({
      activeJobId: new Types.ObjectId(),
      leaseExpiresAt: new Date(0),
    } as never);
    await f.service.advanceDeletion();
    expect(f.auth.deleteUser).not.toHaveBeenCalled();
    expect(f.users.deleteOne).not.toHaveBeenCalled();
  });
  it('keeps the profile while storage cleanup remains unfinished', async () => {
    const f = fixture();
    f.jobs.exists.mockResolvedValue({ _id: new Types.ObjectId() } as never);
    await f.service.advanceDeletion();
    expect(f.auth.deleteUser).not.toHaveBeenCalled();
    expect(f.users.deleteOne).not.toHaveBeenCalled();
  });

  it('keeps the profile when final Firebase deletion fails', async () => {
    const f = fixture();
    f.auth.deleteUser.mockRejectedValue(new Error('fixture provider outage'));
    await f.service.advanceDeletion();
    expect(f.auth.deleteUser).toHaveBeenCalled();
    expect(f.users.deleteOne).not.toHaveBeenCalled();
  });

  it('deletes Firebase last and then removes the fenced profile', async () => {
    const f = fixture();
    await f.service.advanceDeletion();
    expect(f.auth.deleteUser).toHaveBeenCalledWith('test-user');
    expect(f.users.deleteOne).toHaveBeenCalled();
  });
});
