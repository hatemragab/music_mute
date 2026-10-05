import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { StorageClient } from '../infrastructure/storage.module.js';
import { createImmutableUploadGrant } from '../storage/immutable-upload-grant.js';
import {
  confirmedObjectIdentity,
  isStorageEtag,
} from '../storage/object-identity.js';
import { adminError } from '../admin/admin-errors.js';
import type { MacosUpdate } from './macos-update.schema.js';

@Injectable()
export class MacosUpdateStorageService {
  private readonly bucket: string;
  constructor(
    private readonly storage: StorageClient,
    config: ConfigService,
  ) {
    this.bucket = config.getOrThrow<string>('STORAGE_BUCKET');
  }
  async grant(release: Pick<MacosUpdate, 'key' | 'bytes' | 'sha256Hex'>) {
    return createImmutableUploadGrant({
      storage: this.storage,
      bucket: this.bucket,
      key: release.key,
      bytes: release.bytes,
      contentType: 'application/octet-stream',
      checksumSha256: Buffer.from(release.sha256Hex, 'hex').toString('base64'),
      expiresIn: 600,
      expiresAt: new Date(Date.now() + 600_000),
    });
  }
  /** One bounded HEAD and conditional streaming GET. No disk copy or whole-DMG buffer. */
  async verify(
    release: Pick<MacosUpdate, 'key' | 'bytes' | 'sha256Hex'>,
  ): Promise<string> {
    try {
      return await this.verifyBytes(release);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      throw adminError(
        status === 404 || status === 412
          ? 'REVISION_CONFLICT'
          : 'DEPENDENCY_UNAVAILABLE',
      );
    }
  }
  private async verifyBytes(
    release: Pick<MacosUpdate, 'key' | 'bytes' | 'sha256Hex'>,
  ): Promise<string> {
    const reservation = {
      key: release.key,
      bytes: release.bytes,
      sha256: Buffer.from(release.sha256Hex, 'hex').toString('base64'),
      contentType: 'application/octet-stream',
    };
    const head = await this.storage.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: release.key }),
      { abortSignal: AbortSignal.timeout(5000) },
    );
    const identity = confirmedObjectIdentity(reservation, head);
    if (!identity) throw adminError('INVALID_REQUEST');
    const signal = AbortSignal.timeout(600_000);
    const result = await this.storage.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: release.key,
        IfMatch: identity.etag,
      }),
      { abortSignal: signal },
    );
    const stream = result.Body as
      (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
    const abort = () => stream?.destroy?.();
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (
        !stream ||
        result.ETag !== identity.etag ||
        result.ContentLength !== release.bytes ||
        result.ContentType !== 'application/octet-stream'
      )
        throw adminError('INVALID_REQUEST');
      let bytes = 0;
      const hash = createHash('sha256');
      for await (const chunk of stream) {
        signal.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > release.bytes) throw adminError('INVALID_REQUEST');
        hash.update(chunk);
      }
      if (bytes !== release.bytes || hash.digest('hex') !== release.sha256Hex)
        throw adminError('INVALID_REQUEST');
      return identity.etag;
    } finally {
      signal.removeEventListener('abort', abort);
      stream?.destroy?.();
    }
  }
  async download(release: Pick<MacosUpdate, 'key' | 'etag'>) {
    if (!isStorageEtag(release.etag)) throw adminError('RESOURCE_NOT_FOUND');
    // Sparkle cannot supply a pinned If-Match header after following a redirect.
    // The unique create-only key and client-side Ed25519 signature retain identity.
    return getSignedUrl(
      this.storage,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: release.key,
        ResponseCacheControl: 'no-store',
        ResponseContentType: 'application/octet-stream',
      }),
      { expiresIn: 300 },
    );
  }
}
