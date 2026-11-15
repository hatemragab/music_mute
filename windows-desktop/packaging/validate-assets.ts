import { createHash } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";
import { lstat, readdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { auditWindowsX64Binary } from "../../worker/src/platform/windows/pe-audit.js";
import { parseStrictJson } from "../../chrome-extension/src/shared/strict-json.js";
import {
  validatePublicAccountConfiguration,
  type PublicAccountConfiguration,
} from "../src/main/account/account-controller.js";
import { loadPreparationBundle } from "../src/main/prepare/bundle.js";
import { loadConsumerUpdateTrust } from "../src/main/update/metadata.js";
import type { PackagedResourceEntry } from "../src/main/browser/package-trust.js";
export { parsePackagedResourceIndex } from "../src/main/browser/package-trust.js";
export function parsePackageJson(bytes: Uint8Array, maximum = 65536): unknown {
  if (bytes.byteLength < 1 || bytes.byteLength > maximum)
    throw new Error("PACKAGE_INPUT_INVALID");
  return parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    maximum,
  );
}

const HASH = /^[a-f0-9]{64}$/u;
const APPROVED_INPUT_PATH =
  /^(?:native\/(?:musicmute-native|MusicMuteSession|MusicMuteChromeHost)\.exe|(?:desktop-public-config|runtime-public-keys|update-channel|worker-catalog-update-channel)\.json|runtime\/(?:runtime-metadata|runtime-source)\.json|app-icon\.ico|notices\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.txt)$/u;
export interface ApprovedInputEntry {
  path: string;
  bytes: number;
  sha256: string;
}
export interface ApprovedPackageInputs {
  version: 1;
  appVersion: string;
  appBuildNumber: number;
  publisherSha256: string;
  publisherName: string;
  entries: ApprovedInputEntry[];
}
export const REQUIRED_INPUTS = [
  "native/musicmute-native.exe",
  "native/MusicMuteSession.exe",
  "native/MusicMuteChromeHost.exe",
  "desktop-public-config.json",
  "runtime-public-keys.json",
  "runtime/runtime-metadata.json",
  "runtime/runtime-source.json",
  "update-channel.json",
  "app-icon.ico",
  "notices/runtime.txt",
] as const;
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join()
  )
    throw new Error("PACKAGE_INPUT_INVALID");
  return value as Record<string, unknown>;
}
export function parseApprovedPackageInputs(
  value: unknown,
): ApprovedPackageInputs {
  const row = exact(value, [
    "version",
    "appVersion",
    "appBuildNumber",
    "publisherSha256",
    "publisherName",
    "entries",
  ]);
  if (
    row.version !== 1 ||
    typeof row.appVersion !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(row.appVersion) ||
    !Number.isSafeInteger(row.appBuildNumber) ||
    (row.appBuildNumber as number) < 1 ||
    (row.appBuildNumber as number) > 2147483647 ||
    typeof row.publisherSha256 !== "string" ||
    !HASH.test(row.publisherSha256) ||
    typeof row.publisherName !== "string" ||
    !/^[\p{L}\p{N}][\p{L}\p{N} .,()&'-]{0,119}$/u.test(row.publisherName) ||
    !Array.isArray(row.entries) ||
    row.entries.length < REQUIRED_INPUTS.length ||
    row.entries.length > 64
  )
    throw new Error("PACKAGE_INPUT_INVALID");
  const names = new Set<string>(),
    entries: ApprovedInputEntry[] = [];
  for (const value of row.entries) {
    const entry = exact(value, ["path", "bytes", "sha256"]);
    if (
      typeof entry.path !== "string" ||
      !APPROVED_INPUT_PATH.test(entry.path) ||
      !Number.isSafeInteger(entry.bytes) ||
      (entry.bytes as number) < 1 ||
      (entry.bytes as number) > 16 * 1024 ** 2 ||
      typeof entry.sha256 !== "string" ||
      !HASH.test(entry.sha256) ||
      names.has(entry.path.toLowerCase())
    )
      throw new Error("PACKAGE_INPUT_INVALID");
    names.add(entry.path.toLowerCase());
    entries.push(entry as unknown as ApprovedInputEntry);
  }
  for (const path of REQUIRED_INPUTS)
    if (!names.has(path.toLowerCase()))
      throw new Error("PACKAGE_INPUT_MISSING");
  return {
    version: 1,
    appVersion: row.appVersion,
    appBuildNumber: row.appBuildNumber as number,
    publisherSha256: row.publisherSha256,
    publisherName: row.publisherName,
    entries,
  };
}
export function assertSecretFreePublicBytes(bytes: Buffer): void {
  const text = bytes.toString("utf8");
  if (
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|(?:AWS_SECRET_ACCESS_KEY|R2_SECRET_ACCESS_KEY|SENTRY_AUTH_TOKEN)\s*[=:]|"(?:refreshToken|refresh_token|private_key|client_secret)"\s*:/iu.test(
      text,
    )
  )
    throw new Error("PACKAGE_PRIVATE_MATERIAL");
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/giu)) {
    let host: string;
    try {
      host = new URL(match[0]).hostname.toLowerCase();
    } catch {
      throw new Error("PACKAGE_PLACEHOLDER_INPUT");
    }
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "[::1]" ||
      /(?:^|\.)(?:example\.(?:com|org|net)|[^.]+\.(?:invalid|test))$/u.test(
        host,
      )
    )
      throw new Error("PACKAGE_PLACEHOLDER_INPUT");
  }
}
export async function packageFile(
  path: string,
  maximum: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 512 * 1024 ** 2
  )
    throw new Error("PACKAGE_INPUT_INVALID");
  const named = await lstat(path, { bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    named.size < 1n ||
    named.size > BigInt(maximum)
  )
    throw new Error("PACKAGE_INPUT_INVALID");
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.size !== named.size
    )
      throw new Error("PACKAGE_INPUT_INVALID");
    const bytes = Buffer.alloc(Number(before.size));
    let cursor = 0;
    while (cursor < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        cursor,
        bytes.length - cursor,
        cursor,
      );
      if (!bytesRead) throw new Error("PACKAGE_INPUT_CHANGED");
      cursor += bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, cursor)).bytesRead !== 0)
      throw new Error("PACKAGE_INPUT_CHANGED");
    const after = await file.stat({ bigint: true }),
      final = await lstat(path, { bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      final.isSymbolicLink() ||
      final.dev !== before.dev ||
      final.ino !== before.ino ||
      final.nlink !== 1n
    )
      throw new Error("PACKAGE_INPUT_CHANGED");
    return bytes;
  } finally {
    await file.close();
  }
}
/** Revalidate the exact bytes copied after the initial inventory/signature pass. */
export async function approvedPackageFile(
  root: string,
  entry: ApprovedInputEntry,
): Promise<Buffer> {
  if (
    typeof entry.path !== "string" ||
    !APPROVED_INPUT_PATH.test(entry.path) ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 1 ||
    entry.bytes > 16 * 1024 ** 2 ||
    !HASH.test(entry.sha256)
  )
    throw new Error("PACKAGE_INPUT_INVALID");
  const bytes = await packageFile(
    join(root, ...entry.path.split("/")),
    entry.bytes,
  );
  if (
    bytes.length !== entry.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== entry.sha256
  )
    throw new Error("PACKAGE_INPUT_CHANGED");
  return bytes;
}
/** Validate standard PNG/DIB icon payloads; appearance still needs release QA. */
export function validatePackageIcon(bytes: Buffer): void {
  if (
    bytes.length < 22 ||
    bytes.readUInt16LE(0) !== 0 ||
    bytes.readUInt16LE(2) !== 1
  )
    throw new Error("PACKAGE_INPUT_INVALID");
  const count = bytes.readUInt16LE(4),
    header = 6 + count * 16;
  if (count < 1 || count > 32 || header > bytes.length)
    throw new Error("PACKAGE_INPUT_INVALID");
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    const row = 6 + i * 16,
      size = bytes.readUInt32LE(row + 8),
      offset = bytes.readUInt32LE(row + 12);
    if (
      bytes[row + 3] !== 0 ||
      size < 8 ||
      offset < header ||
      offset + size > bytes.length ||
      ranges.some(([a, b]) => offset < b && a < offset + size)
    )
      throw new Error("PACKAGE_INPUT_INVALID");
    ranges.push([offset, offset + size]);
    const width = bytes[row] || 256,
      height = bytes[row + 1] || 256,
      payload = bytes.subarray(offset, offset + size);
    if (
      payload
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      let cursor = 8,
        channels = 0,
        ended = false,
        seenData = false;
      const compressed: Buffer[] = [];
      while (cursor < payload.length) {
        if (cursor + 12 > payload.length)
          throw new Error("PACKAGE_INPUT_INVALID");
        const length = payload.readUInt32BE(cursor),
          end = cursor + 12 + length,
          name = payload.toString("ascii", cursor + 4, cursor + 8);
        if (
          end > payload.length ||
          crc32(payload.subarray(cursor + 4, end - 4)) !==
            payload.readUInt32BE(end - 4)
        )
          throw new Error("PACKAGE_INPUT_INVALID");
        const data = payload.subarray(cursor + 8, end - 4);
        if (cursor === 8) {
          if (
            name !== "IHDR" ||
            length !== 13 ||
            data.readUInt32BE(0) !== width ||
            data.readUInt32BE(4) !== height ||
            data[8] !== 8 ||
            ![2, 6].includes(data[9]!) ||
            data[10] !== 0 ||
            data[11] !== 0 ||
            data[12] !== 0
          )
            throw new Error("PACKAGE_INPUT_INVALID");
          channels = data[9] === 6 ? 4 : 3;
        } else if (name === "IHDR") throw new Error("PACKAGE_INPUT_INVALID");
        else if (name === "IDAT") {
          compressed.push(data);
          seenData = true;
        } else if (name === "IEND") {
          if (length !== 0 || !seenData || end !== payload.length)
            throw new Error("PACKAGE_INPUT_INVALID");
          ended = true;
        } else if ((payload[cursor + 4]! & 32) === 0 && name !== "PLTE")
          throw new Error("PACKAGE_INPUT_INVALID");
        cursor = end;
      }
      if (!ended || channels === 0) throw new Error("PACKAGE_INPUT_INVALID");
      const stride = width * channels + 1,
        expected = stride * height;
      let pixels: Buffer;
      try {
        pixels = inflateSync(Buffer.concat(compressed), {
          maxOutputLength: expected,
        });
      } catch {
        throw new Error("PACKAGE_INPUT_INVALID");
      }
      if (pixels.length !== expected) throw new Error("PACKAGE_INPUT_INVALID");
      for (let y = 0; y < height; y++)
        if (pixels[y * stride]! > 4) throw new Error("PACKAGE_INPUT_INVALID");
    } else {
      if (payload.length < 40) throw new Error("PACKAGE_INPUT_INVALID");
      const dib = payload.readUInt32LE(0),
        bits = payload.readUInt16LE(14),
        compression = payload.readUInt32LE(16),
        colors = payload.readUInt32LE(32);
      if (
        ![40, 52, 56, 108, 124].includes(dib) ||
        dib > payload.length ||
        payload.readInt32LE(4) !== width ||
        payload.readInt32LE(8) !== height * 2 ||
        payload.readUInt16LE(12) !== 1 ||
        ![1, 4, 8, 16, 24, 32].includes(bits) ||
        ![0, 3].includes(compression) ||
        (compression === 3 && bits !== 16 && bits !== 32) ||
        (bytes.readUInt16LE(row + 6) !== 0 &&
          bytes.readUInt16LE(row + 6) !== bits)
      )
        throw new Error("PACKAGE_INPUT_INVALID");
      const palette = bits <= 8 ? colors || 2 ** bits : colors;
      if (palette > 256 || (bits <= 8 && palette > 2 ** bits))
        throw new Error("PACKAGE_INPUT_INVALID");
      const required =
        dib +
        (compression === 3 && dib === 40 ? 12 : 0) +
        palette * 4 +
        Math.ceil((width * bits) / 32) * 4 * height +
        Math.ceil(width / 32) * 4 * height;
      if (required > payload.length) throw new Error("PACKAGE_INPUT_INVALID");
    }
  }
}
export function packageEntry(
  placement: "app" | "resources",
  path: string,
  bytes: Buffer,
): PackagedResourceEntry {
  return {
    placement,
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
export async function packageInventory(root: string): Promise<string[]> {
  const files: string[] = [];
  let directories = 0;
  const visit = async (directory: string, prefix: string, depth = 0) => {
    if (depth > 16 || ++directories > 256 || prefix.length > 256)
      throw new Error("PACKAGE_INPUT_INVALID");
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("PACKAGE_INPUT_INVALID");
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name,
        absolute = join(directory, name),
        stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("PACKAGE_INPUT_INVALID");
      if (stat.isDirectory()) await visit(absolute, path, depth + 1);
      else if (stat.isFile() && stat.nlink === 1) files.push(path);
      else throw new Error("PACKAGE_INPUT_INVALID");
      if (files.length > 1024) throw new Error("PACKAGE_INPUT_INVALID");
    }
  };
  await visit(root, "");
  return files;
}
/** Injected signature checking is a fixture boundary. Production packaging must
 * supply the real Windows Authenticode/timestamp/asInvoker verifier. */
export async function validateApprovedPackageAssets(
  root: string,
  inputs: ApprovedPackageInputs,
  verifySignature: (path: string, publisherSha256: string) => Promise<void>,
): Promise<void> {
  const manifest = parseApprovedPackageInputs(inputs),
    actual = await packageInventory(root);
  if (
    actual.sort().join() !==
    manifest.entries
      .map((entry) => entry.path)
      .sort()
      .join()
  )
    throw new Error("PACKAGE_INPUT_UNEXPECTED");
  for (const entry of manifest.entries) {
    const path = join(root, ...entry.path.split("/")),
      bytes = await packageFile(path, entry.bytes);
    if (
      bytes.length !== entry.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    )
      throw new Error("PACKAGE_INPUT_INVALID");
    if (entry.path.endsWith(".exe")) {
      await auditWindowsX64Binary(path);
      await verifySignature(path, manifest.publisherSha256);
    } else if (entry.path.endsWith(".ico")) validatePackageIcon(bytes);
    else assertSecretFreePublicBytes(bytes);
  }
  const configuration = parseStrictJson(
    (
      await packageFile(join(root, "desktop-public-config.json"), 4096)
    ).toString("utf8"),
    4096,
  );
  const account = validatePublicAccountConfiguration(
    configuration as PublicAccountConfiguration,
  );
  if (!account.google_desktop_client_id)
    throw new Error("PACKAGE_INPUT_MISSING");
  const bundle = await loadPreparationBundle(root, 0);
  if (!bundle.source || bundle.metadata.installationProfile !== "windows-user")
    throw new Error("PACKAGE_INPUT_MISSING");
  const update = await loadConsumerUpdateTrust(root);
  if (update.publisherSha256 !== manifest.publisherSha256)
    throw new Error("PACKAGE_INPUT_INVALID");
  if (
    manifest.entries.some(
      (entry) => entry.path === "worker-catalog-update-channel.json",
    )
  ) {
    const catalog = await loadConsumerUpdateTrust(root, "catalog");
    if (catalog.publisherSha256 !== manifest.publisherSha256)
      throw new Error("PACKAGE_INPUT_INVALID");
  }
}
