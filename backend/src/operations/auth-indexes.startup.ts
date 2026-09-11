import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Device } from '../devices/device.schema.js';
import { DeviceInstallationOwner } from '../devices/device-installation-owner.schema.js';
import { User } from '../users/user.schema.js';
import { UserIdentityFence } from '../users/user-identity-fence.schema.js';
import { StartupDependencyError } from '../startup-error.js';

interface StartupModel {
  init(): Promise<unknown>;
  schema?: {
    indexes(): Array<[Record<string, unknown>, { name?: unknown } | undefined]>;
  };
  collection?: {
    listIndexes(): {
      toArray(): Promise<Array<{ name?: unknown; key?: unknown }>>;
    };
  };
}

function sameIndexKey(left: unknown, right: unknown): boolean {
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return false;
  return (
    JSON.stringify(Object.entries(left)) ===
    JSON.stringify(Object.entries(right))
  );
}

async function indexConflictProvider(
  error: unknown,
  model: StartupModel,
): Promise<unknown> {
  if (
    !(error instanceof Error) ||
    (error as Error & { code?: unknown }).code !== 86 ||
    !model.schema ||
    !model.collection
  )
    return error;
  try {
    const actualIndexes = await model.collection.listIndexes().toArray();
    const conflict = model.schema.indexes().find(([expectedKey, options]) => {
      if (typeof options?.name !== 'string') return false;
      return actualIndexes.some(
        (actual) =>
          actual.name === options.name &&
          !sameIndexKey(actual.key, expectedKey),
      );
    });
    const indexName = conflict?.[1]?.name;
    if (typeof indexName !== 'string') return error;
    return Object.assign(new Error('MongoDB index conflict'), {
      name: error.name,
      code: (error as Error & { code: number }).code,
      indexName,
    });
  } catch {
    return error;
  }
}

async function initializeModel(
  stage: string,
  model: StartupModel,
): Promise<void> {
  try {
    await model.init();
  } catch (error) {
    throw new StartupDependencyError(
      stage,
      await indexConflictProvider(error, model),
    );
  }
}

@Injectable()
export class AuthIndexesStartup implements OnModuleInit {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    @InjectModel(DeviceInstallationOwner.name)
    private readonly installationOwners: Model<DeviceInstallationOwner>,
    @InjectModel(UserIdentityFence.name)
    private readonly identities: Model<UserIdentityFence>,
  ) {}

  async onModuleInit(): Promise<void> {
    await initializeModel('User schema initialization failed', this.users);
    await initializeModel('Device schema initialization failed', this.devices);
    await initializeModel(
      'Device installation owner schema initialization failed',
      this.installationOwners,
    );
    await initializeModel(
      'User identity fence schema initialization failed',
      this.identities,
    );
  }
}
