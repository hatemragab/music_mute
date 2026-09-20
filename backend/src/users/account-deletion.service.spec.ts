import { describe, expect, it, vi } from 'vitest';
import { Types, type Model } from 'mongoose';
import { AccountDeletionService } from './account-deletion.service.js';
import type { UserIdentityFenceService } from './user-identity-fence.service.js';
import type { User } from './user.schema.js';

describe('account deletion acceptance', () => {
  function fixture() {
    const user = {
      _id: new Types.ObjectId(),
      status: 'active',
      deletionRequestId: null as string | null,
    };
    const model = {
      findOneAndUpdate: vi.fn((_filter, update) => ({
        exec: async () => {
          if (user.status !== 'active') return null;
          Object.assign(user, update.$set);
          return user;
        },
      })),
      findById: vi.fn(() => ({ exec: async () => user })),
    };
    return {
      user,
      model,
      service: new AccountDeletionService(
        model as unknown as Model<User>,
        {
          withDeletion: async (_uid: string, action: () => Promise<unknown>) =>
            action(),
        } as unknown as UserIdentityFenceService,
      ),
    };
  }
  it('durably fences access before returning an acceptance receipt and reuses it on retry', async () => {
    const f = fixture();
    const receipt = await f.service.requestDeletion(
      f.user._id.toHexString(),
      1000,
      new Date(1000_000),
    );
    expect(receipt).toMatchObject({
      status: 'accepted',
      requestId: expect.any(String),
      recoverUntil: '1970-01-16T00:16:40.000Z',
    });
    expect(f.user.status).toBe('deleting');
    expect(
      (f.user as { deletionRecoverUntil?: Date }).deletionRecoverUntil,
    ).toEqual(new Date('1970-01-16T00:16:40.000Z'));
    expect(
      await f.service.requestDeletion(
        f.user._id.toHexString(),
        1000,
        new Date(1000_000),
      ),
    ).toEqual(receipt);
  });
  it.each([0, 699, 1001, NaN])(
    'rejects stale, future or invalid authentication time %s before mutation',
    async (authTime) => {
      const f = fixture();
      await expect(
        f.service.requestDeletion(
          f.user._id.toHexString(),
          authTime,
          new Date(1000_000),
        ),
      ).rejects.toMatchObject({
        response: { code: 'REAUTHENTICATION_REQUIRED' },
      });
      expect(f.user.status).toBe('active');
    },
  );
  it('never reports acceptance when persistence fails', async () => {
    const f = fixture();
    f.model.findOneAndUpdate.mockImplementation(() => ({
      exec: async () => {
        throw new Error('offline');
      },
    }));
    await expect(
      f.service.requestDeletion(
        f.user._id.toHexString(),
        1000,
        new Date(1000_000),
      ),
    ).rejects.toThrow('offline');
  });
  it('does not convert an administratively disabled account into a deletion without the verified support path', async () => {
    const f = fixture();
    f.user.status = 'disabled';
    await expect(
      f.service.requestDeletion(
        f.user._id.toHexString(),
        1000,
        new Date(1000_000),
      ),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_DISABLED' } });
  });
});
