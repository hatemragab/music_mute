import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import { ReleaseDownloadService } from './release-download.service.js';
import type { ReleaseArtifactStorageService } from './release-artifact-storage.service.js';
import type { AppPolicyService } from '../app-policy/app-policy.service.js';
import type { Release } from './release.schema.js';
import { defaultPolicy } from '../app-policy/access-policy.js';
describe('public release download grants', () => {
  const id = 'a'.repeat(24);
  function setup(state: string, selected = true) {
    const policy = defaultPolicy();
    policy.platforms.android.releaseSelection = {
      source: 'direct_apk',
      directReleaseId: selected ? id : null,
      storeReleaseId: null,
    };
    const release = {
      _id: id,
      state,
      source: 'direct_apk',
      platform: 'android',
      artifactState: 'verified',
      revision: 1,
      artifact: {
        key: 'fixture/key',
        versionId: 'fixture-version',
        bytes: 123,
        sha256Hex: 'b'.repeat(64),
        signerSha256Hex: 'c'.repeat(64),
      },
    };
    const storage = {
      createDownloadGrant: vi.fn(async () => ({
        url: 'https://example.invalid/signed',
        expiresAt: new Date().toISOString(),
      })),
    };
    const service = new ReleaseDownloadService(
      { current: async () => policy } as AppPolicyService,
      {
        findById: () => ({ maxTimeMS: () => ({ lean: async () => release }) }),
      } as unknown as Model<Release>,
      storage as unknown as ReleaseArtifactStorageService,
      new ConfigService({ APP_UPDATES_ENABLED: true }),
    );
    return { service, storage, release };
  }
  it('denies withdrawn and inactive artifacts before signing', async () => {
    for (const fixture of [setup('withdrawn'), setup('published', false)]) {
      await expect(fixture.service.grant(id)).rejects.toThrow();
      expect(fixture.storage.createDownloadGrant).not.toHaveBeenCalled();
    }
  });
  it('pins a version and rechecks publication after signing', async () => {
    const fixture = setup('published');
    const grant = await fixture.service.grant(id);
    expect(grant.bytes).toBe(123);
    expect(fixture.storage.createDownloadGrant).toHaveBeenCalledWith(
      fixture.release.artifact,
    );
    expect(JSON.stringify(grant)).not.toContain('fixture/key');
    fixture.storage.createDownloadGrant.mockImplementation(async () => {
      fixture.release.state = 'withdrawn';
      return {
        url: 'https://example.invalid/signed',
        expiresAt: new Date().toISOString(),
      };
    });
    await expect(fixture.service.grant(id)).rejects.toThrow();
  });
});
