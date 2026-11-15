import {
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageClient } from '../infrastructure/storage.module.js';
import { jobError } from '../jobs/job-errors.js';
import type {
  AdmissionSnapshot,
  DownloadGrant,
  InputReservation,
  ObjectIdentity,
  UploadGrant,
} from '../jobs/job.types.js';
import { StoragePreflightService } from './storage-preflight.service.js';
import { createImmutableUploadGrant } from './immutable-upload-grant.js';

const REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const MAX_SIGNED_URL_SECONDS = 600;
const MISSING_OBJECT_NAMES = new Set([
  'NotFound',
  'NoSuchKey',
  'NoSuchVersion',
]);

function confirmedMissing(error: unknown): boolean {
  if (!(error instanceof Error) || !MISSING_OBJECT_NAMES.has(error.name))
    return false;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata;
  return metadata?.httpStatusCode === 404;
}

export interface InputTransferJob {
  inputReservation: InputReservation;
  admissionSnapshot?: AdmissionSnapshot | null;
  inputObject: ObjectIdentity | null;
}

type ObjectReservation = Pick<
  InputReservation,
  'key' | 'bytes' | 'sha256' | 'contentType'
>;

@Injectable()
export class StorageTransfersService {
  private readonly bucket: string;
  private readonly grantSeconds: number;

  constructor(
    private readonly storage: StorageClient,
    config: ConfigService,
    private readonly preflight: StoragePreflightService,
  ) {
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.grantSeconds = Math.min(
      MAX_SIGNED_URL_SECONDS,
      config.getOrThrow<number>('PROCESSING_URL_SECONDS'),
    );
  }

  async createInputGrant(
    job: InputTransferJob,
    expiresAt = job.admissionSnapshot?.reservationExpiresAt,
  ): Promise<UploadGrant> {
    return this.createUploadGrant(job.inputReservation, expiresAt);
  }

  async verifyInput(job: InputTransferJob): Promise<ObjectIdentity> {
    const identity = await this.inspect(job.inputReservation);
    if (!identity) throw jobError('UPLOAD_NOT_READY');
    return identity;
  }

  /** Deletes one immutable version only. Missing keys/versions are already reconciled. */
  async deleteExactVersion(key: string, versionId: string): Promise<void> {
    if (!key || !versionId || versionId === 'null')
      throw new TypeError('Invalid exact object identity');
    try {
      await this.storage.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
          VersionId: versionId,
        }),
        { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS) },
      );
    } catch (error) {
      if (!confirmedMissing(error)) throw error;
    }
  }

  /** A bounded sweep of versions for one exact reservation key, never a prefix delete. */
  async deleteVersionsForKey(key: string): Promise<boolean> {
    return (await this.sweepVersionsForKey(key)).complete;
  }

  /** Also reports whether anything was removed so durable cleanup can prove a final empty pass. */
  async sweepVersionsForKey(
    key: string,
  ): Promise<{ complete: boolean; deleted: number }> {
    const page = await this.storage.send(
      new ListObjectVersionsCommand({
        Bucket: this.bucket,
        Prefix: key,
        MaxKeys: 100,
      }),
      { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS) },
    );
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
      .filter((entry) => entry.Key === key && entry.VersionId)
      .map((entry) => ({ Key: key, VersionId: entry.VersionId! }));
    if (objects.length) {
      const result = await this.storage.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
        { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS) },
      );
      if (
        result.Errors?.some(
          (error) => !['NoSuchKey', 'NoSuchVersion'].includes(error.Code ?? ''),
        )
      )
        throw new Error('Artifact cleanup unavailable');
    }
    // S3 orders by key: once the next page starts at a longer sibling key,
    // all versions of our exact key have been visited. Never delete siblings.
    return {
      complete:
        !page.IsTruncated ||
        (page.NextKeyMarker !== undefined && page.NextKeyMarker !== key),
      deleted: objects.length,
    };
  }

  async createDownloadGrant(
    object: ObjectIdentity,
    fixedExpiry?: Date,
  ): Promise<DownloadGrant> {
    const expiresIn = fixedExpiry
      ? Math.min(
          this.grantSeconds,
          Math.floor((fixedExpiry.getTime() - Date.now()) / 1_000),
        )
      : this.grantSeconds;
    if (expiresIn < 1) throw jobError('DOWNLOAD_RESERVATION_EXPIRED');
    return this.signDownload(object, expiresIn);
  }

  async createWorkerOutputGrant(
    reservation: ObjectReservation,
    deadlineAt: Date,
  ): Promise<UploadGrant> {
    return this.createUploadGrant(
      reservation,
      deadlineAt,
      'INTELLIGENT_TIERING',
    );
  }

  async createWorkerInstallationUploadGrant(
    reservation: ObjectReservation,
    deadlineAt: Date,
  ): Promise<UploadGrant> {
    return this.createUploadGrant(reservation, deadlineAt);
  }

  async verifyUploadedVersion(
    reservation: ObjectReservation,
    versionId: string,
  ): Promise<ObjectIdentity> {
    if (!versionId || versionId === 'null') throw jobError('UPLOAD_NOT_READY');
    let pinned: HeadObjectCommandOutput;
    try {
      pinned = await this.head(reservation.key, versionId);
    } catch (error) {
      if (confirmedMissing(error)) throw jobError('UPLOAD_NOT_READY');
      throw error;
    }
    if (
      pinned.VersionId !== versionId ||
      pinned.ContentLength !== reservation.bytes ||
      pinned.ContentType !== reservation.contentType ||
      pinned.ChecksumSHA256 !== reservation.sha256
    )
      throw jobError('UPLOAD_NOT_READY');
    return {
      key: reservation.key,
      versionId,
      bytes: reservation.bytes,
      sha256: reservation.sha256,
      contentType: reservation.contentType,
    };
  }

  /** Recovers the immutable version after a successful PUT response was lost. */
  async findUploadedVersion(
    reservation: ObjectReservation,
  ): Promise<ObjectIdentity | null> {
    return this.inspect(reservation);
  }

  async isPinnedObjectAvailable(object: ObjectIdentity): Promise<boolean> {
    if (!object.versionId || object.versionId === 'null') return false;
    try {
      const pinned = await this.head(object.key, object.versionId);
      return (
        pinned.VersionId === object.versionId &&
        pinned.ContentLength === object.bytes &&
        pinned.ContentType === object.contentType &&
        pinned.ChecksumSHA256 === object.sha256
      );
    } catch (error) {
      if (confirmedMissing(error)) return false;
      throw error;
    }
  }

  async createMediaGrant(
    object: ObjectIdentity,
    purpose: 'play' | 'download',
    filename: string,
  ): Promise<DownloadGrant> {
    if (
      !/^[a-zA-Z0-9._-]{1,120}$/.test(filename) ||
      !object.versionId ||
      object.versionId === 'null'
    )
      throw new TypeError('Invalid media grant');
    return this.signDownload(object, 300, {
      contentType: object.contentType,
      disposition: `${purpose === 'play' ? 'inline' : 'attachment'}; filename="${filename}"`,
    });
  }

  private async signDownload(
    object: ObjectIdentity,
    expiresIn: number,
    response?: { contentType: string; disposition: string },
  ): Promise<DownloadGrant> {
    await this.preflight.assertReady();
    const now = Date.now();
    const url = await getSignedUrl(
      this.storage,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: object.key,
        VersionId: object.versionId,
        ResponseCacheControl: 'no-store',
        ...(response
          ? {
              ResponseContentType: response.contentType,
              ResponseContentDisposition: response.disposition,
            }
          : {}),
      }),
      { expiresIn },
    );
    return {
      url,
      expiresAt: new Date(now + expiresIn * 1_000).toISOString(),
    };
  }

  private async createUploadGrant(
    reservation: ObjectReservation,
    fixedExpiry?: Date,
    storageClass?: 'INTELLIGENT_TIERING',
  ): Promise<UploadGrant> {
    await this.preflight.assertReady();
    const now = Date.now();
    const expiresIn = fixedExpiry
      ? Math.min(
          this.grantSeconds,
          Math.floor((fixedExpiry.getTime() - now) / 1000),
        )
      : this.grantSeconds;
    if (expiresIn < 1) throw jobError('UPLOAD_RESERVATION_EXPIRED');
    return createImmutableUploadGrant({
      storage: this.storage,
      bucket: this.bucket,
      key: reservation.key,
      bytes: reservation.bytes,
      contentType: reservation.contentType,
      checksumSha256: reservation.sha256,
      storageClass,
      expiresIn,
      expiresAt: new Date(now + expiresIn * 1000),
    });
  }

  private async inspect(
    reservation: ObjectReservation,
  ): Promise<ObjectIdentity | null> {
    let latest: HeadObjectCommandOutput;
    try {
      latest = await this.head(reservation.key);
    } catch (error) {
      if (confirmedMissing(error)) return null;
      throw error;
    }
    if (!latest.VersionId || latest.VersionId === 'null')
      throw jobError('UPLOAD_NOT_READY');

    let pinned: HeadObjectCommandOutput;
    try {
      pinned = await this.head(reservation.key, latest.VersionId);
    } catch (error) {
      if (confirmedMissing(error)) return null;
      throw error;
    }
    if (
      pinned.VersionId !== latest.VersionId ||
      pinned.ContentLength !== reservation.bytes ||
      pinned.ContentType !== reservation.contentType ||
      pinned.ChecksumSHA256 !== reservation.sha256
    )
      throw jobError('UPLOAD_NOT_READY');
    return {
      key: reservation.key,
      versionId: latest.VersionId,
      bytes: reservation.bytes,
      sha256: reservation.sha256,
      contentType: reservation.contentType,
    };
  }

  private head(
    key: string,
    versionId?: string,
  ): Promise<HeadObjectCommandOutput> {
    return this.storage.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(versionId ? { VersionId: versionId } : {}),
        ChecksumMode: 'ENABLED',
      }),
      { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS) },
    );
  }
}
