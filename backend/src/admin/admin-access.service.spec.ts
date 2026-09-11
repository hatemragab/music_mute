import { HttpException } from '@nestjs/common';
import type { AdminActor } from './admin.types.js';
import { AdminAccessService } from './admin-access.service.js';

const actor = (role: AdminActor['role']): AdminActor => ({
  uid: 'actor',
  verifiedEmail: 'actor@example.test',
  role,
  permissions: role === 'owner' ? ['admin.access.manage'] : [],
  accessRevision: 0,
  authTimeSec: 1,
});

describe('AdminAccessService', () => {
  it('rejects a non-owner before identity lookup or mutation', async () => {
    const firebase = { getProfileByEmail: vi.fn() };
    const operations = { run: vi.fn() };
    const service = new AdminAccessService(
      {} as never,
      {} as never,
      firebase as never,
      operations as never,
    );
    await expect(
      service.create(actor('support'), {
        verifiedEmail: 'target@example.test',
        role: 'owner',
        operationId: 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
        reason: 'Grant access',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(firebase.getProfileByEmail).not.toHaveBeenCalled();
    expect(operations.run).not.toHaveBeenCalled();
  });

  it('rejects changing the final active owner inside the transaction', async () => {
    const current = { uid: 'owner', role: 'owner', active: true, revision: 2 };
    const query = {
      session: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(current),
    };
    const accesses = {
      findOne: vi.fn(() => query),
      countDocuments: vi.fn(() => ({ session: vi.fn().mockResolvedValue(1) })),
      findOneAndUpdate: vi.fn(),
    };
    const fence = {
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const operations = {
      run: vi.fn(async (_actor, _command, callback) => callback({})),
    };
    const service = new AdminAccessService(
      accesses as never,
      fence as never,
      {} as never,
      operations as never,
    );
    await expect(
      service.update(actor('owner'), 'owner', {
        role: 'viewer',
        expectedRevision: 2,
        operationId: 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
        reason: 'Change duties',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(fence.updateOne).toHaveBeenCalledOnce();
    expect(accesses.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('binds canonical list cursors to the active filter', async () => {
    const id = '0123456789abcdef01234567';
    const record = {
      _id: { toString: () => id },
      uid: 'one',
      verifiedEmail: 'one@example.test',
      role: 'viewer',
      active: true,
      revision: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const query = {
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maxTimeMS: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([record, record]),
    };
    const service = new AdminAccessService(
      { find: vi.fn(() => query) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const first = await service.list({ active: 'true', limit: '1' });
    await expect(
      service.list({ active: 'false', cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.list({ cursor: [first.nextCursor!] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('returns the current access representation on operation replay', async () => {
    const record = {
      uid: 'target',
      verifiedEmail: 'target@example.test',
      role: 'viewer',
      active: true,
      revision: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const accesses = {
      findOne: vi.fn(() => ({
        maxTimeMS: vi.fn().mockReturnThis(),
        lean: vi.fn().mockResolvedValue(record),
      })),
    };
    const firebase = {
      getProfileByEmail: vi.fn().mockResolvedValue({
        uid: 'target',
        email: 'target@example.test',
        emailVerified: false,
        disabled: false,
        providerData: [
          { providerId: 'google.com', email: 'target@example.test' },
        ],
      }),
    };
    const operations = {
      run: vi.fn().mockResolvedValue({
        replayed: true,
        value: undefined,
        receipt: { resourceId: 'target' },
      }),
    };
    const service = new AdminAccessService(
      accesses as never,
      {} as never,
      firebase as never,
      operations as never,
    );
    await expect(
      service.create(actor('owner'), {
        verifiedEmail: 'target@example.test',
        role: 'viewer',
        operationId: 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
        reason: 'Grant access',
      }),
    ).resolves.toMatchObject({ uid: 'target', role: 'viewer' });
  });
});
