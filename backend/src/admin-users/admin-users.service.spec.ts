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
  };
  const aggregate = { option: vi.fn().mockResolvedValue([]) };
  const jobs = {
    aggregate: vi.fn(() => aggregate),
    find: vi.fn(() => query([])),
  };
  return {
    service: new AdminUsersService(
      users as never,
      jobs as never,
      {} as never,
      {} as never,
    ),
    users,
    jobs,
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
});
