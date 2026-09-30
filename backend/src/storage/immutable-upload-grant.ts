import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { UploadGrant } from '../jobs/job.types.js';
import { validateObjectReservation } from './object-identity.js';

interface ImmutableUpload {
  storage: S3Client;
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
  validateObjectReservation({
    key: input.key,
    bytes: input.bytes,
    contentType: input.contentType,
    sha256: input.checksumSha256,
  });
  if (
    !Number.isInteger(input.expiresIn) ||
    input.expiresIn < 1 ||
    input.expiresIn > 600 ||
    !Number.isFinite(input.expiresAt.getTime())
  )
    throw new TypeError('Invalid upload expiration');
  const headers: Record<string, string> = {
    'Content-Type': input.contentType,
    'x-amz-checksum-sha256': input.checksumSha256,
    'x-amz-meta-sha256': input.checksumSha256,
    'If-None-Match': '*',
  };
  const url = await getSignedUrl(
    input.storage,
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      ContentLength: input.bytes,
      ContentType: input.contentType,
      ChecksumSHA256: input.checksumSha256,
      Metadata: { sha256: input.checksumSha256 },
      IfNoneMatch: '*',
    }),
    {
      expiresIn: input.expiresIn,
      signableHeaders: new Set([
        'content-type',
        'if-none-match',
        'x-amz-checksum-sha256',
        'x-amz-meta-sha256',
      ]),
      unhoistableHeaders: new Set([
        'x-amz-checksum-sha256',
        'x-amz-meta-sha256',
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
