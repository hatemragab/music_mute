import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { ObjectIdentity } from '../../jobs/job.types.js';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import { WorkerInstallationArtifactsService } from './worker-installation-artifacts.service.js';

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
    expect(JSON.stringify(result)).not.toContain('versionId');
    expect(JSON.stringify(result)).not.toContain(
      'worker-installation-artifacts/',
    );
    expect(f.transfers.isPinnedObjectAvailable).toHaveBeenCalledTimes(2);
    expect(f.transfers.createDownloadGrant).toHaveBeenCalledTimes(2);
    expect(
      f.transfers.isPinnedObjectAvailable.mock.calls.map(([value]) => value),
    ).toEqual(expectedObjects('darwin-arm64'));
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
    expect(f.transfers.isPinnedObjectAvailable).not.toHaveBeenCalled();
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

  it('does not sign any grants when one pinned object is unavailable', async () => {
    const f = await fixture(catalog());
    f.transfers.isPinnedObjectAvailable
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      f.service.createDownloadGrants(principal, installationId, 'darwin-arm64'),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    expect(f.transfers.createDownloadGrant).not.toHaveBeenCalled();
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

async function fixture(value: object | string | undefined) {
  const root = await mkdtemp(join(tmpdir(), 'musicmute-artifact-catalog-'));
  roots.push(root);
  const path = join(root, 'catalog.json');
  if (value !== undefined)
    await writeFile(
      path,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  const transfers = {
    isPinnedObjectAvailable: vi.fn(async (_object: ObjectIdentity) => true),
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
        versionId: 'darwin-version',
        bytes: 101,
        sha256: digest,
        contentType: 'application/gzip',
      },
      'windows-amd64': {
        version: '0.1.1',
        filename: 'musicmute-worker-windows-amd64.zip',
        key: 'worker-installation-artifacts/releases/windows-amd64/0.1.1.zip',
        versionId: 'windows-version',
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
      versionId: 'fixture-version',
      bytes: 303,
      sha256: digest,
      contentType: 'audio/wav',
    },
  };
}

function expectedObjects(platform: 'darwin-arm64' | 'windows-amd64') {
  const value = catalog();
  return [value.releases[platform], value.fixture].map(
    ({ key, versionId, bytes, sha256, contentType }) => ({
      key,
      versionId,
      bytes,
      sha256: Buffer.from(sha256, 'hex').toString('base64'),
      contentType,
    }),
  );
}
