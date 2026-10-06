import { existsSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
  lstat,
  cp,
} from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appFixture, borrowedAppModel } from "./fixtures/app-service.js";
import { createMacAppCommandContext } from "../src/platform/macos/app-installation.js";
import {
  stageMacAppService,
  APP_MODEL_BYTES,
  APP_MODEL_SHA256,
  publishMacAppRuntimeReference,
  resolveMacAppExecutionLayout,
} from "../src/platform/macos/app-installation-binding.js";
import { activateMacUserRelease } from "../src/platform/macos/user-release.js";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";
import { buildMacUserRuntimeConfig } from "../src/platform/macos/user-installer.js";
import {
  initializeLocalLifecycle,
  loadLocalLifecycle,
  setLocalLifecycleIntent,
} from "../src/runtime/local-lifecycle.js";
import { writeLocalRuntimeStatus } from "../src/runtime/local-runtime-status.js";
import {
  loadUpdateState,
  updateMacUserWorker,
} from "../src/platform/macos/user-updater.js";
import { withMacAppPreparationFence } from "../src/platform/macos/app-control-maintenance.js";
import { createInstallationReleaseArchive } from "../src/enrollment/release-archive.js";
import {
  canonicalUpdateMetadata,
  type UpdateMetadata,
} from "../src/platform/shared/update-metadata.js";
import { readMacQualifiedRollback } from "../src/platform/macos/app-installation-state.js";
import {
  cleanupWorkerStorage,
  macWorkerStorageLayout,
} from "../src/platform/shared/storage-maintenance.js";
import { runMacUserCommand } from "../src/platform/macos/user-cli.js";
import { writeConfirmedUnpairReceipt } from "../src/platform/shared/unpair-receipt.js";

const machineId = "32410a14-e85a-4a1d-bb99-61fa54b07eaa";
const workerId = "718bd89b-bd03-43f7-adb7-9cb5ff415918";
const secondWorkerId = "718bd89b-bd03-43f7-adb7-9cb5ff415919";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "musicmute-app-install-")),
  );
  roots.push(root);
  const f = await appFixture(root);
  let loaded = false;
  const service = {
    status: vi.fn(async () => ({ loaded, running: loaded })),
    bootstrap: vi.fn(async (_path: string) => {
      loaded = true;
    }),
    bootout: vi.fn(async () => {
      loaded = false;
    }),
    kickstart: vi.fn(async () => {
      loaded = true;
    }),
  };
  const beforeQualification = vi.fn(async () => {
    expect(loaded).toBe(false);
    await expect(
      lstat(join(f.layout.stateRoot, "app-preparation.json")),
    ).resolves.toBeDefined();
  });
  const wait = async () => {
    const lifecycle = await loadLocalLifecycle(f.layout.lifecyclePath);
    await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [], {
      observedLifecycle: {
        revision: lifecycle.revision,
        intent: lifecycle.intent,
      },
    });
  };
  return { ...f, root, service, beforeQualification, wait };
}
async function legacy(
  f: Awaited<ReturnType<typeof fixture>>,
  running: boolean,
) {
  const release = join(f.layout.releasesRoot, "0.1.3");
  for (const path of [
    "app/dist/src/cli/main.js",
    "runtime/node/bin/node",
    "runtime/python/bin/python3",
    "runtime/bin/ffmpeg",
    "runtime/bin/ffprobe",
    "runtime/media-source-manifest.json",
    "runtime/licenses/ffmpeg/COPYING.LGPLv2.1",
    "runtime/licenses/lame/COPYING",
  ]) {
    await mkdir(dirname(join(release, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(release, path), "fixture", { mode: 0o755 });
  }
  await mkdir(join(release, "app", "engine"), { mode: 0o700 });
  await writeMacReleaseManifest(release, "0.1.3");
  await activateMacUserRelease(f.layout, "0.1.3");
  const config = {
    ...buildMacUserRuntimeConfig(
      f.layout,
      "https://api.music-mute.com",
      false,
      { machineId, workerId },
    ),
    validatedMaxWorkersPerGpu: 2,
  };
  config.slots.push({
    ...config.slots[0]!,
    workerId: secondWorkerId,
    slotIndex: 1,
  });
  await writeFile(f.layout.configPath, JSON.stringify(config), { mode: 0o600 });
  await writeFile(f.layout.credentialPath, "x".repeat(43), { mode: 0o600 });
  await writeFile(
    f.layout.installationStatePath,
    JSON.stringify({ schemaVersion: 1, machineId, releaseVersion: "0.1.3" }),
    { mode: 0o600 },
  );
  await writeFile(
    f.layout.updateStatePath,
    JSON.stringify({
      schemaVersion: 1,
      highestSequence: 47,
      status: "healthy",
      knownGoodVersion: "0.1.3",
      quarantinedVersions: [],
      updatedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  await initializeLocalLifecycle(f.layout.lifecyclePath);
  await setLocalLifecycleIntent(f.layout.lifecyclePath, "paused");
  await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, []);
  await writeFile(join(f.layout.stateRoot, "qualification.wav"), "fixture", {
    mode: 0o600,
  });
  if (running) await f.service.bootstrap(f.layout.plistPath);
  return config;
}

describe.skipIf(!existsSync(borrowedAppModel) || process.platform !== "darwin")(
  "app-owned worker migration with isolated services",
  () => {
    it("direct support cleanup owns its preparation fence without blocking itself", async () => {
      const f = await fixture();
      await legacy(f, false);
      const output: string[] = [];
      expect(
        await runMacUserCommand("cleanup", ["--apply", "--json"], {
          layout: f.layout,
          launchAgent: f.service,
          beforeWorkerLoad: f.beforeQualification,
          stdout: (value) => output.push(value),
        }),
      ).toBe(0);
      expect(JSON.parse(output[0]!)).toMatchObject({
        action: "cleanup",
        mode: "apply",
        status: "ok",
        keptReleaseVersions: ["0.1.3"],
      });
      expect(f.beforeQualification).toHaveBeenCalledOnce();
      await expect(
        lstat(join(f.layout.stateRoot, "app-preparation.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("direct support recovery restores a killed GUI maintenance transaction before starting paired processing", async () => {
      const f = await fixture();
      const original = await legacy(f, false);
      await setLocalLifecycleIntent(f.layout.lifecyclePath, "draining");
      await writeFile(
        join(f.layout.stateRoot, "app-maintenance.json"),
        JSON.stringify({
          schemaVersion: 1,
          intent: "paused",
          loaded: true,
          stopped: true,
          phase: "stopped",
        }),
        { mode: 0o600 },
      );
      const beforeWorkerLoad = vi.fn(async () => {
        expect((await f.service.status()).loaded).toBe(false);
        await expect(
          lstat(join(f.layout.stateRoot, "app-maintenance.json")),
        ).resolves.toBeDefined();
      });
      expect(
        await runMacUserCommand("recover", ["--json"], {
          layout: f.layout,
          launchAgent: f.service,
          beforeWorkerLoad,
          stdout: () => undefined,
        }),
      ).toBe(0);
      expect(beforeWorkerLoad).toHaveBeenCalledOnce();
      expect((await f.service.status()).running).toBe(true);
      expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
        "paused",
      );
      expect(JSON.parse(await readFile(f.layout.configPath, "utf8"))).toEqual(
        original,
      );
      await expect(
        lstat(join(f.layout.stateRoot, "app-maintenance.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("app to signed catalog update selects the catalog supervisor/tools/model and support CLI", async () => {
      const f = await fixture();
      await legacy(f, false);
      const context = createMacAppCommandContext(f.resources, f.support, {
        ...f,
        launchAgent: f.service,
        qualify: async () => "qualification",
        healthy: async () => true,
      });
      const adopted = await context.adopt!();
      const appLayout = await resolveMacAppExecutionLayout(f.layout);
      const candidateRoot = join(f.root, "catalog");
      await cp(join(f.layout.releasesRoot, "0.1.3"), candidateRoot, {
        recursive: true,
      });
      for (const [path, output] of [
        ["runtime/node/bin/node", "v24.18.0"],
        ["runtime/bin/ffmpeg", "ffmpeg version 8.0.3 Copyright"],
        ["runtime/bin/ffprobe", "ffprobe version 8.0.3 Copyright"],
      ])
        await writeFile(
          join(candidateRoot, path!),
          `#!/bin/sh\nprintf '${output}\\n'\n`,
          { mode: 0o755 },
        );
      await rm(join(candidateRoot, "release-manifest.json"));
      await writeMacReleaseManifest(candidateRoot, "0.2.0");
      const archivePath = join(f.root, "catalog.tar.gz");
      const archive = await createInstallationReleaseArchive({
        releaseRoot: candidateRoot,
        outputPath: archivePath,
        platform: "darwin-arm64",
      });
      const bytes = await readFile(archivePath);
      const now = new Date("2026-09-22T00:00:00.000Z");
      const metadata: UpdateMetadata = {
        schemaVersion: 1,
        sequence: 48,
        platform: "darwin-arm64",
        releaseVersion: "0.2.0",
        publishedAt: "2026-09-21T00:00:00.000Z",
        expiresAt: "2026-09-23T00:00:00.000Z",
        release: {
          filename: "musicmute-worker-darwin-arm64.tar.gz",
          bytes: archive.bytes,
          sha256: archive.sha256,
          contentType: "application/gzip",
        },
      };
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      await writeFile(
        f.layout.updateTrustPath,
        JSON.stringify({
          "catalog-test": publicKey
            .export({ type: "spki", format: "pem" })
            .toString(),
        }),
        { mode: 0o600 },
      );
      const candidate = {
        signed: {
          keyId: "catalog-test",
          metadata,
          signature: sign(
            null,
            Buffer.from(canonicalUpdateMetadata(metadata)),
            privateKey,
          ).toString("base64url"),
        },
        grant: {
          url: "https://storage.example.invalid/catalog.tar.gz",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      };
      await withMacAppPreparationFence(f.layout, "update", () =>
        updateMacUserWorker({
          layout: appLayout,
          uid: process.getuid!(),
          launchAgent: f.service,
          candidate: async () => candidate,
          now,
          fetch: vi.fn(
            async () =>
              new Response(bytes, {
                status: 200,
                headers: {
                  "content-type": "application/gzip",
                  "content-length": String(bytes.length),
                },
              }),
          ) as typeof fetch,
          qualify: async () => "qualification",
          beforeQualification: f.beforeQualification,
        }),
      );
      const plist = await readFile(f.layout.plistPath, "utf8");
      expect(plist).toContain(f.layout.nodePath);
      expect(plist).toContain(f.layout.cliPath);
      expect(plist).not.toContain(appLayout.nodePath);
      expect(plist).not.toContain(appLayout.cliPath);
      const support = await readFile(
        join(f.layout.installRoot, "bin", "mw"),
        "utf8",
      );
      expect(support).toContain(f.layout.nodePath);
      expect(support).toContain(f.layout.cliPath);
      expect(support).not.toContain(appLayout.cliPath);
      const config = JSON.parse(await readFile(f.layout.configPath, "utf8"));
      expect(config.pythonPath).toBe(f.layout.pythonPath);
      expect(config.engineRoot).toBe(f.layout.engineRoot);
      expect(config.modelCacheRoot).toBe(f.layout.modelRoot);
      expect(
        (
          await lstat(
            join(f.layout.modelRoot, APP_MODEL_SHA256, "Kim_Vocal_2.onnx"),
          )
        ).size,
      ).toBe(APP_MODEL_BYTES);
      expect(await readMacQualifiedRollback(f.layout)).toEqual({
        schemaVersion: 1,
        knownGoodVersion: "0.2.0",
        previousVersion: adopted.releaseVersion,
      });
      expect(
        (await loadUpdateState(f.layout.updateStatePath)).highestSequence,
      ).toBe(48);
    });
    it("confirmed purge retires own consumer refs before deleting worker state", async () => {
      const f = await fixture();
      await legacy(f, false);
      const staged = await stageMacAppService(f.layout, f.resources, f.support);
      await publishMacAppRuntimeReference(f.layout, staged.releaseRoot);
      const reference = join(
        f.support,
        "runtime",
        "consumers",
        `${staged.serviceId}.json`,
      );
      await writeConfirmedUnpairReceipt(f.layout.unpairReceiptPath, machineId);
      await rm(f.layout.configPath);
      await rm(f.layout.credentialPath);
      const context = createMacAppCommandContext(f.resources, f.support, {
        ...f,
        launchAgent: f.service,
      });
      expect(
        await runMacUserCommand("uninstall", ["--purge", "--json"], {
          ...context,
          stdout: () => undefined,
        }),
      ).toBe(0);
      await expect(lstat(reference)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(f.layout.installRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    it.each([true, false])(
      "adopts with identities/intent/running=%s and actual rollback retained",
      async (running) => {
        const f = await fixture();
        const previous = await legacy(f, running);
        const qualify = vi.fn(async () => {
          expect((await f.service.status()).loaded).toBe(false);
          return "qualification";
        });
        const context = createMacAppCommandContext(f.resources, f.support, {
          ...f,
          launchAgent: f.service,
          qualify,
          healthy: async () => true,
        });
        const result = await context.adopt!();
        expect(result.adopted).toBe(true);
        expect(result.capacityRequalificationRequired).toBe(true);
        expect(qualify).toHaveBeenCalledOnce();
        expect(f.beforeQualification).toHaveBeenCalledOnce();
        const next = JSON.parse(await readFile(f.layout.configPath, "utf8"));
        expect(next.machineId).toBe(previous.machineId);
        expect(next.credentialFile).toBe(previous.credentialFile);
        expect(next.slots[0].workerId).toBe(workerId);
        expect(next.inactiveSlots[0].workerId).toBe(secondWorkerId);
        expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
          "paused",
        );
        expect((await f.service.status()).running).toBe(running);
        const state = await loadUpdateState(f.layout.updateStatePath);
        expect(state.highestSequence).toBe(47);
        expect(state.knownGoodVersion).toBe(result.releaseVersion);
        expect(await readMacQualifiedRollback(f.layout)).toEqual({
          schemaVersion: 1,
          knownGoodVersion: result.releaseVersion,
          previousVersion: "0.1.3",
        });
        const cleanup = await cleanupWorkerStorage({
          layout: macWorkerStorageLayout(f.layout),
        });
        expect(cleanup.status).toBe("ok");
        expect(cleanup.keptReleaseVersions).toEqual([
          result.releaseVersion,
          "0.1.3",
        ]);
      },
    );

    it("rolls back pointer/config/update sequence/intent after candidate doctor fails", async () => {
      const f = await fixture();
      const previous = await legacy(f, true);
      const context = createMacAppCommandContext(f.resources, f.support, {
        ...f,
        launchAgent: f.service,
        qualify: async () => "qualification",
        healthy: async () => false,
      });
      await expect(context.adopt!()).rejects.toThrow();
      expect(await readlink(f.layout.currentLink)).toBe("releases/0.1.3");
      expect(JSON.parse(await readFile(f.layout.configPath, "utf8"))).toEqual(
        previous,
      );
      expect(
        (await loadUpdateState(f.layout.updateStatePath)).knownGoodVersion,
      ).toBe("0.1.3");
      expect(
        (await loadUpdateState(f.layout.updateStatePath)).highestSequence,
      ).toBe(47);
      expect(await readMacQualifiedRollback(f.layout)).toBeNull();
      expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
        "paused",
      );
      expect((await f.service.status()).running).toBe(true);
      await expect(
        lstat(join(f.layout.stateRoot, "app-activation.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses active/unknown personal ownership before staging or qualification", async () => {
      const f = await fixture();
      await legacy(f, false);
      await writeFile(
        join(f.layout.stateRoot, "personal-admission.json"),
        JSON.stringify({ request_id: machineId }),
        { mode: 0o600 },
      );
      const stage = vi.fn(stageMacAppService);
      const qualify = vi.fn(async () => "qualification");
      const context = createMacAppCommandContext(f.resources, f.support, {
        ...f,
        launchAgent: f.service,
        stage,
        qualify,
      });
      await expect(context.adopt!()).rejects.toMatchObject({
        errorCode: "WORKER_PERSONAL_BUSY",
      });
      expect(stage).not.toHaveBeenCalled();
      expect(qualify).not.toHaveBeenCalled();
    });

    it("fresh setup reuses the external model/runtime, quiet enrollment hooks and independent service", async () => {
      const f = await fixture();
      const fixturePath = join(f.layout.stateRoot, "qualification.wav");
      await writeFile(fixturePath, "fixture", { mode: 0o600 });
      const prepare = vi.fn(async (_args, reuse) => {
        const transaction = join(f.layout.transactionRoot, "install");
        const binding = JSON.parse(
          await readFile(
            join(reuse.appReleaseRoot!, "release-manifest.json"),
            "utf8",
          ),
        );
        await writeFile(
          join(transaction, "installation-artifacts.json"),
          JSON.stringify({
            schemaVersion: 1,
            installationId: machineId,
            platform: "darwin-arm64",
            releaseVersion: binding.releaseVersion,
            release: { releaseRoot: reuse.appReleaseRoot },
            model: {
              path: f.modelPath,
              bytes: APP_MODEL_BYTES,
              sha256: APP_MODEL_SHA256,
            },
            fixture: {
              path: fixturePath,
              sha256: createHash("sha256").update("fixture").digest("hex"),
            },
          }),
          { mode: 0o600 },
        );
      });
      const enroll = vi.fn(async () => {
        const transaction = join(f.layout.transactionRoot, "install");
        await writeFile(
          join(transaction, ".enrollment-state.json"),
          JSON.stringify({ schemaVersion: 1, machineId, workerId }),
          { mode: 0o600 },
        );
        await writeFile(
          join(transaction, "machine.credential"),
          "x".repeat(43),
          { mode: 0o600 },
        );
      });
      const component = {
        decision: "reuse" as const,
        requestedVersion: "24.18.0",
        installedVersion: "24.18.0",
        reason: "compatible" as const,
      };
      const context = createMacAppCommandContext(f.resources, f.support, {
        ...f,
        launchAgent: f.service,
        prepare,
        enroll,
        qualify: async () => "qualification",
        inspectRuntime: async () => ({
          node: component,
          ffmpeg: component,
          ffprobe: component,
        }),
      });
      const result = await context.install!({
        enrollmentCredential: "e".repeat(43),
        label: "Fixture",
      });
      expect(result.machineId).toBe(machineId);
      expect(result.reusedModel).toBe(true);
      expect(prepare).toHaveBeenCalledOnce();
      expect(enroll).toHaveBeenCalledOnce();
      const config = JSON.parse(await readFile(f.layout.configPath, "utf8"));
      expect(config.modelCacheRoot).toBe(join(f.support, "models"));
      expect(config.pythonPath).toContain(f.runtimeId);
      expect((await f.service.status()).running).toBe(true);
      expect(
        (await loadUpdateState(f.layout.updateStatePath)).knownGoodVersion,
      ).toBe(result.releaseVersion);
    });
  },
);
