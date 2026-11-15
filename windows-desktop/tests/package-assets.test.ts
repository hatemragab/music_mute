import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertSecretFreePublicBytes,
  parseApprovedPackageInputs,
  parsePackageJson,
  REQUIRED_INPUTS,
  validateApprovedPackageAssets,
  validatePackageIcon,
  approvedPackageFile,
  packageInventory,
  packageFile,
} from "../packaging/validate-assets.js";
import {
  canonicalUpdateMetadata,
  type UpdateMetadata,
} from "../../worker/src/platform/shared/update-metadata.js";
import { preparationTargetIdentity } from "../src/main/prepare/bundle.js";
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function pe() {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64, "binary");
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(0x20b, 88);
  return bytes;
}
it("permits an optional exact approved catalog trust input, requires its normal schema/publisher and never fabricates it", async () => {
  const f = await fixture();
  await validateApprovedPackageAssets(f.root, f.manifest, f.verify);
  expect(
    f.manifest.entries.some(
      (entry) => entry.path === "worker-catalog-update-channel.json",
    ),
  ).toBe(false);
  const content = await readFile(join(f.root, "update-channel.json"));
  const path = "worker-catalog-update-channel.json";
  f.manifest.entries.push({
    path,
    bytes: content.length,
    sha256: hash(content),
  });
  await writeFile(join(f.root, path), content);
  await validateApprovedPackageAssets(f.root, f.manifest, f.verify);
  for (const changed of [
    {
      ...JSON.parse(content.toString("utf8")),
      publisherSha256: "b".repeat(64),
    },
    { ...JSON.parse(content.toString("utf8")), unexpected: true },
  ]) {
    await f.replace(path, Buffer.from(JSON.stringify(changed)));
    await expect(
      validateApprovedPackageAssets(f.root, f.manifest, f.verify),
    ).rejects.toThrow();
  }
});
function ico() {
  const bytes = Buffer.alloc(70);
  bytes.writeUInt16LE(1, 2);
  bytes.writeUInt16LE(1, 4);
  bytes[6] = 1;
  bytes[7] = 1;
  bytes.writeUInt16LE(1, 10);
  bytes.writeUInt16LE(32, 12);
  bytes.writeUInt32LE(48, 14);
  bytes.writeUInt32LE(22, 18);
  bytes.writeUInt32LE(40, 22);
  bytes.writeInt32LE(1, 26);
  bytes.writeInt32LE(2, 30);
  bytes.writeUInt16LE(1, 34);
  bytes.writeUInt16LE(32, 36);
  bytes.set([20, 90, 120, 255], 62);
  return bytes;
}
function pngIcon(pixels = Buffer.from([0, 20, 90, 120, 255])): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(name, 4);
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const bytes = Buffer.alloc(22 + png.length);
  bytes.writeUInt16LE(1, 2);
  bytes.writeUInt16LE(1, 4);
  bytes[6] = 1;
  bytes[7] = 1;
  bytes.writeUInt32LE(png.length, 14);
  bytes.writeUInt32LE(22, 18);
  png.copy(bytes, 22);
  return bytes;
}
async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-approved-input-fixture-"),
  );
  roots.push(root);
  const keys = generateKeyPairSync("ed25519"),
    publicKeys = {
      fixture: keys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    };
  const now = Date.now(),
    metadata: UpdateMetadata = {
      schemaVersion: 1,
      platform: "windows-amd64",
      installationProfile: "windows-user",
      sequence: 1,
      releaseVersion: "0.1.0",
      publishedAt: new Date(now - 86400000).toISOString(),
      expiresAt: new Date(now + 86400000).toISOString(),
      release: {
        filename: "runtime.zip",
        bytes: 100,
        sha256: "f".repeat(64),
        contentType: "application/zip",
      },
    };
  const contents: Record<string, Buffer> = {};
  for (const path of REQUIRED_INPUTS)
    contents[path] = path.endsWith(".exe")
      ? pe()
      : Buffer.from(
          "Synthetic code fixture notice; no actual release or signature",
        );
  const json = (path: string, value: unknown) => {
    contents[path] = Buffer.from(JSON.stringify(value));
  };
  contents["app-icon.ico"] = ico();
  json("desktop-public-config.json", {
    backend_base_url: "https://api.music-mute.com",
    firebase_api_key: "FixturePublicAPIKey123456789",
    firebase_project_id: "fixture-public",
    google_desktop_client_id: "123456-fixture.apps.googleusercontent.com",
  });
  json("runtime-public-keys.json", publicKeys);
  json("runtime/runtime-metadata.json", {
    keyId: "fixture",
    metadata,
    signature: sign(
      null,
      Buffer.from(canonicalUpdateMetadata(metadata)),
      keys.privateKey,
    ).toString("base64url"),
  });
  json("runtime/runtime-source.json", {
    version: 1 as const,
    platform: "windows-amd64",
    installationProfile: "windows-user",
    targetIdentity: preparationTargetIdentity(metadata),
    filename: "runtime.zip",
    bytes: 100,
    sha256: metadata.release.sha256,
    unpackedBytes: 1000,
    url: "https://downloads.music-mute.com/releases/fixture-only/runtime.zip",
  });
  json("update-channel.json", {
    version: 1,
    feed: "https://downloads.music-mute.com/releases/fixture-only/stable.json",
    allowedOrigins: ["https://downloads.music-mute.com"],
    publicKeys,
    publisherSha256: "a".repeat(64),
  });
  const manifest = {
    version: 1 as const,
    appVersion: "0.1.0",
    appBuildNumber: 42,
    publisherName: "Fixture Publisher",
    publisherSha256: "a".repeat(64),
    entries: Object.entries(contents).map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: hash(bytes),
    })),
  };
  for (const [path, bytes] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  const replace = async (path: string, bytes: Buffer) => {
    await writeFile(join(root, path), bytes);
    const entry = manifest.entries.find((entry) => entry.path === path)!;
    entry.bytes = bytes.length;
    entry.sha256 = hash(bytes);
  };
  return { root, manifest, replace, verify: vi.fn(async () => {}) };
}
it("validates signed-profile/source/hash/publisher/public config with only an injected signature boundary", async () => {
  const f = await fixture();
  await validateApprovedPackageAssets(
    f.root,
    parseApprovedPackageInputs(f.manifest),
    f.verify,
  );
  expect(f.verify).toHaveBeenCalledTimes(3);
  expect(f.verify).toHaveBeenCalledWith(
    join(f.root, "native/musicmute-native.exe"),
    f.manifest.publisherSha256,
  );
});
it("rejects absent approval, unexpected files and duplicate JSON keys before trusting inputs", async () => {
  expect(() => parseApprovedPackageInputs({})).toThrow("PACKAGE_INPUT_INVALID");
  expect(() =>
    parsePackageJson(Buffer.from('{"version":1,"version":1}')),
  ).toThrow();
  const f = await fixture();
  for (const appBuildNumber of [undefined, 0, 1.5, 2147483648])
    expect(() =>
      parseApprovedPackageInputs({ ...f.manifest, appBuildNumber }),
    ).toThrow("PACKAGE_INPUT_INVALID");
  await writeFile(join(f.root, "extra.txt"), "unknown");
  await expect(
    validateApprovedPackageAssets(f.root, f.manifest, f.verify),
  ).rejects.toThrow("PACKAGE_INPUT_UNEXPECTED");
  expect(f.verify).not.toHaveBeenCalled();
});
it("refuses altered bytes, ARM payload and actual verifier failure", async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, "native/musicmute-native.exe"),
    Buffer.alloc(128),
  );
  await expect(
    validateApprovedPackageAssets(f.root, f.manifest, f.verify),
  ).rejects.toThrow("PACKAGE_INPUT_INVALID");
  const arm = pe();
  arm.writeUInt16LE(0xaa64, 68);
  await f.replace("native/musicmute-native.exe", arm);
  await expect(
    validateApprovedPackageAssets(f.root, f.manifest, f.verify),
  ).rejects.toThrow("not x86_64");
  await f.replace("native/musicmute-native.exe", pe());
  f.verify.mockRejectedValueOnce(new Error("PACKAGE_SIGNATURE_INVALID"));
  await expect(
    validateApprovedPackageAssets(f.root, f.manifest, f.verify),
  ).rejects.toThrow("PACKAGE_SIGNATURE_INVALID");
});
it("rechecks approved asset bytes at copy time instead of trusting an earlier signature/hash pass", async () => {
  const f = await fixture(),
    entry = f.manifest.entries.find(
      (entry) => entry.path === "native/musicmute-native.exe",
    )!;
  expect(await approvedPackageFile(f.root, entry)).toEqual(pe());
  const changed = pe();
  changed[40] = 1;
  await writeFile(join(f.root, entry.path), changed);
  await expect(approvedPackageFile(f.root, entry)).rejects.toThrow(
    "PACKAGE_INPUT_CHANGED",
  );
});
it("bounds inventory depth, validates the actual file descriptor and refuses oversized copy reads", async () => {
  const f = await fixture();
  expect(
    await packageFile(join(f.root, "native/musicmute-native.exe"), 128),
  ).toEqual(pe());
  await expect(
    packageFile(join(f.root, "native/musicmute-native.exe"), 127),
  ).rejects.toThrow("PACKAGE_INPUT_INVALID");
  const deep = join(f.root, ...Array.from({ length: 18 }, (_, i) => `dir${i}`));
  await mkdir(deep, { recursive: true });
  await expect(packageInventory(f.root)).rejects.toThrow(
    "PACKAGE_INPUT_INVALID",
  );
});
it("refuses unsafe links, package secrets, placeholders and malformed icon bounds", async () => {
  for (const value of [
    "-----BEGIN PRIVATE KEY-----",
    '{"refresh_token":"forbidden"}',
    "AWS_SECRET_ACCESS_KEY=forbidden",
  ])
    expect(() => assertSecretFreePublicBytes(Buffer.from(value))).toThrow(
      "PACKAGE_PRIVATE_MATERIAL",
    );
  for (const url of [
    "https://example.com/path",
    "https://a.example.net/path",
    "https://localhost/path",
    "https://updates.invalid/path",
    "https://a.test/path",
  ])
    expect(() => assertSecretFreePublicBytes(Buffer.from(url))).toThrow(
      "PACKAGE_PLACEHOLDER_INPUT",
    );
  expect(() => validatePackageIcon(Buffer.from("not an icon"))).toThrow(
    "PACKAGE_INPUT_INVALID",
  );
  const icon = ico();
  icon.writeUInt32LE(100, 18);
  expect(() => validatePackageIcon(icon)).toThrow("PACKAGE_INPUT_INVALID");
  const empty = Buffer.alloc(30);
  empty.writeUInt16LE(1, 2);
  empty.writeUInt16LE(1, 4);
  empty[6] = 1;
  empty[7] = 1;
  empty.writeUInt32LE(8, 14);
  empty.writeUInt32LE(22, 18);
  expect(() => validatePackageIcon(empty)).toThrow("PACKAGE_INPUT_INVALID");
  const f = await fixture();
  await rm(join(f.root, "notices/runtime.txt"));
  await symlink(
    join(f.root, "update-channel.json"),
    join(f.root, "notices/runtime.txt"),
  );
  await expect(
    validateApprovedPackageAssets(f.root, f.manifest, f.verify),
  ).rejects.toThrow("PACKAGE_INPUT_INVALID");
});
it("validates PNG icon CRC/dimensions and bounds decompression instead of accepting header-only images", () => {
  expect(() => validatePackageIcon(pngIcon())).not.toThrow();
  const badCrc = pngIcon();
  badCrc[badCrc.length - 1] = badCrc[badCrc.length - 1]! ^ 1;
  expect(() => validatePackageIcon(badCrc)).toThrow("PACKAGE_INPUT_INVALID");
  expect(() => validatePackageIcon(pngIcon(Buffer.alloc(1024)))).toThrow(
    "PACKAGE_INPUT_INVALID",
  );
  expect(() =>
    validatePackageIcon(pngIcon(Buffer.from([5, 20, 90, 120, 255]))),
  ).toThrow("PACKAGE_INPUT_INVALID");
  const badDimensions = pngIcon();
  badDimensions[6] = 2;
  expect(() => validatePackageIcon(badDimensions)).toThrow(
    "PACKAGE_INPUT_INVALID",
  );
});
