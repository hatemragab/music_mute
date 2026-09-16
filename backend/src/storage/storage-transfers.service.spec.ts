import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import type { StorageClient } from '../infrastructure/storage.module.js';
import type { ObjectIdentity } from '../jobs/job.types.js';
import { StorageTransfersService } from './storage-transfers.service.js';
import type { StoragePreflightService } from './storage-preflight.service.js';

const object: ObjectIdentity = {
  key: 'users/user-1/jobs/job-1/output/vocals.mp3',
  versionId: 'pinned',
  contentType: 'audio/mpeg',
  bytes: 2048,
  sha256: Buffer.alloc(32, 2).toString('base64'),
};

function fixture() {
  const client = new S3Client({
    region: 'us-east-1',
    credentials: {
      accessKeyId: 'fixture-access-key',
      secretAccessKey: 'fixture-secret-key',
    },
  });
  const send = vi.spyOn(client, 'send');
  const preflight = { assertReady: vi.fn(async () => undefined) };
  const service = new StorageTransfersService(
    client as unknown as StorageClient,
    new ConfigService({
      S3_BUCKET: 'private-fixture-bucket',
      PROCESSING_URL_SECONDS: 900,
    }),
    preflight as unknown as StoragePreflightService,
  );
  return { service, client, send, preflight };
}

describe('StorageTransfersService', () => {
  it('signs downloads for the exact pinned key and version', async () => {
    const { service, client, preflight } = fixture();
    const grant = await service.createDownloadGrant(object);
    const url = new URL(grant.url);
    expect(preflight.assertReady).toHaveBeenCalledOnce();
    expect(decodeURIComponent(url.pathname)).toBe(`/${object.key}`);
    expect(url.searchParams.get('versionId')).toBe(object.versionId);
    expect(url.searchParams.get('response-cache-control')).toBe('no-store');
    client.destroy();
  });

  it('bounds media grants and rejects unsafe filenames', async () => {
    const { service, client } = fixture();
    const grant = await service.createMediaGrant(
      object,
      'download',
      'vocals.mp3',
    );
    const url = new URL(grant.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="vocals.mp3"',
    );
    await expect(
      service.createMediaGrant(object, 'play', 'bad\r\nheader'),
    ).rejects.toThrow('Invalid media grant');
    client.destroy();
  });

  it('checks the exact stored version and distinguishes missing from unavailable', async () => {
    const { service, client, send } = fixture();
    send.mockResolvedValueOnce({
      VersionId: object.versionId,
      ContentLength: object.bytes,
      ContentType: object.contentType,
      ChecksumSHA256: object.sha256,
    } as never);
    await expect(service.isPinnedObjectAvailable(object)).resolves.toBe(true);
    expect((send.mock.calls[0][0] as HeadObjectCommand).input.VersionId).toBe(
      object.versionId,
    );
    send.mockRejectedValueOnce(
      Object.assign(new Error('missing'), {
        name: 'NoSuchVersion',
        $metadata: { httpStatusCode: 404 },
      }) as never,
    );
    await expect(service.isPinnedObjectAvailable(object)).resolves.toBe(false);
    send.mockRejectedValueOnce(new Error('unavailable') as never);
    await expect(service.isPinnedObjectAvailable(object)).rejects.toThrow(
      'unavailable',
    );
    client.destroy();
  });

  it('deletes only exact-key versions and delete markers', async () => {
    const { service, client, send } = fixture();
    send
      .mockResolvedValueOnce({
        Versions: [
          { Key: object.key, VersionId: 'v1' },
          { Key: `${object.key}-other`, VersionId: 'other' },
        ],
        DeleteMarkers: [{ Key: object.key, VersionId: 'marker' }],
        IsTruncated: false,
      } as never)
      .mockResolvedValueOnce({} as never);
    await expect(service.sweepVersionsForKey(object.key)).resolves.toEqual({
      complete: true,
      deleted: 2,
    });
    expect(
      (send.mock.calls[1][0] as DeleteObjectsCommand).input.Delete?.Objects,
    ).toEqual([
      { Key: object.key, VersionId: 'v1' },
      { Key: object.key, VersionId: 'marker' },
    ]);
    client.destroy();
  });
});
