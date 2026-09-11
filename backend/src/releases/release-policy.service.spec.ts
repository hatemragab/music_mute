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
        RELEASE_LANDING_BASE_URL: 'https://example.invalid/api/v1',
      }),
    );
    return { service, records };
  }
  it('returns an empty valid snapshot without existing restrictions', async () => {
    const { service } = setup();
    expect(await service.snapshot('android', 'direct')).toMatchObject({
      schemaVersion: 1,
      minimumBuild: null,
      target: null,
    });
  });
  it('fails closed for legacy restrictions requiring explicit conversion', async () => {
    const policy = defaultPolicy();
    policy.platforms.android = {
      minimumBuild: 10,
      latestBuild: 12,
      downloadUrl: 'https://example.invalid/update',
    };
    await expect(
      setup(policy).service.snapshot('android', 'direct'),
    ).rejects.toThrow();
  });
  it('does not leak draft releases or storage identities', async () => {
    const policy = defaultPolicy();
    policy.platforms.android.releaseSelection = {
      source: 'direct_apk',
      directReleaseId: 'a'.repeat(24),
      storeReleaseId: null,
    };
    policy.platforms.android.latestBuild = 12;
    policy.platforms.android.downloadUrl = `https://example.invalid/api/v1/app-updates/releases/${'a'.repeat(24)}`;
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
  it('rejects a missing selected target or drift from its legacy projection', async () => {
    const policy = defaultPolicy();
    policy.platforms.android = {
      minimumBuild: null,
      latestBuild: 12,
      downloadUrl:
        'https://play.google.com/store/apps/details?id=com.example.fixture',
      releaseSelection: {
        source: 'google_play',
        directReleaseId: null,
        storeReleaseId: null,
      },
    };
    await expect(
      setup(policy).service.snapshot('android', 'direct'),
    ).rejects.toThrow();
    policy.platforms.android.releaseSelection!.storeReleaseId = 'a'.repeat(24);
    const release = {
      _id: 'a'.repeat(24),
      platform: 'android',
      state: 'published',
      source: 'google_play',
      versionName: '1',
      buildNumber: 13,
      changelogEn: 'Notes',
      storeUrl: policy.platforms.android.downloadUrl,
    };
    await expect(
      setup(policy, release).service.snapshot('android', 'direct'),
    ).rejects.toThrow();
    policy.platforms.android.latestBuild = 13;
    expect(
      (await setup(policy, release).service.snapshot('android', 'direct'))
        .target?.buildNumber,
    ).toBe(13);
  });
  it('allows a distinct Play latest when direct APK is the configured source', async () => {
    const policy = defaultPolicy();
    policy.platforms.android = {
      minimumBuild: 10,
      latestBuild: 12,
      downloadUrl: 'https://example.invalid/fixture',
      releaseSelection: {
        source: 'direct_apk',
        directReleaseId: 'a'.repeat(24),
        storeReleaseId: 'b'.repeat(24),
      },
    };
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
