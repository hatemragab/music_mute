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
const digest = 'ab'.repeat(32);
const expiresAt = '2026-09-20T12:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true })),
  );
});

describe('worker installation artifact grants', () => {
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
        url: 'https://storage.example.invalid/grant/2',
        expiresAt,
      },
      fixture: {
        filename: 'qualification.wav',
        bytes: 303,
        sha256: digest,
        contentType: 'audio/wav',
        url: 'https://storage.example.invalid/grant/3',
        expiresAt,
      },
    });
    expect(JSON.stringify(result)).not.toContain('versionId');
    expect(JSON.stringify(result)).not.toContain(
      'worker-installation-artifacts/',
    );
    expect(f.transfers.isPinnedObjectAvailable).toHaveBeenCalledTimes(3);
    expect(f.transfers.createDownloadGrant).toHaveBeenCalledTimes(3);
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
      'unsafe storage key',
      JSON.stringify({
        ...catalog(),
        model: { ...catalog().model, key: 'jobs/private-model.onnx' },
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
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

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
      key: 'worker-installation-artifacts/models/kim-vocal-2.onnx',
      versionId: 'model-version',
      bytes: 202,
      sha256: digest,
      contentType: 'application/octet-stream',
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
  return [value.releases[platform], value.model, value.fixture].map(
    ({ key, versionId, bytes, sha256, contentType }) => ({
      key,
      versionId,
      bytes,
      sha256: Buffer.from(sha256, 'hex').toString('base64'),
      contentType,
    }),
  );
}
