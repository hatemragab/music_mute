import {
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageClient } from '../infrastructure/storage.module.js';
import type { DownloadGrant, ObjectIdentity } from '../jobs/job.types.js';
import { StoragePreflightService } from './storage-preflight.service.js';

const REQUEST_TIMEOUT_MILLISECONDS = 5_000;
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
    this.grantSeconds = config.getOrThrow<number>('PROCESSING_URL_SECONDS');
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
