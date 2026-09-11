import {
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageClient } from '../infrastructure/storage.module.js';
import { jobError } from '../jobs/job-errors.js';
import type {
  DownloadGrant,
  AdmissionSnapshot,
  InputReservation,
  ObjectIdentity,
  OutputReservation,
  UploadGrant,
} from '../jobs/job.types.js';
import { StoragePreflightService } from './storage-preflight.service.js';

const REQUEST_TIMEOUT_MILLISECONDS = 5_000;
const MISSING_OBJECT_NAMES = new Set([
  'NotFound',
  'NoSuchKey',
  'NoSuchVersion',
]);

export interface TransferJob {
  inputReservation: InputReservation;
  admissionSnapshot?: AdmissionSnapshot | null;
  inputObject: ObjectIdentity | null;
  outputReservation: OutputReservation | null;
  outputObject: ObjectIdentity | null;
}

type ObjectReservation = Pick<
  InputReservation | OutputReservation,
  'key' | 'bytes' | 'sha256' | 'contentType'
>;

function confirmedMissing(error: unknown): boolean {
  if (!(error instanceof Error) || !MISSING_OBJECT_NAMES.has(error.name))
    return false;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata;
  return metadata?.httpStatusCode === 404;
}

@Injectable()
export class StorageTransfersService {
  private readonly bucket: string;
  private readonly grantSeconds: number;
  private readonly outputMaxBytes: number;

  constructor(
    private readonly storage: StorageClient,
    config: ConfigService,
    private readonly preflight: StoragePreflightService,
  ) {
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.grantSeconds = config.getOrThrow<number>('PROCESSING_URL_SECONDS');
    this.outputMaxBytes = config.getOrThrow<number>(
      'PROCESSING_OUTPUT_MAX_BYTES',
    );
  }

  async createInputGrant(job: TransferJob): Promise<UploadGrant> {
    return this.createUploadGrant(
      job.inputReservation,
      job.admissionSnapshot?.reservationExpiresAt,
    );
  }

  /** A bounded sweep of versions for one exact reservation key, never a prefix delete. */
  async deleteVersionsForKey(key: string): Promise<boolean> {
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
    return (
      !page.IsTruncated ||
      (page.NextKeyMarker !== undefined && page.NextKeyMarker !== key)
    );
  }

  async verifyInput(job: TransferJob): Promise<ObjectIdentity> {
    const identity = await this.inspect(job.inputReservation, false);
    if (!identity) throw jobError('UPLOAD_NOT_READY');
    return identity;
  }

  async createOutputGrant(job: TransferJob): Promise<UploadGrant> {
    const reservation = this.outputReservation(job);
    if (
      !Number.isInteger(reservation.bytes) ||
      reservation.bytes < 1 ||
      reservation.bytes >= this.outputMaxBytes ||
      reservation.contentType !== 'audio/mpeg'
    ) {
      throw new TypeError('Invalid output reservation');
    }
    return this.createUploadGrant(reservation);
  }

  async verifyOutput(job: TransferJob): Promise<ObjectIdentity> {
    const identity = await this.inspect(this.outputReservation(job), false);
    if (!identity) throw jobError('UPLOAD_NOT_READY');
    return identity;
  }

  async findOutput(job: TransferJob): Promise<ObjectIdentity | null> {
    return this.inspect(this.outputReservation(job), true);
  }

  async createDownloadGrant(object: ObjectIdentity): Promise<DownloadGrant> {
    return this.signDownload(object, this.grantSeconds);
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

  private outputReservation(job: TransferJob): OutputReservation {
    if (!job.outputReservation)
      throw new TypeError('Output reservation is required');
    return job.outputReservation;
  }

  private async createUploadGrant(
    reservation: ObjectReservation,
    fixedExpiry?: Date,
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
    const fields = {
      key: reservation.key,
      'Content-Type': reservation.contentType,
      'x-amz-checksum-algorithm': 'SHA256',
      'x-amz-checksum-sha256': reservation.sha256,
    };
    const signed = await createPresignedPost(this.storage, {
      Bucket: this.bucket,
      Key: reservation.key,
      Expires: expiresIn,
      Fields: fields,
      Conditions: [
        { key: reservation.key },
        { 'Content-Type': reservation.contentType },
        { 'x-amz-checksum-algorithm': 'SHA256' },
        { 'x-amz-checksum-sha256': reservation.sha256 },
        ['content-length-range', reservation.bytes, reservation.bytes],
      ],
    });
    return {
      ...signed,
      expiresAt: new Date(now + expiresIn * 1_000).toISOString(),
    };
  }

  private async inspect(
    reservation: ObjectReservation,
    missingAsNull: boolean,
  ): Promise<ObjectIdentity | null> {
    let latest: HeadObjectCommandOutput;
    try {
      latest = await this.head(reservation.key);
    } catch (error) {
      if (confirmedMissing(error)) {
        if (missingAsNull) return null;
        throw jobError('UPLOAD_NOT_READY');
      }
      throw error;
    }
    if (!latest.VersionId || latest.VersionId === 'null') {
      throw jobError('UPLOAD_NOT_READY');
    }

    let pinned: HeadObjectCommandOutput;
    try {
      pinned = await this.head(reservation.key, latest.VersionId);
    } catch (error) {
      if (confirmedMissing(error)) {
        if (missingAsNull) return null;
        throw jobError('UPLOAD_NOT_READY');
      }
      throw error;
    }

    if (
      pinned.VersionId !== latest.VersionId ||
      pinned.ContentLength !== reservation.bytes ||
      pinned.ContentType !== reservation.contentType ||
      pinned.ChecksumSHA256 !== reservation.sha256
    ) {
      throw jobError('UPLOAD_NOT_READY');
    }
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
