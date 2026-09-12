import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageClient } from '../infrastructure/storage.module.js';
import type { UploadGrant } from '../jobs/job.types.js';

interface ImmutableUpload {
  storage: StorageClient;
  bucket: string;
  key: string;
  bytes: number;
  contentType: string;
  checksumSha256: string;
  expiresIn: number;
  expiresAt: Date;
}

/** Signs one exact whole-object create. The conditional header prevents key replay. */
export async function createImmutableUploadGrant(
  input: ImmutableUpload,
): Promise<UploadGrant> {
  const headers = {
    'Content-Type': input.contentType,
    'x-amz-checksum-sha256': input.checksumSha256,
    'If-None-Match': '*',
  } as const;
  const url = await getSignedUrl(
    input.storage,
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentLength: input.bytes,
      ContentType: input.contentType,
      ChecksumSHA256: input.checksumSha256,
      IfNoneMatch: '*',
    }),
    {
      expiresIn: input.expiresIn,
      signableHeaders: new Set([
        'content-type',
        'if-none-match',
        'x-amz-checksum-sha256',
      ]),
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
    },
  );
  return {
    method: 'PUT',
    url,
    headers: { ...headers },
    expiresAt: input.expiresAt.toISOString(),
  };
}
