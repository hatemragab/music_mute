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
  it('signs immutable input uploads with exact size, type, and checksum', async () => {
    const { service, client, preflight } = fixture();
    const reservation = {
      key: 'users/user-1/jobs/job-1/input/source.mp3',
      extension: 'mp3' as const,
      contentType: 'audio/mpeg',
      bytes: 2048,
      durationSeconds: 30,
      sha256: object.sha256,
    };
    const grant = await service.createInputGrant({
      inputReservation: reservation,
      inputObject: null,
      admissionSnapshot: {
        policyVersion: 1,
        settingsRevision: 1,
        maxInputBytesExclusive: 30_000_000,
        maxDurationSecondsExclusive: 600,
        maxActiveJobsPerUser: 1,
        reservationExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(preflight.assertReady).toHaveBeenCalledOnce();
    expect(grant.method).toBe('PUT');
    expect(grant.headers).toEqual({
      'Content-Type': reservation.contentType,
      'x-amz-checksum-sha256': reservation.sha256,
      'If-None-Match': '*',
    });
    const url = new URL(grant.url);
    expect(decodeURIComponent(url.pathname)).toBe(`/${reservation.key}`);
    expect(url.searchParams.get('x-id')).toBe('PutObject');
    client.destroy();
  });

  it('pins a verified input to the immutable S3 version', async () => {
    const { service, client, send } = fixture();
    const reservation = {
      key: 'users/user-1/jobs/job-1/input/source.mp3',
      extension: 'mp3' as const,
      contentType: 'audio/mpeg',
      bytes: 2048,
      durationSeconds: 30,
      sha256: object.sha256,
    };
    send
      .mockResolvedValueOnce({ VersionId: 'input-version' } as never)
      .mockResolvedValueOnce({
        VersionId: 'input-version',
        ContentLength: reservation.bytes,
        ContentType: reservation.contentType,
        ChecksumSHA256: reservation.sha256,
      } as never);
    await expect(
      service.verifyInput({ inputReservation: reservation, inputObject: null }),
    ).resolves.toEqual({
      key: reservation.key,
      versionId: 'input-version',
      bytes: reservation.bytes,
      contentType: reservation.contentType,
      sha256: reservation.sha256,
    });
    expect((send.mock.calls[0][0] as HeadObjectCommand).input.VersionId).toBe(
      undefined,
    );
    expect((send.mock.calls[1][0] as HeadObjectCommand).input.VersionId).toBe(
      'input-version',
    );
    client.destroy();
  });
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

  it('verifies only the worker-declared immutable output version', async () => {
    const { service, client, send } = fixture();
    const reservation = {
      key: object.key,
      bytes: object.bytes,
      sha256: object.sha256,
      contentType: object.contentType,
    };
    send.mockResolvedValueOnce({
      VersionId: 'worker-version',
      ContentLength: object.bytes,
      ContentType: object.contentType,
      ChecksumSHA256: object.sha256,
    } as never);
    await expect(
      service.verifyUploadedVersion(reservation, 'worker-version'),
    ).resolves.toEqual({ ...reservation, versionId: 'worker-version' });
    expect((send.mock.calls[0][0] as HeadObjectCommand).input.VersionId).toBe(
      'worker-version',
    );

    send.mockResolvedValueOnce({
      VersionId: 'worker-version',
      ContentLength: object.bytes + 1,
      ContentType: object.contentType,
      ChecksumSHA256: object.sha256,
    } as never);
    await expect(
      service.verifyUploadedVersion(reservation, 'worker-version'),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_READY' } });
    client.destroy();
  });

  it('recovers an exact immutable output after the PUT response is lost', async () => {
    const { service, client, send } = fixture();
    const reservation = {
      key: object.key,
      bytes: object.bytes,
      sha256: object.sha256,
      contentType: object.contentType,
    };
    send
      .mockResolvedValueOnce({ VersionId: 'worker-version' } as never)
      .mockResolvedValueOnce({
        VersionId: 'worker-version',
        ContentLength: object.bytes,
        ContentType: object.contentType,
        ChecksumSHA256: object.sha256,
      } as never);

    await expect(service.findUploadedVersion(reservation)).resolves.toEqual({
      ...reservation,
      versionId: 'worker-version',
    });
    expect((send.mock.calls[1][0] as HeadObjectCommand).input.VersionId).toBe(
      'worker-version',
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
