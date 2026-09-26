import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { UploadGrant } from '../jobs/job.types.js';

interface ImmutableUpload {
  storage: S3Client;
  bucket: string;
  key: string;
  bytes: number;
  contentType: string;
  checksumSha256: string;
  storageClass?: 'INTELLIGENT_TIERING';
  expiresIn: number;
  expiresAt: Date;
}

/** Signs one exact whole-object create. The conditional header prevents key replay. */
export async function createImmutableUploadGrant(
  input: ImmutableUpload,
): Promise<UploadGrant> {
  const headers: Record<string, string> = {
    'Content-Type': input.contentType,
    'x-amz-checksum-sha256': input.checksumSha256,
    'If-None-Match': '*',
  };
  if (input.storageClass) headers['x-amz-storage-class'] = input.storageClass;
  const url = await getSignedUrl(
    input.storage,
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentLength: input.bytes,
      ContentType: input.contentType,
      ChecksumSHA256: input.checksumSha256,
      IfNoneMatch: '*',
      StorageClass: input.storageClass,
    }),
    {
      expiresIn: input.expiresIn,
      signableHeaders: new Set([
        'content-type',
        'if-none-match',
        'x-amz-checksum-sha256',
        ...(input.storageClass ? ['x-amz-storage-class'] : []),
      ]),
      unhoistableHeaders: new Set([
        'x-amz-checksum-sha256',
        ...(input.storageClass ? ['x-amz-storage-class'] : []),
      ]),
    },
  );
  return {
    method: 'PUT',
    url,
    headers,
    expiresAt: input.expiresAt.toISOString(),
  };
}
