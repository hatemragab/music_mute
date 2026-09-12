import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { StorageClient } from '../infrastructure/storage.module.js';
import type { StoragePreflightService } from '../storage/storage-preflight.service.js';
import { ReleaseArtifactStorageService } from './release-artifact-storage.service.js';

describe('release artifact version pinning', () => {
  const reservation = {
    key: 'app-releases/fixture.apk',
    expectedBytes: 10,
    expectedSha256: 'a'.repeat(64),
  };
  function setup(results: unknown[]) {
    const send = vi.fn();
    results.forEach((result) => send.mockResolvedValueOnce(result));
    return {
      send,
      service: new ReleaseArtifactStorageService(
        { send } as unknown as StorageClient,
        new ConfigService({ S3_BUCKET: 'fixture-private' }),
        { assertReady: async () => {} } as StoragePreflightService,
      ),
    };
  }
  it('signs an immutable whole-APK PUT with exact integrity headers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'));
    const client = new S3Client({
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'fixture-access-key',
        secretAccessKey: 'fixture-secret-key',
      },
    });
    const service = new ReleaseArtifactStorageService(
      client as unknown as StorageClient,
      new ConfigService({ S3_BUCKET: 'fixture-private' }),
      { assertReady: async () => {} } as StoragePreflightService,
    );
    const grant = await service.grant(
      reservation,
      new Date('2026-09-12T00:15:00.000Z'),
    );
    const checksum = Buffer.from(reservation.expectedSha256, 'hex').toString(
      'base64',
    );
    expect(grant).toMatchObject({
      method: 'PUT',
      headers: {
        'Content-Type': 'application/vnd.android.package-archive',
        'x-amz-checksum-sha256': checksum,
        'If-None-Match': '*',
      },
      expiresAt: '2026-09-12T00:15:00.000Z',
    });
    const url = new URL(grant.url);
    expect(decodeURIComponent(url.pathname)).toBe('/app-releases/fixture.apk');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.has('x-amz-checksum-sha256')).toBe(false);
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining([
        'content-length',
        'content-type',
        'host',
        'if-none-match',
        'x-amz-checksum-sha256',
      ]),
    );
    client.destroy();
    vi.useRealTimers();
  });
  it('uses the configurable short lifetime for version-pinned APK downloads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'));
    const client = new S3Client({
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'fixture-access-key',
        secretAccessKey: 'fixture-secret-key',
      },
    });
    const service = new ReleaseArtifactStorageService(
      client as unknown as StorageClient,
      new ConfigService({
        S3_BUCKET: 'fixture-private',
        APP_RELEASE_DOWNLOAD_SECONDS: 120,
      }),
      { assertReady: async () => {} } as StoragePreflightService,
    );

    const grant = await service.createDownloadGrant({
      key: reservation.key,
      versionId: 'immutable-v1',
    });

    expect(new URL(grant.url).searchParams.get('X-Amz-Expires')).toBe('120');
    expect(grant.expiresAt).toBe('2026-09-12T00:02:00.000Z');
    client.destroy();
    vi.useRealTimers();
  });
  it('selects a version and verifies the exact version on read-back', async () => {
    const checksum = Buffer.from(reservation.expectedSha256, 'hex').toString(
      'base64',
    );
    const { service, send } = setup([
      { VersionId: 'immutable-1' },
      { VersionId: 'immutable-1', ContentLength: 10, ChecksumSHA256: checksum },
    ]);
    expect(await service.pin(reservation)).toBe('immutable-1');
    expect(send.mock.calls[1]![0].input.VersionId).toBe('immutable-1');
  });
  it.each([undefined, 'null', ''])(
    'rejects absent/non-versioned object identity %s',
    async (VersionId) => {
      const { service } = setup([{ VersionId }]);
      await expect(service.pin(reservation)).rejects.toThrow();
    },
  );
  it('rejects pinned size or checksum mismatch', async () => {
    const { service } = setup([
      { VersionId: 'v1' },
      { VersionId: 'v1', ContentLength: 11, ChecksumSHA256: 'wrong' },
    ]);
    await expect(service.pin(reservation)).rejects.toThrow();
  });
});
