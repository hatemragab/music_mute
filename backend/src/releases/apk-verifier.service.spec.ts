import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseApkMetadata, validateApkZip } from './apk-verifier.service.js';

const signer = 'a'.repeat(64);
const expected = {
  packageId: 'com.example.fixture',
  versionName: '1.0',
  buildNumber: 10,
  maximumMinimumSdk: 26,
  trustedSigners: [signer],
};
const badging =
  "package: name='com.example.fixture' versionCode='10' versionName='1.0'\nsdkVersion:'26'\n";
const certificate = `Signer #1 certificate SHA-256 digest: ${signer}\n`;

describe('APK identity verification', () => {
  it('extracts only a matching non-debug package and trusted signer', () => {
    expect(parseApkMetadata(badging, certificate, expected)).toEqual({
      packageId: expected.packageId,
      minimumSdk: 26,
      signerSha256Hex: signer,
    });
  });
  it.each([
    [badging.replace('com.example.fixture', 'com.attacker.app'), certificate],
    [badging.replace("versionCode='10'", "versionCode='11'"), certificate],
    [badging.replace("versionName='1.0'", "versionName='2.0'"), certificate],
    [badging.replace("sdkVersion:'26'", "sdkVersion:'27'"), certificate],
    [badging + 'application-debuggable\n', certificate],
    [badging, certificate.replace(signer, 'b'.repeat(64))],
    [badging, ''],
    [
      badging,
      certificate + `Signer #2 certificate SHA-256 digest: ${signer}\n`,
    ],
  ])(
    'rejects incompatible identity or signature metadata',
    (manifest, cert) => {
      expect(() => parseApkMetadata(manifest, cert, expected)).toThrow();
    },
  );
  it('rejects truncated archives before running Android tools', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'apk-truncated-fixture-'));
    try {
      const path = join(directory, 'truncated.apk');
      await writeFile(path, Buffer.from('PK'));
      await expect(validateApkZip(path)).rejects.toMatchObject({
        code: 'APK_INVALID',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
