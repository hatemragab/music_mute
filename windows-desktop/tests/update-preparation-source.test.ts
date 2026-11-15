import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("node:path", async (original) => {
  const actual = await original<typeof import("node:path")>();
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.map((part) => part.replaceAll("\\", "/"))),
    },
  };
});
vi.mock("../../chrome-extension/src/shared/local-model.js", async () => {
  const { createHash } = await import("node:crypto"),
    bytes = Buffer.from("catalog installed model fixture only");
  return {
    MODEL: {
      filename: "Kim_Vocal_2.onnx",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      url: "https://models.example.invalid/model.onnx",
    },
  };
});
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { writeWindowsReleaseManifest } from "../../worker/src/platform/windows/release-manifest.js";
import {
  canonicalUpdateMetadata,
  type UpdateMetadata,
} from "../../worker/src/platform/shared/update-metadata.js";
import { preparationTargetIdentity } from "../src/main/prepare/bundle.js";
import { WindowsPreparationOperations } from "../src/main/prepare/operations.js";
import { privateFingerprint } from "../src/main/prepare/private-files.js";
import { loadInstalledPreparationBundle } from "../src/main/update/loader.js";
import {
  canonicalConsumerUpdate,
  consumerUpdateSourceDescriptor,
} from "../src/main/update/metadata.js";
import type { ConsumerUpdateMetadata } from "../src/shared/update-contracts.js";
import { receipt, gpu, bootIdentity } from "./fixtures/prepare.js";
import { storageFixture } from "./storage-fixtures.js";
const roots: string[] = [],
  hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Actual signed selection, inventory and Operations reads. Executable/model
 * bytes and the native vault/path adapter are synthetic; no process is launched. */
async function fixture() {
  const f = await storageFixture();
  roots.push(f.root);
  const vault = new Map<string, Buffer>(),
    keys = generateKeyPairSync("ed25519"),
    resources = join(f.root, "resources"),
    now = Date.now(),
    trust = {
      feed: "https://updates.example.invalid/catalog.json",
      publicKeys: {
        fixture: keys.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      },
      allowedOrigins: ["https://updates.example.invalid"],
      publisherSha256: "9".repeat(64),
    },
    runtime: UpdateMetadata = {
      schemaVersion: 1,
      platform: "windows-amd64",
      installationProfile: "windows-user",
      sequence: 2,
      releaseVersion: "0.1.4",
      publishedAt: new Date(now - 60000).toISOString(),
      expiresAt: new Date(now + 86400000).toISOString(),
      release: {
        filename: "new-runtime.zip",
        bytes: 1000,
        sha256: "c".repeat(64),
        contentType: "application/zip",
      },
    },
    release = preparationTargetIdentity(runtime),
    releaseRoot = join(f.root, "runtime", "releases", release),
    files = [
      "app/dist/src/cli/main.js",
      "runtime/node/node.exe",
      "runtime/python/python.exe",
      "runtime/bin/ffmpeg.exe",
      "runtime/bin/ffprobe.exe",
      "runtime/native/musicmute-native.exe",
      "runtime/media-source-manifest.json",
      "runtime/licenses/ffmpeg/COPYING.LGPLv2.1",
      "runtime/licenses/lame/COPYING",
      ...["session-agent", "login-worker", "personal", "fleet", "prepare"].map(
        (role) => `agent/${role}.cjs`,
      ),
      ...[
        "windows_gpu",
        "provider_adapter",
        "qualification",
        "consumer_personal",
      ].map((name) => `app/engine/musicmute_engine/${name}.py`),
    ];
  for (const name of files) {
    await mkdir(dirname(join(releaseRoot, name)), { recursive: true });
    await writeFile(
      join(releaseRoot, name),
      `synthetic catalog fixture: ${name}`,
    );
  }
  await writeWindowsReleaseManifest(
    releaseRoot,
    runtime.releaseVersion,
    "windows-user",
  );
  const manifestSha256 = hash(
    await readFile(join(releaseRoot, "release-manifest.json")),
  );
  await mkdir(join(f.root, "models"));
  await writeFile(
    join(f.root, "models", MODEL.filename),
    "catalog installed model fixture only",
  );
  const installed = {
    ...receipt(),
    sid: f.host.identity.sid,
    target: release,
    release,
    sequence: runtime.sequence,
    manifestSha256,
    activatedAt: new Date(now - 1000).toISOString(),
    modelFingerprint: await privateFingerprint(
      f.host,
      `models\\${MODEL.filename}`,
    ),
  };
  installed.qualification.serviceIdentity = f.host.identity.sid;
  installed.qualification.releaseManifestDigest = manifestSha256;
  const metadata: ConsumerUpdateMetadata = {
      schemaVersion: 1,
      installationProfile: "windows-user",
      platform: "windows-amd64",
      channel: "stable",
      sequence: 2,
      publishedAt: runtime.publishedAt,
      expiresAt: runtime.expiresAt,
      dataSchema: 1,
      publisherSha256: trust.publisherSha256,
      app: {
        version: "0.1.3",
        payloadSha256: "8".repeat(64),
        artifact: {
          filename: "app.exe",
          url: "https://updates.example.invalid/app.exe",
          bytes: 100,
          sha256: "7".repeat(64),
          contentType: "application/x-msdownload",
        },
      },
      runtime: {
        version: runtime.releaseVersion,
        minimumAppVersion: "0.1.3",
        artifact: {
          ...runtime.release,
          url: "https://updates.example.invalid/new-runtime.zip",
        },
      },
      model: {
        version: "1.0.0",
        minimumRuntimeVersion: runtime.releaseVersion,
        artifact: {
          filename: MODEL.filename,
          url: "https://updates.example.invalid/model.onnx",
          bytes: MODEL.bytes,
          sha256: MODEL.sha256,
          contentType: "application/octet-stream",
        },
      },
      required: {
        minimumAppVersion: "0.1.3",
        minimumRuntimeVersion: runtime.releaseVersion,
        minimumModelVersion: "1.0.0",
      },
    },
    signed = {
      keyId: "fixture",
      metadata,
      signature: sign(
        null,
        Buffer.from(canonicalConsumerUpdate(metadata)),
        keys.privateKey,
      ).toString("base64url"),
    },
    active = {
      version: 1,
      kind: "consumer",
      signed,
      target: release,
      activatedAt: installed.activatedAt,
      recoveryOf: null,
      source: "catalog",
      sourceDescriptor: consumerUpdateSourceDescriptor(trust),
    };
  await mkdir(join(resources, "runtime"), { recursive: true });
  await writeFile(
    join(resources, "worker-catalog-update-channel.json"),
    JSON.stringify({ version: 1, ...trust }),
  );
  // The unchanged installed app still seals an older default runtime.
  const old = {
    ...runtime,
    sequence: 1,
    releaseVersion: "0.1.3",
    release: { ...runtime.release, sha256: "a".repeat(64) },
  };
  await writeFile(
    join(resources, "runtime-public-keys.json"),
    JSON.stringify(trust.publicKeys),
  );
  await writeFile(
    join(resources, "runtime", "runtime-metadata.json"),
    JSON.stringify({
      keyId: "fixture",
      metadata: old,
      signature: sign(
        null,
        Buffer.from(canonicalUpdateMetadata(old)),
        keys.privateKey,
      ).toString("base64url"),
    }),
  );
  vault.set("ready_receipt", Buffer.from(JSON.stringify(installed)));
  vault.set(
    "runtime_sequence",
    Buffer.from(JSON.stringify({ version: 1, sequence: 2 })),
  );
  vault.set(
    `runtime_${release.slice(0, 56)}`,
    Buffer.from(
      JSON.stringify({
        version: 2,
        dllPolicy: "private-pe-imports-msvc-v3",
        sid: f.host.identity.sid,
        release,
        archiveSha256: runtime.release.sha256,
        sequence: 2,
        manifestSha256,
      }),
    ),
  );
  vault.set("consumer_update_active", Buffer.from(JSON.stringify(active)));
  const native = Object.assign(f.native, {
    vaultRead: vi.fn(async (_namespace: string, key: string) =>
      vault.has(key) ? Buffer.from(vault.get(key)!) : null,
    ),
    vaultWrite: vi.fn(async () => {}),
    vaultDelete: vi.fn(async () => {}),
    bootIdentity: vi.fn(async () => bootIdentity),
    enumerateGpus: vi.fn(async () => [gpu]),
  });
  const operations = new WindowsPreparationOperations(
    f.host,
    resources,
    async () => false,
    (minimum) => loadInstalledPreparationBundle(f.host, resources, minimum),
  );
  return {
    ...f,
    vault,
    native,
    resources,
    operations,
    installed,
    active,
    trust,
    keys,
    releaseRoot,
    runtime,
  };
}
it("unaudited old consumer proof cannot authorize cached, personal or media-tool execution while signed metadata remains selectable", async () => {
  const f = await fixture(),
    signal = new AbortController().signal,
    key = `runtime_${f.installed.release.slice(0, 56)}`,
    proof = JSON.parse(f.vault.get(key)!.toString());
  delete proof.dllPolicy;
  proof.version = 1;
  f.vault.set(key, Buffer.from(JSON.stringify(proof)));
  const target = await f.operations.target(signal);
  expect(await f.operations.cachedReady(target, signal)).toBe(false);
  await expect(f.operations.snapshotReady(signal)).rejects.toThrow(
    "INTEGRITY_INVALID",
  );
  await expect(f.operations.snapshotMediaTools(signal)).rejects.toThrow(
    "INTEGRITY_INVALID",
  );
  expect(
    (await loadInstalledPreparationBundle(f.host, f.resources, 2))
      .targetIdentity,
  ).toBe(f.installed.target);
});
it("rebound real Operations loads the approved new catalog runtime for personal Ready and CPU tools while packaged runtime remains older", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  expect(await f.operations.target(signal)).toEqual({
    sid: f.host.identity.sid,
    identity: f.installed.target,
  });
  expect(await f.operations.snapshotReady(signal)).toMatchObject({
    release: f.installed.target,
    releaseRoot: f.releaseRoot,
    releaseVersion: "0.1.4",
    archiveSha256: f.runtime.release.sha256,
  });
  expect(await f.operations.snapshotMediaTools(signal)).toMatchObject({
    releaseRoot: f.releaseRoot,
    ffmpegPath: join(f.releaseRoot, "runtime", "bin", "ffmpeg.exe"),
  });
  const bundle = await loadInstalledPreparationBundle(f.host, f.resources, 2);
  expect(bundle.source).toMatchObject({
    url: "https://updates.example.invalid/new-runtime.zip",
    allowedOrigins: f.trust.allowedOrigins,
    unpackedBytes: null,
  });
  expect(bundle.allowNetwork).toBe(true);
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
});
it.each([
  "signature",
  "descriptor",
  "target",
  "missing-receipt",
  "missing-trust",
])(
  "a protected catalog %s fault cannot fall back to the older app runtime",
  async (fault) => {
    const f = await fixture(),
      active = structuredClone(f.active);
    if (fault === "signature") active.signed.signature = "A".repeat(86);
    if (fault === "descriptor") active.sourceDescriptor = "d".repeat(64);
    if (fault === "target") active.target = "a".repeat(64);
    if (fault === "missing-receipt") f.vault.delete("ready_receipt");
    if (fault === "missing-trust")
      await rm(join(f.resources, "worker-catalog-update-channel.json"));
    f.vault.set("consumer_update_active", Buffer.from(JSON.stringify(active)));
    await expect(
      f.operations.target(new AbortController().signal),
    ).rejects.toThrow();
    expect(f.native.vaultWrite).not.toHaveBeenCalled();
  },
);
it("stale-boot metadata selects real installed bytes but cannot authorize operational personal Ready", async () => {
  const f = await fixture(),
    signal = new AbortController().signal;
  f.native.bootIdentity.mockResolvedValue("f".repeat(64));
  expect((await f.operations.target(signal)).identity).toBe(f.installed.target);
  expect(await f.operations.snapshotMediaTools(signal)).toMatchObject({
    releaseRoot: f.releaseRoot,
  });
  await expect(f.operations.snapshotReady(signal)).rejects.toThrow(
    "INTEGRITY_INVALID",
  );
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
});
it("expired authenticated installed catalog bytes remain selectable offline but cannot permit new repair transfers", async () => {
  const f = await fixture(),
    activatedAt = new Date(Date.now() - 30000).toISOString();
  const active = structuredClone(f.active),
    installed = { ...f.installed, activatedAt };
  active.activatedAt = activatedAt;
  active.signed.metadata.expiresAt = new Date(Date.now() - 1000).toISOString();
  active.signed.signature = sign(
    null,
    Buffer.from(canonicalConsumerUpdate(active.signed.metadata)),
    f.keys.privateKey,
  ).toString("base64url");
  f.vault.set("ready_receipt", Buffer.from(JSON.stringify(installed)));
  f.vault.set("consumer_update_active", Buffer.from(JSON.stringify(active)));
  const bundle = await loadInstalledPreparationBundle(f.host, f.resources, 2);
  expect(bundle.targetIdentity).toBe(installed.target);
  expect(bundle.allowNetwork).toBe(false);
  expect(
    (await f.operations.target(new AbortController().signal)).identity,
  ).toBe(installed.target);
  expect(
    await f.operations.snapshotMediaTools(new AbortController().signal),
  ).toMatchObject({ releaseRoot: f.releaseRoot });
  expect(f.native.vaultWrite).not.toHaveBeenCalled();
});
