import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import { defaultPolicy } from '../app-policy/access-policy.js';
import type { AppPolicyService } from '../app-policy/app-policy.service.js';
import { ReleasePolicyService } from './release-policy.service.js';
import type { Release } from './release.schema.js';

describe('public update snapshots', () => {
  function setup(policy = defaultPolicy(), release?: object) {
    const records = {
      findById: vi.fn(() => ({
        maxTimeMS: () => ({ lean: async () => release ?? null }),
      })),
    };
    const service = new ReleasePolicyService(
      { current: async () => policy } as AppPolicyService,
      records as unknown as Model<Release>,
      new ConfigService({
        APP_UPDATES_ENABLED: true,
        APK_EXPECTED_PACKAGE_ID: 'com.example.fixture',
      }),
    );
    return { service, records };
  }

  it('returns an empty valid snapshot without a selected release', async () => {
    const { service } = setup();
    expect(await service.snapshot('android', 'play')).toMatchObject({
      schemaVersion: 1,
      minimumBuild: null,
      target: null,
    });
  });

  it('fails closed when a minimum build has no selected target', async () => {
    const policy = defaultPolicy();
    policy.platforms.android.minimumBuild = 10;
    await expect(
      setup(policy).service.snapshot('android', 'play'),
    ).rejects.toThrow();
  });

  it('rejects retired distribution without reading releases', async () => {
    const { service, records } = setup();
    await expect(service.snapshot('android', 'direct')).rejects.toMatchObject({
      status: 400,
    });
    expect(records.findById).not.toHaveBeenCalled();
  });

  it('never exposes historical artifact fields from a Play target', async () => {
    const policy = defaultPolicy();
    policy.platforms.android.releaseSelection.storeReleaseId = 'a'.repeat(24);
    const release = {
      _id: 'a'.repeat(24),
      platform: 'android',
      state: 'published',
      source: 'google_play',
      versionName: '1',
      buildNumber: 12,
      changelogEn: 'Notes',
      storeUrl:
        'https://play.google.com/store/apps/details?id=com.example.fixture',
      artifact: {
        key: 'private-secret-key',
        etag: '"private-version"',
        bytes: 1,
      },
    };
    const snapshot = await setup(policy, release).service.snapshot(
      'android',
      'play',
    );
    expect(snapshot.target?.artifact).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain('private');
    await expect(
      setup(policy, { ...release, state: 'draft' }).service.snapshot(
        'android',
        'play',
      ),
    ).rejects.toThrow();
    await expect(
      setup(policy, { ...release, source: 'direct_apk' }).service.snapshot(
        'android',
        'play',
      ),
    ).rejects.toThrow();
    await expect(
      setup(policy, {
        ...release,
        storeUrl:
          'https://play.google.com:443/store/apps/details?id=com.example.fixture',
      }).service.snapshot('android', 'play'),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('rejects a selected target below the minimum build', async () => {
    const policy = defaultPolicy();
    policy.platforms.android.minimumBuild = 14;
    policy.platforms.android.releaseSelection.source = 'google_play';
    policy.platforms.android.releaseSelection.storeReleaseId = 'a'.repeat(24);
    const release = {
      _id: 'a'.repeat(24),
      platform: 'android',
      state: 'published',
      source: 'google_play',
      versionName: '1',
      buildNumber: 13,
      changelogEn: 'Notes',
      storeUrl:
        'https://play.google.com/store/apps/details?id=com.example.fixture',
    };
    await expect(
      setup(policy, release).service.snapshot('android', 'play'),
    ).rejects.toThrow();
    policy.platforms.android.minimumBuild = 13;
    expect(
      (await setup(policy, release).service.snapshot('android', 'play')).target
        ?.buildNumber,
    ).toBe(13);
  });

  it('allows a distinct Play target when direct APK is selected', async () => {
    const policy = defaultPolicy();
    policy.platforms.android.minimumBuild = 10;
    policy.platforms.android.releaseSelection.storeReleaseId = 'a'.repeat(24);
    policy.platforms.android.releaseSelection.storeReleaseId = 'b'.repeat(24);
    const release = {
      _id: 'b'.repeat(24),
      platform: 'android',
      state: 'published',
      source: 'google_play',
      versionName: '1',
      buildNumber: 14,
      changelogEn: 'Notes',
      storeUrl:
        'https://play.google.com/store/apps/details?id=com.example.fixture',
    };
    expect(
      (await setup(policy, release).service.snapshot('android', 'play')).target
        ?.buildNumber,
    ).toBe(14);
  });
});
