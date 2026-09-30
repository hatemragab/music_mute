import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { StorageClient } from '../infrastructure/storage.module.js';
import type { ObjectIdentity } from '../jobs/job.types.js';
import { StorageTransfersService } from './storage-transfers.service.js';
import type { StoragePreflightService } from './storage-preflight.service.js';

const endpoint =
  'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
const bucket = 'music-mute-test-unit';
const object: ObjectIdentity = {
  key: 'users/user-1/jobs/job-1/output/vocals.mp3',
  etag: '"immutable-etag"',
  contentType: 'audio/mpeg',
  bytes: 2048,
  sha256: Buffer.alloc(32, 2).toString('base64'),
};
const clients: StorageClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
  vi.useRealTimers();
});

function fixture() {
  const client = new StorageClient(
    new ConfigService({
      STORAGE_ENDPOINT: endpoint,
      STORAGE_REGION: 'auto',
      STORAGE_ACCESS_KEY_ID: 'fixture-access-key',
      STORAGE_SECRET_ACCESS_KEY: 'fixture-secret-key',
    }),
  );
  clients.push(client);
  const send = vi.spyOn(client, 'send');
  const preflight = {
    assertReady: vi.fn(async () => undefined),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  };
  const service = new StorageTransfersService(
    client,
    new ConfigService({
      STORAGE_BUCKET: bucket,
      PROCESSING_URL_SECONDS: 900,
    }),
    preflight as unknown as StoragePreflightService,
  );
  return { service, client, send, preflight };
}
function reservation() {
  return {
    key: object.key,
    bytes: object.bytes,
    sha256: object.sha256,
    contentType: object.contentType,
  };
}
function inputReservation() {
  return {
    ...reservation(),
    key: 'users/user-1/jobs/job-1/input/source.mp3',
    extension: 'mp3' as const,
    durationSeconds: 30,
  };
}
function verifiedHead() {
  return {
    ETag: object.etag,
    ContentLength: object.bytes,
    ContentType: object.contentType,
    Metadata: { sha256: object.sha256 },
  };
}
function storageError(name: string, statusCode: number) {
  return Object.assign(new Error('private storage diagnostics'), {
    name,
    $metadata: { httpStatusCode: statusCode },
  });
}
function expectSignedUrl(url: string) {
  const parsed = new URL(url);
  expect(parsed.origin).toBe(endpoint);
  expect(decodeURIComponent(parsed.pathname)).toBe(`/${bucket}/${object.key}`);
  expect(parsed.searchParams.get('X-Amz-Credential')).toContain(
    '/auto/s3/aws4_request',
  );
  return parsed;
}

describe('StorageTransfersService R2', () => {
  it('signs one conditional PUT locally with exact size, type and both bound SHA256 headers', async () => {
    const { service, send, preflight } = fixture();
    const grant = await service.createInputGrant(
      { inputReservation: inputReservation(), inputObject: null },
      new Date(Date.now() + 60_000),
    );
    expect(grant.method).toBe('PUT');
    expect(grant.headers).toEqual({
      'Content-Type': object.contentType,
      'x-amz-checksum-sha256': object.sha256,
      'x-amz-meta-sha256': object.sha256,
      'If-None-Match': '*',
    });
    const url = new URL(grant.url);
    expect(url.origin).toBe(endpoint);
    expect(decodeURIComponent(url.pathname)).toBe(
      `/${bucket}/${inputReservation().key}`,
    );
    expect(url.searchParams.get('x-id')).toBe('PutObject');
    for (const name of [
      'x-amz-checksum-sha256',
      'x-amz-meta-sha256',
      'x-amz-storage-class',
    ])
      expect(url.searchParams.has(name)).toBe(false);
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual([
      'content-length',
      'content-type',
      'host',
      'if-none-match',
      'x-amz-checksum-sha256',
      'x-amz-meta-sha256',
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(preflight.assertReady).not.toHaveBeenCalled();
  });

  it('caps upload/download lifetimes at ten minutes and respects fixed deadlines', async () => {
    const { service } = fixture();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T00:00:00.000Z'));
    const deadline = new Date(Date.now() + 60_000);
    for (const grant of [
      await service.createWorkerOutputGrant(
        reservation(),
        new Date(Date.now() + 3_600_000),
      ),
      await service.createDownloadGrant(object),
    ]) {
      expect(new URL(grant.url).searchParams.get('X-Amz-Expires')).toBe('600');
      expect(grant.expiresAt).toBe('2026-09-30T00:10:00.000Z');
    }
    for (const grant of [
      await service.createWorkerOutputGrant(reservation(), deadline),
      await service.createWorkerInstallationUploadGrant(
        reservation(),
        deadline,
      ),
      await service.createDownloadGrant(object, deadline),
    ]) {
      expect(new URL(grant.url).searchParams.get('X-Amz-Expires')).toBe('60');
      expect(grant.expiresAt).toBe(deadline.toISOString());
    }
    for (const expired of [
      new Date(Date.now()),
      new Date(Date.now() - 1000),
      new Date(NaN),
    ]) {
      await expect(
        service.createWorkerOutputGrant(reservation(), expired),
      ).rejects.toMatchObject({
        response: { code: 'UPLOAD_RESERVATION_EXPIRED' },
      });
      await expect(
        service.createDownloadGrant(object, expired),
      ).rejects.toMatchObject({
        response: { code: 'DOWNLOAD_RESERVATION_EXPIRED' },
      });
    }
  });

  it('signs immutable downloads without storage requests, checksum-mode or version selectors', async () => {
    const { service, send, preflight } = fixture();
    const url = expectSignedUrl(
      (await service.createDownloadGrant(object)).url,
    );
    expect(url.searchParams.get('response-cache-control')).toBe('no-store');
    expect(url.searchParams.has('x-amz-checksum-mode')).toBe(false);
    expect(
      [...url.searchParams.keys()].some((key) => /version/i.test(key)),
    ).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(preflight.assertReady).not.toHaveBeenCalled();
  });

  it('bounds playback/download grants and rejects header-injection filenames', async () => {
    const { service } = fixture();
    for (const [purpose, disposition] of [
      ['download', 'attachment'],
      ['play', 'inline'],
    ] as const) {
      const url = expectSignedUrl(
        (await service.createMediaGrant(object, purpose, 'vocals.mp3')).url,
      );
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
      expect(url.searchParams.get('response-content-type')).toBe(
        object.contentType,
      );
      expect(url.searchParams.get('response-content-disposition')).toBe(
        `${disposition}; filename="vocals.mp3"`,
      );
    }
    for (const filename of ['../vocals.mp3', 'bad\r\nheader', '"unsafe"', ''])
      await expect(
        service.createMediaGrant(object, 'play', filename),
      ).rejects.toThrow('Invalid media grant');
  });

  it('confirms a successful PUT with one HEAD using signed metadata when checksum is omitted', async () => {
    const { service, send, preflight } = fixture();
    send.mockResolvedValueOnce(verifiedHead() as never);
    await expect(
      service.verifyUploadedObject(reservation(), object.etag),
    ).resolves.toEqual(object);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect((send.mock.calls[0][0] as HeadObjectCommand).input).toEqual({
      Bucket: bucket,
      Key: object.key,
      IfMatch: object.etag,
    });
    expect(send.mock.calls[0][1]).toMatchObject({
      abortSignal: expect.any(AbortSignal),
    });
    expect(preflight.recordSuccess).toHaveBeenCalledOnce();
    expect(preflight.assertReady).not.toHaveBeenCalled();
  });

  it('checks the provider checksum when present without making a second HEAD', async () => {
    const { service, send } = fixture();
    send.mockResolvedValueOnce({
      ...verifiedHead(),
      ChecksumSHA256: object.sha256,
    } as never);
    await expect(
      service.verifyUploadedObject(reservation(), object.etag),
    ).resolves.toEqual(object);
    expect(send).toHaveBeenCalledOnce();
  });

  it('recovers a lost PUT response using one HEAD by immutable key', async () => {
    const { service, send } = fixture();
    send.mockResolvedValueOnce(verifiedHead() as never);
    await expect(service.findUploadedObject(reservation())).resolves.toEqual(
      object,
    );
    expect(send).toHaveBeenCalledOnce();
    expect((send.mock.calls[0][0] as HeadObjectCommand).input).toEqual({
      Bucket: bucket,
      Key: object.key,
    });
  });

  it('confirms input without version discovery or a second storage read', async () => {
    const { service, send } = fixture();
    const input = inputReservation();
    send.mockResolvedValueOnce(verifiedHead() as never);
    await expect(
      service.verifyInput({ inputReservation: input, inputObject: null }),
    ).resolves.toEqual({ ...reservation(), key: input.key, etag: object.etag });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    ['oversized', { ContentLength: object.bytes + 1 }],
    ['undersized', { ContentLength: object.bytes - 1 }],
    ['wrong type', { ContentType: 'audio/wav' }],
    ['missing signed metadata', { Metadata: undefined }],
    [
      'wrong signed metadata',
      { Metadata: { sha256: Buffer.alloc(32, 3).toString('base64') } },
    ],
    [
      'wrong checksum',
      { ChecksumSHA256: Buffer.alloc(32, 3).toString('base64') },
    ],
    ['missing ETag', { ETag: undefined }],
    ['bare ETag', { ETag: 'bare' }],
    ['weak ETag', { ETag: 'W/"weak"' }],
    ['different ETag', { ETag: '"different"' }],
  ])('rejects %s after one HEAD', async (_label, patch) => {
    const { service, send } = fixture();
    send.mockResolvedValueOnce({ ...verifiedHead(), ...patch } as never);
    await expect(
      service.verifyUploadedObject(reservation(), object.etag),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_READY' } });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(['NotFound', 'NoSuchKey'])(
    'treats only a confirmed %s HTTP 404 as missing',
    async (name) => {
      const { service, send, preflight } = fixture();
      send.mockRejectedValueOnce(storageError(name, 404) as never);
      await expect(
        service.findUploadedObject(reservation()),
      ).resolves.toBeNull();
      expect(preflight.recordSuccess).toHaveBeenCalledOnce();
      expect(preflight.recordFailure).not.toHaveBeenCalled();
      send.mockRejectedValueOnce(storageError(name, 404) as never);
      await expect(
        service.verifyInput({
          inputReservation: inputReservation(),
          inputObject: null,
        }),
      ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_READY' } });
      send.mockRejectedValueOnce(storageError(name, 404) as never);
      await expect(service.isObjectAvailable(object)).resolves.toBe(false);
    },
  );

  it.each([
    ['AccessDenied', 403],
    ['ServiceUnavailable', 503],
    ['NotFound', 403],
    ['NoSuchBucket', 404],
  ])(
    'preserves storage failure %s HTTP %s instead of claiming an absent object',
    async (name, status) => {
      const { service, send, preflight } = fixture();
      const error = storageError(name, status);
      send.mockRejectedValueOnce(error as never);
      await expect(service.findUploadedObject(reservation())).rejects.toBe(
        error,
      );
      expect(preflight.recordFailure).toHaveBeenCalledOnce();
      expect(preflight.recordSuccess).not.toHaveBeenCalled();
    },
  );

  it('checks availability using the confirmed ETag and metadata only when explicitly requested', async () => {
    const { service, send } = fixture();
    send.mockResolvedValueOnce(verifiedHead() as never);
    await expect(service.isObjectAvailable(object)).resolves.toBe(true);
    expect((send.mock.calls[0][0] as HeadObjectCommand).input.IfMatch).toBe(
      object.etag,
    );
    await expect(
      service.isObjectAvailable({ ...object, etag: 'invalid' }),
    ).resolves.toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    ['invalid key', { key: '../other' }],
    ['encoded key', { key: 'users/%2fother' }],
    ['empty key', { key: '' }],
    ['invalid bytes', { bytes: 0 }],
    ['fractional bytes', { bytes: 1.5 }],
    ['invalid hash', { sha256: 'not-a-checksum' }],
    ['invalid content type', { contentType: 'audio/mpeg\r\nprivate-header' }],
  ])(
    'rejects %s before any signing/storage operation',
    async (_label, patch) => {
      const { service, send } = fixture();
      const invalid = { ...object, ...patch };
      await expect(
        service.createWorkerOutputGrant(invalid, new Date(Date.now() + 60_000)),
      ).rejects.toThrow(TypeError);
      await expect(service.createDownloadGrant(invalid)).rejects.toThrow(
        TypeError,
      );
      await expect(service.findUploadedObject(invalid)).rejects.toThrow(
        TypeError,
      );
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(['bare', 'W/"weak"', '"inner"quote"', '"control\n"'])(
    'rejects invalid ETag %s before any storage call',
    async (etag) => {
      const { service, send } = fixture();
      await expect(
        service.verifyUploadedObject(reservation(), etag),
      ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_READY' } });
      await expect(
        service.createDownloadGrant({ ...object, etag }),
      ).rejects.toThrow('Invalid storage identity');
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('deletes one exact key without version listing, read or marker operations', async () => {
    const { service, send, preflight } = fixture();
    send.mockResolvedValueOnce({} as never);
    await expect(service.deleteObject(object.key)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
    expect((send.mock.calls[0][0] as DeleteObjectCommand).input).toEqual({
      Bucket: bucket,
      Key: object.key,
    });
    expect(send.mock.calls[0][1]).toMatchObject({
      abortSignal: expect.any(AbortSignal),
    });
    expect(preflight.recordSuccess).toHaveBeenCalledOnce();
    expect(preflight.assertReady).not.toHaveBeenCalled();
  });

  it('reconciles confirmed missing deletes but propagates permission/transport failures', async () => {
    const { service, send, preflight } = fixture();
    send.mockRejectedValueOnce(storageError('NoSuchKey', 404) as never);
    await expect(service.deleteObject(object.key)).resolves.toBeUndefined();
    expect(preflight.recordSuccess).toHaveBeenCalledOnce();
    const denied = storageError('AccessDenied', 403);
    send.mockRejectedValueOnce(denied as never);
    await expect(service.deleteObject(object.key)).rejects.toBe(denied);
    expect(preflight.recordFailure).toHaveBeenCalledOnce();
    await expect(service.deleteObject('users/../other')).rejects.toThrow(
      'Invalid storage key',
    );
    expect(send).toHaveBeenCalledTimes(2);
  });
});
