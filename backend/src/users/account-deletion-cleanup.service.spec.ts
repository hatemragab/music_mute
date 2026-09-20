import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { AccountDeletionCleanupService } from './account-deletion-cleanup.service.js';

type FixtureOptions = {
  status?: 'deleting' | 'purging';
  phase?:
    'grace_fence' | 'identity' | 'jobs' | 'records' | 'provider' | 'profile';
  activeJobs?: Array<{ _id: Types.ObjectId; status: string }>;
  liveJobs?: Array<{ _id: Types.ObjectId; status: string }>;
  jobs?: Array<{ _id: Types.ObjectId; status: string }>;
  attempts?: Array<Record<string, unknown>>;
};

function fixture(options: FixtureOptions = {}) {
  const user = {
    _id: new Types.ObjectId(),
    firebaseUid: 'test-user',
    status: options.status ?? 'purging',
    deletionRequestId: 'deletion-one',
    deletionRequestedAt: new Date('2025-01-01T00:00:00.000Z'),
    deletionRecoverUntil: new Date('2025-01-16T00:00:00.000Z'),
    deletionNextAt: new Date('2025-01-16T00:00:00.000Z'),
    deletionLeaseToken: null as string | null,
    deletionLeaseUntil: null as Date | null,
    deletionPhase: options.phase ?? 'identity',
    deletionCursor: null as string | null,
    deletionFailureCode: null as string | null,
  };
  let leaseAvailable = true;
  const apply = (update: { $set?: Record<string, unknown> }) => {
    if (update.$set) Object.assign(user, update.$set);
  };
  const users = {
    findOneAndUpdate: vi.fn((_filter, update) => ({
      lean: async () => {
        if (!leaseAvailable) return null;
        apply(update);
        return user;
      },
    })),
    updateOne: vi.fn(async (_filter, update) => {
      apply(update);
      return { matchedCount: 1, modifiedCount: 1 };
    }),
    deleteOne: vi.fn(async () => ({ deletedCount: 1 })),
  };
  const jobs = {
    find: vi.fn((filter: Record<string, unknown>) => ({
      sort: () => ({
        limit: () => ({
          lean: async () =>
            Object.hasOwn(filter, 'status')
              ? (options.activeJobs ?? [])
              : Object.hasOwn(filter, 'deletedAt')
                ? (options.liveJobs ?? [])
                : (options.jobs ?? []),
        }),
      }),
    })),
    exists: vi.fn(async () => null),
  };
  const auth = {
    revokeRefreshTokens: vi.fn(async () => undefined),
    updateUser: vi.fn(async () => undefined),
    deleteUser: vi.fn(async () => undefined),
  };
  const actions = { cancelForAccountDeletion: vi.fn(async () => undefined) };
  const deletion = { delete: vi.fn(async () => undefined) };
  const storageCleanup = {
    hasPendingForOwner: vi.fn(async () => false),
    schedule: vi.fn(async () => undefined),
  };
  const tombstones: Record<string, unknown>[] = [];
  const find = vi.fn((name: string) => ({
    project: () => ({
      limit: () => ({
        toArray: async () =>
          name === 'worker_attempts' ? (options.attempts ?? []) : [],
      }),
    }),
  }));
  const collection = {
    deleteMany: vi.fn(async () => ({ deletedCount: 0 })),
    deleteOne: vi.fn(async () => ({ deletedCount: 0 })),
    updateOne: vi.fn(async (_filter, update) => {
      tombstones.push(update.$setOnInsert);
      return { upsertedCount: 1 };
    }),
  };
  const connection = {
    collection: vi.fn((name: string) => ({
      ...collection,
      find: () => find(name),
    })),
  };
  const identities = { complete: vi.fn(async () => undefined) };
  const service = new AccountDeletionCleanupService(
    users as never,
    jobs as never,
    connection as never,
    actions as never,
    deletion as never,
    storageCleanup as never,
    auth as never,
    identities as never,
  );
  return {
    service,
    user,
    users,
    jobs,
    auth,
    actions,
    deletion,
    storageCleanup,
    identities,
    collection,
    connection,
    tombstones,
    denyLease: () => {
      leaseAvailable = false;
    },
  };
}

describe('account deletion cleanup', () => {
  it('does not perform external operations without an acquired durable lease', async () => {
    const f = fixture();
    f.denyLease();
    expect(await f.service.advanceDeletion()).toBe(false);
    expect(f.auth.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it('cancels active work during grace without deleting durable account data', async () => {
    const job = { _id: new Types.ObjectId(), status: 'processing' };
    const f = fixture({
      status: 'deleting',
      phase: 'grace_fence',
      activeJobs: [job],
    });
    f.user.deletionRequestedAt = new Date('2026-01-01T00:00:00.000Z');
    f.user.deletionRecoverUntil = new Date('2026-01-16T00:00:00.000Z');

    await f.service.advanceDeletion(new Date('2026-01-02T00:00:00.000Z'));

    expect(f.actions.cancelForAccountDeletion).toHaveBeenCalledWith(
      f.user._id.toHexString(),
      job._id.toHexString(),
    );
    expect(f.user.status).toBe('deleting');
    expect(f.deletion.delete).not.toHaveBeenCalled();
    expect(f.auth.deleteUser).not.toHaveBeenCalled();
  });

  it('backfills the exact fifteen-day deadline and waits before purging', async () => {
    const f = fixture({ status: 'deleting', phase: 'grace_fence' });
    f.user.deletionRequestedAt = new Date('2026-01-31T12:00:00.000Z');
    f.user.deletionRecoverUntil = null as never;

    await f.service.advanceDeletion(new Date('2026-02-01T00:00:00.000Z'));

    expect(f.user.status).toBe('deleting');
    expect(f.user.deletionRecoverUntil).toEqual(
      new Date('2026-02-15T12:00:00.000Z'),
    );
    expect(f.user.deletionNextAt).toEqual(new Date('2026-02-15T12:00:00.000Z'));
    expect(f.auth.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  it.each(['2026-01-16T00:00:00.000Z', '2026-01-16T00:00:00.001Z'])(
    'starts irreversible purge at or after the exact deadline %s',
    async (at) => {
      const f = fixture({ status: 'deleting', phase: 'grace_fence' });
      f.user.deletionRequestedAt = new Date('2026-01-01T00:00:00.000Z');
      f.user.deletionRecoverUntil = new Date('2026-01-16T00:00:00.000Z');

      await f.service.advanceDeletion(new Date(at));

      expect(f.user.status).toBe('purging');
      expect(f.auth.revokeRefreshTokens).toHaveBeenCalledWith('test-user');
      expect(f.user.deletionPhase).toBe('jobs');
    },
  );

  it('keeps the profile while exact-key storage cleanup remains unfinished', async () => {
    const f = fixture({ phase: 'provider' });
    f.storageCleanup.hasPendingForOwner.mockResolvedValue(true);

    await f.service.advanceDeletion(new Date('2026-01-17T00:00:00.000Z'));

    expect(f.storageCleanup.hasPendingForOwner).toHaveBeenCalledWith(
      f.user._id,
    );
    expect(f.auth.deleteUser).not.toHaveBeenCalled();
    expect(f.users.deleteOne).not.toHaveBeenCalled();
  });

  it('retains a safe retry state when final Firebase deletion fails', async () => {
    const f = fixture({ phase: 'provider' });
    f.auth.deleteUser.mockRejectedValue(new Error('fixture provider outage'));

    await f.service.advanceDeletion(new Date('2026-01-17T00:00:00.000Z'));

    expect(f.auth.deleteUser).toHaveBeenCalled();
    expect(f.user.deletionPhase).toBe('provider');
    expect(f.user.deletionFailureCode).toBe('DEPENDENCY_RETRY');
    expect(f.users.deleteOne).not.toHaveBeenCalled();
  });

  it('schedules exact stale-attempt artifacts before deleting attempt records', async () => {
    const jobId = new Types.ObjectId();
    const attempts: Array<Record<string, unknown>> = [];
    const f = fixture({
      phase: 'jobs',
      jobs: [{ _id: jobId, status: 'cancelled' }],
      attempts,
    });
    attempts.push({
      _id: 'attempt-one',
      outputReservation: {
        key: `users/${f.user._id.toHexString()}/jobs/job-one/attempt.mp3`,
      },
      outputObject: {
        key: `users/${f.user._id.toHexString()}/jobs/job-one/published.mp3`,
        versionId: 'version-one',
      },
    });

    await f.service.advanceDeletion(new Date('2026-01-17T00:00:00.000Z'));

    expect(f.storageCleanup.schedule).toHaveBeenCalledTimes(2);
    expect(f.storageCleanup.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: 'version-one',
        ownerUserId: f.user._id,
        reason: 'AUDIO_OUTPUT_ORPHANED',
      }),
    );
    expect(f.collection.deleteMany).toHaveBeenCalledWith({
      jobId,
      _id: { $in: ['attempt-one'] },
    });
  });

  it('walks every account-owned branch 1-4 collection with a durable records cursor', async () => {
    const f = fixture({ phase: 'records' });

    await f.service.advanceDeletion(new Date('2026-01-17T00:00:00.000Z'));

    expect(f.connection.collection.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'audio_notification_outbox',
        'user_devices',
        'device_installation_owners',
        'push_registrations',
        'client_errors',
        'account_recovery_requests',
        'processing_usage_ledger',
        'account_usage_periods',
        'account_daily_usage_periods',
        'upload_grant_receipts',
        'download_grant_receipts',
        'processing_reservations',
        'account_policy_overrides',
        'abuse_event_buckets',
        'abuse_monthly_summaries',
        'account_restrictions',
      ]),
    );
    expect(f.user.deletionPhase).toBe('provider');
    expect(f.user.deletionCursor).toBeNull();
  });

  it('resumes a provider phase and writes only a non-personal tombstone before profile removal', async () => {
    const f = fixture({ phase: 'provider' });
    const now = new Date('2026-01-17T00:00:00.000Z');

    await f.service.advanceDeletion(now);
    expect(f.auth.deleteUser).toHaveBeenCalledWith('test-user');
    expect(f.user.deletionPhase).toBe('profile');
    expect(f.users.deleteOne).not.toHaveBeenCalled();

    await f.service.advanceDeletion(now);

    expect(f.identities.complete).toHaveBeenCalledWith('test-user', now);
    expect(f.tombstones).toEqual([
      {
        acceptedAt: new Date('2025-01-01T00:00:00.000Z'),
        completedAt: now,
        status: 'purged',
        schemaVersion: 1,
      },
    ]);
    expect(JSON.stringify(f.tombstones)).not.toMatch(
      /test-user|email|device|media|s3|abuse|note/i,
    );
    expect(f.users.deleteOne).toHaveBeenCalled();
  });
});
