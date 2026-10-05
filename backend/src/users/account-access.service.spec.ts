import { Types } from 'mongoose';
import type { ClientSession, Model } from 'mongoose';
import { AccountAccessService } from './account-access.service.js';
import type { User } from './user.schema.js';

function fixture(status: User['status'] | null = 'active') {
  const owner = new Types.ObjectId();
  const query = {
    read: vi.fn(() => query),
    exec: vi.fn(async () => (status === 'active' ? { _id: owner } : null)),
  };
  const session = {
    withTransaction: vi.fn(async (operation: () => Promise<unknown>) =>
      operation(),
    ),
    endSession: vi.fn(async () => {}),
  };
  const users = {
    exists: vi.fn(
      (filter: { _id: string | Types.ObjectId; status: string }) => {
        query.exec.mockImplementation(async () =>
          String(filter._id) === String(owner) && status === filter.status
            ? { _id: owner }
            : null,
        );
        return query;
      },
    ),
    updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
    db: { startSession: vi.fn(async () => session) },
  };
  const service = new AccountAccessService(users as unknown as Model<User>);
  return { owner, query, session, users, service };
}

describe('read-only account access', () => {
  it('checks only active existence on the primary without writing or starting a transaction', async () => {
    const f = fixture();

    await expect(
      f.service.assertActiveReadOnly(f.owner),
    ).resolves.toBeUndefined();

    expect(f.users.exists).toHaveBeenCalledWith({
      _id: f.owner,
      status: 'active',
    });
    expect(f.query.read).toHaveBeenCalledWith('primary');
    expect(f.query.exec).toHaveBeenCalledOnce();
    expect(f.users.updateOne).not.toHaveBeenCalled();
    expect(f.users.db.startSession).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'deleting', 'purging', null] as const)(
    'denies a %s account without acquiring the write fence',
    async (status) => {
      const f = fixture(status);

      await expect(
        f.service.assertActiveReadOnly(f.owner.toHexString()),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'ACCOUNT_DISABLED' },
      });

      expect(f.users.updateOne).not.toHaveBeenCalled();
      expect(f.users.db.startSession).not.toHaveBeenCalled();
    },
  );

  it('does not substitute another active owner for the requested account', async () => {
    const f = fixture();
    const other = new Types.ObjectId();

    await expect(f.service.assertActiveReadOnly(other)).rejects.toMatchObject({
      response: { code: 'ACCOUNT_DISABLED' },
    });

    expect(f.users.exists).toHaveBeenCalledWith({
      _id: other,
      status: 'active',
    });
    expect(f.users.updateOne).not.toHaveBeenCalled();
  });

  it('keeps parallel snapshot validation free of account revision writes', async () => {
    const f = fixture();

    await Promise.all(
      Array.from({ length: 10 }, () => f.service.assertActiveReadOnly(f.owner)),
    );

    expect(f.users.exists).toHaveBeenCalledTimes(10);
    expect(f.users.updateOne).not.toHaveBeenCalled();
    expect(f.users.db.startSession).not.toHaveBeenCalled();
  });

  it('preserves database failures instead of treating them as active access', async () => {
    const f = fixture();
    const failure = new Error('Synthetic database failure');
    f.query.exec.mockRejectedValueOnce(failure);

    await expect(f.service.assertActiveReadOnly(f.owner)).rejects.toBe(failure);
    expect(f.users.updateOne).not.toHaveBeenCalled();
  });
});

describe('account-owned write fences', () => {
  it('preserves the revision increment and caller transaction session', async () => {
    const f = fixture();

    await f.service.assertActive(
      f.owner,
      f.session as unknown as ClientSession,
    );

    expect(f.users.updateOne).toHaveBeenCalledWith(
      { _id: f.owner, status: 'active' },
      { $inc: { accessRevision: 1 } },
      { session: f.session },
    );
    expect(f.users.exists).not.toHaveBeenCalled();
  });

  it('still rejects commands when the account write fence cannot be acquired', async () => {
    const f = fixture();
    f.users.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });

    await expect(f.service.assertActive(f.owner)).rejects.toMatchObject({
      response: { code: 'ACCOUNT_DISABLED' },
    });
    expect(f.users.exists).not.toHaveBeenCalled();
  });

  it('runs account-owned commands only after the transactional write fence', async () => {
    const f = fixture();
    const operation = vi.fn(async () => {
      expect(f.users.updateOne).toHaveBeenCalledOnce();
      return 'accepted';
    });

    await expect(f.service.runActive(f.owner, operation)).resolves.toBe(
      'accepted',
    );

    expect(operation).toHaveBeenCalledWith(f.session);
    expect(f.session.endSession).toHaveBeenCalledOnce();
    expect(f.users.exists).not.toHaveBeenCalled();
  });

  it('does not execute account-owned commands after disablement and ends the session', async () => {
    const f = fixture();
    f.users.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    const operation = vi.fn();

    await expect(f.service.runActive(f.owner, operation)).rejects.toMatchObject(
      {
        response: { code: 'ACCOUNT_DISABLED' },
      },
    );

    expect(operation).not.toHaveBeenCalled();
    expect(f.session.endSession).toHaveBeenCalledOnce();
  });
});
