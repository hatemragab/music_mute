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
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.downloadSeconds = config.get<number>(
      'APP_RELEASE_DOWNLOAD_SECONDS',
      300,
    );
  }
  async grant(reservation: Reservation, expiresAt: Date) {
    await this.preflight.assertReady();
    const expires = Math.max(
      1,
      Math.min(900, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    );
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
      expiresAt,
    });
  }
  async pin(reservation: Reservation, versionId?: string): Promise<string> {
    const latest =
      versionId ??
      (
        await this.storage.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: reservation.key }),
          { abortSignal: AbortSignal.timeout(5000) },
        )
      ).VersionId;
    if (!latest || latest === 'null' || latest.length > 1024)
      throw new ApkVerificationError('APK_INVALID');
    const pinned = await this.storage.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: reservation.key,
        VersionId: latest,
        ChecksumMode: 'ENABLED',
      }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    if (pinned.VersionId !== latest)
      throw new ApkVerificationError('APK_INVALID');
    if (pinned.ContentLength !== reservation.expectedBytes)
      throw new ApkVerificationError('APK_SIZE_MISMATCH');
    if (
      pinned.ChecksumSHA256 !==
      Buffer.from(reservation.expectedSha256, 'hex').toString('base64')
    )
      throw new ApkVerificationError('APK_CHECKSUM_MISMATCH');
    return latest;
  }
  async download(
    reservation: Reservation,
    versionId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.storage.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: reservation.key,
        VersionId: versionId,
      }),
      { abortSignal: signal },
    );
    if (
      result.VersionId !== versionId ||
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
  async createDownloadGrant(artifact: { key: string; versionId: string }) {
    await this.preflight.assertReady();
    const url = await getSignedUrl(
      this.storage,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: artifact.key,
        VersionId: artifact.versionId,
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
