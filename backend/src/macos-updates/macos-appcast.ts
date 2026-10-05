import { createPublicKey, verify } from 'node:crypto';
import { adminError } from '../admin/admin-errors.js';

export const MAX_MACOS_ARCHIVE_BYTES = 2 * 1024 ** 3;
// Base64 plus command metadata must fit the existing 64 KiB HTTP JSON limit.
export const MAX_APPCAST_BYTES = 32 * 1024;
export const SPARKLE_SIGN_WARNING =
  '<!-- sparkle-sign-warning:\nIMPORTANT: This file was signed by Sparkle. Any modifications to this file requires re-signing this file with generate_appcast or sign_update! The signed signature will be embedded at the end of this file.\n-->';
const versionPattern = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
const buildPattern = /^[1-9]\d{0,17}$/;
export function validPublicEdKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9+/]{43}=$/.test(value) &&
    Buffer.from(value, 'base64').length === 32 &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}
export function macosArchiveName(
  version: string,
  build: string,
  sha256Hex: string,
): string {
  if (
    !versionPattern.test(version) ||
    version.length > 64 ||
    !buildPattern.test(build) ||
    !/^[a-f0-9]{64}$/.test(sha256Hex)
  )
    throw adminError('INVALID_REQUEST');
  return `MusicMute-${version}-${build}-arm64-${sha256Hex}.dmg`;
}
export function isMacosArchiveName(value: string): boolean {
  return (
    /^MusicMute-\d+\.\d+\.\d+(?:\.\d+)?-[1-9]\d{0,17}-arm64-[a-f0-9]{64}\.dmg$/.test(
      value,
    ) && value.length <= 256
  );
}
function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
/** Accept the single-item template produced by prepare-macos-update, without parsing XML entities or external resources. */
export function validateSignedAppcast(input: {
  appcastBase64: string;
  archiveName: string;
  bytes: number;
  sha256Hex: string;
  publicEdKey: string;
  downloadBaseUrl: string;
}) {
  if (
    !validPublicEdKey(input.publicEdKey) ||
    typeof input.appcastBase64 !== 'string' ||
    input.appcastBase64.length > Math.ceil(MAX_APPCAST_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      input.appcastBase64,
    )
  )
    throw adminError('INVALID_REQUEST');
  const bytes = Buffer.from(input.appcastBase64, 'base64');
  if (
    bytes.length > MAX_APPCAST_BYTES ||
    bytes.toString('base64') !== input.appcastBase64
  )
    throw adminError('INVALID_REQUEST');
  const text = bytes.toString('utf8');
  if (!bytes.equals(Buffer.from(text, 'utf8')))
    throw adminError('INVALID_REQUEST');
  const footer =
    /<!-- sparkle-signatures:\nedSignature: ([A-Za-z0-9+/]{86}==)\nlength: ([1-9]\d{0,5})\n-->\n{0,2}$/.exec(
      text,
    );
  if (!footer || text.indexOf('<!-- sparkle-signatures:') !== footer.index)
    throw adminError('INVALID_REQUEST');
  const prefix = Buffer.from(text.slice(0, footer.index), 'utf8');
  const signature = Buffer.from(footer[1], 'base64');
  if (
    Number(footer[2]) !== prefix.length ||
    signature.length !== 64 ||
    signature.toString('base64') !== footer[1]
  )
    throw adminError('INVALID_REQUEST');
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(input.publicEdKey, 'base64'),
    ]),
    format: 'der',
    type: 'spki',
  });
  if (!verify(null, prefix, publicKey, signature))
    throw adminError('INVALID_REQUEST');
  // sign_update 2.10 reserializes the generated XML and inserts a fixed warning.
  // The exact resulting bytes, including this comment, stay signed and stored.
  const xml = prefix.toString('utf8');
  const item =
    /<item><title>MusicMute (\d+\.\d+\.\d+(?:\.\d+)?)<\/title><sparkle:version>([1-9]\d{0,17})<\/sparkle:version>/.exec(
      xml,
    );
  const archiveSignature = /sparkle:edSignature="([A-Za-z0-9+/]{86}==)"/.exec(
    xml,
  )?.[1];
  if (
    !item ||
    !archiveSignature ||
    Buffer.from(archiveSignature, 'base64').toString('base64') !==
      archiveSignature ||
    input.archiveName !== macosArchiveName(item[1], item[2], input.sha256Hex)
  )
    throw adminError('INVALID_REQUEST');
  const url = input.downloadBaseUrl + input.archiveName;
  const expected = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>${SPARKLE_SIGN_WARNING}<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel>\n<title>MusicMute updates</title>\n<item><title>MusicMute ${item[1]}</title><sparkle:version>${item[2]}</sparkle:version><sparkle:shortVersionString>${item[1]}</sparkle:shortVersionString><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements><enclosure url="${xmlEscape(url)}" length="${input.bytes}" type="application/octet-stream" sparkle:edSignature="${archiveSignature}"></enclosure></item>\n</channel></rss>`;
  if (
    xml !== expected ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > MAX_MACOS_ARCHIVE_BYTES
  )
    throw adminError('INVALID_REQUEST');
  return { versionName: item[1], buildNumber: item[2], downloadUrl: url };
}
