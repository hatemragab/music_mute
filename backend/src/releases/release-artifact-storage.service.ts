import {
  isStorageEtag,
  confirmedObjectIdentity,
  validateStorageKey,
} from '../storage/object-identity.js';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageClient } from '../infrastructure/storage.module.js';
import { StoragePreflightService } from '../storage/storage-preflight.service.js';
import { createImmutableUploadGrant } from '../storage/immutable-upload-grant.js';
import { ApkVerificationError } from './apk-verifier.service.js';

interface Reservation {
  key: string;
  expectedBytes: number;
  expectedSha256: string;
}
@Injectable()
export class ReleaseArtifactStorageService {
  private readonly bucket: string;
  private readonly downloadSeconds: number;
  constructor(
    private readonly storage: StorageClient,
    config: ConfigService,
    private readonly preflight: StoragePreflightService,
  ) {
    this.bucket = config.getOrThrow<string>('STORAGE_BUCKET');
    this.downloadSeconds = Math.min(
      600,
      config.get<number>('APP_RELEASE_DOWNLOAD_SECONDS', 300),
    );
  }
  async grant(reservation: Reservation, expiresAt: Date) {
    const now = Date.now();
    const expires = Math.min(
      600,
      Math.floor((expiresAt.getTime() - now) / 1000),
    );
    if (
      !Number.isFinite(expires) ||
      expires < 1 ||
      !/^[a-f0-9]{64}$/.test(reservation.expectedSha256)
    )
      throw new ApkVerificationError('APK_INVALID');
    const checksum = Buffer.from(reservation.expectedSha256, 'hex').toString(
      'base64',
    );
    return createImmutableUploadGrant({
      storage: this.storage,
      bucket: this.bucket,
      key: reservation.key,
      bytes: reservation.expectedBytes,
      contentType: 'application/vnd.android.package-archive',
      checksumSha256: checksum,
      expiresIn: expires,
      expiresAt: new Date(now + expires * 1_000),
    });
  }
  async pin(reservation: Reservation, etag?: string): Promise<string> {
    validateStorageKey(reservation.key);
    if (etag !== undefined && !isStorageEtag(etag))
      throw new ApkVerificationError('APK_INVALID');
    const pinned = await this.storage.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: reservation.key,
        ...(etag ? { IfMatch: etag } : {}),
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    this.preflight.recordSuccess?.();
    if (!isStorageEtag(pinned.ETag) || (etag && pinned.ETag !== etag))
      throw new ApkVerificationError('APK_INVALID');
    if (pinned.ContentLength !== reservation.expectedBytes)
      throw new ApkVerificationError('APK_SIZE_MISMATCH');
    const identity = confirmedObjectIdentity(
      {
        key: reservation.key,
        bytes: reservation.expectedBytes,
        sha256: Buffer.from(reservation.expectedSha256, 'hex').toString(
          'base64',
        ),
        contentType: 'application/vnd.android.package-archive',
      },
      pinned,
    );
    if (!identity) throw new ApkVerificationError('APK_CHECKSUM_MISMATCH');
    return identity.etag;
  }

  async download(
    reservation: Reservation,
    etag: string,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    validateStorageKey(reservation.key);
    if (!isStorageEtag(etag)) throw new ApkVerificationError('APK_INVALID');
    const result = await this.storage.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: reservation.key,
        IfMatch: etag,
      }),
      { abortSignal: signal },
    );
    if (
      result.ETag !== etag ||
      result.ContentLength !== reservation.expectedBytes ||
      !result.Body
    ) {
      const stream = result.Body as
        (NodeJS.ReadableStream & { destroy?: () => void }) | undefined;
      stream?.destroy?.();
      throw new ApkVerificationError('APK_SIZE_MISMATCH');
    }
    let bytes = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        done(
          bytes > reservation.expectedBytes
            ? new ApkVerificationError('APK_SIZE_MISMATCH')
            : null,
          chunk,
        );
      },
    });
    await pipeline(
      result.Body as NodeJS.ReadableStream,
      bounded,
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (bytes !== reservation.expectedBytes)
      throw new ApkVerificationError('APK_SIZE_MISMATCH');
  }
  async createDownloadGrant(artifact: { key: string; etag: string }) {
    validateStorageKey(artifact.key);
    if (!isStorageEtag(artifact.etag))
      throw new ApkVerificationError('APK_INVALID');
    const url = await getSignedUrl(
      this.storage,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: artifact.key,
        ResponseCacheControl: 'no-store',
        ResponseContentType: 'application/vnd.android.package-archive',
      }),
      { expiresIn: this.downloadSeconds },
    );
    return {
      url,
      expiresAt: new Date(
        Date.now() + this.downloadSeconds * 1_000,
      ).toISOString(),
    };
  }
}
