import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageClient } from '../infrastructure/storage.module.js';
import type { StoragePreflightService } from '../storage/storage-preflight.service.js';
import { ReleaseArtifactStorageService } from './release-artifact-storage.service.js';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const reservation = {
  key: 'app-releases/fixture.apk',
  expectedBytes: 10,
  expectedSha256: 'a'.repeat(64),
};
const checksum = Buffer.from(reservation.expectedSha256, 'hex').toString(
  'base64',
);
const contentType = 'application/vnd.android.package-archive';
const head = {
  ETag: '"immutable-1"',
  ContentLength: 10,
  ContentType: contentType,
  Metadata: { sha256: checksum },
};
function setup(results: unknown[]) {
  const send = vi.fn();
  results.forEach((result) => send.mockResolvedValueOnce(result));
  return {
    send,
    service: new ReleaseArtifactStorageService(
      { send } as unknown as StorageClient,
      new ConfigService({ STORAGE_BUCKET: 'fixture-private' }),
      {} as StoragePreflightService,
    ),
  };
}
function signer() {
  const client = new S3Client({
    endpoint:
      'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    region: 'auto',
    forcePathStyle: true,
    credentials: {
      accessKeyId: 'fixture-access-key',
      secretAccessKey: 'fixture-secret-key',
    },
  });
  const service = new ReleaseArtifactStorageService(
    client as StorageClient,
    new ConfigService({
      STORAGE_BUCKET: 'fixture-private',
      APP_RELEASE_DOWNLOAD_SECONDS: 120,
    }),
    {} as StoragePreflightService,
  );
  return { client, service };
}
describe('release artifact R2 integrity', () => {
  afterEach(() => vi.useRealTimers());
  it('signs a conditional checksum-bound whole APK locally with four headers', async () => {
    const { client, service } = signer();
    try {
      const grant = await service.grant(
        reservation,
        new Date(Date.now() + 900_000),
      );
      expect(grant.headers).toEqual({
        'Content-Type': contentType,
        'x-amz-checksum-sha256': checksum,
        'x-amz-meta-sha256': checksum,
        'If-None-Match': '*',
      });
      const url = new URL(grant.url);
      expect(url.pathname).toBe('/fixture-private/app-releases/fixture.apk');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
      expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
        expect.arrayContaining([
          'content-type',
          'if-none-match',
          'x-amz-checksum-sha256',
          'x-amz-meta-sha256',
        ]),
      );
      expect(url.searchParams.has('x-amz-meta-sha256')).toBe(false);
      await expect(
        service.grant(reservation, new Date(Date.now() - 1000)),
      ).rejects.toThrow('APK_INVALID');
    } finally {
      client.destroy();
    }
  });
  it('uses a short locally signed download URL with no version request', async () => {
    const { client, service } = signer();
    try {
      const grant = await service.createDownloadGrant({
        key: reservation.key,
        etag: head.ETag,
      });
      expect(new URL(grant.url).searchParams.get('X-Amz-Expires')).toBe('120');
      expect(new URL(grant.url).searchParams.has('versionId')).toBe(false);
    } finally {
      client.destroy();
    }
  });
  it('pins and checks an opaque ETag with a single HEAD including metadata fallback', async () => {
    const { service, send } = setup([head]);
    expect(await service.pin(reservation, head.ETag)).toBe(head.ETag);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0].input).toEqual({
      Bucket: 'fixture-private',
      Key: reservation.key,
      IfMatch: head.ETag,
    });
  });
  it.each([
    { ETag: undefined },
    { ETag: 'null' },
    { ETag: 'unquoted' },
    { ContentLength: 11 },
    { ContentType: 'text/html' },
    { Metadata: {} },
    { ChecksumSHA256: 'wrong' },
  ])('rejects inconsistent confirmed metadata %j', async (extra) => {
    const { service } = setup([{ ...head, ...extra }]);
    await expect(service.pin(reservation)).rejects.toThrow();
  });
  it('downloads exact bytes with If-Match before existing independent APK verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'musicmute-r2-apk-'));
    try {
      const { service, send } = setup([
        { ...head, Body: Readable.from([Buffer.alloc(10)]) },
      ]);
      const path = join(dir, 'artifact.apk');
      await service.download(
        reservation,
        head.ETag,
        path,
        new AbortController().signal,
      );
      expect((await readFile(path)).length).toBe(10);
      expect(send.mock.calls[0]![0].input.IfMatch).toBe(head.ETag);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it.each([9, 11])(
    'rejects truncated or oversized streamed APK %s',
    async (bytes) => {
      const dir = await mkdtemp(join(tmpdir(), 'musicmute-r2-apk-'));
      try {
        const { service } = setup([
          { ...head, Body: Readable.from([Buffer.alloc(bytes)]) },
        ]);
        await expect(
          service.download(
            reservation,
            head.ETag,
            join(dir, 'artifact.apk'),
            new AbortController().signal,
          ),
        ).rejects.toThrow('APK_SIZE_MISMATCH');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
