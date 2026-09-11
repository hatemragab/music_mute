import type { UserIdentityFence } from '../users/user-identity-fence.schema.js';
import type { Connection, Model } from 'mongoose';
import type { Device } from '../devices/device.schema.js';
import type { DeviceInstallationOwner } from '../devices/device-installation-owner.schema.js';
import type { User } from '../users/user.schema.js';
import { applyAuthIndexes, inspectAuthIndexes } from './auth-indexes.js';
import { AuthIndexesStartup } from './auth-indexes.startup.js';

interface CollectionFixture {
  indexes?: Array<Record<string, unknown>>;
  duplicates?: { groups: number; documents: number };
  createIndex?: ReturnType<typeof vi.fn>;
}

function connectionFixture(
  collections: Record<string, CollectionFixture>,
): Connection {
  return {
    db: {
      listCollections: ({ name }: { name: string }) => ({
        hasNext: async () => name in collections,
      }),
      collection: (name: string) => ({
        listIndexes: () => ({
          toArray: async () => collections[name]?.indexes ?? [],
        }),
        aggregate: () => ({
          toArray: async () => {
            const duplicate = collections[name]?.duplicates;
            return duplicate && duplicate.groups > 0 ? [duplicate] : [];
          },
        }),
        createIndex:
          collections[name]?.createIndex ??
          vi.fn().mockResolvedValue('created'),
      }),
    },
  } as unknown as Connection;
}

describe('auth index operations', () => {
  it('reports absent collections without attempting a write', async () => {
    const result = await inspectAuthIndexes(connectionFixture({}));

    expect(result.ready).toBe(false);
    expect(result.missing.map((index) => index.name)).toEqual([
      'users_firebase_uid_unique',
      'devices_owner_installation_unique',
      'devices_owner_cursor',
      'devices_recent_versions',
    ]);
    expect(result.conflicting).toEqual([]);
    expect(result.duplicates.every((item) => item.documents === 0)).toBe(true);
  });

  it('reports exact name, key and uniqueness conflicts', async () => {
    const result = await inspectAuthIndexes(
      connectionFixture({
        users: {
          indexes: [
            {
              name: 'users_firebase_uid_unique',
              key: { firebaseUid: -1 },
              unique: true,
            },
          ],
        },
        user_devices: {
          indexes: [
            {
              name: 'wrong_device_index_name',
              key: { userId: 1, installationId: 1 },
              unique: false,
            },
            {
              name: 'devices_owner_cursor',
              key: { userId: 1, _id: -1, search: 'hashed' },
              unique: false,
            },
          ],
        },
      }),
    );

    expect(result.conflicting).toHaveLength(3);
    expect(result.conflicting.map((item) => item.required.name)).toEqual([
      'users_firebase_uid_unique',
      'devices_owner_installation_unique',
      'devices_owner_cursor',
    ]);
  });

  it('counts duplicate identity groups and documents before apply', async () => {
    const connection = connectionFixture({
      users: { duplicates: { groups: 1, documents: 2 } },
      user_devices: { duplicates: { groups: 2, documents: 5 } },
    });

    const result = await inspectAuthIndexes(connection);

    expect(result.duplicates).toEqual([
      {
        collection: 'users',
        indexName: 'users_firebase_uid_unique',
        groups: 1,
        documents: 2,
      },
      {
        collection: 'user_devices',
        indexName: 'devices_owner_installation_unique',
        groups: 2,
        documents: 5,
      },
    ]);
    await expect(applyAuthIndexes(connection)).rejects.toThrow(
      'AUTH_INDEX_DUPLICATES',
    );
  });

  it('creates only missing required indexes after a clean inspection', async () => {
    const createUser = vi.fn().mockResolvedValue('users_firebase_uid_unique');
    const createDevice = vi.fn().mockResolvedValue('created');
    const connection = connectionFixture({
      users: { createIndex: createUser },
      user_devices: { createIndex: createDevice },
    });

    await applyAuthIndexes(connection);

    expect(createUser).toHaveBeenCalledWith(
      { firebaseUid: 1 },
      { name: 'users_firebase_uid_unique', unique: true },
    );
    expect(createDevice).toHaveBeenCalledWith(
      { userId: 1, installationId: 1 },
      { name: 'devices_owner_installation_unique', unique: true },
    );
    expect(createDevice).toHaveBeenCalledWith(
      { userId: 1, _id: -1 },
      { name: 'devices_owner_cursor' },
    );
    expect(createDevice).toHaveBeenCalledWith(
      { lastSeenAt: 1, platform: 1, buildNumber: 1 },
      { name: 'devices_recent_versions' },
    );
  });
});

describe('AuthIndexesStartup', () => {
  it('awaits model index initialization outside production', async () => {
    const users = { init: vi.fn().mockResolvedValue(undefined) };
    const devices = { init: vi.fn().mockResolvedValue(undefined) };
    const installationOwners = { init: vi.fn().mockResolvedValue(undefined) };
    const startup = new AuthIndexesStartup(
      users as unknown as Model<User>,
      devices as unknown as Model<Device>,
      installationOwners as unknown as Model<DeviceInstallationOwner>,
      {
        init: vi.fn().mockResolvedValue(undefined),
      } as unknown as Model<UserIdentityFence>,
    );

    await startup.onModuleInit();

    expect(users.init).toHaveBeenCalledOnce();
    expect(devices.init).toHaveBeenCalledOnce();
    expect(installationOwners.init).toHaveBeenCalledOnce();
  });

  it('awaits schema index initialization during production startup', async () => {
    const users = { init: vi.fn().mockResolvedValue(undefined) };
    const devices = { init: vi.fn().mockResolvedValue(undefined) };
    const installationOwners = { init: vi.fn().mockResolvedValue(undefined) };
    const startup = new AuthIndexesStartup(
      users as unknown as Model<User>,
      devices as unknown as Model<Device>,
      installationOwners as unknown as Model<DeviceInstallationOwner>,
      {
        init: vi.fn().mockResolvedValue(undefined),
      } as unknown as Model<UserIdentityFence>,
    );

    await expect(startup.onModuleInit()).resolves.toBeUndefined();
    expect(users.init).toHaveBeenCalledOnce();
    expect(devices.init).toHaveBeenCalledOnce();
    expect(installationOwners.init).toHaveBeenCalledOnce();
  });

  it('rejects startup when a schema index cannot be initialized', async () => {
    const users = {
      init: vi.fn().mockRejectedValue(new Error('INDEX_BUILD_FAILED')),
    };
    const devices = { init: vi.fn().mockResolvedValue(undefined) };
    const installationOwners = { init: vi.fn().mockResolvedValue(undefined) };
    const startup = new AuthIndexesStartup(
      users as unknown as Model<User>,
      devices as unknown as Model<Device>,
      installationOwners as unknown as Model<DeviceInstallationOwner>,
      {
        init: vi.fn().mockResolvedValue(undefined),
      } as unknown as Model<UserIdentityFence>,
    );

    await expect(startup.onModuleInit()).rejects.toThrow('INDEX_BUILD_FAILED');
  });
});
