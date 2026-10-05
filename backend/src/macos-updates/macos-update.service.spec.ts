import { ConfigService } from '@nestjs/config';
import { Types, type Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type {
  AdminOperationsService,
  AdminMutationResult,
} from '../admin/admin-operations.service.js';
import type { AdminActor } from '../admin/admin.types.js';
import {
  MacosUpdate,
  MacosUpdateConfiguration,
} from './macos-update.schema.js';
import { MacosUpdateService } from './macos-update.service.js';
import type { MacosUpdateStorageService } from './macos-update-storage.service.js';

const actor = { uid: 'owner', role: 'owner', accessRevision: 0 } as AdminActor;
const operationId = 'e091e3c0-5803-49b1-89a1-29c235b16ca1';
const publicEdKey = Buffer.alloc(32, 9).toString('base64');
function setup() {
  let config: MacosUpdateConfiguration = {
    _id: 'global',
    revision: 1,
    mutationFence: 0,
    publicEdKey,
    selectedReleaseId: null,
  };
  const release = {
    _id: new Types.ObjectId(),
    versionName: '1.2.3',
    buildNumber: '42',
    buildOrder: '000000000000000042',
    archiveName: `MusicMute-1.2.3-42-arm64-${'a'.repeat(64)}.dmg`,
    bytes: 42,
    sha256Hex: 'a'.repeat(64),
    appcastBase64: Buffer.from('<signed-exact-bytes/>').toString('base64'),
    key: 'releases/macos/fixture.dmg',
    publicEdKey,
    etag: '"verified"',
    state: 'draft',
    artifactState: 'verified',
    revision: 0,
    createdBy: 'owner',
    createdAt: new Date(),
    updatedAt: new Date(),
    publishedAt: null,
    save: vi.fn(async () => undefined),
    toObject() {
      return { ...this };
    },
  } as MacosUpdate & {
    save: ReturnType<typeof vi.fn>;
    toObject(): MacosUpdate;
  };
  let latest: MacosUpdate | null = null;
  function query<T>(value: () => T) {
    const builder = {
      session: vi.fn().mockReturnThis(),
      maxTimeMS: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn(async () => value()),
      // This fixture mirrors Mongoose's awaitable query contract.
      // oxlint-disable-next-line unicorn/no-thenable
      then(
        resolve: (value: T) => unknown,
        reject: (reason: unknown) => unknown,
      ) {
        return Promise.resolve(value()).then(resolve, reject);
      },
    };
    return builder;
  }
  const configurations = {
    findById: vi.fn(() => query(() => ({ ...config }))),
    updateOne: vi.fn(
      async (filter: { revision: number }, update: { $set: object }) => {
        if (filter.revision !== config.revision)
          return { modifiedCount: 0, upsertedCount: 0 };
        config = {
          ...config,
          ...update.$set,
          mutationFence: config.mutationFence + 1,
        };
        return { modifiedCount: 1 };
      },
    ),
  };
  const releases = {
    findById: vi.fn(() => query(() => release)),
    exists: vi.fn(() => query(() => latest)),
    findOne: vi.fn((filter: Record<string, unknown>) =>
      query(() =>
        filter._id && typeof filter._id === 'object' && '$ne' in filter._id
          ? latest
          : release,
      ),
    ),
  };
  const receipts = new Map<
    string,
    { resourceId: string; revision: number | null }
  >();
  const operations = {
    run: vi.fn(async (_actor, command, mutate) => {
      if (receipts.has(command.operationId))
        return {
          receipt: receipts.get(command.operationId),
          replayed: true,
          value: undefined,
        };
      const result: AdminMutationResult<unknown> = await mutate({});
      const receipt = {
        resourceId: result.resourceId,
        revision: result.revision ?? null,
      };
      receipts.set(command.operationId, receipt);
      return { value: result.value, receipt, replayed: false };
    }),
  };
  const storage = {
    verify: vi.fn(async () => '"verified"'),
    grant: vi.fn(async () => ({
      method: 'PUT',
      url: 'https://fixture.test/upload',
      headers: { 'If-None-Match': '*' },
      expiresAt: new Date().toISOString(),
    })),
    download: vi.fn(async () => 'https://fixture.test/signed'),
  };
  const service = new MacosUpdateService(
    releases as unknown as Model<MacosUpdate>,
    configurations as unknown as Model<MacosUpdateConfiguration>,
    operations as unknown as AdminOperationsService,
    storage as unknown as MacosUpdateStorageService,
    new ConfigService({ PUBLIC_SITE_ORIGIN: 'https://example.test' }),
  );
  return {
    service,
    release,
    storage,
    configurations,
    operations,
    config: () => config,
    latest(value: MacosUpdate | null) {
      latest = value;
    },
  };
}
describe('macOS update administrative transitions', () => {
  it('allows only owners to change trust keys and blocks rotation after any release exists', async () => {
    const fixture = setup(),
      body = {
        expectedRevision: 1,
        publicEdKey: Buffer.alloc(32, 10).toString('base64'),
        operationId,
        reason: 'Initial trust key',
      };
    await expect(
      fixture.service.configure({ ...actor, role: 'release_manager' }, body),
    ).rejects.toMatchObject({ response: { code: 'PERMISSION_DENIED' } });
    fixture.latest(fixture.release);
    await expect(fixture.service.configure(actor, body)).rejects.toMatchObject({
      response: { code: 'REVISION_CONFLICT' },
    });
    expect(fixture.configurations.updateOne).not.toHaveBeenCalled();
  });
  it('requires verified artifacts and both expected revisions before selecting an update', async () => {
    for (const extra of [
      { expectedRevision: 2 },
      { expectedConfigurationRevision: 2 },
      { awaiting: true },
    ]) {
      const fixture = setup();
      if ('awaiting' in extra)
        fixture.release.artifactState = 'awaiting_upload';
      const body = {
        operationId,
        reason: 'Publish tested update',
        expectedRevision: 0,
        expectedConfigurationRevision: 1,
        ...('awaiting' in extra ? {} : extra),
      };
      await expect(
        fixture.service.mutate(
          actor,
          fixture.release._id.toString(),
          'publish',
          body,
        ),
      ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
      expect(fixture.release.save).not.toHaveBeenCalled();
    }
  });
  it('publishes, withdraws the selected feed, retains old downloads, and safely republishes the newest build', async () => {
    const fixture = setup(),
      id = fixture.release._id.toString();
    const published = await fixture.service.mutate(actor, id, 'publish', {
      operationId,
      reason: 'Publish tested update',
      expectedRevision: 0,
      expectedConfigurationRevision: 1,
    });
    expect(published).toMatchObject({
      release: { state: 'published', revision: 1 },
      configurationRevision: 2,
    });
    expect(await fixture.service.appcast()).toEqual(
      Buffer.from('<signed-exact-bytes/>'),
    );
    await fixture.service.mutate(actor, id, 'withdraw', {
      operationId: '12345678-1234-4123-8123-123456789012',
      reason: 'Stop advertising update',
      expectedRevision: 1,
      expectedConfigurationRevision: 2,
    });
    expect(await fixture.service.appcast()).toBeNull();
    expect(fixture.release.publishedAt).toBeInstanceOf(Date);
    expect(await fixture.service.download(fixture.release.archiveName)).toBe(
      'https://fixture.test/signed',
    );
    await fixture.service.mutate(actor, id, 'publish', {
      operationId: '22345678-1234-4123-8123-123456789012',
      reason: 'Restore newest tested update',
      expectedRevision: 2,
      expectedConfigurationRevision: 3,
    });
    expect(fixture.config().selectedReleaseId?.toString()).toBe(id);
  });
  it('rejects publication below the highest ever-published build, including a withdrawn newer build', async () => {
    const fixture = setup();
    fixture.latest({
      ...fixture.release,
      _id: new Types.ObjectId(),
      buildNumber: '100',
      state: 'withdrawn',
      publishedAt: new Date(),
    });
    await expect(
      fixture.service.mutate(actor, fixture.release._id.toString(), 'publish', {
        operationId,
        reason: 'Publish older update',
        expectedRevision: 0,
        expectedConfigurationRevision: 1,
      }),
    ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
  });
  it('verifies once, then retries completion without reading R2 again', async () => {
    const fixture = setup();
    fixture.release.artifactState = 'awaiting_upload';
    fixture.release.etag = null;
    const id = fixture.release._id.toString();
    await expect(
      fixture.service.complete(actor, id, { operationId }),
    ).resolves.toMatchObject({ artifactState: 'verified', revision: 1 });
    await expect(
      fixture.service.complete(actor, id, { operationId }),
    ).resolves.toMatchObject({ artifactState: 'verified', revision: 1 });
    expect(fixture.storage.verify).toHaveBeenCalledOnce();
  });
  it('reissues an audited create-only grant to resume an awaiting draft after reload', async () => {
    const fixture = setup();
    fixture.release.artifactState = 'awaiting_upload';
    fixture.release.etag = null;
    const id = fixture.release._id.toString(),
      body = { operationId, expectedRevision: 0, reason: 'Resume upload' };
    await expect(
      fixture.service.upload(actor, id, body),
    ).resolves.toMatchObject({
      release: { revision: 1 },
      grant: { headers: { 'If-None-Match': '*' } },
    });
    await expect(
      fixture.service.upload(actor, id, body),
    ).resolves.toMatchObject({ release: { revision: 1 } });
    expect(fixture.release.save).toHaveBeenCalledOnce();
    expect(fixture.storage.grant).toHaveBeenCalledTimes(2);
    fixture.release.artifactState = 'verified';
    await expect(
      fixture.service.upload(actor, id, {
        ...body,
        operationId: '22345678-1234-4123-8123-123456789012',
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
  });
});
