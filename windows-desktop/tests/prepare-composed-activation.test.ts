import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
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
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("synthetic-model-fixture-no-inference");
  return {
    MODEL: {
      filename: "Kim_Vocal_2.onnx",
      url: "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
});
const nativeFixture = vi.hoisted(() => ({
  fullInventoryChecks: 0,
  current: null as {
    host: import("../src/main/host-context.js").HostContext;
    events: string[];
    result: unknown;
    stopFailure: boolean;
  } | null,
}));
vi.mock(
  "../../worker/src/platform/windows/release-manifest.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../worker/src/platform/windows/release-manifest.js")
      >();
    return {
      ...actual,
      verifyWindowsRelease: async (
        ...args: Parameters<typeof actual.verifyWindowsRelease>
      ) => {
        nativeFixture.fullInventoryChecks++;
        return actual.verifyWindowsRelease(...args);
      },
    };
  },
);
vi.mock(
  "../../worker/src/platform/windows/consumer-native.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../worker/src/platform/windows/consumer-native.js")
      >();
    return {
      ...actual,
      createConsumerNativeTransport: vi.fn(async () => ({})),
      WindowsConsumerNative: class {
        private readonly fixture = nativeFixture.current!;
        private listeners = new Set<(event: unknown) => void>();
        async identity() {
          return this.fixture.host.identity;
        }
        async bootIdentity() {
          return "e".repeat(64);
        }
        async legacyWorkerConflict() {
          return false;
        }
        async enumerateGpus() {
          return [gpu];
        }
        async acquireGpuGuard(selected: typeof gpu) {
          this.fixture.events.push("physical-guard");
          return {
            luid: selected.luid,
            nonce: "d".repeat(64),
            identity: this.fixture.host.identity,
            abandoned: false,
            gpu: selected,
          };
        }
        async releaseGpuGuard() {
          this.fixture.events.push("physical-release");
        }
        onEvent(listener: (event: unknown) => void) {
          this.listeners.add(listener);
          return () => this.listeners.delete(listener);
        }
        onClosed() {
          return () => {};
        }
        async launchOwned() {
          this.fixture.events.push("owned-qualification");
          const root = this.fixture.host.personalRoot;
          const config = JSON.parse(
            await readFile(join(root, "prepare-config.json"), "utf8"),
          );
          expect(config.gpu).toEqual(gpu);
          expect(config.operation).toBe("qualify");
          const raw = receipt().qualification;
          raw.serviceIdentity = this.fixture.host.identity.sid;
          raw.releaseManifestDigest = config.manifestSha256;
          await writeFile(
            join(root, "prepare", "results", `${config.requestId}.json`),
            JSON.stringify(raw),
            { flag: "wx" },
          );
          this.fixture.result = raw;
          const owner = {
            role: "prepare",
            nonce: "f".repeat(64),
            identity: {
              ...this.fixture.host.identity,
              pid: 123,
              creationTime: "2000",
            },
          };
          for (const listener of this.listeners)
            listener({ kind: "child_exit", owner });
          return owner;
        }
        async stopOwned() {
          this.fixture.events.push("positive-job-teardown");
          if (this.fixture.stopFailure) throw new Error("TREE_STILL_LIVE");
        }
        async close() {
          this.fixture.events.push("helper-close");
        }
      },
    };
  },
);
import { crc32 } from "../src/main/crc32.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import {
  canonicalUpdateMetadata,
  type UpdateMetadata,
} from "../../worker/src/platform/shared/update-metadata.js";
import { writeWindowsReleaseManifest } from "../../worker/src/platform/windows/release-manifest.js";
import { HostContext } from "../src/main/host-context.js";
import { preparationTargetIdentity } from "../src/main/prepare/bundle.js";
import { PrepareController } from "../src/main/prepare/controller.js";
import {
  DesktopPreparationLifecycle,
  type DesktopPrepareOwner,
} from "../src/main/prepare/desktop-lifecycle.js";
import {
  WindowsPreparationOperations,
  parseReadyReceipt,
} from "../src/main/prepare/operations.js";
import {
  RUNTIME_STAGING_KEY,
  RUNTIME_STAGING_PATH,
} from "../src/main/prepare/runtime-staging.js";
import { storageFixture } from "./storage-fixtures.js";
import {
  RUNTIME_REPAIR_KEY,
  RUNTIME_BACKUP_PATH,
  RUNTIME_BACKUP_INVENTORY,
} from "../src/main/prepare/runtime-repair.js";
import { fixturePe64 } from "../../worker/tests/fixtures/windows-pe64.js";
import { gpu, receipt } from "./fixtures/prepare.js";
const roots: string[] = [];
afterEach(async () => {
  nativeFixture.current = null;
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
/** Stored ZIP, valid CRCs and actual signed inventory. Every executable/model is
 * synthetic fixture bytes; only file/transfer/inventory/activation code executes. */
function zip(files: readonly { name: string; bytes: Buffer }[]): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const { name: raw, bytes } of files) {
    const name = Buffer.from(raw),
      local = Buffer.alloc(30),
      index = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    index.writeUInt32LE(0x02014b50);
    index.writeUInt16LE(0x0314, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt32LE(crc32(bytes), 16);
    index.writeUInt32LE(bytes.length, 20);
    index.writeUInt32LE(bytes.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(offset, 42);
    locals.push(local, name, bytes);
    central.push(index, name);
    offset += local.length + name.length + bytes.length;
  }
  const indexes = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(indexes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, indexes, end]);
}
async function fixture(missingDll = false, extraFiles = 0) {
  const f = await storageFixture();
  roots.push(f.root);
  const vault = new Map<string, Buffer>(),
    events: string[] = [],
    cleanupEvidence: {
      row: unknown;
      backupInode: string;
      damagedBytes: string;
    }[] = [];
  const native = Object.assign(f.native, {
    vaultRead: vi.fn(async (_namespace: string, key: string) =>
      vault.has(key) ? Buffer.from(vault.get(key)!) : null,
    ),
    vaultWrite: vi.fn(
      async (_namespace: string, key: string, bytes: Buffer) => {
        events.push(`vault:${key}`);
        vault.set(key, Buffer.from(bytes));
      },
    ),
    vaultDelete: vi.fn(async (_namespace: string, key: string) => {
      vault.delete(key);
    }),
    bootIdentity: vi.fn(async () => "e".repeat(64)),
    enumerateGpus: vi.fn(async () => [gpu]),
    // Injected native I/O outcome only: production deletion is handle-held C++.
    removeRuntimeRepairBackup: vi.fn(async (target: string, digest: string) => {
      const raw = vault.get(RUNTIME_REPAIR_KEY)!;
      expect(hash(raw)).toBe(digest);
      const row = JSON.parse(raw.toString());
      expect(row).toMatchObject({ phase: "activated", target });
      expect(
        JSON.parse(vault.get("ready_receipt")!.toString()).manifestSha256,
      ).toBe(row.manifestSha256);
      expect(events).toContain("positive-job-teardown");
      cleanupEvidence.push({
        row,
        backupInode: String(
          (
            await lstat(
              join(f.root, RUNTIME_BACKUP_PATH.replaceAll("\\", "/")),
              { bigint: true },
            )
          ).ino,
        ),
        damagedBytes: await readFile(
          join(
            f.root,
            RUNTIME_BACKUP_PATH.replaceAll("\\", "/"),
            "runtime",
            "node",
            "node.exe",
          ),
          "utf8",
        ),
      });
      await rm(join(f.root, RUNTIME_BACKUP_PATH.replaceAll("\\", "/")), {
        recursive: true,
      });
      await rm(join(f.root, RUNTIME_BACKUP_INVENTORY.replaceAll("\\", "/")));
      vault.delete(RUNTIME_REPAIR_KEY);
      events.push("native-backup-completed");
      return { state: "completed" as const };
    }),
  });
  Object.assign(f.host, {
    prepareLease: (target: Parameters<HostContext["prepareLease"]>[0]) =>
      HostContext.prototype.prepareLease.call(f.host, target),
    prepareJournal: {
      read: async () =>
        vault.has("prepare_journal")
          ? JSON.parse(vault.get("prepare_journal")!.toString())
          : null,
      write: async (row: unknown) =>
        native.vaultWrite(
          "account",
          "prepare_journal",
          Buffer.from(JSON.stringify(row)),
        ),
    },
  });
  const assembly = join(f.root, "fixture-assembly"),
    resources = join(f.root, "fixture-resources");
  const names = [
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
    ].map((file) => `app/engine/musicmute_engine/${file}.py`),
    ...Array.from(
      { length: extraFiles },
      (_, i) => `runtime/python/source-fixture/file-${i}.txt`,
    ),
  ];
  for (const name of names) {
    await mkdir(dirname(join(assembly, name)), { recursive: true });
    await writeFile(
      join(assembly, name),
      name.endsWith(".exe")
        ? fixturePe64(
            missingDll && name === "runtime/python/python.exe"
              ? [{ name: "vcruntime140.dll", kind: "delay" }]
              : [],
          )
        : `synthetic fixture only: ${name}`,
    );
  }
  const manifest = await writeWindowsReleaseManifest(
    assembly,
    "0.1.3",
    "windows-user",
  );
  const files: { name: string; bytes: Buffer }[] = [];
  for (const name of [...names, "release-manifest.json"])
    files.push({ name, bytes: await readFile(join(assembly, name)) });
  const archive = zip(files),
    model = Buffer.from("synthetic-model-fixture-no-inference");
  const now = Date.now();
  const metadata: UpdateMetadata = {
    schemaVersion: 1,
    platform: "windows-amd64",
    installationProfile: "windows-user",
    sequence: 1,
    releaseVersion: "0.1.3",
    publishedAt: new Date(now - 60000).toISOString(),
    expiresAt: new Date(now + 86400000).toISOString(),
    release: {
      filename: "fixture-only.zip",
      bytes: archive.length,
      sha256: hash(archive),
      contentType: "application/zip",
    },
  };
  const keys = generateKeyPairSync("ed25519"),
    target = preparationTargetIdentity(metadata);
  await mkdir(join(resources, "runtime"), { recursive: true });
  await writeFile(
    join(resources, "runtime-public-keys.json"),
    JSON.stringify({
      fixture: keys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    }),
  );
  await writeFile(
    join(resources, "runtime", "runtime-metadata.json"),
    JSON.stringify({
      keyId: "fixture",
      metadata,
      signature: sign(
        null,
        Buffer.from(canonicalUpdateMetadata(metadata)),
        keys.privateKey,
      ).toString("base64url"),
    }),
  );
  const runtimeUrl =
    "https://downloads.music-mute.com/releases/test-only-fixture/fixture-only.zip";
  await writeFile(
    join(resources, "runtime", "runtime-source.json"),
    JSON.stringify({
      version: 1,
      platform: "windows-amd64",
      installationProfile: "windows-user",
      targetIdentity: target,
      filename: metadata.release.filename,
      bytes: archive.length,
      sha256: hash(archive),
      unpackedBytes: files.reduce(
        (total, file) => total + file.bytes.length,
        0,
      ),
      url: runtimeUrl,
    }),
  );
  const fetcher = vi.fn(async (raw: string | URL) => {
    const url = raw.toString();
    events.push(url === runtimeUrl ? "runtime-fetch" : "model-fetch");
    if (![runtimeUrl, MODEL.url].includes(url))
      throw new Error("unexpected fixture network");
    const bytes = url === runtimeUrl ? archive : model;
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Length": String(bytes.length),
        ETag: '"fixture-immutable"',
      },
    });
  });
  const state = {
    host: f.host,
    events,
    result: null as unknown,
    stopFailure: false,
  };
  nativeFixture.current = state;
  let mutationAllowed = false;
  const assertMutation = vi.fn(async () => {
    if (!mutationAllowed) throw new Error("MUTATION_AUTHORITY_MISSING");
    events.push("mutation-proof");
  });
  const operations = new WindowsPreparationOperations(
    f.host,
    resources,
    async () => false,
    undefined,
    { fetch: fetcher as typeof fetch, assertMutation },
  );
  const admission = {
    beforeMutation: vi.fn(async () => {
      events.push("maintenance-enter");
      mutationAllowed = true;
      return {
        release: async () => {
          events.push("maintenance-release");
          mutationAllowed = false;
        },
      };
    }),
  };
  const controller = new PrepareController(
    operations,
    f.host.prepareJournal,
    admission,
  );
  const path = (relative: string) =>
    join(f.root, relative.replaceAll("\\", "/"));
  return {
    ...f,
    native,
    vault,
    events,
    resources,
    operations,
    controller,
    admission,
    fetcher,
    target,
    archive,
    model,
    path,
    state,
    assertMutation,
    cleanupEvidence,
    manifestSha: hash(await readFile(join(assembly, "release-manifest.json"))),
    manifest,
  };
}
it("executes the actual Main lifecycle through signed Operations activation then authenticated cheap warm startup", async () => {
  const f = await fixture(),
    cold = new DesktopPreparationLifecycle();
  const recovery = vi.fn(() => {
    f.events.push("automatic-approved-recovery");
  });
  const owner: DesktopPrepareOwner = {
    current: () => true,
    start: () => f.controller.start(),
    cancel: () => f.controller.cancel(),
    settle: async (task, rebind) => {
      await task;
      expect(f.controller.isRunning()).toBe(false);
      expect(f.operations.cleanupPending()).toBe(false);
      await rebind();
    },
    rebind: [],
    ready: recovery,
    failed: vi.fn(),
    setup: vi.fn(),
  };
  await cold.startAutomatic(owner, () => true);
  expect(f.controller.view().state).toBe("ready");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.events.indexOf("maintenance-release")).toBeLessThan(
    f.events.indexOf("automatic-approved-recovery"),
  );
  const before = [...f.events],
    checks = nativeFixture.fullInventoryChecks;
  const next = new WindowsPreparationOperations(
    f.host,
    f.resources,
    async () => true,
    undefined,
    { fetch: f.fetcher as typeof fetch },
  );
  const noMutation = {
    beforeMutation: vi.fn(async () => {
      throw new Error("WARM_MUTATION_FORBIDDEN");
    }),
  };
  const warmController = new PrepareController(
    next,
    f.host.prepareJournal,
    noMutation,
  );
  const warm = new DesktopPreparationLifecycle();
  const warmRecovered = vi.fn();
  await warm.startAutomatic(
    {
      ...owner,
      start: () => warmController.start(),
      cancel: () => warmController.cancel(),
      settle: async (task) => {
        await task;
        expect(warmController.isRunning()).toBe(false);
      },
      ready: warmRecovered,
    },
    () => true,
  );
  expect(warmController.view().state).toBe("ready");
  expect(warmRecovered).toHaveBeenCalledOnce();
  expect(noMutation.beforeMutation).not.toHaveBeenCalled();
  expect(nativeFixture.fullInventoryChecks).toBe(checks);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(f.events).toEqual(before);
  expect(next.startupMeasurement()).toMatchObject({
    ready: true,
  });
  await cold.close();
  await warm.close();
});
it("composes genuine signed ZIP transfer/extraction, injected owned qualification, receipt-last activation and a cheap offline second controller", async () => {
  const f = await fixture();
  expect(await f.controller.start()).toMatchObject({
    state: "ready",
    browser: "attention-needed",
  });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(await readFile(f.path(`models\\${MODEL.filename}`))).toEqual(f.model);
  expect(
    await readFile(
      f.path(`runtime\\releases\\${f.target}\\release-manifest.json`),
    ),
  ).toEqual(
    await readFile(join(f.root, "fixture-assembly", "release-manifest.json")),
  );
  const ready = parseReadyReceipt(
    JSON.parse(f.vault.get("ready_receipt")!.toString()),
    { sid: f.host.identity.sid, identity: f.target },
    "e".repeat(64),
  );
  expect(ready.receipt.manifestSha256).toBe(f.manifestSha);
  expect(ready.receipt.modelFingerprint.fileId).toBe(
    String(
      (await lstat(f.path(`models\\${MODEL.filename}`), { bigint: true })).ino,
    ),
  );
  expect(f.events.indexOf("positive-job-teardown")).toBeLessThan(
    f.events.indexOf("vault:ready_receipt"),
  );
  expect(f.events.indexOf("physical-release")).toBeLessThan(
    f.events.indexOf("vault:ready_receipt"),
  );
  expect(f.events.at(-1)).toBe("maintenance-release");
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(false);
  await expect(
    readFile(f.path(`prepare\\downloads\\runtime-${f.target}.zip`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(f.path("staging"))).toEqual([]);
  const before = [...f.events];
  const next = new WindowsPreparationOperations(
    f.host,
    f.resources,
    async () => true,
    undefined,
    { fetch: f.fetcher as typeof fetch },
  );
  const noMaintenance = {
    beforeMutation: vi.fn(async () => {
      throw new Error("warm startup must not retire a worker");
    }),
  };
  expect(
    (
      await new PrepareController(
        next,
        f.host.prepareJournal,
        noMaintenance,
      ).start()
    ).state,
  ).toBe("ready");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(noMaintenance.beforeMutation).not.toHaveBeenCalled();
  expect(f.events).toEqual(before);
  expect(next.startupMeasurement()).toMatchObject({
    ready: true,
    reason: "verified",
    filesChecked:
      f.manifest.entries.filter((entry) => entry.kind === "file").length + 3,
  });
});
it("a signed archive missing a delayed private DLL fails actual extracted-stage audit before any proof, final rename, model or GPU work", async () => {
  const f = await fixture(true);
  expect((await f.controller.start()).state).toBe("error");
  expect(f.controller.view().errorComponent ?? null).toBeNull();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.vault.has(`runtime_${f.target.slice(0, 56)}`)).toBe(false);
  expect(f.vault.has("ready_receipt")).toBe(false);
  expect(f.events).not.toContain("model-fetch");
  expect(f.events).not.toContain("physical-acquire");
  await expect(
    lstat(f.path(`runtime\\releases\\${f.target}`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(f.path("staging"))).toEqual([]);
});
it("only actual model transfer verification produces model assistance; retry and readonly success clear the cause", async () => {
  const f = await fixture(),
    original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (raw: string | URL) =>
    raw.toString() === MODEL.url
      ? new Response(new Uint8Array(Buffer.alloc(f.model.length, 88)), {
          headers: { "Content-Length": String(f.model.length) },
        })
      : original(raw),
  );
  expect(await f.controller.start()).toMatchObject({
    state: "error",
    errorComponent: "model",
  });
  expect(f.events).not.toContain("owned-qualification");
  f.fetcher.mockImplementation(original);
  expect(await f.controller.start({ repair: true })).toMatchObject({
    state: "ready",
    errorComponent: null,
  });
  expect(await f.controller.check()).toMatchObject({
    state: "ready",
    errorComponent: null,
  });
});
it("actual Operations warm snapshot status reads authenticated fingerprints/tiny manifest only; full execution snapshots still verify every runtime byte", async () => {
  const f = await fixture();
  expect((await f.controller.start()).state).toBe("ready");
  const next = new WindowsPreparationOperations(
    f.host,
    f.resources,
    async () => true,
    undefined,
    { fetch: f.fetcher as typeof fetch },
  );
  await next.target(new AbortController().signal);
  const checks = nativeFixture.fullInventoryChecks,
    events = [...f.events];
  expect(
    await next.snapshotReadyStatus(new AbortController().signal),
  ).toMatchObject({ release: f.target, manifestSha256: f.manifestSha });
  expect(
    await next.snapshotMediaToolsStatus(new AbortController().signal),
  ).toMatchObject({ manifestSha256: f.manifestSha });
  expect(nativeFixture.fullInventoryChecks).toBe(checks);
  expect(f.events).toEqual(events);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  await next.snapshotReady(new AbortController().signal);
  expect(nativeFixture.fullInventoryChecks).toBe(checks + 1);
  await next.snapshotMediaTools(new AbortController().signal);
  expect(nativeFixture.fullInventoryChecks).toBe(checks + 2);
});
it("a runtime status marker failure preserves a verified canonical runtime and Ready instead of starting corrupt-runtime replacement", async () => {
  const f = await fixture();
  expect((await f.controller.start()).state).toBe("ready");
  const ready = Buffer.from(f.vault.get("ready_receipt")!),
    proof = Buffer.from(f.vault.get(`runtime_${f.target.slice(0, 56)}`)!),
    final = f.path(`runtime\\releases\\${f.target}`),
    before = await lstat(final, { bigint: true }),
    originalWrite = f.native.vaultWrite.getMockImplementation()!,
    target = await f.operations.target(new AbortController().signal),
    lease = await f.operations.lock(target);
  expect(lease).not.toBeNull();
  f.assertMutation.mockClear();
  f.native.vaultWrite.mockImplementation(async (namespace, key, bytes) => {
    if (key === "runtime_status") throw new Error("CACHE_WRITE_ACK_LOST");
    return originalWrite(namespace, key, bytes);
  });
  try {
    await expect(
      f.operations.perform(
        "runtime",
        target,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("CACHE_WRITE_ACK_LOST");
    expect(f.assertMutation).not.toHaveBeenCalled();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.vault.get("ready_receipt")).toEqual(ready);
    expect(f.vault.get(`runtime_${f.target.slice(0, 56)}`)).toEqual(proof);
    expect((await lstat(final, { bigint: true })).ino).toBe(before.ino);
    expect(f.vault.has(RUNTIME_REPAIR_KEY)).toBe(false);
    expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(false);
    expect(f.native.removeRuntimeRepairBackup).not.toHaveBeenCalled();
  } finally {
    f.native.vaultWrite.mockImplementation(originalWrite);
    await lease!.release();
  }
});
it("actual signed ZIP/Operations supports a complete private runtime above8192 files and warm controller status performs no inventory rehash", async () => {
  const f = await fixture(false, 8300);
  expect((await f.controller.start()).state).toBe("ready");
  const covered =
    f.manifest.entries.filter((entry) => entry.kind === "file").length + 3;
  expect(covered).toBeGreaterThan(8192);
  expect(JSON.parse(f.vault.get("startup_receipt")!.toString()).version).toBe(
    3,
  );
  const checks = nativeFixture.fullInventoryChecks,
    events = [...f.events],
    next = new WindowsPreparationOperations(
      f.host,
      f.resources,
      async () => true,
      undefined,
      { fetch: f.fetcher as typeof fetch },
    );
  const selected = await next.target(new AbortController().signal);
  expect(await next.cachedReady(selected, new AbortController().signal)).toBe(
    true,
  );
  expect(next.startupMeasurement()?.filesChecked).toBe(covered);
  expect(
    await next.snapshotReadyStatus(new AbortController().signal),
  ).toMatchObject({ release: f.target });
  expect(nativeFixture.fullInventoryChecks).toBe(checks);
  expect(f.events).toEqual(events);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
}, 120000);
it("runtime-only CPU status stays available after model removal/current witness change and never queries a GPU; local ready status refuses both", async () => {
  const f = await fixture();
  expect((await f.controller.start()).state).toBe("ready");
  await rm(f.path(`models\\${MODEL.filename}`));
  f.native.bootIdentity.mockResolvedValue("f".repeat(64));
  const next = new WindowsPreparationOperations(
    f.host,
    f.resources,
    async () => true,
    undefined,
    { fetch: f.fetcher as typeof fetch },
  );
  f.native.bootIdentity.mockRejectedValue(new Error("GPU witness unavailable"));
  f.native.bootIdentity.mockClear();
  f.native.enumerateGpus.mockClear();
  const checks = nativeFixture.fullInventoryChecks;
  expect(
    await next.snapshotMediaToolsStatus(new AbortController().signal),
  ).toMatchObject({ manifestSha256: f.manifestSha });
  expect(f.native.bootIdentity).not.toHaveBeenCalled();
  expect(f.native.enumerateGpus).not.toHaveBeenCalled();
  expect(nativeFixture.fullInventoryChecks).toBe(checks);
  await expect(
    next.snapshotReadyStatus(new AbortController().signal),
  ).rejects.toThrow("GPU witness unavailable");
});
it("repairs corrupt installed bytes only through actual Setup/mutation proof, exact backup and injected native cleanup after requalification", async () => {
  const f = await fixture();
  expect((await f.controller.start()).state).toBe("ready");
  const relative = `runtime\\releases\\${f.target}`;
  const before = await lstat(f.path(relative), { bigint: true });
  await writeFile(
    f.path(`${relative}\\runtime\\node\\node.exe`),
    "damaged private executable",
  );
  await writeFile(join(f.root, "user-audio.wav"), "never altered");
  const start = f.events.length;
  expect((await f.controller.start({ repair: true })).state).toBe("ready");
  expect(f.assertMutation).toHaveBeenCalled();
  expect((await lstat(f.path(relative), { bigint: true })).ino).not.toBe(
    before.ino,
  );
  expect(f.cleanupEvidence[0]).toMatchObject({
    backupInode: String(before.ino),
    damagedBytes: "damaged private executable",
  });
  expect(
    await readFile(f.path(`${relative}\\runtime\\node\\node.exe`)),
  ).toEqual(fixturePe64([]));
  const repair = f.cleanupEvidence[0]!.row;
  expect(repair).toMatchObject({
    phase: "activated",
    target: f.target,
    previousManifestSha256: f.manifestSha,
    manifestSha256: f.manifestSha,
  });
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(false);
  expect(f.vault.has(RUNTIME_REPAIR_KEY)).toBe(false);
  await expect(lstat(f.path(RUNTIME_BACKUP_PATH))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const events = f.events.slice(start);
  expect(events.indexOf("mutation-proof")).toBeLessThan(
    events.indexOf("runtime-fetch"),
  );
  expect(events.indexOf("positive-job-teardown")).toBeLessThan(
    events.indexOf("vault:ready_receipt"),
  );
  expect(await readFile(join(f.root, "user-audio.wav"), "utf8")).toBe(
    "never altered",
  );
  const next = new WindowsPreparationOperations(
    f.host,
    f.resources,
    async () => true,
    undefined,
    { fetch: f.fetcher as typeof fetch },
  );
  const noMutation = {
    beforeMutation: vi.fn(async () => {
      throw new Error("ordinary warm startup must stay readonly");
    }),
  };
  expect(
    (
      await new PrepareController(
        next,
        f.host.prepareJournal,
        noMutation,
      ).start()
    ).state,
  ).toBe("ready");
  expect(noMutation.beforeMutation).not.toHaveBeenCalled();
  expect(f.native.removeRuntimeRepairBackup).toHaveBeenCalledOnce();
  // A later corruption is not blocked by the first repair's fixed bank. The
  // injected native retirement uses installed metadata, not damaged old bytes.
  await rm(f.path(`${relative}\\release-manifest.json`));
  expect((await f.controller.start({ repair: true })).state).toBe("ready");
  expect(f.native.removeRuntimeRepairBackup).toHaveBeenCalledTimes(2);
  expect(f.vault.has(RUNTIME_REPAIR_KEY)).toBe(false);
  await expect(lstat(f.path(RUNTIME_BACKUP_PATH))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("an unknown file in a corrupt runtime remains untouched; pre-effect failure cancels only owned staging and releases Setup", async () => {
  const f = await fixture();
  expect((await f.controller.start()).state).toBe("ready");
  const relative = `runtime\\releases\\${f.target}`;
  await writeFile(f.path(`${relative}\\runtime\\node\\node.exe`), "damaged");
  await writeFile(
    f.path(`${relative}\\unknown-user.wav`),
    "keep this unknown audio",
  );
  expect((await f.controller.start({ repair: true })).state).toBe("error");
  expect(f.controller.isRunning()).toBe(true);
  await f.controller.cancel();
  expect(f.controller.isRunning()).toBe(false);
  expect(f.operations.cleanupPending()).toBe(false);
  expect(f.vault.has(RUNTIME_REPAIR_KEY)).toBe(false);
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(false);
  expect(f.native.removeRuntimeRepairBackup).not.toHaveBeenCalled();
  expect(await readFile(f.path(`${relative}\\unknown-user.wav`), "utf8")).toBe(
    "keep this unknown audio",
  );
});
it("an existing corrupt runtime cannot be replaced by a direct caller without the held Setup/retired coordinator proof", async () => {
  const f = await fixture();
  expect((await f.controller.start()).state).toBe("ready");
  await writeFile(
    f.path(`runtime\\releases\\${f.target}\\runtime\\node\\node.exe`),
    "damaged",
  );
  const selected = await f.operations.target(new AbortController().signal);
  await expect(
    f.operations.perform(
      "runtime",
      selected,
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("BUSY");
  expect(f.vault.has(RUNTIME_REPAIR_KEY)).toBe(false);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("a runtime proof-write fault removes only closed owned extraction and retry reuses exact signed cached bytes", async () => {
  const f = await fixture();
  const original = f.native.vaultWrite.getMockImplementation()!;
  let faulted = false;
  f.native.vaultWrite.mockImplementation(async (namespace, key, bytes) => {
    if (key.startsWith("runtime_") && key !== "runtime_sequence" && !faulted) {
      faulted = true;
      throw new Error("proof disk fault");
    }
    return original(namespace, key, bytes);
  });
  expect((await f.controller.start()).state).toBe("error");
  expect(f.vault.has("ready_receipt")).toBe(false);
  expect(f.vault.has(RUNTIME_STAGING_KEY)).toBe(false);
  await expect(readFile(f.path(RUNTIME_STAGING_PATH))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect((await f.controller.start({ repair: true })).state).toBe("ready");
  expect(f.fetcher).toHaveBeenCalledTimes(2); // model only; verified archive reused
});
it("activation receipt/sequence ACK faults never advertise Ready and retry preserves the exact published release", async () => {
  const f = await fixture();
  const original = f.native.vaultWrite.getMockImplementation()!;
  let faulted = false;
  f.native.vaultWrite.mockImplementation(async (namespace, key, bytes) => {
    await original(namespace, key, bytes);
    if (key === "runtime_sequence" && !faulted) {
      faulted = true;
      throw new Error("lost sequence ACK");
    }
  });
  expect((await f.controller.start()).state).toBe("error");
  const release = f.path(`runtime\\releases\\${f.target}`),
    before = await lstat(release, { bigint: true });
  expect((await f.controller.start({ repair: true })).state).toBe("ready");
  expect((await lstat(release, { bigint: true })).ino).toBe(before.ino);
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("expired exact active metadata permits offline installed reuse but never a fresh missing model download", async () => {
  const f = await fixture();
  expect((await f.controller.start()).state).toBe("ready");
  const active = JSON.parse(f.vault.get("ready_receipt")!.toString());
  const signed = JSON.parse(
    await readFile(
      join(f.resources, "runtime", "runtime-metadata.json"),
      "utf8",
    ),
  );
  // Signature validity is genuine at activation time. Advance only the loader's
  // clock; no expiry rewrite or fabricated active identity is accepted.
  const { loadPreparationBundle } =
    await import("../src/main/prepare/bundle.js");
  const offline = await loadPreparationBundle(
    f.resources,
    1,
    new Date(Date.parse(signed.metadata.expiresAt) + 1),
    active,
  );
  expect(offline.allowNetwork).toBe(false);
  await rm(f.path(`models\\${MODEL.filename}`));
  const next = new WindowsPreparationOperations(
    f.host,
    f.resources,
    async () => false,
    async () => offline,
    { fetch: f.fetcher as typeof fetch },
  );
  const selected = await next.target(new AbortController().signal);
  await expect(
    next.perform("model", selected, new AbortController().signal, () => {}),
  ).rejects.toThrow("INTEGRITY_INVALID");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("uncertain actual owned-qualification cleanup retains Prepare+maintenance and publishes no Ready receipt", async () => {
  const f = await fixture();
  f.state.stopFailure = true;
  expect((await f.controller.start()).state).toBe("error");
  expect(f.controller.isRunning()).toBe(true);
  expect(f.vault.has("ready_receipt")).toBe(false);
  expect(f.events).not.toContain("physical-release");
  expect(f.events).not.toContain("maintenance-release");
  expect(
    f.native.releaseMutex.mock.calls.some(
      ([lease]) => lease.scope === "prepare",
    ),
  ).toBe(false);
  f.state.stopFailure = false;
  await f.controller.cancel();
  expect(f.controller.isRunning()).toBe(false);
  expect(f.events.slice(-4)).toEqual([
    "positive-job-teardown",
    "physical-release",
    "helper-close",
    "maintenance-release",
  ]);
});
it("warm activation recovers completed archive deletion without another download/GPU/maintenance, while readonly check leaves it intact", async () => {
  const f = await fixture();
  expect((await f.controller.start()).state).toBe("ready");
  const relative = `prepare\\downloads\\runtime-${f.target}.zip`;
  await writeFile(f.path(relative), f.archive);
  const before = [...f.events];
  const next = new WindowsPreparationOperations(
    f.host,
    f.resources,
    async () => true,
    undefined,
    { fetch: f.fetcher as typeof fetch },
  );
  const admission = {
    beforeMutation: vi.fn(async () => {
      throw new Error(
        "no mutation admission for disposable archive retirement",
      );
    }),
  };
  const controller = new PrepareController(
    next,
    f.host.prepareJournal,
    admission,
  );
  expect((await controller.check()).state).toBe("ready");
  expect(await readFile(f.path(relative))).toEqual(f.archive);
  expect((await controller.start()).state).toBe("ready");
  await expect(readFile(f.path(relative))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(admission.beforeMutation).not.toHaveBeenCalled();
  expect(f.events).toEqual(before);
});
