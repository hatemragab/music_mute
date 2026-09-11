import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ApkRejectionCode } from './apk-verification-errors.js';

export const APK_MAX_BYTES = 268435456;
export const APK_VERIFICATION_MS = 90000;
export class ApkVerificationError extends Error {
  constructor(readonly code: ApkRejectionCode) {
    super(code);
  }
}
function reject(code: ApkRejectionCode = 'APK_INVALID'): never {
  throw new ApkVerificationError(code);
}
interface ExpectedIdentity {
  packageId: string;
  versionName: string;
  buildNumber: number;
  maximumMinimumSdk: number;
  trustedSigners: readonly string[];
}
export interface ApkMetadata {
  packageId: string;
  minimumSdk: number;
  signerSha256Hex: string;
}

export function parseApkMetadata(
  badging: string,
  certificate: string,
  expected: ExpectedIdentity,
): ApkMetadata {
  const packages = [
    ...badging.matchAll(
      /^package: name='([^'\r\n]+)' versionCode='(\d+)' versionName='([^'\r\n]*)'/gm,
    ),
  ];
  const sdks = [
    ...badging.matchAll(/^(?:minSdkVersion|sdkVersion):'(\d+)'\r?$/gm),
  ];
  const signers = [
    ...certificate.matchAll(
      /^Signer #(\d+) certificate SHA-256 digest: ([a-fA-F0-9]{64})\r?$/gm,
    ),
  ];
  if (
    packages.length !== 1 ||
    sdks.length !== 1 ||
    /^application-debuggable(?:\s|$)/m.test(badging)
  )
    reject('APK_IDENTITY_MISMATCH');
  const info = packages[0]!;
  const minimumSdk = Number(sdks[0]![1]);
  if (
    info[1] !== expected.packageId ||
    Number(info[2]) !== expected.buildNumber ||
    info[3] !== expected.versionName ||
    !Number.isInteger(minimumSdk) ||
    minimumSdk < 1 ||
    minimumSdk > expected.maximumMinimumSdk
  )
    reject('APK_IDENTITY_MISMATCH');
  if (
    signers.length !== 1 ||
    signers[0]![1] !== '1' ||
    !expected.trustedSigners.includes(signers[0]![2]!.toLowerCase())
  )
    reject('APK_SIGNER_UNTRUSTED');
  return {
    packageId: info[1]!,
    minimumSdk,
    signerSha256Hex: signers[0]![2]!.toLowerCase(),
  };
}

/** Inspect the central directory without extracting attacker-controlled paths or inflated bytes. */
export async function validateApkZip(
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    if (size < 22 || size > APK_MAX_BYTES) reject();
    const tail = Buffer.alloc(Math.min(size, 65557));
    await file.read(tail, 0, tail.length, size - tail.length);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (
        tail.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + tail.readUInt16LE(i + 20) === tail.length
      ) {
        end = i;
        break;
      }
    if (end < 0) reject();
    const entries = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (
      tail.readUInt16LE(end + 4) !== 0 ||
      tail.readUInt16LE(end + 6) !== 0 ||
      tail.readUInt16LE(end + 8) !== entries ||
      entries < 1 ||
      entries > 20000 ||
      length > 16 * 1024 * 1024 ||
      offset + length !== size - tail.length + end
    )
      reject();
    const directory = Buffer.alloc(length);
    if ((await file.read(directory, 0, length, offset)).bytesRead !== length)
      reject();
    let cursor = 0,
      inflated = 0,
      manifests = 0;
    const names = new Set<string>();
    const ranges: { start: number; end: number }[] = [];
    for (let index = 0; index < entries; index++) {
      if (signal?.aborted) reject('APK_VERIFICATION_TIMEOUT');
      if (cursor + 46 > length || directory.readUInt32LE(cursor) !== 0x02014b50)
        reject();
      const flags = directory.readUInt16LE(cursor + 8),
        method = directory.readUInt16LE(cursor + 10);
      const compressed = directory.readUInt32LE(cursor + 20),
        uncompressed = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28),
        extra = directory.readUInt16LE(cursor + 30),
        comment = directory.readUInt16LE(cursor + 32);
      const start = directory.readUInt32LE(cursor + 42);
      if (
        (flags & 1) !== 0 ||
        ![0, 8].includes(method) ||
        nameLength < 1 ||
        nameLength > 1024 ||
        cursor + 46 + nameLength + extra + comment > length ||
        directory.readUInt16LE(cursor + 34) !== 0 ||
        start + 30 > offset ||
        compressed === 0xffffffff ||
        uncompressed === 0xffffffff
      )
        reject();
      const name = directory
        .subarray(cursor + 46, cursor + 46 + nameLength)
        .toString('utf8');
      if (
        names.has(name) ||
        name.startsWith('/') ||
        name.includes('\\') ||
        name.includes('\0') ||
        name.split('/').includes('..')
      )
        reject();
      names.add(name);
      inflated += uncompressed;
      if (
        inflated > 1024 * 1024 * 1024 ||
        uncompressed > 512 * 1024 * 1024 ||
        (uncompressed > 1024 * 1024 &&
          uncompressed > Math.max(1, compressed) * 200)
      )
        reject();
      if (name === 'AndroidManifest.xml') {
        manifests++;
        if (uncompressed > 4 * 1024 * 1024) reject();
      }
      const header = Buffer.alloc(30);
      if (
        (await file.read(header, 0, 30, start)).bytesRead !== 30 ||
        header.readUInt32LE(0) !== 0x04034b50 ||
        header.readUInt16LE(6) !== flags ||
        header.readUInt16LE(8) !== method ||
        header.readUInt16LE(26) !== nameLength
      )
        reject();
      const localName = Buffer.alloc(nameLength);
      if (
        (await file.read(localName, 0, nameLength, start + 30)).bytesRead !==
          nameLength ||
        !localName.equals(
          directory.subarray(cursor + 46, cursor + 46 + nameLength),
        )
      )
        reject();
      const dataEnd =
        start + 30 + nameLength + header.readUInt16LE(28) + compressed;
      if (dataEnd > offset) reject();
      ranges.push({ start, end: dataEnd });
      cursor += 46 + nameLength + extra + comment;
    }
    if (cursor !== length || manifests !== 1) reject();
    ranges.sort((a, b) => a.start - b.start);
    if (
      ranges.some(
        (entry, index) => index > 0 && entry.start < ranges[index - 1]!.end,
      )
    )
      reject();
  } finally {
    await file.close();
  }
}

export function runApkTool(
  executable: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  if (!isAbsolute(executable))
    return Promise.reject(new ApkVerificationError('APK_VERIFIER_UNAVAILABLE'));
  if (signal.aborted)
    return Promise.reject(new ApkVerificationError('APK_VERIFICATION_TIMEOUT'));
  return new Promise((resolve, rejectPromise) => {
    const child = spawn(executable, [...args], {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let count = 0,
      failure: ApkVerificationError | undefined;
    const stop = (code: ApkRejectionCode) => {
      failure ??= new ApkVerificationError(code);
      try {
        if (child.pid && process.platform !== 'win32')
          process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const abort = () => stop('APK_VERIFICATION_TIMEOUT');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      count += chunk.length;
      if (count > 1024 * 1024) stop('APK_INVALID');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      count += chunk.length;
      if (count > 1024 * 1024) stop('APK_INVALID');
    });
    child.once('error', () => {
      failure ??= new ApkVerificationError('APK_VERIFIER_UNAVAILABLE');
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (failure) rejectPromise(failure);
      else if (code !== 0)
        rejectPromise(new ApkVerificationError('APK_INVALID'));
      else resolve(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

@Injectable()
export class ApkVerifierService {
  constructor(private readonly config: ConfigService) {}
  async verify(input: {
    bytes: number;
    sha256Hex: string;
    versionName: string;
    buildNumber: number;
    download: (path: string, signal: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
  }): Promise<ApkMetadata> {
    if (
      !Number.isInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > APK_MAX_BYTES
    )
      reject('APK_SIZE_MISMATCH');
    const aapt = this.config.get<string>('APK_AAPT2_PATH');
    const signer = this.config.get<string>('APK_APKSIGNER_PATH');
    const packageId = this.config.get<string>('APK_EXPECTED_PACKAGE_ID');
    const trusted =
      this.config.get<string>('APK_TRUSTED_SIGNER_SHA256')?.split(',') ?? [];
    if (
      !aapt ||
      !signer ||
      !isAbsolute(aapt) ||
      !isAbsolute(signer) ||
      !packageId ||
      trusted.length === 0
    )
      reject('APK_VERIFIER_UNAVAILABLE');
    const signal = AbortSignal.any([
      AbortSignal.timeout(APK_VERIFICATION_MS),
      ...(input.signal ? [input.signal] : []),
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'musicmute-apk-'));
    try {
      const path = join(directory, 'artifact.apk');
      if (signal.aborted) reject('APK_VERIFICATION_TIMEOUT');
      await input.download(path, signal);
      if (signal.aborted) reject('APK_VERIFICATION_TIMEOUT');
      if ((await stat(path)).size !== input.bytes) reject('APK_SIZE_MISMATCH');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path, { signal }))
        hash.update(chunk as Buffer);
      if (hash.digest('hex') !== input.sha256Hex)
        reject('APK_CHECKSUM_MISMATCH');
      await validateApkZip(path, signal);
      const certificate = await runApkTool(
        signer,
        ['verify', '--print-certs', path],
        directory,
        signal,
      );
      const badging = await runApkTool(
        aapt,
        ['dump', 'badging', path],
        directory,
        signal,
      );
      // Badging omits the high 32 bits on current aapt2. Our API build contract
      // deliberately supports only positive signed 32-bit version codes.
      const manifestTree = await runApkTool(
        aapt,
        ['dump', 'xmltree', '--file', 'AndroidManifest.xml', path],
        directory,
        signal,
      );
      if (!/^\s*E: manifest(?:\s|$)/m.test(manifestTree)) reject('APK_INVALID');
      for (const line of manifestTree.split('\n')) {
        if (
          /^\s*A:.*(?:versionCodeMajor|0x01010576)[^=]*=/.test(line) &&
          !['0', '0x0'].includes(line.slice(line.indexOf('=') + 1).trim())
        )
          reject('APK_IDENTITY_MISMATCH');
      }
      return parseApkMetadata(badging, certificate, {
        packageId,
        versionName: input.versionName,
        buildNumber: input.buildNumber,
        maximumMinimumSdk: this.config.get<number>('APK_MAX_MIN_SDK', 26),
        trustedSigners: trusted,
      });
    } catch (error) {
      if (error instanceof ApkVerificationError) throw error;
      throw new ApkVerificationError(
        signal.aborted ? 'APK_VERIFICATION_TIMEOUT' : 'APK_INVALID',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
