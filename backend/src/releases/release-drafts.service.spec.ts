import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import { ReleaseDraftsService } from './release-drafts.service.js';
import { Release } from './release.schema.js';
import type { AdminOperationsService } from '../admin/admin-operations.service.js';
import type { AdminActor } from '../admin/admin.types.js';
const actor = { uid: 'owner', role: 'owner', accessRevision: 0 } as AdminActor;
describe('release draft writes', () => {
  function setup(record?: object, latest: object | null = null) {
    const save = vi.fn();
    const doc = record ? { ...record, save, set: vi.fn() } : null;
    const latestQuery = {
      sort: vi.fn().mockReturnThis(),
      maxTimeMS: vi.fn().mockReturnThis(),
      session: vi.fn().mockReturnThis(),
      lean: vi.fn(async () => latest),
    };
    const models = {
      findById: vi.fn(() => ({ session: () => doc })),
      findOne: vi.fn(() => latestQuery),
      create: vi.fn(async () => {
        throw new Error('release write should not happen');
      }),
    };
    const ops = { run: vi.fn(async (_a, _cmd, mutate) => mutate({})) };
    const service = new ReleaseDraftsService(
      models as unknown as Model<Release>,
      ops as unknown as AdminOperationsService,
      new ConfigService({
        APK_EXPECTED_PACKAGE_ID: 'com.example.fixture',
        APP_ANDROID_CURRENT_VERSION_NAME: '0.1.0',
        APP_ANDROID_CURRENT_BUILD_NUMBER: 1,
        APP_IOS_CURRENT_VERSION_NAME: '0.1.0',
        APP_IOS_CURRENT_BUILD_NUMBER: 1,
      }),
    );
    return { service, save, models, ops, latestQuery };
  }
  it('proposes the next version and build from the latest channel release', async () => {
    const { service } = setup(undefined, {
      versionName: '1.2.0',
      buildNumber: 12,
    });

    await expect(
      (
        service as ReleaseDraftsService & {
          proposal(input: Record<string, unknown>): Promise<unknown>;
        }
      ).proposal({ platform: 'android', source: 'direct_apk' }),
    ).resolves.toEqual({
      platform: 'android',
      source: 'direct_apk',
      current: { versionName: '1.2.0', buildNumber: 12 },
      suggested: { versionName: '1.2.1', buildNumber: 13 },
    });
  });
  it('uses the maintained app version when a channel has no releases', async () => {
    const { service } = setup();

    await expect(
      (
        service as ReleaseDraftsService & {
          proposal(input: Record<string, unknown>): Promise<unknown>;
        }
      ).proposal({ platform: 'ios', source: 'app_store' }),
    ).resolves.toMatchObject({
      current: { versionName: '0.1.0', buildNumber: 1 },
      suggested: { versionName: '0.1.1', buildNumber: 2 },
    });
  });
  it('rejects a draft unless both identity fields advance', async () => {
    const latest = { versionName: '1.2.0', buildNumber: 12 };
    for (const candidate of [
      { versionName: '1.2.0', buildNumber: 13 },
      { versionName: '1.3.0', buildNumber: 12 },
      { versionName: '1.1.9', buildNumber: 13 },
    ]) {
      const { service, models } = setup(undefined, latest);
      await expect(
        service.create(actor, {
          platform: 'android',
          source: 'direct_apk',
          ...candidate,
          changelogEn: 'New release',
          storeUrl: null,
          operationId: '07a5d459-24e7-4db3-9469-7f398210e007',
          reason: 'Ship new release',
        }),
      ).rejects.toMatchObject({
        response: { code: 'REVISION_CONFLICT' },
      });
      expect(models.create).not.toHaveBeenCalled();
    }
  });
  it('checks the whole channel rather than querying for the candidate identity', async () => {
    const { service, models } = setup(undefined, {
      versionName: '1.2.0',
      buildNumber: 12,
    });
    await expect(
      service.create(actor, {
        platform: 'android',
        source: 'direct_apk',
        versionName: '1.1.0',
        buildNumber: 11,
        changelogEn: 'Older release',
        storeUrl: null,
        operationId: '07a5d459-24e7-4db3-9469-7f398210e007',
        reason: 'Attempt older release',
      }),
    ).rejects.toThrow();
    expect(models.findOne).toHaveBeenCalledWith({
      platform: 'android',
      source: 'direct_apk',
    });
  });
  it('does not let an edited draft move its version or build backwards', async () => {
    const { service, save } = setup(
      {
        _id: { toString: () => 'a'.repeat(24) },
        state: 'draft',
        revision: 1,
        artifactState: null,
        platform: 'android',
        source: 'direct_apk',
        versionName: '1.2.0',
        buildNumber: 12,
        changelogEn: 'Current notes',
        storeUrl: null,
      },
      { versionName: '1.1.0', buildNumber: 11 },
    );

    await expect(
      service.edit(actor, 'a'.repeat(24), {
        expectedRevision: 1,
        operationId: '07a5d459-24e7-4db3-9469-7f398210e007',
        reason: 'Attempt downgrade',
        versionName: '1.1.1',
        buildNumber: 13,
      }),
    ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
    expect(save).not.toHaveBeenCalled();
  });
  it('does not mutate a published release', async () => {
    const { service, save } = setup({ state: 'published', revision: 1 });
    await expect(
      service.edit(actor, 'a'.repeat(24), {
        expectedRevision: 1,
        operationId: '07a5d459-24e7-4db3-9469-7f398210e007',
        reason: 'Fix notes',
        changelogEn: 'Updated',
      }),
    ).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
  it('rejects revision conflicts and verified artifact identity changes', async () => {
    for (const record of [
      { state: 'draft', revision: 2 },
      {
        state: 'draft',
        revision: 1,
        artifactState: 'verified',
        buildNumber: 10,
      },
    ]) {
      const { service, save } = setup(record);
      await expect(
        service.edit(actor, 'a'.repeat(24), {
          expectedRevision: 1,
          operationId: '07a5d459-24e7-4db3-9469-7f398210e007',
          reason: 'New build',
          buildNumber: 12,
        }),
      ).rejects.toThrow();
      expect(save).not.toHaveBeenCalled();
    }
  });
  it('rejects untrusted store identity before reserving an operation', async () => {
    const { service, ops } = setup();
    await expect(
      service.create(actor, {
        platform: 'android',
        source: 'google_play',
        versionName: '1',
        buildNumber: 1,
        changelogEn: 'Initial',
        storeUrl: 'https://evil.example/app',
        operationId: '07a5d459-24e7-4db3-9469-7f398210e007',
        reason: 'Initial',
      }),
    ).rejects.toThrow();
    expect(ops.run).not.toHaveBeenCalled();
  });
});
