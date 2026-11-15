import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { ObjectIdentity } from '../../jobs/job.types.js';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import { WorkerInstallationArtifactsService } from './worker-installation-artifacts.service.js';
import {
  QUALIFIED_MODEL_BYTES,
  QUALIFIED_MODEL_DIGEST,
} from '../../jobs/worker-recipes.js';

const installationId = '32410a14-e85a-4a1d-bb99-61fa54b07eaa';
const principal: WorkerPrincipal = {
  kind: 'installation',
  subjectId: installationId,
  credential: 'x'.repeat(43),
};
const machinePrincipal: WorkerPrincipal = {
  kind: 'machine',
  subjectId: installationId,
  credential: 'm'.repeat(43),
  machineStatus: 'active',
};
const digest = 'ab'.repeat(32);
const expiresAt = '2026-09-20T12:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true })),
  );
});

describe('worker installation artifact grants', () => {
  it('grants only approved Store qualification data when no runtime archive exists', async () => {
    const base = catalog(),
      model = {
        ...base.model,
        filename: 'Kim_Vocal_2.onnx',
        bytes: QUALIFIED_MODEL_BYTES,
        sha256: QUALIFIED_MODEL_DIGEST,
      },
      f = await fixture({ ...base, releases: {}, model });
    const data = await f.service.createStoreQualificationDataGrants(
      principal,
      installationId,
    );
    expect(Object.keys(data).sort()).toEqual([
      'fixture',
      'installationProfile',
      'model',
      'platform',
      'purpose',
      'schemaVersion',
    ]);
    expect(data).toMatchObject({
      schemaVersion: 1,
      purpose: 'store-qualification-data',
      platform: 'windows-amd64',
      installationProfile: 'windows-user',
      model,
      fixture: { filename: base.fixture.filename, contentType: 'audio/wav' },
    });
    expect(f.transfers.createDownloadGrant).toHaveBeenCalledExactlyOnceWith(
      expectedObjects('windows-amd64')[1],
    );
    await expect(
      f.service.createDownloadGrants(
        principal,
        installationId,
        'windows-amd64',
        'windows-user',
      ),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    expect(f.transfers.createDownloadGrant).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign credentials, missing fixtures and changed Store model/fixture identity before any grant', async () => {
    const base = catalog(),
      model = {
        ...base.model,
        filename: 'Kim_Vocal_2.onnx',
        bytes: QUALIFIED_MODEL_BYTES,
        sha256: QUALIFIED_MODEL_DIGEST,
      };
    const valid = await fixture({ ...base, releases: {}, model });
    for (const actor of [
      machinePrincipal,
      { ...principal, subjectId: 'foreign-installation' },
    ])
      await expect(
        valid.service.createStoreQualificationDataGrants(actor, installationId),
      ).rejects.toMatchObject({ response: { code: 'WORKER_NOT_FOUND' } });
    expect(valid.transfers.createDownloadGrant).not.toHaveBeenCalled();
    for (const changed of [
      { model: { ...model, sha256: digest } },
      { model: { ...model, bytes: 202 } },
      { model: { ...model, filename: 'foreign.onnx' } },
      { fixture: null },
      { fixture: { ...base.fixture, bytes: 43 } },
      { fixture: { ...base.fixture, bytes: 64 * 1024 ** 2 + 1 } },
      { fixture: { ...base.fixture, filename: 'runtime.exe' } },
    ]) {
      const f = await fixture({ ...base, releases: {}, model, ...changed });
      await expect(
        f.service.createStoreQualificationDataGrants(principal, installationId),
      ).rejects.toMatchObject({
        response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
      });
      expect(f.transfers.createDownloadGrant).not.toHaveBeenCalled();
    }
  });
  it('preserves dependency failures for Store data without constructing an executable or fallback grant', async () => {
    const base = catalog(),
      f = await fixture({
        ...base,
        releases: {},
        model: {
          ...base.model,
          filename: 'Kim_Vocal_2.onnx',
          bytes: QUALIFIED_MODEL_BYTES,
          sha256: QUALIFIED_MODEL_DIGEST,
        },
      });
    f.transfers.createDownloadGrant.mockRejectedValueOnce(
      new Error('unavailable fixture'),
    );
    await expect(
      f.service.createStoreQualificationDataGrants(principal, installationId),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    expect(f.transfers.createDownloadGrant).toHaveBeenCalledTimes(1);
    const missing = await fixture(undefined);
    await expect(
      missing.service.createStoreQualificationDataGrants(
        principal,
        installationId,
      ),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    expect(missing.transfers.createDownloadGrant).not.toHaveBeenCalled();
  });
  it('refuses revoked, deleted, mismatched-platform and unsigned consumer selections before granting artifacts', async () => {
    const base = catalog();
    const unsigned = {
      ...base,
      releases: {
        ...base.releases,
        'windows-amd64-user': base.releases['windows-amd64'],
      },
    };
    const f = await fixture(unsigned);
    await expect(
      f.service.createDownloadGrants(
        principal,
        installationId,
        'windows-amd64',
        'windows-user',
      ),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    expect(f.transfers.createDownloadGrant).not.toHaveBeenCalled();
    for (const machine of [
      null,
      { status: 'revoked' },
      { deletedAt: new Date() },
    ]) {
      const f = await fixture(base, machine);
      await expect(
        f.service.createUpdateGrant(
          machinePrincipal,
          'windows-amd64',
          false,
          'windows-user',
        ),
      ).rejects.toMatchObject({ response: { code: 'WORKER_NOT_FOUND' } });
      expect(f.transfers.createDownloadGrant).not.toHaveBeenCalled();
    }
    const wrongPlatform = await fixture(base, {
      runtimeIdentity: { installationProfile: 'windows-user' },
      approvedCapabilities: [{ platform: 'darwin-arm64' }],
    });
    await expect(
      wrongPlatform.service.createUpdateGrant(
        machinePrincipal,
        'windows-amd64',
        true,
        'windows-user',
      ),
    ).rejects.toMatchObject({ response: { code: 'WORKER_INVALID_REQUEST' } });
    expect(wrongPlatform.transfers.createDownloadGrant).not.toHaveBeenCalled();
  });

  it('selects and signs the consumer target without altering legacy service artifacts', async () => {
    const base = catalog();
    const consumer = {
      ...base.releases['windows-amd64'],
      filename: 'musicmute-worker-windows-amd64-user.zip',
      key: 'worker-installation-artifacts/releases/windows-amd64-user/0.1.1.zip',
      sequence: 7,
      publishedAt: '2026-09-21T00:00:00.000Z',
      expiresAt: '2026-09-23T00:00:00.000Z',
      keyId: 'release-2026',
      signature: 's'.repeat(86),
    };
    const f = await fixture(
      {
        ...base,
        releases: { ...base.releases, 'windows-amd64-user': consumer },
      },
      {
        runtimeIdentity: { installationProfile: 'windows-user' },
        approvedCapabilities: [{ platform: 'windows-amd64' }],
      },
    );
    const installation = await f.service.createDownloadGrants(
      principal,
      installationId,
      'windows-amd64',
      'windows-user',
    );
    expect(installation).toMatchObject({
      installationProfile: 'windows-user',
      release: {
        filename: consumer.filename,
        signed: {
          metadata: {
            platform: 'windows-amd64',
            installationProfile: 'windows-user',
          },
        },
      },
    });
    const legacy = await f.service.createDownloadGrants(
      principal,
      installationId,
      'windows-amd64',
    );
    expect(legacy.release.filename).toBe(
      base.releases['windows-amd64'].filename,
    );
    expect(legacy).not.toHaveProperty('installationProfile');
    const update = await f.service.createUpdateGrant(
      machinePrincipal,
      'windows-amd64',
      false,
      'windows-user',
    );
    expect(update.signed).toEqual(installation.release.signed);
    await expect(
      f.service.createUpdateGrant(machinePrincipal, 'windows-amd64', false),
    ).rejects.toMatchObject({ response: { code: 'WORKER_INVALID_REQUEST' } });
  });

  it('refuses a legacy machine opt-in, non-Windows consumer platform, or missing consumer catalog target', async () => {
    const f = await fixture(catalog(), {
      runtimeIdentity: {},
      approvedCapabilities: [{ platform: 'windows-amd64' }],
    });
    await expect(
      f.service.createUpdateGrant(
        machinePrincipal,
        'windows-amd64',
        false,
        'windows-user',
      ),
    ).rejects.toMatchObject({ response: { code: 'WORKER_INVALID_REQUEST' } });
    await expect(
      f.service.createDownloadGrants(
        principal,
        installationId,
        'darwin-arm64',
        'windows-user',
      ),
    ).rejects.toMatchObject({ response: { code: 'WORKER_INVALID_REQUEST' } });
    await expect(
      f.service.createDownloadGrants(
        principal,
        installationId,
        'windows-amd64',
        'windows-user',
      ),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    expect(f.transfers.createDownloadGrant).not.toHaveBeenCalled();
  });

  it('returns machine-authenticated signed update metadata and one release grant', async () => {
    const base = catalog();
    const value = {
      ...base,
      releases: {
        ...base.releases,
        'darwin-arm64': {
          ...base.releases['darwin-arm64'],
          sequence: 7,
          publishedAt: '2026-09-21T00:00:00.000Z',
          expiresAt: '2026-09-23T00:00:00.000Z',
          keyId: 'release-2026',
          signature: 's'.repeat(86),
        },
      },
    };
    const f = await fixture(value);

    await expect(
      f.service.createUpdateGrant(machinePrincipal, 'darwin-arm64'),
    ).resolves.toEqual({
      schemaVersion: 1,
      platform: 'darwin-arm64',
      signed: {
        keyId: 'release-2026',
        metadata: {
          schemaVersion: 1,
          sequence: 7,
          platform: 'darwin-arm64',
          releaseVersion: '0.1.1',
          publishedAt: '2026-09-21T00:00:00.000Z',
          expiresAt: '2026-09-23T00:00:00.000Z',
          release: {
            filename: 'musicmute-worker-darwin-arm64.tar.gz',
            bytes: 101,
            sha256: digest,
            contentType: 'application/gzip',
          },
        },
        signature: 's'.repeat(86),
      },
      grant: {
        url: 'https://storage.example.invalid/grant/1',
        expiresAt,
      },
    });
    expect(f.transfers.createDownloadGrant).toHaveBeenCalledOnce();
    const installation = await f.service.createDownloadGrants(
      principal,
      installationId,
      'darwin-arm64',
    );
    const update = await f.service.createUpdateGrant(
      machinePrincipal,
      'darwin-arm64',
      false,
    );
    expect(installation.release).toMatchObject({ signed: update.signed });
  });

  it('fails closed when update metadata is absent or the caller is not a machine', async () => {
    const f = await fixture(catalog());
    await expect(
      f.service.createUpdateGrant(machinePrincipal, 'darwin-arm64'),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    await expect(
      f.service.createUpdateGrant(principal, 'darwin-arm64'),
    ).rejects.toMatchObject({ response: { code: 'WORKER_NOT_FOUND' } });
  });

  it('checks signed update metadata without minting a download grant', async () => {
    const base = catalog();
    const value = {
      ...base,
      releases: {
        ...base.releases,
        'darwin-arm64': {
          ...base.releases['darwin-arm64'],
          sequence: 7,
          publishedAt: '2026-09-21T00:00:00.000Z',
          expiresAt: '2026-09-23T00:00:00.000Z',
          keyId: 'release-2026',
          signature: 's'.repeat(86),
        },
      },
    };
    const f = await fixture(value);
    const result = await f.service.createUpdateGrant(
      machinePrincipal,
      'darwin-arm64',
      false,
    );
    expect(result).not.toHaveProperty('grant');
    expect(result).toHaveProperty('signed.metadata.releaseVersion', '0.1.1');
    expect(f.transfers.createDownloadGrant).not.toHaveBeenCalled();
  });

  it('returns only verified platform artifacts and hides storage identities', async () => {
    const f = await fixture(catalog());

    const result = await f.service.createDownloadGrants(
      principal,
      installationId,
      'darwin-arm64',
    );

    expect(result).toEqual({
      schemaVersion: 1,
      platform: 'darwin-arm64',
      release: {
        version: '0.1.1',
        filename: 'musicmute-worker-darwin-arm64.tar.gz',
        bytes: 101,
        sha256: digest,
        contentType: 'application/gzip',
        url: 'https://storage.example.invalid/grant/1',
        expiresAt,
      },
      model: {
        filename: 'kim-vocal-2.onnx',
        bytes: 202,
        sha256: digest,
        contentType: 'application/octet-stream',
        url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx',
        sourcePolicy: 'direct-owner-source-only',
        allowedHosts: ['github.com', 'release-assets.githubusercontent.com'],
        maxRedirects: 2,
      },
      fixture: {
        filename: 'qualification.wav',
        bytes: 303,
        sha256: digest,
        contentType: 'audio/wav',
        url: 'https://storage.example.invalid/grant/2',
        expiresAt,
      },
    });
    expect(JSON.stringify(result)).not.toContain('etag');
    expect(JSON.stringify(result)).not.toContain(
      'worker-installation-artifacts/',
    );
    expect(f.transfers.isObjectAvailable).not.toHaveBeenCalled();
    expect(f.transfers.createDownloadGrant).toHaveBeenCalledTimes(2);
    expect(
      f.transfers.createDownloadGrant.mock.calls.map(([value]) => value),
    ).toEqual(expectedObjects('darwin-arm64'));
  });

  it('selects the Windows release without changing shared artifacts', async () => {
    const f = await fixture(catalog());

    const result = await f.service.createDownloadGrants(
      principal,
      installationId,
      'windows-amd64',
    );

    expect(result.release).toMatchObject({
      version: '0.1.1',
      filename: 'musicmute-worker-windows-amd64.zip',
      contentType: 'application/zip',
    });
    expect(
      f.transfers.createDownloadGrant.mock.calls.map(([value]) => value),
    ).toEqual(expectedObjects('windows-amd64'));
  });

  it('allows a staged single-platform catalog and fails closed for an unavailable platform', async () => {
    const value = catalog();
    delete (value.releases as Partial<typeof value.releases>)['windows-amd64'];
    const f = await fixture(value);

    await expect(
      f.service.createDownloadGrants(principal, installationId, 'darwin-arm64'),
    ).resolves.toHaveProperty('release.version', '0.1.1');
    await expect(
      f.service.createDownloadGrants(
        principal,
        installationId,
        'windows-amd64',
      ),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
  });

  it('hides whether an installation exists when the principal does not own it', async () => {
    const f = await fixture(catalog());

    await expect(
      f.service.createDownloadGrants(
        { ...principal, subjectId: '718bd89b-bd03-43f7-adb7-9cb5ff415918' },
        installationId,
        'darwin-arm64',
      ),
    ).rejects.toMatchObject({ response: { code: 'WORKER_NOT_FOUND' } });
    expect(f.transfers.isObjectAvailable).not.toHaveBeenCalled();
  });

  it.each([
    ['missing configuration', undefined],
    ['invalid JSON', '{'],
    ['unknown fields', JSON.stringify({ ...catalog(), unexpected: true })],
    [
      'unsafe model source host',
      JSON.stringify({
        ...catalog(),
        model: { ...catalog().model, url: 'https://music-mute.com/model.onnx' },
      }),
    ],
  ])('fails closed for %s', async (_name, value) => {
    const f = await fixture(value);

    await expect(
      f.service.createDownloadGrants(principal, installationId, 'darwin-arm64'),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    expect(f.transfers.createDownloadGrant).not.toHaveBeenCalled();
  });

  it('fails closed for a fresh R2 catalog without making storage requests', async () => {
    const f = await fixture({ ...catalog(), releases: {}, fixture: null });
    await expect(
      f.service.createDownloadGrants(principal, installationId, 'darwin-arm64'),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    await expect(
      f.service.createUpdateGrant(machinePrincipal, 'darwin-arm64'),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    expect(f.transfers.isObjectAvailable).not.toHaveBeenCalled();
    expect(f.transfers.createDownloadGrant).not.toHaveBeenCalled();
  });

  it('rejects unquoted, weak and malformed catalog ETags before signing', async () => {
    for (const etag of ['bare', 'W/"weak"', '"control\n"', '"inner"quote"']) {
      const value = catalog();
      value.releases['darwin-arm64'].etag = etag;
      const f = await fixture(value);
      await expect(
        f.service.createDownloadGrants(
          principal,
          installationId,
          'darwin-arm64',
        ),
      ).rejects.toMatchObject({
        response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
      });
      expect(f.transfers.createDownloadGrant).not.toHaveBeenCalled();
    }
  });

  it('maps storage failures to the bounded worker dependency error', async () => {
    const f = await fixture(catalog());
    f.transfers.createDownloadGrant.mockRejectedValueOnce(
      new Error('private storage failure'),
    );

    await expect(
      f.service.createDownloadGrants(principal, installationId, 'darwin-arm64'),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
  });
});

async function fixture(
  value: object | string | undefined,
  machine?: object | null,
) {
  const root = await mkdtemp(join(tmpdir(), 'musicmute-artifact-catalog-'));
  roots.push(root);
  const path = join(root, 'catalog.json');
  if (value !== undefined)
    await writeFile(
      path,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  const transfers = {
    isObjectAvailable: vi.fn(async (_object: ObjectIdentity) => true),
    createDownloadGrant: vi.fn(async (_object: ObjectIdentity) => ({
      url: `https://storage.example.invalid/grant/${transfers.createDownloadGrant.mock.calls.length}`,
      expiresAt,
    })),
  };
  const service = new WorkerInstallationArtifactsService(
    new ConfigService(
      value === undefined ? {} : { WORKER_INSTALLATION_CATALOG_PATH: path },
    ),
    transfers as never,
    machine === undefined
      ? undefined
      : ({
          findById: () => ({
            maxTimeMS: () => ({ lean: async () => machine }),
          }),
        } as never),
  );
  return { service, transfers };
}

function catalog() {
  return {
    schemaVersion: 1,
    releases: {
      'darwin-arm64': {
        version: '0.1.1',
        filename: 'musicmute-worker-darwin-arm64.tar.gz',
        key: 'worker-installation-artifacts/releases/darwin-arm64/0.1.1.tar.gz',
        etag: '"darwin-version"',
        bytes: 101,
        sha256: digest,
        contentType: 'application/gzip',
      },
      'windows-amd64': {
        version: '0.1.1',
        filename: 'musicmute-worker-windows-amd64.zip',
        key: 'worker-installation-artifacts/releases/windows-amd64/0.1.1.zip',
        etag: '"windows-version"',
        bytes: 102,
        sha256: digest,
        contentType: 'application/zip',
      },
    },
    model: {
      filename: 'kim-vocal-2.onnx',
      bytes: 202,
      sha256: digest,
      contentType: 'application/octet-stream',
      url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx',
      sourcePolicy: 'direct-owner-source-only',
      allowedHosts: ['github.com', 'release-assets.githubusercontent.com'],
      maxRedirects: 2,
    },
    fixture: {
      filename: 'qualification.wav',
      key: 'worker-installation-artifacts/fixtures/qualification.wav',
      etag: '"fixture-version"',
      bytes: 303,
      sha256: digest,
      contentType: 'audio/wav',
    },
  };
}

function expectedObjects(platform: 'darwin-arm64' | 'windows-amd64') {
  const value = catalog();
  return [value.releases[platform], value.fixture].map(
    ({ key, etag, bytes, sha256, contentType }) => ({
      key,
      etag,
      bytes,
      sha256: Buffer.from(sha256, 'hex').toString('base64'),
      contentType,
    }),
  );
}
