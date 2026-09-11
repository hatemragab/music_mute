import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import type { HttpException } from '@nestjs/common';
import type { StorageClient } from '../infrastructure/storage.module.js';
import type { InputReservation, OutputReservation } from '../jobs/job.types.js';
import {
  StorageTransfersService,
  type TransferJob,
} from './storage-transfers.service.js';
import type { StoragePreflightService } from './storage-preflight.service.js';

const inputSha256 = Buffer.alloc(32, 1).toString('base64');
const outputSha256 = Buffer.alloc(32, 2).toString('base64');
const inputReservation: InputReservation = {
  key: 'users/user-1/jobs/job-1/input/upload-1.m4a',
  extension: 'm4a',
  contentType: 'audio/mp4',
  bytes: 1024,
  durationSeconds: 12.5,
  sha256: inputSha256,
};
const outputReservation: OutputReservation = {
  key: 'users/user-1/jobs/job-1/output/attempt-1/vocals.mp3',
  attemptId: 'attempt-1',
  contentType: 'audio/mpeg',
  bytes: 2048,
  durationSeconds: 12.25,
  sha256: outputSha256,
};

function transferJob(overrides: Partial<TransferJob> = {}): TransferJob {
  return {
    inputReservation: { ...inputReservation },
    inputObject: null,
    outputReservation: { ...outputReservation },
    outputObject: null,
    ...overrides,
  };
}

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
      AWS_REGION: 'us-east-1',
      S3_BUCKET: 'private-fixture-bucket',
      PROCESSING_URL_SECONDS: 900,
      PROCESSING_OUTPUT_MAX_BYTES: 30_000_000,
    }),
    preflight as unknown as StoragePreflightService,
  );
  return { service, client, send, preflight };
}

function decodePolicy(fields: Record<string, string>) {
  return JSON.parse(Buffer.from(fields.Policy, 'base64').toString()) as {
    conditions: unknown[];
  };
}

async function expectUploadNotReady(action: Promise<unknown>) {
  const error = (await action.catch(
    (caught: unknown) => caught,
  )) as HttpException;
  expect(error.getResponse()).toMatchObject({ code: 'UPLOAD_NOT_READY' });
}

describe('StorageTransfersService grants', () => {
  it('bounds admin media grants to five minutes and signs safe disposition metadata', async () => {
    const { service, client } = fixture();
    const grant = await service.createMediaGrant(
      { ...outputReservation, versionId: 'pinned' },
      'download',
      'vocals.mp3',
    );
    const url = new URL(grant.url);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('versionId')).toBe('pinned');
    expect(url.searchParams.get('response-content-type')).toBe('audio/mpeg');
    expect(url.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="vocals.mp3"',
    );
    await expect(
      service.createMediaGrant(
        { ...outputReservation, versionId: 'pinned' },
        'play',
        'bad\r\nheader',
      ),
    ).rejects.toThrow();
    client.destroy();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('signs an input POST for the exact reserved key, bytes, content type and checksum', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T00:00:00.000Z'));
    const { service, client, preflight } = fixture();
    const job = transferJob();
    const before = JSON.stringify(job);

    const grant = await service.createInputGrant(job);
    const policy = decodePolicy(grant.fields);

    expect(preflight.assertReady).toHaveBeenCalledOnce();
    expect(policy.conditions).toContainEqual([
      'content-length-range',
      1024,
      1024,
    ]);
    expect(policy.conditions).toContainEqual({ key: inputReservation.key });
    expect(policy.conditions).toContainEqual({
      bucket: 'private-fixture-bucket',
    });
    expect(policy.conditions).toContainEqual({
      'Content-Type': inputReservation.contentType,
    });
    expect(policy.conditions).toContainEqual({
      'x-amz-checksum-algorithm': 'SHA256',
    });
    expect(policy.conditions).toContainEqual({
      'x-amz-checksum-sha256': inputSha256,
    });
    expect(grant.fields).toMatchObject({
      key: inputReservation.key,
      'Content-Type': inputReservation.contentType,
      'x-amz-checksum-algorithm': 'SHA256',
      'x-amz-checksum-sha256': inputSha256,
    });
    expect(grant.expiresAt).toBe('2026-09-09T00:15:00.000Z');
    expect(JSON.stringify(job)).toBe(before);
    expect(JSON.stringify(job)).not.toContain('X-Amz-Signature');
    client.destroy();
  });

  it('never extends a recorded input reservation expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T00:00:00.000Z'));
    const { service, client } = fixture();
    const admissionSnapshot = {
      settingsRevision: 1,
      maxInputBytesExclusive: 30_000_000,
      maxDurationSecondsExclusive: 600,
      maxActiveJobsPerUser: null,
      reservationExpiresAt: new Date('2026-09-09T00:05:00.000Z'),
    };
    await expect(
      service.createInputGrant(transferJob({ admissionSnapshot })),
    ).resolves.toMatchObject({ expiresAt: '2026-09-09T00:05:00.000Z' });
    vi.setSystemTime(new Date('2026-09-09T00:05:00.000Z'));
    await expect(
      service.createInputGrant(transferJob({ admissionSnapshot })),
    ).rejects.toMatchObject({ status: 409 });
    client.destroy();
  });

  it('signs output POSTs against the independent configured output limit', async () => {
    const { service, client } = fixture();

    const grant = await service.createOutputGrant(transferJob());
    expect(decodePolicy(grant.fields).conditions).toContainEqual([
      'content-length-range',
      2048,
      2048,
    ]);

    await expect(
      service.createOutputGrant(
        transferJob({
          outputReservation: {
            ...outputReservation,
            bytes: 30_000_000,
          },
        }),
      ),
    ).rejects.toThrow('Invalid output reservation');
    client.destroy();
  });

  it('signs a GET only for the pinned key and version', async () => {
    const { service, client, preflight } = fixture();

    const grant = await service.createDownloadGrant({
      key: outputReservation.key,
      versionId: 'version/id + 1',
      bytes: outputReservation.bytes,
      sha256: outputReservation.sha256,
      contentType: outputReservation.contentType,
    });
    const url = new URL(grant.url);

    expect(preflight.assertReady).toHaveBeenCalledOnce();
    expect(url.hostname).toBe(
      'private-fixture-bucket.s3.us-east-1.amazonaws.com',
    );
    expect(decodeURIComponent(url.pathname)).toBe(`/${outputReservation.key}`);
    expect(url.searchParams.get('versionId')).toBe('version/id + 1');
    expect(url.searchParams.get('response-cache-control')).toBe('no-store');
    expect(url.searchParams.has('X-Amz-Signature')).toBe(true);
    client.destroy();
  });
});

describe('StorageTransfersService object verification', () => {
  it('checks the stored exact version and never substitutes the latest object', async () => {
    const { service, client, send } = fixture();
    const object = { ...outputReservation, versionId: 'pinned' };
    send.mockResolvedValueOnce({
      VersionId: 'pinned',
      ContentLength: object.bytes,
      ContentType: object.contentType,
      ChecksumSHA256: object.sha256,
    } as never);
    expect(await service.isPinnedObjectAvailable(object)).toBe(true);
    expect((send.mock.calls[0][0] as HeadObjectCommand).input.VersionId).toBe(
      'pinned',
    );
    send.mockRejectedValueOnce(
      Object.assign(new Error('missing'), {
        name: 'NoSuchVersion',
        $metadata: { httpStatusCode: 404 },
      }) as never,
    );
    expect(await service.isPinnedObjectAvailable(object)).toBe(false);
    send.mockRejectedValueOnce(new Error('unavailable') as never);
    await expect(service.isPinnedObjectAvailable(object)).rejects.toThrow(
      'unavailable',
    );
    expect(
      await service.isPinnedObjectAvailable({ ...object, versionId: 'null' }),
    ).toBe(false);
    client.destroy();
  });
  it('deletes only exact-key versions, including delete markers', async () => {
    const { service, client, send } = fixture();
    send
      .mockResolvedValueOnce({
        Versions: [
          { Key: inputReservation.key, VersionId: 'v1' },
          { Key: `${inputReservation.key}-other`, VersionId: 'other' },
        ],
        DeleteMarkers: [{ Key: inputReservation.key, VersionId: 'marker' }],
        IsTruncated: false,
      } as never)
      .mockResolvedValueOnce({} as never);
    expect(await service.deleteVersionsForKey(inputReservation.key)).toBe(true);
    expect(
      (send.mock.calls[1][0] as DeleteObjectsCommand).input.Delete?.Objects,
    ).toEqual([
      { Key: inputReservation.key, VersionId: 'v1' },
      { Key: inputReservation.key, VersionId: 'marker' },
    ]);
    client.destroy();
  });

  it('keeps cleanup pending when S3 reports a partial delete failure', async () => {
    const { service, client, send } = fixture();
    send
      .mockResolvedValueOnce({
        Versions: [{ Key: inputReservation.key, VersionId: 'v1' }],
      } as never)
      .mockResolvedValueOnce({ Errors: [{ Code: 'AccessDenied' }] } as never);
    await expect(
      service.deleteVersionsForKey(inputReservation.key),
    ).rejects.toThrow();
    client.destroy();
  });

  it('finishes when truncated prefix pagination has moved past the exact key', async () => {
    const { service, client, send } = fixture();
    send.mockResolvedValueOnce({
      Versions: [{ Key: `${inputReservation.key}-other`, VersionId: 'other' }],
      IsTruncated: true,
      NextKeyMarker: `${inputReservation.key}-other`,
    } as never);
    expect(await service.deleteVersionsForKey(inputReservation.key)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('pins a version with a second HEAD before accepting an input object', async () => {
    const { service, client, send } = fixture();
    send
      .mockResolvedValueOnce({ VersionId: 'input-version-1' } as never)
      .mockResolvedValueOnce({
        VersionId: 'input-version-1',
        ContentLength: inputReservation.bytes,
        ContentType: inputReservation.contentType,
        ChecksumSHA256: inputReservation.sha256,
      } as never);

    await expect(service.verifyInput(transferJob())).resolves.toEqual({
      key: inputReservation.key,
      versionId: 'input-version-1',
      bytes: inputReservation.bytes,
      sha256: inputReservation.sha256,
      contentType: inputReservation.contentType,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.map(([command]) => (command as HeadObjectCommand).input),
    ).toEqual([
      {
        Bucket: 'private-fixture-bucket',
        Key: inputReservation.key,
        ChecksumMode: 'ENABLED',
      },
      {
        Bucket: 'private-fixture-bucket',
        Key: inputReservation.key,
        VersionId: 'input-version-1',
        ChecksumMode: 'ENABLED',
      },
    ]);
    client.destroy();
  });

  it.each([
    ['size', { ContentLength: inputReservation.bytes + 1 }],
    ['content type', { ContentType: 'video/mp4' }],
    ['checksum', { ChecksumSHA256: outputSha256 }],
  ])('refuses an input %s mismatch', async (_field, mismatch) => {
    const { service, client, send } = fixture();
    send
      .mockResolvedValueOnce({ VersionId: 'input-version-1' } as never)
      .mockResolvedValueOnce({
        VersionId: 'input-version-1',
        ContentLength: inputReservation.bytes,
        ContentType: inputReservation.contentType,
        ChecksumSHA256: inputReservation.sha256,
        ...mismatch,
      } as never);

    await expectUploadNotReady(service.verifyInput(transferJob()));
    client.destroy();
  });

  it('refuses an upload when S3 does not return a version or checksum', async () => {
    const first = fixture();
    first.send.mockResolvedValueOnce({} as never);
    await expectUploadNotReady(first.service.verifyInput(transferJob()));
    first.client.destroy();

    const second = fixture();
    second.send
      .mockResolvedValueOnce({ VersionId: 'input-version-1' } as never)
      .mockResolvedValueOnce({
        VersionId: 'input-version-1',
        ContentLength: inputReservation.bytes,
        ContentType: inputReservation.contentType,
      } as never);
    await expectUploadNotReady(second.service.verifyInput(transferJob()));
    second.client.destroy();
  });

  it('rejects the mutable S3 null version when versioning was suspended', async () => {
    const { service, client, send } = fixture();
    send.mockResolvedValue({
      VersionId: 'null',
      ContentLength: inputReservation.bytes,
      ContentType: inputReservation.contentType,
      ChecksumSHA256: inputReservation.sha256,
    } as never);
    await expectUploadNotReady(service.verifyInput(transferJob()));
    client.destroy();
  });

  it('verifies an output reservation with the same version and checksum boundary', async () => {
    const { service, client, send } = fixture();
    send
      .mockResolvedValueOnce({ VersionId: 'output-version-1' } as never)
      .mockResolvedValueOnce({
        VersionId: 'output-version-1',
        ContentLength: outputReservation.bytes,
        ContentType: outputReservation.contentType,
        ChecksumSHA256: outputReservation.sha256,
      } as never);

    await expect(service.verifyOutput(transferJob())).resolves.toEqual({
      key: outputReservation.key,
      versionId: 'output-version-1',
      bytes: outputReservation.bytes,
      sha256: outputReservation.sha256,
      contentType: outputReservation.contentType,
    });
    client.destroy();
  });

  it('returns null from output recovery only for a confirmed missing object', async () => {
    const missing = fixture();
    missing.send.mockRejectedValueOnce(
      Object.assign(new Error('missing'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      }) as never,
    );
    await expect(missing.service.findOutput(transferJob())).resolves.toBeNull();
    missing.client.destroy();

    const unavailable = fixture();
    unavailable.send.mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), {
        name: 'ServiceUnavailable',
        $metadata: { httpStatusCode: 503 },
      }) as never,
    );
    await expect(unavailable.service.findOutput(transferJob())).rejects.toThrow(
      'unavailable',
    );
    unavailable.client.destroy();
  });

  it('does not report a mismatched recovery object as missing', async () => {
    const { service, client, send } = fixture();
    send
      .mockResolvedValueOnce({ VersionId: 'output-version-1' } as never)
      .mockResolvedValueOnce({
        VersionId: 'output-version-1',
        ContentLength: outputReservation.bytes + 1,
        ContentType: outputReservation.contentType,
        ChecksumSHA256: outputReservation.sha256,
      } as never);

    await expectUploadNotReady(service.findOutput(transferJob()));
    client.destroy();
  });
});
