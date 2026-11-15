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
      new ConfigService({ APP_UPDATES_ENABLED: true }),
    );
    return { service, records };
  }

  it('returns an empty valid snapshot without a selected release', async () => {
    const { service } = setup();
    expect(await service.snapshot('android', 'direct')).toMatchObject({
      schemaVersion: 1,
      minimumBuild: null,
      target: null,
    });
  });

  it('fails closed when a minimum build has no selected target', async () => {
    const policy = defaultPolicy();
    policy.platforms.android.minimumBuild = 10;
    await expect(
      setup(policy).service.snapshot('android', 'direct'),
    ).rejects.toThrow();
  });

  it('does not leak draft releases or storage identities', async () => {
    const policy = defaultPolicy();
    policy.platforms.android.releaseSelection.directReleaseId = 'a'.repeat(24);
    await expect(
      setup(policy, { state: 'draft' }).service.snapshot('android', 'direct'),
    ).rejects.toThrow();
    const release = {
      _id: 'a'.repeat(24),
      platform: 'android',
      state: 'published',
      source: 'direct_apk',
      artifactState: 'verified',
      versionName: '1',
      buildNumber: 12,
      changelogEn: 'Changes',
      storeUrl: null,
      artifact: {
        key: 'private-secret-key',
        versionId: 'private-version',
        bytes: 1,
        sha256Hex: 'b'.repeat(64),
        signerSha256Hex: 'c'.repeat(64),
      },
    };
    const snapshot = await setup(policy, release).service.snapshot(
      'android',
      'direct',
    );
    expect(snapshot.target?.artifact?.bytes).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain('private');
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
    policy.platforms.android.releaseSelection.directReleaseId = 'a'.repeat(24);
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
