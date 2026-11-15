import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import {
  ApkVerifierService,
  validateApkZip,
  runApkTool,
} from '../dist/releases/apk-verifier.service.js';

const exec = promisify(execFile);
const sdk = process.env.ANDROID_HOME ?? join(homedir(), 'Library/Android/sdk');
const aapt =
  process.env.TEST_APK_AAPT2_PATH ?? join(sdk, 'build-tools/35.0.0/aapt2');
const signer =
  process.env.TEST_APK_APKSIGNER_PATH ??
  join(sdk, 'build-tools/35.0.0/apksigner');
const androidJar =
  process.env.TEST_ANDROID_JAR ?? join(sdk, 'platforms/android-35/android.jar');
const packageId = 'com.example.musicmute.fixture';

test(
  'native Android tools verify a synthetic signed APK and reject tampering, unsigned data, wrong identity and signer',
  { timeout: 60000 },
  async (t) => {
    try {
      await Promise.all([access(aapt), access(signer), access(androidJar)]);
      await exec('keytool', ['-help']);
    } catch {
      t.skip(
        'Android aapt2/apksigner/android.jar and Java keytool are required; no native verifier proof',
      );
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), 'musicmute-signed-apk-fixture-'));
    try {
      const manifest = join(dir, 'AndroidManifest.xml'),
        unsigned = join(dir, 'unsigned.apk'),
        signed = join(dir, 'signed.apk');
      await writeFile(
        manifest,
        `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${packageId}" android:versionCode="10" android:versionName="1.0"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="35"/><application android:label="Synthetic verification fixture" android:debuggable="false"/></manifest>`,
      );
      await exec(
        aapt,
        ['link', '-o', unsigned, '--manifest', manifest, '-I', androidJar],
        { timeout: 10000 },
      );
      await exec(
        'keytool',
        [
          '-genkeypair',
          '-keystore',
          join(dir, 'fixture.p12'),
          '-storetype',
          'PKCS12',
          '-storepass',
          'synthetic-fixture-only',
          '-keypass',
          'synthetic-fixture-only',
          '-alias',
          'fixture',
          '-keyalg',
          'RSA',
          '-keysize',
          '2048',
          '-validity',
          '1',
          '-dname',
          'CN=Synthetic Test',
        ],
        { timeout: 20000 },
      );
      await exec(
        signer,
        [
          'sign',
          '--ks',
          join(dir, 'fixture.p12'),
          '--ks-pass',
          'pass:synthetic-fixture-only',
          '--out',
          signed,
          unsigned,
        ],
        { timeout: 10000 },
      );
      const certificate = (
        await exec(signer, ['verify', '--print-certs', signed])
      ).stdout;
      const fingerprint =
        /Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})/.exec(
          certificate,
        )?.[1];
      assert.ok(fingerprint);
      const config = {
        APK_AAPT2_PATH: aapt,
        APK_APKSIGNER_PATH: signer,
        APK_EXPECTED_PACKAGE_ID: packageId,
        APK_TRUSTED_SIGNER_SHA256: fingerprint,
        APK_MAX_MIN_SDK: 26,
      };
      const bytes = await readFile(signed);
      let temporaryPath;
      const input = {
        bytes: bytes.length,
        sha256Hex: createHash('sha256').update(bytes).digest('hex'),
        versionName: '1.0',
        buildNumber: 10,
        download: async (path) => {
          temporaryPath = path;
          await copyFile(signed, path);
        },
      };
      const verify = () =>
        new ApkVerifierService(new ConfigService(config)).verify(input);
      assert.deepEqual(await verify(), {
        packageId,
        minimumSdk: 26,
        signerSha256Hex: fingerprint,
      });
      await assert.rejects(access(temporaryPath));
      // aapt2 badging omits versionCodeMajor; the actual long build must still be rejected.
      const majorUnsigned = join(dir, 'major-unsigned.apk'),
        majorSigned = join(dir, 'major-signed.apk');
      const originalManifest = await readFile(manifest, 'utf8');
      await writeFile(
        manifest,
        originalManifest.replace(
          'android:versionCode="10"',
          'android:versionCode="10" android:versionCodeMajor="1"',
        ),
      );
      await exec(
        aapt,
        ['link', '-o', majorUnsigned, '--manifest', manifest, '-I', androidJar],
        { timeout: 10000 },
      );
      await exec(
        signer,
        [
          'sign',
          '--ks',
          join(dir, 'fixture.p12'),
          '--ks-pass',
          'pass:synthetic-fixture-only',
          '--out',
          majorSigned,
          majorUnsigned,
        ],
        { timeout: 10000 },
      );
      const majorBytes = await readFile(majorSigned);
      await assert.rejects(
        new ApkVerifierService(new ConfigService(config)).verify({
          ...input,
          bytes: majorBytes.length,
          sha256Hex: createHash('sha256').update(majorBytes).digest('hex'),
          download: (path) => copyFile(majorSigned, path),
        }),
        (error) => error.code === 'APK_IDENTITY_MISMATCH',
      );
      for (const patch of [
        { APK_EXPECTED_PACKAGE_ID: 'com.example.wrong' },
        { APK_TRUSTED_SIGNER_SHA256: 'b'.repeat(64) },
        { APK_MAX_MIN_SDK: 25 },
      ]) {
        await assert.rejects(
          new ApkVerifierService(
            new ConfigService({ ...config, ...patch }),
          ).verify(input),
        );
      }
      for (const patch of [
        { sha256Hex: 'c'.repeat(64) },
        { bytes: bytes.length + 1 },
        { versionName: '2.0' },
        { buildNumber: 11 },
      ])
        await assert.rejects(
          new ApkVerifierService(new ConfigService(config)).verify({
            ...input,
            ...patch,
          }),
        );
      const unsignedBytes = await readFile(unsigned);
      await assert.rejects(
        new ApkVerifierService(new ConfigService(config)).verify({
          ...input,
          bytes: unsignedBytes.length,
          sha256Hex: createHash('sha256').update(unsignedBytes).digest('hex'),
          download: (path) => copyFile(unsigned, path),
        }),
      );
      const tampered = Buffer.from(bytes);
      tampered[100] ^= 1;
      await assert.rejects(
        new ApkVerifierService(new ConfigService(config)).verify({
          ...input,
          sha256Hex: createHash('sha256').update(tampered).digest('hex'),
          download: (path) => writeFile(path, tampered),
        }),
      );
      const malformed = join(dir, 'malformed.apk');
      await writeFile(malformed, Buffer.from('not a ZIP'));
      await assert.rejects(validateApkZip(malformed));
      await assert.rejects(
        new ApkVerifierService(
          new ConfigService({
            ...config,
            APK_AAPT2_PATH: '/missing-fixture/aapt2',
          }),
        ).verify(input),
        (error) => error.code === 'APK_VERIFIER_UNAVAILABLE',
      );
      await assert.rejects(access(temporaryPath));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25);
      try {
        await assert.rejects(
          new ApkVerifierService(new ConfigService(config)).verify({
            ...input,
            signal: controller.signal,
            download: async (path, signal) => {
              temporaryPath = path;
              await writeFile(path, Buffer.alloc(1));
              await new Promise((_, reject) =>
                signal.addEventListener(
                  'abort',
                  () => reject(new Error('cancelled')),
                  { once: true },
                ),
              );
            },
          }),
          (error) => error.code === 'APK_VERIFICATION_TIMEOUT',
        );
      } finally {
        clearTimeout(timeout);
      }
      await assert.rejects(access(temporaryPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'verifier tool output and runtime are bounded without a shell',
  { timeout: 5000 },
  async () => {
    await assert.rejects(
      runApkTool(
        process.execPath,
        ['-e', 'process.stdout.write(Buffer.alloc(1048577));'],
        tmpdir(),
        AbortSignal.timeout(2000),
      ),
      (error) => error.code === 'APK_INVALID',
    );
    await assert.rejects(
      runApkTool(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000);'],
        tmpdir(),
        AbortSignal.timeout(50),
      ),
      (error) => error.code === 'APK_VERIFICATION_TIMEOUT',
    );
  },
);
