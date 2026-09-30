import {
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
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
import {
  confirmedObjectIdentity,
  isStorageEtag,
  validateObjectReservation,
  validateStorageKey,
} from './object-identity.js';

const REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const MAX_SIGNED_URL_SECONDS = 600;
function confirmedMissing(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    !['NotFound', 'NoSuchKey'].includes(error.name)
  )
    return false;
  return (
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode === 404
  );
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
    this.bucket = config.getOrThrow<string>('STORAGE_BUCKET');
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
    const identity = await this.findUploadedObject(job.inputReservation);
    if (!identity) throw jobError('UPLOAD_NOT_READY');
    return identity;
  }
  /** Unique keys are deleted only after all upload grants and transfers settle. */
  async deleteObject(key: string): Promise<void> {
    validateStorageKey(key);
    try {
      await this.storage.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS) },
      );
      this.preflight.recordSuccess?.();
    } catch (error) {
      if (!confirmedMissing(error)) {
        this.preflight.recordFailure?.();
        throw error;
      }
      this.preflight.recordSuccess?.();
    }
  }
  async createDownloadGrant(
    object: ObjectIdentity,
    fixedExpiry?: Date,
  ): Promise<DownloadGrant> {
    const expiresIn = this.expiration(fixedExpiry);
    if (!Number.isFinite(expiresIn) || expiresIn < 1)
      throw jobError('DOWNLOAD_RESERVATION_EXPIRED');
    return this.signDownload(object, expiresIn);
  }
  async createWorkerOutputGrant(
    reservation: ObjectReservation,
    deadlineAt: Date,
  ): Promise<UploadGrant> {
    return this.createUploadGrant(reservation, deadlineAt);
  }
  async createWorkerInstallationUploadGrant(
    reservation: ObjectReservation,
    deadlineAt: Date,
  ): Promise<UploadGrant> {
    return this.createUploadGrant(reservation, deadlineAt);
  }
  async verifyUploadedObject(
    reservation: ObjectReservation,
    etag: string,
  ): Promise<ObjectIdentity> {
    if (!isStorageEtag(etag)) throw jobError('UPLOAD_NOT_READY');
    const object = await this.findUploadedObject(reservation, etag);
    if (!object || object.etag !== etag) throw jobError('UPLOAD_NOT_READY');
    return object;
  }
  /** One HEAD recovers a successful upload whose response was lost. */
  async findUploadedObject(
    reservation: ObjectReservation,
    etag?: string,
  ): Promise<ObjectIdentity | null> {
    validateObjectReservation(reservation);
    if (etag !== undefined && !isStorageEtag(etag))
      throw jobError('UPLOAD_NOT_READY');
    let head;
    try {
      head = await this.storage.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: reservation.key,
          ...(etag ? { IfMatch: etag } : {}),
        }),
        { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS) },
      );
      this.preflight.recordSuccess?.();
    } catch (error) {
      if (confirmedMissing(error)) {
        this.preflight.recordSuccess?.();
        return null;
      }
      this.preflight.recordFailure?.();
      throw error;
    }
    const object = confirmedObjectIdentity(reservation, head);
    if (!object || (etag !== undefined && object.etag !== etag))
      throw jobError('UPLOAD_NOT_READY');
    return object;
  }
  async isObjectAvailable(object: ObjectIdentity): Promise<boolean> {
    if (!isStorageEtag(object.etag)) return false;
    const found = await this.findUploadedObject(object, object.etag);
    return found !== null;
  }
  async createMediaGrant(
    object: ObjectIdentity,
    purpose: 'play' | 'download',
    filename: string,
  ): Promise<DownloadGrant> {
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(filename))
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
    validateObjectReservation(object);
    if (!isStorageEtag(object.etag))
      throw new TypeError('Invalid storage identity');
    // Keys are unique and conditional PUTs cannot overwrite them. Signing is local;
    // authorization and database identity checks happen before this call.
    const now = Date.now();
    const url = await getSignedUrl(
      this.storage,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: object.key,
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
    return { url, expiresAt: new Date(now + expiresIn * 1_000).toISOString() };
  }
  private expiration(fixedExpiry?: Date): number {
    return fixedExpiry
      ? Math.min(
          this.grantSeconds,
          Math.floor((fixedExpiry.getTime() - Date.now()) / 1_000),
        )
      : this.grantSeconds;
  }
  private async createUploadGrant(
    reservation: ObjectReservation,
    fixedExpiry?: Date,
  ): Promise<UploadGrant> {
    const expiresIn = this.expiration(fixedExpiry);
    if (!Number.isFinite(expiresIn) || expiresIn < 1)
      throw jobError('UPLOAD_RESERVATION_EXPIRED');
    return createImmutableUploadGrant({
      storage: this.storage,
      bucket: this.bucket,
      key: reservation.key,
      bytes: reservation.bytes,
      contentType: reservation.contentType,
      checksumSha256: reservation.sha256,
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1_000),
    });
  }
}
