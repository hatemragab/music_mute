import type { HeadObjectCommandOutput } from '@aws-sdk/client-s3';
import type { ObjectIdentity } from '../jobs/job.types.js';

export function isStorageEtag(value: unknown): value is string {
  return typeof value === 'string' && /^"[\x21\x23-\x7e]{1,1022}"$/.test(value);
}

export function validateStorageKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.length < 1 ||
    key.length > 1024 ||
    key.includes('..') ||
    key.includes('//') ||
    !/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(key)
  )
    throw new TypeError('Invalid storage key');
}

export function validateObjectReservation(
  object: Omit<ObjectIdentity, 'etag'>,
): void {
  validateStorageKey(object.key);
  if (
    !Number.isSafeInteger(object.bytes) ||
    object.bytes < 1 ||
    !/^[A-Za-z0-9+/]{43}=$/.test(object.sha256) ||
    Buffer.from(object.sha256, 'base64').toString('base64') !== object.sha256 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(object.contentType)
  )
    throw new TypeError('Invalid storage reservation');
}

/**
 * Only the backend holds storage credentials. Every application write signs
 * both the R2-validated SHA256 checksum and identical immutable metadata.
 * The metadata supplies the digest when R2 HEAD omits ChecksumSHA256; it is
 * never a substitute for signing/validating the checksum on the PUT itself.
 */
export function confirmedObjectIdentity(
  reservation: Omit<ObjectIdentity, 'etag'>,
  head: HeadObjectCommandOutput,
): ObjectIdentity | null {
  validateObjectReservation(reservation);
  if (
    !isStorageEtag(head.ETag) ||
    head.ContentLength !== reservation.bytes ||
    head.ContentType !== reservation.contentType ||
    head.Metadata?.sha256 !== reservation.sha256 ||
    (head.ChecksumSHA256 !== undefined &&
      head.ChecksumSHA256 !== reservation.sha256)
  )
    return null;
  return {
    key: reservation.key,
    etag: head.ETag,
    bytes: reservation.bytes,
    sha256: reservation.sha256,
    contentType: reservation.contentType,
  };
}
