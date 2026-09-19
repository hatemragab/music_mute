import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { AdminUsersService } from './admin-users.service.js';

const id = new Types.ObjectId('64b000000000000000000001');
const now = new Date('2026-09-10T12:00:00.000Z');

function query<T>(value: T) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ['sort', 'limit', 'maxTimeMS', 'session', 'select'])
    chain[name] = vi.fn(() => chain);
  chain.exec = vi.fn().mockResolvedValue(value);
  chain.lean = vi.fn().mockResolvedValue(value);
  return chain;
}

function user(overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    firebaseUid: 'firebase-user-1',
    email: 'person@example.test',
    displayName: 'Person One',
    status: 'active',
    processingSuspended: false,
    processingSuspensionReason: null,
    processingSuspendedBy: null,
    processingSuspendedAt: null,
    adminRevision: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setup(records = [user()]) {
  const users = {
    find: vi.fn(() => query(records)),
    findOne: vi.fn(() => query(records[0] ?? null)),
    findOneAndUpdate: vi.fn(() =>
      query(user({ processingSuspended: true, adminRevision: 1 })),
    ),
  };
  const aggregate = { option: vi.fn().mockResolvedValue([]) };
  const jobs = {
    aggregate: vi.fn(() => aggregate),
    find: vi.fn(() => query([])),
  };
  const fences = {
    updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
  };
  const identity = { touch: vi.fn().mockResolvedValue(undefined) };
  const operations = {
    run: vi.fn(async (_actor, _command, mutation) => ({
      value: (await mutation({})).value,
      replayed: false,
      receipt: {},
    })),
  };
  return {
    service: new AdminUsersService(
      users as never,
      jobs as never,
      fences as never,
      identity as never,
      operations as never,
      {} as never,
      {} as never,
    ),
    users,
    jobs,
    fences,
    identity,
    operations,
  };
}

describe('AdminUsersService', () => {
  it('uses exact uid/email and escaped anchored display-name prefix search', async () => {
    const f = setup();
    await f.service.list({ query: 'a.b@example.test', limit: '25' });
    const filter = (
      f.users.find.mock.calls as unknown as [Record<string, unknown>][]
    )[0]![0];
    expect(filter.$or).toEqual([
      { firebaseUid: 'a.b@example.test' },
      { email: /^a\.b@example\.test$/i },
      { displayName: /^a\.b@example\.test/i },
    ]);
  });

  it('binds pagination cursors to normalized filters', async () => {
    const records = [
      user(),
      user({ _id: new Types.ObjectId('64b000000000000000000002') }),
    ];
    const f = setup(records);
    const first = await f.service.list({ query: ' Person ', limit: '1' });
    await expect(
      f.service.list({ query: 'Other', limit: '1', cursor: first.nextCursor! }),
    ).rejects.toMatchObject({
      response: { code: 'INVALID_CURSOR' },
    });
  });

  it('does not reuse a cursor when exact UID case changes', async () => {
    const records = [
      user(),
      user({ _id: new Types.ObjectId('64b000000000000000000002') }),
    ];
    const f = setup(records);
    const first = await f.service.list({ query: 'ExactUid', limit: '1' });
    await expect(
      f.service.list({
        query: 'exactuid',
        limit: '1',
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CURSOR' } });
  });

  it('treats legacy users with no suspension field as not suspended', async () => {
    const f = setup();
    await f.service.list({ processingSuspended: 'false' });
    const filter = (
      f.users.find.mock.calls as unknown as [Record<string, unknown>][]
    )[0]![0];
    expect((filter.processingSuspended as { $ne: boolean }).$ne).toBe(true);
  });

  it('returns bounded recent job ids and batched processing counts in detail', async () => {
    const f = setup();
    const jobId = new Types.ObjectId('64b000000000000000000099');
    f.jobs.aggregate.mockReturnValue({
      option: vi.fn().mockResolvedValue([{ _id: 'ready', count: 3 }]),
    });
    f.jobs.find.mockReturnValue(query([{ _id: jobId }]));
    await expect(f.service.detail(id.toHexString())).resolves.toMatchObject({
      id: id.toHexString(),
      processingCounts: { ready: 3 },
      recentJobIds: [jobId.toHexString()],
    });
    expect(f.jobs.aggregate).toHaveBeenCalledOnce();
    expect(f.jobs.find).toHaveBeenCalledOnce();
  });

  it('suspends under identity and admission fences without changing account status', async () => {
    const f = setup();
    const result = await f.service.suspend(
      { uid: 'admin-1', role: 'support', accessRevision: 0 } as never,
      id.toHexString(),
      {
        expectedRevision: 0,
        operationId: 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
        reason: 'Abuse review',
      },
    );
    expect(f.identity.touch).toHaveBeenCalledWith(
      'firebase-user-1',
      expect.anything(),
    );
    expect(f.fences.updateOne).toHaveBeenCalledWith(
      { _id: `user:${id.toHexString()}` },
      { $inc: { revision: 1 } },
      expect.objectContaining({ upsert: true }),
    );
    const update = (
      f.users.findOneAndUpdate.mock.calls as unknown as [
        unknown,
        Record<string, Record<string, unknown>>,
      ][]
    )[0]![1];
    expect(update.$set).toMatchObject({
      processingSuspended: true,
      processingSuspensionReason: 'Abuse review',
    });
    expect(update.$set).not.toHaveProperty('status');
    const mutationFilter = (
      f.users.findOneAndUpdate.mock.calls as unknown as [
        Record<string, unknown>,
        unknown,
      ][]
    )[0]![0];
    expect((mutationFilter.adminRevision as { $in: unknown[] }).$in).toEqual([
      0,
      null,
    ]);
    expect(result.status).toBe('active');
  });

  it('rejects stale revisions before mutating a user', async () => {
    const f = setup([user({ adminRevision: 2 })]);
    await expect(
      f.service.resume(
        { uid: 'admin-1', role: 'support', accessRevision: 0 } as never,
        id.toHexString(),
        {
          expectedRevision: 1,
          operationId: '14b2d476-e40e-4aeb-a8dd-24db12337695',
          reason: 'Review complete',
        },
      ),
    ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
    expect(f.users.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('clears suspension metadata when processing is resumed', async () => {
    const f = setup([
      user({
        processingSuspended: true,
        processingSuspensionReason: 'Old reason',
        processingSuspendedBy: 'old-admin',
        processingSuspendedAt: now,
      }),
    ]);
    f.users.findOneAndUpdate.mockReturnValue(
      query(user({ processingSuspended: false, adminRevision: 1 })),
    );
    await f.service.resume(
      { uid: 'admin-1', role: 'support', accessRevision: 0 } as never,
      id.toHexString(),
      {
        expectedRevision: 0,
        operationId: '14b2d476-e40e-4aeb-a8dd-24db12337695',
        reason: 'Review complete',
      },
    );
    const update = (
      f.users.findOneAndUpdate.mock.calls as unknown as [
        unknown,
        Record<string, Record<string, unknown>>,
      ][]
    )[0]![1];
    expect(update.$set).toMatchObject({
      processingSuspended: false,
      processingSuspensionReason: null,
      processingSuspendedBy: null,
      processingSuspendedAt: null,
    });
  });
});
