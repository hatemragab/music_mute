import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  macosArchiveName,
  SPARKLE_SIGN_WARNING,
  validateSignedAppcast,
} from './macos-appcast.js';

export function signedAppcastFixture() {
  const key = generateKeyPairSync('ed25519');
  const publicEdKey = key.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('base64');
  const sha256Hex = 'a'.repeat(64),
    archiveName = macosArchiveName('1.2.3', '42', sha256Hex),
    downloadBaseUrl = 'https://example.test/macos-updates/artifacts/';
  const archiveSignature = sign(
    null,
    Buffer.from('synthetic archive'),
    key.privateKey,
  ).toString('base64');
  const prefix = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>${SPARKLE_SIGN_WARNING}<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel>\n<title>MusicMute updates</title>\n<item><title>MusicMute 1.2.3</title><sparkle:version>42</sparkle:version><sparkle:shortVersionString>1.2.3</sparkle:shortVersionString><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements><enclosure url="${downloadBaseUrl}${archiveName}" length="42" type="application/octet-stream" sparkle:edSignature="${archiveSignature}"></enclosure></item>\n</channel></rss>`;
  function signed(prefixText: string) {
    const prefixBytes = Buffer.from(prefixText);
    return Buffer.from(
      `${prefixText}<!-- sparkle-signatures:\nedSignature: ${sign(null, prefixBytes, key.privateKey).toString('base64')}\nlength: ${prefixBytes.length}\n-->\n\n`,
    ).toString('base64');
  }
  return {
    input: {
      appcastBase64: signed(prefix),
      archiveName,
      bytes: 42,
      sha256Hex,
      publicEdKey,
      downloadBaseUrl,
    },
    prefix,
    signed,
  };
}

describe('signed macOS appcast boundary', () => {
  it('accepts the exact Sparkle 2.10 reserialized template and binds its immutable filename', () => {
    const { input } = signedAppcastFixture();
    expect(validateSignedAppcast(input)).toEqual({
      versionName: '1.2.3',
      buildNumber: '42',
      downloadUrl: input.downloadBaseUrl + input.archiveName,
    });
  });
  it('rejects modified signed bytes, a foreign key and a false signed prefix length', () => {
    const { input } = signedAppcastFixture(),
      text = Buffer.from(input.appcastBase64, 'base64').toString();
    for (const change of [
      text.replace('1.2.3', '1.2.4'),
      text.replace(/length: \d+/, 'length: 1'),
    ])
      expect(() =>
        validateSignedAppcast({
          ...input,
          appcastBase64: Buffer.from(change).toString('base64'),
        }),
      ).toThrow();
    expect(() =>
      validateSignedAppcast({
        ...input,
        publicEdKey: signedAppcastFixture().input.publicEdKey,
      }),
    ).toThrow();
  });
  it('rejects validly signed foreign hosts, extra items, DTDs, wrong minimum systems and mismatching archive metadata', () => {
    const { input, prefix, signed } = signedAppcastFixture();
    for (const change of [
      prefix.replace('https://example.test', 'https://foreign.test'),
      prefix.replace('</channel>', '<item></item></channel>'),
      prefix.replace(
        '<rss ',
        '<!DOCTYPE rss SYSTEM "https://foreign.test/dtd"><rss ',
      ),
      prefix.replace('>14.0<', '>13.0<'),
      prefix.replace('>arm64<', '>x86_64<'),
      prefix.replace('sparkle:edSignature=', 'sparkle:dsaSignature='),
    ])
      expect(() =>
        validateSignedAppcast({ ...input, appcastBase64: signed(change) }),
      ).toThrow();
    for (const extra of [
      { bytes: 43 },
      { sha256Hex: 'b'.repeat(64) },
      { archiveName: 'MusicMute-1.2.3.dmg' },
    ])
      expect(() => validateSignedAppcast({ ...input, ...extra })).toThrow();
  });
  it('rejects oversized and noncanonical base64 without trusting permissive Buffer decoding', () => {
    const { input } = signedAppcastFixture();
    for (const appcastBase64 of [
      input.appcastBase64 + '\n',
      'a'.repeat(90000),
      Buffer.alloc(32769).toString('base64'),
    ])
      expect(() =>
        validateSignedAppcast({ ...input, appcastBase64 }),
      ).toThrow();
  });
});
