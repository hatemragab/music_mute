import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { StorageClient } from '../infrastructure/storage.module.js';
import { MacosUpdateStorageService } from './macos-update-storage.service.js';

const content = Buffer.from('Synthetic installer bytes'),
  sha256Hex = createHash('sha256').update(content).digest('hex');
const release = {
  key: 'releases/macos/fixture.dmg',
  bytes: content.length,
  sha256Hex,
};
const head = {
  ETag: '"immutable"',
  ContentLength: content.length,
  ContentType: 'application/octet-stream',
  Metadata: { sha256: Buffer.from(sha256Hex, 'hex').toString('base64') },
};
function setup(results: unknown[]) {
  const send = vi.fn();
  results.forEach((result) => send.mockResolvedValueOnce(result));
  return {
    send,
    service: new MacosUpdateStorageService(
      { send } as unknown as StorageClient,
      new ConfigService({ STORAGE_BUCKET: 'fixture' }),
    ),
  };
}
describe('macOS private immutable artifact storage', () => {
  it('returns safe retryable conflicts for missing objects and hides storage-provider errors', async () => {
    for (const [httpStatusCode, code] of [
      [404, 'REVISION_CONFLICT'],
      [412, 'REVISION_CONFLICT'],
      [503, 'DEPENDENCY_UNAVAILABLE'],
    ] as const) {
      const send = vi.fn().mockRejectedValue({
        $metadata: { httpStatusCode },
        message: 'provider details are private',
      });
      const service = new MacosUpdateStorageService(
        { send } as unknown as StorageClient,
        new ConfigService({ STORAGE_BUCKET: 'fixture' }),
      );
      await expect(service.verify(release)).rejects.toMatchObject({
        response: { code },
      });
    }
  });
  it('verifies actual streamed checksum with a single HEAD and conditional GET', async () => {
    const { service, send } = setup([
      head,
      {
        ...head,
        Body: Readable.from([content.subarray(0, 4), content.subarray(4)]),
      },
    ]);
    expect(await service.verify(release)).toBe(head.ETag);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].input.IfMatch).toBe(head.ETag);
  });
  it('rejects forged metadata when bytes have changed, oversized and truncated transfers', async () => {
    for (const bytes of [
      Buffer.alloc(content.length),
      Buffer.concat([content, Buffer.from('!')]),
      content.subarray(1),
    ]) {
      const { service } = setup([
        head,
        { ...head, Body: Readable.from([bytes]) },
      ]);
      await expect(service.verify(release)).rejects.toMatchObject({
        response: { code: 'INVALID_REQUEST' },
      });
    }
  });
  it.each([
    { ETag: 'invalid' },
    { ContentLength: 1 },
    { ContentType: 'text/plain' },
    { Metadata: {} },
  ])('rejects inconsistent HEAD %j before a GET', async (extra) => {
    const { service, send } = setup([{ ...head, ...extra }]);
    await expect(service.verify(release)).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
  it('signs create-only uploads and host-only download redirects with bounded expiration', async () => {
    const client = new S3Client({
      endpoint:
        'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      region: 'auto',
      forcePathStyle: true,
      credentials: {
        accessKeyId: 'fixture',
        secretAccessKey: 'synthetic-fixture',
      },
    });
    try {
      const service = new MacosUpdateStorageService(
        client as StorageClient,
        new ConfigService({ STORAGE_BUCKET: 'fixture' }),
      );
      const grant = await service.grant(release);
      expect(grant.headers['Content-Type']).toBe('application/octet-stream');
      expect(grant.headers['If-None-Match']).toBe('*');
      expect(new URL(grant.url).searchParams.get('X-Amz-Expires')).toBe('600');
      const url = new URL(
        await service.download({ key: release.key, etag: head.ETag }),
      );
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.has('versionId')).toBe(false);
    } finally {
      client.destroy();
    }
  });
});
