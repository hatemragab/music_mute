import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  lstat,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import type {
  WindowsConsumerNative,
  ConsumerInstallerPin,
  ConsumerInstallerLaunchStatus,
} from "../../worker/src/platform/windows/consumer-native.js";
import type { SessionClient } from "../src/main/session/control.js";
import {
  canonicalConsumerUpdate,
  consumerUpdateIdentity,
} from "../src/main/update/metadata.js";
import { canonicalUpdateMetadata } from "../../worker/src/platform/shared/update-metadata.js";
import { preparationTargetIdentity } from "../src/main/prepare/bundle.js";
import { createWindowsConsumerUpdater } from "../src/main/update/factory.js";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import { receipt, sid } from "./fixtures/prepare.js";
import type { ConsumerUpdateMetadata } from "../src/shared/update-contracts.js";

// GPU/runtime-inventory/installer/session boundaries are fixture adapters; model bytes/hashes, backup files and updater factory are real.
const state = vi.hoisted(() => ({
  fault: "",
  events: [] as string[],
  pendingSave: false,
  sessionUnavailable: false,
}));
vi.mock("../../chrome-extension/src/shared/local-model.js", async () => {
  const { createHash } = await import("node:crypto"),
    bytes = Buffer.from("synthetic pinned model for updater fixtures");
  return {
    MODEL: {
      filename: "Kim_Vocal_2.onnx",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      url: "https://models.example.invalid/model.onnx",
    },
  };
});
vi.mock("../src/main/library/pins.js", () => ({
  LibraryPins: class {
    async hasLiveConsumers() {
      return false;
    }
  },
}));
vi.mock("../src/main/outbox/store.js", () => ({
  WindowsOutboxStore: class {
    async list() {
      return state.pendingSave
        ? [{ state: "capturing", captured: false, copiesReleased: false }]
        : [];
    }
  },
}));
vi.mock("../src/main/session/maintenance.js", () => ({
  createSessionMaintenancePort: () => ({
    acquire: async () => {
      if (state.sessionUnavailable) throw new Error("SESSION_UNAVAILABLE");
      state.events.push("session:fence");
      return {
        release: async () => {
          state.events.push("session:release");
        },
        commit: async () => {
          state.events.push("session:commit");
        },
      };
    },
  }),
}));
vi.mock("../src/main/session/desktop-client.js", () => ({
  activateDesktopSession: async () => {
    state.events.push("activation:session");
  },
}));
vi.mock("../src/main/browser/registration.js", () => ({
  registerBrowserIntegration: async () => true,
  verifyBrowserIntegration: async () => true,
}));
vi.mock("../src/main/prepare/private-files.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/main/prepare/private-files.js")
  >("../src/main/prepare/private-files.js");
  const path = (host: HostContext, relative: string) =>
    join(host.personalRoot, ...relative.split("\\"));
  return {
    ...actual,
    readPrivateBytes: async (host: HostContext, relative: string) =>
      readFile(path(host, relative)),
    writePrivateAtomic: async (
      host: HostContext,
      relative: string,
      bytes: Buffer,
    ) => writeFile(path(host, relative), bytes),
    privateFingerprint: async (host: HostContext, relative: string) => {
      const s = await lstat(path(host, relative), { bigint: true });
      return {
        device: String(s.dev),
        fileId: String(s.ino),
        bytes: Number(s.size),
        writtenAt: String(s.mtimeNs),
        changedAt: String(s.ctimeNs),
      };
    },
    verifyPrivateFile: async (
      host: HostContext,
      relative: string,
      expectedBytes: number,
      signal: AbortSignal,
    ) => {
      signal.throwIfAborted();
      await host.native.validatePath("personal", relative, "file");
      const before = await lstat(path(host, relative), { bigint: true }),
        bytes = await readFile(path(host, relative)),
        after = await lstat(path(host, relative), { bigint: true });
      if (
        bytes.length !== expectedBytes ||
        before.ino !== after.ino ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new Error("INTEGRITY_INVALID");
      return {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        fingerprint: {
          device: String(after.dev),
          fileId: String(after.ino),
          bytes: Number(after.size),
          writtenAt: String(after.mtimeNs),
          changedAt: String(after.ctimeNs),
        },
      };
    },
  };
});
vi.mock("../src/main/prepare/operations.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/main/prepare/operations.js")
  >("../src/main/prepare/operations.js");
  return {
    ...actual,
    WindowsPreparationOperations: class {
      private qualified = false;
      constructor(
        private host: HostContext,
        _resources: string,
        _registration: unknown,
        private loader: () => Promise<{
          targetIdentity: string;
          metadata: {
            sequence: number;
            release: { sha256: string };
            releaseVersion: string;
          };
        }>,
      ) {}
      async target() {
        return {
          sid: this.host.identity.sid,
          identity: (await this.loader()).targetIdentity,
        };
      }
      async perform(stage: string, target: { identity: string }) {
        state.events.push(`prepare:${stage}`);
        if (stage === "gpu" && state.fault === "gpu") {
          await writeFile(
            join(this.host.personalRoot, "models", MODEL.filename),
            "corrupted by failed activation",
          );
          throw new Error("UPDATE_HEALTH_FAILED");
        }
        if (stage === "gpu") this.qualified = true;
        if (stage === "activate") {
          const b = await this.loader(),
            old = JSON.parse(
              (await this.host.native.vaultRead(
                "account",
                "ready_receipt",
              ))!.toString("utf8"),
            );
          const fingerprint = await lstat(
            join(this.host.personalRoot, "models", MODEL.filename),
            { bigint: true },
          );
          const next = {
            ...old,
            modelFingerprint: {
              device: String(fingerprint.dev),
              fileId: String(fingerprint.ino),
              bytes: MODEL.bytes,
              writtenAt: String(fingerprint.mtimeNs),
              changedAt: String(fingerprint.ctimeNs),
            },
            target: target.identity,
            release: target.identity,
            sequence: b.metadata.sequence,
            manifestSha256: "f".repeat(64),
            qualification: {
              ...old.qualification,
              releaseManifestDigest: "f".repeat(64),
            },
          };
          await this.host.native.vaultWrite(
            "account",
            "ready_receipt",
            Buffer.from(JSON.stringify(next)),
          );
          await this.host.native.vaultWrite(
            "account",
            "runtime_sequence",
            Buffer.from(
              JSON.stringify({ version: 1, sequence: b.metadata.sequence }),
            ),
          );
        }
      }
      async verifyReady(target: { identity: string }) {
        if (!this.qualified) return false;
        const row = JSON.parse(
          (await this.host.native.vaultRead(
            "account",
            "ready_receipt",
          ))!.toString("utf8"),
        );
        const hash = createHash("sha256")
          .update(
            await readFile(
              join(this.host.personalRoot, "models", MODEL.filename),
            ),
          )
          .digest("hex");
        return row.target === target.identity && hash === MODEL.sha256;
      }
      async registerBrowser() {
        return true;
      }
      async recaptureStartupReceipt() {
        state.events.push("startup:recaptured");
      }
      async snapshotMediaTools() {
        const row = JSON.parse(
          (await this.host.native.vaultRead(
            "account",
            "ready_receipt",
          ))!.toString(),
        );
        return { manifestSha256: row.manifestSha256 };
      }
      async requalifyInstalled() {
        const row = JSON.parse(
            (await this.host.native.vaultRead(
              "account",
              "ready_receipt",
            ))!.toString(),
          ),
          file = join(this.host.personalRoot, "models", MODEL.filename),
          bytes = await readFile(file),
          s = await lstat(file, { bigint: true });
        if (createHash("sha256").update(bytes).digest("hex") !== MODEL.sha256)
          throw new Error("INTEGRITY_INVALID");
        state.events.push("prepare:rollback-qualify");
        await this.host.native.vaultWrite(
          "account",
          "ready_receipt",
          Buffer.from(
            JSON.stringify({
              ...row,
              version: 2,
              bootIdentity: await this.host.native.bootIdentity(),
              modelFingerprint: {
                device: String(s.dev),
                fileId: String(s.ino),
                bytes: bytes.length,
                writtenAt: String(s.mtimeNs),
                changedAt: String(s.ctimeNs),
              },
            }),
          ),
        );
      }
      async snapshotReady() {
        if (state.fault === "current-gpu")
          throw new Error("GPU_QUALIFICATION_REQUIRED");
        const row = JSON.parse(
            (await this.host.native.vaultRead(
              "account",
              "ready_receipt",
            ))!.toString("utf8"),
          ),
          bundle = await this.loader();
        const fingerprint = await lstat(
          join(this.host.personalRoot, "models", MODEL.filename),
          { bigint: true },
        );
        if (row.modelFingerprint.fileId !== String(fingerprint.ino))
          throw new Error("UPDATE_HEALTH_FAILED");
        return {
          release: row.release,
          archiveSha256: bundle.metadata.release.sha256,
          manifestSha256: row.manifestSha256,
          modelSha256: row.modelSha256,
          nativeSha256: "d".repeat(64),
          qualification: row.qualification,
          evidence: actual.parseReadyReceipt(
            row,
            {
              sid: row.sid,
              identity: row.target,
            },
            await this.host.native.bootIdentity(),
          ).evidence,
        };
      }
    },
  };
});
vi.mock("../src/main/update/storage.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/main/update/storage.js")
  >("../src/main/update/storage.js");
  return {
    ...actual,
    ConsumerUpdateStager: class {
      constructor(private host: HostContext) {}
      async stage(
        metadata: ConsumerUpdateMetadata,
        _transaction: string,
        _signal: AbortSignal,
        components: readonly string[] = ["app", "runtime", "model"],
      ) {
        const root = join(
          this.host.personalRoot,
          "updates",
          "staging",
          consumerUpdateIdentity(metadata),
        );
        await mkdir(root, { recursive: true });
        if (components.includes("model"))
          await writeFile(
            join(root, "model.onnx"),
            "synthetic pinned model for updater fixtures",
          );
        state.events.push("stage");
        state.events.push(`stage:${components.join(",")}`);
      }
      async verifyStage() {
        state.events.push("stage:verified");
      }
      async cleanup() {
        state.events.push("cleanup");
      }
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  state.events = [];
  state.fault = "";
  state.pendingSave = false;
  state.sessionUnavailable = false;
});
async function fixture(appUpdate = false, cold = false) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-update-factory-"));
  roots.push(root);
  const resources = join(root, "resources"),
    personal = join(root, "personal");
  await mkdir(join(resources, "runtime"), { recursive: true });
  await mkdir(join(personal, "models"), { recursive: true });
  const model = Buffer.from("synthetic pinned model for updater fixtures");
  await writeFile(join(personal, "models", MODEL.filename), model);
  const keys = generateKeyPairSync("ed25519"),
    publicKeys = {
      fixture: keys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    };
  await writeFile(
    join(resources, "update-channel.json"),
    JSON.stringify({
      version: 1,
      feed: "https://updates.example.invalid/stable.json",
      allowedOrigins: ["https://updates.example.invalid"],
      publisherSha256: "9".repeat(64),
      publicKeys,
    }),
  );
  await writeFile(
    join(resources, "runtime-public-keys.json"),
    JSON.stringify(publicKeys),
  );
  await writeFile(
    join(resources, "app-update-identity.json"),
    JSON.stringify({
      version: 1,
      appVersion: "1.0.0",
      payloadSha256: "a".repeat(64),
    }),
  );
  const old = {
    schemaVersion: 1 as const,
    installationProfile: "windows-user" as const,
    platform: "windows-amd64" as const,
    sequence: 1,
    releaseVersion: "1.0.0",
    publishedAt: "2026-10-08T00:00:00Z",
    expiresAt: "2027-10-08T00:00:00Z",
    release: {
      filename: "runtime.zip",
      bytes: 100,
      sha256: "1".repeat(64),
      contentType: "application/zip" as const,
    },
  };
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
  const original = receipt();
  original.target = preparationTargetIdentity(old);
  original.release = original.target;
  const st = await lstat(join(personal, "models", MODEL.filename), {
    bigint: true,
  });
  original.modelFingerprint = {
    device: String(st.dev),
    fileId: String(st.ino),
    bytes: MODEL.bytes,
    writtenAt: String(st.mtimeNs),
    changedAt: String(st.ctimeNs),
  };
  const data = new Map<string, Buffer>([
      ["account:ready_receipt", Buffer.from(JSON.stringify(original))],
    ]),
    writes: string[] = [];
  const identity = {
    sid,
    sessionId: 1,
    pid: 12345,
    creationTime: "133000000000000000",
    osBuild: 19045,
  };
  const installerStatuses = new Map<string, ConsumerInstallerLaunchStatus>();
  const native = {
    bootIdentity: async () => "e".repeat(64),
    vaultRead: async (namespace: string, key: string) =>
      data.has(`${namespace}:${key}`)
        ? Buffer.from(data.get(`${namespace}:${key}`)!)
        : null,
    vaultWrite: async (namespace: string, key: string, bytes: Buffer) => {
      writes.push(`${namespace}:${key}`);
      data.set(`${namespace}:${key}`, Buffer.from(bytes));
    },
    vaultDelete: async (namespace: string, key: string) => {
      data.delete(`${namespace}:${key}`);
    },
    acquireMutex: async (scope: string) => ({
      scope,
      nonce: "a".repeat(64),
      identity,
      abandoned: false,
    }),
    releaseMutex: async () => {},
    validatePath: async (
      _namespace: string,
      relative: string,
      kind: string,
    ) => {
      const path = join(personal, ...relative.split("\\"));
      if (kind === "absent") {
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
        return;
      }
      const stat = await lstat(path);
      if (
        stat.isSymbolicLink() ||
        (kind === "file" && (!stat.isFile() || stat.nlink !== 1))
      )
        throw new Error("ACL_UNSAFE");
    },
    processIdentity: async () => null,
    verifyInstaller: vi.fn(async () => {}),
    removeCompletedInstallerMonitor: vi.fn(async () => true),
    inspectInstallerLaunch: vi.fn(
      async (pin: ConsumerInstallerPin) =>
        installerStatuses.get(pin.identity) ?? {
          state: "absent",
          certificate: null,
        },
    ),
    recoverInstallerLaunch: vi.fn(
      async (pin: ConsumerInstallerPin) =>
        installerStatuses.get(pin.identity) ?? {
          state: "absent",
          certificate: null,
        },
    ),
    launchInstaller: vi.fn(async (pin: ConsumerInstallerPin) => {
      installerStatuses.set(pin.identity, {
        state: "running",
        certificate: {
          version: 1,
          nonce: "b".repeat(64),
          pin,
          monitor: { ...identity, pid: 23456 },
          process: identity,
          exitCode: null,
          treeExited: false,
        },
      });
      return identity;
    }),
    waitProcessExit: vi.fn(async () => true),
    removeUnusedRelease: async () => false,
  } as unknown as WindowsConsumerNative;
  const host = {
    native,
    identity,
    personalRoot: personal,
    directory: async (relative: string) => {
      const path = join(personal, ...relative.split("\\"));
      await mkdir(path, { recursive: true });
      return path;
    },
    prepareJournal: { write: async () => {} },
  } as unknown as HostContext;
  const metadata: ConsumerUpdateMetadata = {
    schemaVersion: 1,
    installationProfile: "windows-user",
    platform: "windows-amd64",
    channel: "stable",
    sequence: 2,
    publishedAt: "2026-10-09T00:00:00Z",
    expiresAt: "2027-10-09T00:00:00Z",
    dataSchema: 1,
    publisherSha256: "9".repeat(64),
    app: {
      version: appUpdate ? "2.0.0" : "1.0.0",
      payloadSha256: (appUpdate ? "5" : "a").repeat(64),
      artifact: {
        filename: "app.exe",
        url: "https://updates.example.invalid/app.exe",
        bytes: 10,
        sha256: "2".repeat(64),
        contentType: "application/x-msdownload",
      },
    },
    runtime: {
      version: "2.0.0",
      minimumAppVersion: "1.0.0",
      artifact: {
        filename: "runtime.zip",
        url: "https://updates.example.invalid/runtime.zip",
        bytes: 10,
        sha256: "3".repeat(64),
        contentType: "application/zip",
      },
    },
    model: {
      version: "1.0.0",
      minimumRuntimeVersion: "1.0.0",
      artifact: {
        filename: "model.onnx",
        url: "https://updates.example.invalid/model.onnx",
        bytes: MODEL.bytes,
        sha256: MODEL.sha256,
        contentType: "application/octet-stream",
      },
    },
    required: {
      minimumAppVersion: "1.0.0",
      minimumRuntimeVersion: "1.0.0",
      minimumModelVersion: "1.0.0",
    },
  };
  const signed = {
    metadata,
    keyId: "fixture",
    signature: sign(
      null,
      Buffer.from(canonicalConsumerUpdate(metadata)),
      keys.privateKey,
    ).toString("base64url"),
  };
  const rollbackMetadata = {
    ...metadata,
    sequence: 1,
    app: { ...metadata.app, version: "1.0.0", payloadSha256: "a".repeat(64) },
    runtime: {
      ...metadata.runtime,
      version: "1.0.0",
      artifact: { ...metadata.runtime.artifact, sha256: "1".repeat(64) },
    },
  };
  const rollbackSigned = {
    metadata: rollbackMetadata,
    keyId: "fixture",
    signature: sign(
      null,
      Buffer.from(canonicalConsumerUpdate(rollbackMetadata)),
      keys.privateKey,
    ).toString("base64url"),
  };
  const activity = {
    acquire: vi.fn(async () => {
      state.events.push("activity:fence");
      return {
        assertIdle: async () => {
          state.events.push("activity:idle");
        },
        release: async () => {
          state.events.push("activity:release");
        },
        commit: async () => {
          state.events.push("activity:commit");
        },
      };
    }),
  };
  const options = {
    host,
    resourcesRoot: resources,
    native,
    session: { currentAuthority: () => null } as unknown as SessionClient,
    consumerActivity: activity,
    onSessionRetired: async () => {
      state.events.push("session:retired");
    },
    onInstallerStarted: vi.fn(async () => {
      const saved = JSON.parse(
        data.get("account:consumer_update_state")!.toString("utf8"),
      );
      expect(saved.journal.phase).toBe("restart-required");
    }),
    fetch: vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            appUpdate
              ? { current: signed, rollback: [rollbackSigned] }
              : signed,
          ),
          { headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch,
  };
  native.ensurePrivateDirectory = async (_namespace, relative = "") => {
    const path = join(personal, ...relative.split("\\"));
    await mkdir(path, { recursive: true });
    return path;
  };
  native.enumerateGpus = async () => [original.qualification.gpuIdentity];
  if (cold) data.delete("account:ready_receipt");
  return {
    options,
    data,
    writes,
    metadata,
    personal,
    original,
    model,
    activity,
    installerStatuses,
    controller: await createWindowsConsumerUpdater(options),
  };
}
it("consumer catalog factory stages only runtime/model, never an installer, and persists exact source for later installed-byte reads", async () => {
  const f = await fixture(),
    resources = f.options.resourcesRoot,
    channel = JSON.parse(
      await readFile(join(resources, "update-channel.json"), "utf8"),
    );
  await writeFile(
    join(resources, "worker-catalog-update-channel.json"),
    JSON.stringify({
      ...channel,
      feed: "https://updates.example.invalid/catalog.json",
    }),
  );
  const controller = await createWindowsConsumerUpdater(f.options);
  await controller.install(new AbortController().signal, "catalog");
  expect(state.events).toContain("stage:runtime,model");
  expect(state.events).not.toContain("stage:app,runtime,model");
  expect(f.options.native.launchInstaller).not.toHaveBeenCalled();
  expect(f.options.native.inspectInstallerLaunch).not.toHaveBeenCalled();
  const active = JSON.parse(
    f.data.get("account:consumer_update_active")!.toString(),
  );
  expect(active).toMatchObject({ source: "catalog" });
  expect(active.sourceDescriptor).toMatch(/^[a-f0-9]{64}$/u);
  const reopened = await createWindowsConsumerUpdater(f.options);
  await reopened.check(new AbortController().signal, false, "catalog");
  expect(reopened.snapshot().phase).toBe("current");
});
it("installs only app bytes after a stale witness while retaining attested runtime/model metadata and operational refusal", async () => {
  const f = await fixture(true),
    stored = JSON.parse(f.data.get("account:ready_receipt")!.toString());
  stored.bootIdentity = "f".repeat(64);
  f.data.set("account:ready_receipt", Buffer.from(JSON.stringify(stored)));
  const controller = await createWindowsConsumerUpdater(f.options);
  await controller.check(new AbortController().signal);
  expect(controller.snapshot().scope).toBe("app-only");
  await controller.install(new AbortController().signal);
  const journal = JSON.parse(
    f.data.get("account:consumer_update_state")!.toString(),
  ).journal;
  expect(journal.scope).toBe("app-only");
  expect(journal.previous.runtime).not.toBeNull();
  expect(journal.previous.model.sha256).toBe(MODEL.sha256);
  expect(state.events).toContain("stage:app");
  expect(state.events.some((event) => event.startsWith("prepare:"))).toBe(
    false,
  );
  expect(
    JSON.parse(f.data.get("account:ready_receipt")!.toString()).bootIdentity,
  ).toBe("f".repeat(64));
  expect(await readFile(join(f.personal, "models", MODEL.filename))).toEqual(
    f.model,
  );
});
it("a current-witness GPU refusal keeps attested installed metadata but stages only an app update", async () => {
  const f = await fixture(true);
  state.fault = "current-gpu";
  const controller = await createWindowsConsumerUpdater(f.options);
  await controller.check(new AbortController().signal);
  expect(controller.snapshot().scope).toBe("app-only");
  await controller.install(new AbortController().signal);
  const journal = JSON.parse(
    f.data.get("account:consumer_update_state")!.toString(),
  ).journal;
  expect(journal.previous.runtime).not.toBeNull();
  expect(journal.previous.model.sha256).toBe(MODEL.sha256);
  expect(state.events).toContain("stage:app");
  expect(state.events.some((e) => e.startsWith("prepare:"))).toBe(false);
});
it("actual updater factory reserves bounded backup before packets and captures immutable model bytes", async () => {
  const f = await fixture();
  await f.controller.install(new AbortController().signal);
  const reserved = f.writes.indexOf("account:consumer_update_backups"),
    packet = f.writes.findIndex((key) => key.startsWith("account:up_"));
  expect(reserved).toBeGreaterThanOrEqual(0);
  expect(reserved).toBeLessThan(packet);
  const id = consumerUpdateIdentity(f.metadata);
  expect(
    await readFile(join(f.personal, "updates", "backups", id, "model.onnx")),
  ).toEqual(f.model);
  expect(f.controller.snapshot().phase).toBe("complete");
  expect(state.events.indexOf("activity:fence")).toBeLessThan(
    state.events.indexOf("session:fence"),
  );
  expect(state.events.slice(-2)).toEqual(["activity:commit", "cleanup"]);
  expect(f.controller.snapshot().problem).toBeNull();
});
it("backup limit rejects activation without writing a fourth packet or archive", async () => {
  const f = await fixture();
  f.data.set(
    "account:consumer_update_backups",
    Buffer.from(
      JSON.stringify({
        version: 1,
        identities: ["4".repeat(64), "5".repeat(64), "6".repeat(64)],
      }),
    ),
  );
  await expect(
    f.controller.install(new AbortController().signal),
  ).rejects.toThrow("UPDATE_CLEANUP_PENDING");
  expect(f.writes.some((key) => key.startsWith("account:up_"))).toBe(false);
  expect(state.events.some((v) => v.startsWith("prepare:"))).toBe(false);
  expect(f.controller.snapshot().problem).toBe("UPDATE_CLEANUP_PENDING");
  await expect(
    lstat(
      join(
        f.personal,
        "updates",
        "backups",
        consumerUpdateIdentity(f.metadata),
      ),
    ),
  ).rejects.toMatchObject({ code: "ENOENT" });
});
it("failed qualification restores exact model bytes and rebinds old Ready file identity, preserving sequence floor", async () => {
  const f = await fixture();
  state.fault = "gpu";
  await expect(
    f.controller.install(new AbortController().signal),
  ).rejects.toThrow("UPDATE_HEALTH_FAILED");
  expect(f.controller.snapshot().phase).toBe("rolled-back");
  expect(await readFile(join(f.personal, "models", MODEL.filename))).toEqual(
    f.model,
  );
  const restored = JSON.parse(
      f.data.get("account:ready_receipt")!.toString("utf8"),
    ),
    st = await lstat(join(f.personal, "models", MODEL.filename), {
      bigint: true,
    });
  expect(restored.target).toBe(f.original.target);
  expect(restored.modelFingerprint.fileId).toBe(String(st.ino));
  const update = JSON.parse(
    f.data.get("account:consumer_update_state")!.toString("utf8"),
  );
  expect(update.highestSequence).toBe(2);
  expect(update.journal.phase).toBe("rolled-back");
  expect(state.events).toContain("activity:release");
  expect(state.events).toContain("startup:recaptured");
});
it("absent headless activity authority fails closed before backup or activation", async () => {
  const f = await fixture(),
    controller = await createWindowsConsumerUpdater({
      ...f.options,
      consumerActivity: undefined as never,
    });
  await expect(
    controller.install(new AbortController().signal),
  ).rejects.toThrow("UPDATE_ACTIVITY_UNAVAILABLE");
  expect(f.writes.some((key) => key.startsWith("account:up_"))).toBe(false);
  expect(state.events).not.toContain("session:fence");
});
it("pending original/account copy prevents maintenance and preserves protected data", async () => {
  const f = await fixture();
  state.pendingSave = true;
  await expect(
    f.controller.install(new AbortController().signal),
  ).rejects.toThrow("UPDATE_BUSY");
  expect(f.activity.acquire).not.toHaveBeenCalled();
  expect(await readFile(join(f.personal, "models", MODEL.filename))).toEqual(
    f.model,
  );
});
it("activity idle-proof failure releases its acquired fence and never starts session maintenance", async () => {
  const f = await fixture(),
    release = vi.fn(async () => {});
  f.activity.acquire.mockResolvedValueOnce({
    assertIdle: async () => {
      throw new Error("UPDATE_BUSY");
    },
    release,
    commit: async () => {},
  });
  await expect(
    f.controller.install(new AbortController().signal),
  ).rejects.toThrow("UPDATE_BUSY");
  expect(release).toHaveBeenCalledOnce();
  expect(state.events).not.toContain("session:fence");
});
it("an interrupted packet write is tracked and recovers before any activation", async () => {
  const f = await fixture(),
    write = f.options.native.vaultWrite.bind(f.options.native);
  let failed = false;
  vi.spyOn(f.options.native, "vaultWrite").mockImplementation(
    async (namespace, key, bytes) => {
      if (!failed && key.endsWith("_ready")) {
        failed = true;
        throw new Error("UPDATE_PACKET_WRITE_FAILED");
      }
      await write(namespace, key, bytes);
    },
  );
  await expect(
    f.controller.install(new AbortController().signal),
  ).rejects.toThrow("UPDATE_PACKET_WRITE_FAILED");
  expect(state.events.some((v) => v.startsWith("prepare:"))).toBe(false);
  expect(
    JSON.parse(f.data.get("account:consumer_update_backups")!.toString("utf8"))
      .identities,
  ).toEqual([consumerUpdateIdentity(f.metadata)]);
  await f.controller.recover(new AbortController().signal);
  expect(f.controller.snapshot().phase).toBe("complete");
  expect(await readFile(join(f.personal, "models", MODEL.filename))).toEqual(
    f.model,
  );
});
it("installer acknowledgement persists actual process birth and restart checkpoint before UI quit", async () => {
  const f = await fixture(true);
  await f.controller.install(new AbortController().signal);
  expect(f.controller.snapshot().phase).toBe("restart-required");
  expect(f.options.onInstallerStarted).toHaveBeenCalledOnce();
  const launch = JSON.parse(
    f.data.get("account:consumer_update_installer")!.toString("utf8"),
  );
  expect(launch.phase).toBe("running");
  expect(launch.nonce).toBe("b".repeat(64));
  expect(launch.pin.identity).toBe(consumerUpdateIdentity(f.metadata));
});
it("lost installer ACK keeps exact ambiguity and cannot relaunch or start rollback", async () => {
  const f = await fixture(true);
  vi.mocked(f.options.native.launchInstaller).mockRejectedValueOnce(
    new Error("HELPER_LOST"),
  );
  await expect(
    f.controller.install(new AbortController().signal),
  ).rejects.toThrow("UPDATE_INSTALLER_UNCONFIRMED");
  await expect(
    f.controller.recover(new AbortController().signal),
  ).rejects.toThrow("UPDATE_INSTALLER_UNCONFIRMED");
  expect(f.options.native.launchInstaller).toHaveBeenCalledOnce();
  expect(f.options.onInstallerStarted).not.toHaveBeenCalled();
  expect(
    JSON.parse(
      f.data.get("account:consumer_update_installer")!.toString("utf8"),
    ).phase,
  ).toBe("launching");
  expect(state.events).not.toContain("activity:release");
});
it("cold app update stages only installers and preserves absent readiness plus any unqualified model bytes", async () => {
  const f = await fixture(true, true);
  vi.spyOn(f.options.native, "enumerateGpus").mockRejectedValue(
    new Error("NO_GPU"),
  );
  await f.controller.install(new AbortController().signal);
  expect(f.controller.snapshot()).toMatchObject({
    phase: "restart-required",
    scope: "app-only",
  });
  expect(
    state.events.filter(
      (x) => x.startsWith("stage:") && !x.includes("verified"),
    ),
  ).toEqual(["stage:app", "stage:app"]);
  expect(state.events.some((x) => x.startsWith("prepare:"))).toBe(false);
  expect(f.options.native.enumerateGpus).not.toHaveBeenCalled();
  expect(f.data.has("account:ready_receipt")).toBe(false);
  expect(f.data.has("account:consumer_update_active")).toBe(false);
  const id = consumerUpdateIdentity(f.metadata),
    index = JSON.parse(
      f.data.get(`account:up_${id.slice(0, 40)}_index`)!.toString(),
    );
  expect(index.model).toBeNull();
  expect(index.previous).toMatchObject({ runtime: null, model: null });
  await expect(
    lstat(join(f.personal, "updates", "backups", id, "model.onnx")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.personal, "models", MODEL.filename))).toEqual(
    f.model,
  );
});
it("cold recovery completes only after certified tree exit and actual new packaged app identity without Prepare", async () => {
  const f = await fixture(true, true);
  await f.controller.install(new AbortController().signal);
  const id = consumerUpdateIdentity(f.metadata),
    status = f.installerStatuses.get(id)!;
  if (status.state === "absent") throw new Error();
  f.installerStatuses.set(id, {
    state: "completed",
    certificate: { ...status.certificate, exitCode: 0, treeExited: true },
  });
  await writeFile(
    join(f.options.resourcesRoot, "app-update-identity.json"),
    JSON.stringify({
      version: 1,
      appVersion: f.metadata.app.version,
      payloadSha256: f.metadata.app.payloadSha256,
    }),
  );
  const controller = await createWindowsConsumerUpdater(f.options);
  await controller.recover(new AbortController().signal);
  expect(controller.snapshot().phase).toBe("complete");
  expect(f.data.has("account:ready_receipt")).toBe(false);
  expect(state.events.some((x) => x.startsWith("prepare:"))).toBe(false);
  expect(f.options.native.launchInstaller).toHaveBeenCalledOnce();
  expect(await readFile(join(f.personal, "models", MODEL.filename))).toEqual(
    f.model,
  );
});
it("new packaged app opening while installer still runs retains the update fence and absent runtime", async () => {
  const f = await fixture(true, true);
  await f.controller.install(new AbortController().signal);
  await writeFile(
    join(f.options.resourcesRoot, "app-update-identity.json"),
    JSON.stringify({
      version: 1,
      appVersion: f.metadata.app.version,
      payloadSha256: f.metadata.app.payloadSha256,
    }),
  );
  const controller = await createWindowsConsumerUpdater(f.options);
  await expect(
    controller.recover(new AbortController().signal),
  ).rejects.toThrow("UPDATE_INSTALLER_RUNNING");
  expect(controller.snapshot().problem).toBe("UPDATE_INSTALLER_RUNNING");
  expect(f.data.has("account:ready_receipt")).toBe(false);
  expect(f.options.native.launchInstaller).toHaveBeenCalledOnce();
  expect(state.events).not.toContain("activity:release");
});
it("confirmed failed cold installer restores absent state without copying or qualifying model", async () => {
  const f = await fixture(true, true),
    launch = vi
      .mocked(f.options.native.launchInstaller)
      .getMockImplementation()!;
  vi.mocked(f.options.native.launchInstaller).mockImplementation(
    async (pin) => {
      const identity = await launch(pin),
        status = f.installerStatuses.get(pin.identity)!;
      if (status.state === "absent") throw new Error();
      f.installerStatuses.set(pin.identity, {
        state: "completed",
        certificate: {
          ...status.certificate,
          exitCode: 1603,
          treeExited: true,
        },
      });
      return identity;
    },
  );
  await expect(
    f.controller.install(new AbortController().signal),
  ).rejects.toThrow("UPDATE_INSTALLER_FAILED");
  expect(f.controller.snapshot().phase).toBe("rolled-back");
  expect(f.data.has("account:ready_receipt")).toBe(false);
  expect(state.events.some((x) => x.startsWith("prepare:"))).toBe(false);
  expect(await readFile(join(f.personal, "models", MODEL.filename))).toEqual(
    f.model,
  );
});
it("old session birth must exit before any model replacement or new activation", async () => {
  const f = await fixture();
  await f.controller.install(new AbortController().signal);
  expect(state.events.indexOf("session:commit")).toBeLessThan(
    state.events.findIndex((x) => x.startsWith("prepare:")),
  );
  expect(state.events.indexOf("session:commit")).toBeLessThan(
    state.events.indexOf("activation:session"),
  );
  expect(state.events.indexOf("session:retired")).toBeGreaterThan(
    state.events.indexOf("activation:session"),
  );
});
it("unconfirmed exact session exit prevents runtime mutation and holds maintenance", async () => {
  const f = await fixture();
  f.options.session.currentAuthority = () => ({ ...f.options.host.identity });
  vi.mocked(f.options.native.waitProcessExit).mockResolvedValue(false);
  await expect(
    f.controller.install(new AbortController().signal),
  ).rejects.toThrow("UPDATE_SESSION_STOP_UNCONFIRMED");
  expect(state.events.some((x) => x.startsWith("prepare:"))).toBe(false);
  expect(state.events).not.toContain("activity:release");
  expect(f.controller.snapshot().phase).toBe("blocked");
  expect(await readFile(join(f.personal, "models", MODEL.filename))).toEqual(
    f.model,
  );
});
it("cold app maintenance uses genuine native session singleton when no prepared session exists", async () => {
  const f = await fixture(true, true);
  state.sessionUnavailable = true;
  const acquire = vi.spyOn(f.options.native, "acquireMutex"),
    release = vi.spyOn(f.options.native, "releaseMutex");
  await f.controller.install(new AbortController().signal);
  expect(acquire).toHaveBeenCalledWith("session");
  expect(release.mock.calls.some(([lease]) => lease.scope === "session")).toBe(
    true,
  );
  expect(f.controller.snapshot().phase).toBe("restart-required");
  expect(f.data.has("account:ready_receipt")).toBe(false);
});
it("cold app without current native singleton cannot bypass another logged-in authority", async () => {
  const f = await fixture(true, true);
  state.sessionUnavailable = true;
  const acquire = f.options.native.acquireMutex.bind(f.options.native);
  vi.spyOn(f.options.native, "acquireMutex").mockImplementation(
    async (scope) => (scope === "session" ? null : acquire(scope)),
  );
  await expect(
    f.controller.install(new AbortController().signal),
  ).rejects.toThrow("UPDATE_BUSY");
  expect(f.options.native.launchInstaller).not.toHaveBeenCalled();
  expect(f.writes.some((key) => key.startsWith("account:up_"))).toBe(false);
});
it("a foreign-SID durable idle record cannot become current update authority", async () => {
  const f = await fixture(true, true);
  state.sessionUnavailable = true;
  f.data.set(
    "fleet:session_state",
    Buffer.from(
      JSON.stringify({
        version: 1,
        sid: "S-1-5-21-100-200-300-2002",
        revision: 1,
        fleetIntent: "stopped",
        restartPending: false,
        owner: null,
        maintenance: null,
        budgets: {
          personal: { attempts: 0, nextStartAt: 0, blocked: false },
          fleet: { attempts: 0, nextStartAt: 0, blocked: false },
        },
        receipts: [],
      }),
    ),
  );
  await expect(
    f.controller.install(new AbortController().signal),
  ).rejects.toThrow("UPDATE_RECOVERY_REQUIRED");
  expect(f.options.native.launchInstaller).not.toHaveBeenCalled();
  expect(f.writes.some((key) => key.startsWith("account:up_"))).toBe(false);
});
it("nested certified installer assistance binds live signed journal/full pin even before launch ACK WAL adoption", async () => {
  const f = await fixture(true, true);
  await f.controller.install(new AbortController().signal);
  const { authorizeConsumerInstallerAssistance } =
      await import("../src/main/update/factory.js"),
    id = consumerUpdateIdentity(f.metadata),
    status = f.installerStatuses.get(id)!;
  if (status.state === "absent" || !status.certificate.process)
    throw new Error();
  const wal = JSON.parse(
      f.data.get("account:consumer_update_installer")!.toString(),
    ),
    state = JSON.parse(f.data.get("account:consumer_update_state")!.toString());
  wal.phase = "launching";
  wal.nonce = null;
  state.journal.phase = "activating";
  f.data.set(
    "account:consumer_update_installer",
    Buffer.from(JSON.stringify(wal)),
  );
  f.data.set(
    "account:consumer_update_state",
    Buffer.from(JSON.stringify(state)),
  );
  const before = vi.mocked(f.options.native.launchInstaller).mock.calls.length,
    result = await authorizeConsumerInstallerAssistance({
      ...f.options,
      receipt: {
        issuer: status.certificate.process,
        certificateNonce: status.certificate.nonce,
      },
      signal: new AbortController().signal,
    });
  expect(result).toEqual({
    transaction: state.journal.transaction,
    identity: id,
  });
  expect(f.options.native.launchInstaller).toHaveBeenCalledTimes(before);
});
it("nested assistance rejects missing/mismatched pin, unknown/completed issuer and foreign birth without acquiring leases", async () => {
  const f = await fixture(true, true);
  await f.controller.install(new AbortController().signal);
  const { authorizeConsumerInstallerAssistance } =
      await import("../src/main/update/factory.js"),
    id = consumerUpdateIdentity(f.metadata),
    status = f.installerStatuses.get(id)!;
  if (status.state === "absent" || !status.certificate.process)
    throw new Error();
  const receipt = {
      issuer: status.certificate.process,
      certificateNonce: status.certificate.nonce,
    },
    call = (r = receipt) =>
      authorizeConsumerInstallerAssistance({
        ...f.options,
        receipt: r,
        signal: new AbortController().signal,
      });
  expect(
    await call({ ...receipt, certificateNonce: "f".repeat(64) }),
  ).toBeNull();
  expect(
    await call({
      ...receipt,
      issuer: { ...receipt.issuer, creationTime: "133000000000000001" },
    }),
  ).toBeNull();
  const wal = JSON.parse(
    f.data.get("account:consumer_update_installer")!.toString(),
  );
  f.data.set(
    "account:consumer_update_installer",
    Buffer.from(
      JSON.stringify({ ...wal, pin: { ...wal.pin, bytes: wal.pin.bytes + 1 } }),
    ),
  );
  expect(await call()).toBeNull();
  f.data.set(
    "account:consumer_update_installer",
    Buffer.from(JSON.stringify(wal)),
  );
  for (const state of ["unknown", "completed"] as const) {
    f.installerStatuses.set(id, {
      state,
      certificate: {
        ...status.certificate,
        exitCode: state === "completed" ? 0 : null,
        treeExited: state === "completed",
      },
    });
    expect(await call()).toBeNull();
  }
});
