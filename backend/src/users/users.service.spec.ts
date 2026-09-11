import { Types } from 'mongoose';
import type { Model } from 'mongoose';
import type { UserRecord } from 'firebase-admin/auth';
import type { UserIdentityFenceService } from './user-identity-fence.service.js';
const identities = {
  withProvision: async (_uid: string, action: () => Promise<unknown>) =>
    action(),
} as unknown as UserIdentityFenceService;
import { UsersService } from './users.service.js';
import type { User, UserDocument } from './user.schema.js';

describe('user profile trust boundary', () => {
  const identity = {
    uid: 'fixture-owner',
    authTimeSec: 100,
    provider: 'password' as const,
    tokenEmailVerified: false,
  };

  it('rejects profile identity substitution before writing data', async () => {
    const service = new UsersService({} as Model<User>, identities);
    await expect(
      service.provision(identity, { uid: 'fixture-other' } as UserRecord),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('never provisions a disabled Firebase identity', async () => {
    const service = new UsersService({} as Model<User>, identities);
    await expect(
      service.provision(identity, {
        uid: identity.uid,
        disabled: true,
      } as UserRecord),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects profile sync for a different Firebase owner', async () => {
    const model = {
      findById: () => ({
        exec: async () => ({
          _id: new Types.ObjectId(),
          firebaseUid: identity.uid,
        }),
      }),
    };
    const service = new UsersService(
      model as unknown as Model<User>,
      identities,
    );
    await expect(
      service.syncProfile(
        new Types.ObjectId().toHexString(),
        { uid: 'fixture-other' } as UserRecord,
        identity,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each([
    ['google.com', false, true],
    ['apple.com', false, true],
    ['password', false, false],
    ['password', true, true],
  ] as const)(
    'stores %s profiles with Firebase verification %s as %s',
    async (providerId, firebaseVerified, expected) => {
      const id = new Types.ObjectId();
      let state = {
        _id: id,
        firebaseUid: identity.uid,
        status: 'active',
        email: 'user@fixture.invalid',
        emailVerified: false,
        displayName: 'user',
        nameSource: 'email_prefix',
        providerIds: ['password'],
      };
      const model = {
        findById: () => ({ exec: async () => ({ ...state }) }),
        findOneAndUpdate: (
          _filter: Record<string, unknown>,
          update: { $set: Record<string, unknown> },
        ) => ({
          exec: async () => {
            state = { ...state, ...update.$set } as typeof state;
            return { ...state };
          },
        }),
      };
      const service = new UsersService(
        model as unknown as Model<User>,
        identities,
      );

      const result = await service.syncProfile(
        id.toHexString(),
        {
          uid: identity.uid,
          email: 'user@fixture.invalid',
          emailVerified: firebaseVerified,
          providerData: [{ providerId }],
        } as UserRecord,
        {
          ...identity,
          provider: providerId,
          tokenEmailVerified: expected,
        },
      );

      expect(result.emailVerified).toBe(expected);
    },
  );

  it('keeps an unverified password session unverified when Google is only linked', async () => {
    const id = new Types.ObjectId();
    let state = {
      _id: id,
      firebaseUid: identity.uid,
      status: 'active',
      email: 'user@fixture.invalid',
      emailVerified: true,
      displayName: 'user',
      nameSource: 'email_prefix',
      providerIds: ['password', 'google.com'],
    };
    const model = {
      findById: () => ({ exec: async () => ({ ...state }) }),
      findOneAndUpdate: (
        _filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => ({
        exec: async () => {
          state = { ...state, ...update.$set } as typeof state;
          return { ...state };
        },
      }),
    };
    const service = new UsersService(
      model as unknown as Model<User>,
      identities,
    );

    const result = await service.syncProfile(
      id.toHexString(),
      {
        uid: identity.uid,
        email: 'user@fixture.invalid',
        emailVerified: false,
        providerData: [
          { providerId: 'password' },
          { providerId: 'google.com' },
        ],
      } as UserRecord,
      identity,
    );

    expect(result.emailVerified).toBe(false);
  });

  it('preserves a concurrently persisted numeric alias while updating profile fields', async () => {
    const id = new Types.ObjectId();
    const relayEmail = 'hidden@privaterelay.appleid.com';
    const currentEmail = 'new-email@fixture.invalid';
    let state = {
      _id: id,
      firebaseUid: identity.uid,
      status: 'active',
      email: 'old-email@fixture.invalid',
      emailVerified: false,
      displayName: 'old-email',
      nameSource: 'email_prefix',
      providerIds: ['password'],
    };
    let initialReads = 0;
    let releaseReads!: () => void;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let releaseAliasWrite!: () => void;
    const aliasWritten = new Promise<void>((resolve) => {
      releaseAliasWrite = resolve;
    });
    let currentEmailAttempts = 0;
    const model = {
      findById: () => ({
        exec: async () => {
          if (initialReads < 2) {
            initialReads += 1;
            if (initialReads === 2) releaseReads();
            await readsReleased;
          }
          return { ...state };
        },
      }),
      findOneAndUpdate: (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => ({
        exec: async () => {
          if (
            update.$set.email === currentEmail &&
            currentEmailAttempts++ === 0
          )
            await aliasWritten;
          const matches = Object.entries(filter).every(([key, value]) =>
            key === '_id'
              ? String(state._id) === String(value)
              : state[key as keyof typeof state] === value,
          );
          if (!matches) return null;
          state = { ...state, ...update.$set } as typeof state;
          if (update.$set.email === relayEmail) releaseAliasWrite();
          return { ...state };
        },
      }),
    };
    const service = new UsersService(
      model as unknown as Model<User>,
      identities,
    );

    const [aliasResult, currentResult] = await Promise.all([
      service.syncProfile(
        id.toHexString(),
        {
          uid: identity.uid,
          email: relayEmail,
          providerData: [{ providerId: 'apple.com' }],
        } as UserRecord,
        {
          ...identity,
          provider: 'apple.com',
          tokenEmailVerified: true,
        },
      ),
      service.syncProfile(
        id.toHexString(),
        {
          uid: identity.uid,
          email: currentEmail,
          emailVerified: true,
          providerData: [{ providerId: 'google.com' }],
        } as UserRecord,
        {
          ...identity,
          provider: 'google.com',
          tokenEmailVerified: true,
        },
      ),
    ]);

    expect(aliasResult.displayName).toMatch(/^\d{12}$/);
    expect(currentResult.displayName).toBe(aliasResult.displayName);
    expect(state).toMatchObject({
      email: currentEmail,
      emailVerified: true,
      displayName: aliasResult.displayName,
      nameSource: 'numeric_alias',
      providerIds: ['google.com'],
    });
  });

  it('recovers a known Firebase UID duplicate by loading the existing user', async () => {
    const duplicate = Object.assign(new Error('duplicate UID'), {
      code: 11000,
      keyPattern: { firebaseUid: 1 },
    });
    const model = {
      findOneAndUpdate: () => ({ exec: async () => Promise.reject(duplicate) }),
    };
    const user = {
      _id: new Types.ObjectId(),
      firebaseUid: identity.uid,
      status: 'active',
      sessionsRevokedAfterSec: 0,
    } as UserDocument;
    const service = new UsersService(
      model as unknown as Model<User>,
      identities,
    );
    vi.spyOn(service, 'findByFirebaseUid').mockResolvedValue(user);
    vi.spyOn(service, 'syncProfile').mockResolvedValue(user);

    await expect(
      service.provision(identity, { uid: identity.uid } as UserRecord),
    ).resolves.toBe(user);
  });

  it('does not hide an unrelated duplicate-key failure', async () => {
    const duplicate = Object.assign(new Error('unrelated duplicate'), {
      code: 11000,
      keyPattern: { email: 1 },
    });
    const model = {
      findOneAndUpdate: () => ({ exec: async () => Promise.reject(duplicate) }),
    };
    const service = new UsersService(
      model as unknown as Model<User>,
      identities,
    );

    await expect(
      service.provision(identity, { uid: identity.uid } as UserRecord),
    ).rejects.toBe(duplicate);
  });
});
