import { createHash, randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";
import {
  buildMacUserRuntimeConfig,
  installMacUserWorker,
  inspectPendingMacUserEnrollment,
  PRODUCTION_BACKEND_BASE_URL,
  readPendingMacUserEnrollmentCredential,
  recoverMacUserWorker,
  resumeMacUserInstallation,
  resetPendingMacUserEnrollment,
  type MacUserInstallationOptions,
} from "../src/platform/macos/user-installer.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
  type MacUserLayout,
} from "../src/platform/macos/user-paths.js";
import { loadRuntimeConfig } from "../src/runtime/runtime-config.js";
import { MAC_RECIPE_IDS } from "../src/platform/macos/runtime-recipes.js";
import { runMacUserCommand } from "../src/platform/macos/user-cli.js";
import {
  resetDeletedMacRegistration,
  finishDeletedMacRegistration,
  writeMachineDeletionNotice,
  loadMachineDeletionNotice,
} from "../src/platform/macos/deleted-registration.js";
import { writeConfirmedUnpairReceipt } from "../src/platform/shared/unpair-receipt.js";
import { writeLocalRuntimeStatus } from "../src/runtime/local-runtime-status.js";
import { DiagnosticSpool } from "../src/runtime/diagnostic-spool.js";
import { DiagnosticForwarder } from "../src/runtime/diagnostic-forwarder.js";
import { WorkerEnrollmentError } from "../src/enrollment/enrollment-client.js";
import {
  setLocalLifecycleIntent,
  loadLocalLifecycle,
} from "../src/runtime/local-lifecycle.js";

const machineId = "32410a14-e85a-4a1d-bb99-61fa54b07eaa";
const workerId = "718bd89b-bd03-43f7-adb7-9cb5ff415918";
const roots: string[] = [];
const compatibleRuntime = {
  node: {
    decision: "reuse" as const,
    requestedVersion: "24.18.0",
    installedVersion: "24.18.0",
    reason: "compatible" as const,
  },
  ffmpeg: {
    decision: "reuse" as const,
    requestedVersion: "8.0.3",
    installedVersion: "8.0.3",
    reason: "compatible" as const,
  },
  ffprobe: {
    decision: "reuse" as const,
    requestedVersion: "8.0.3",
    installedVersion: "8.0.3",
    reason: "compatible" as const,
  },
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

// These fixtures exercise Darwin paths, UID ownership and POSIX permissions.
describe.skipIf(process.platform !== "darwin")(
  "macOS one-command user installation",
  () => {
    it
      .skipIf(process.platform !== "darwin")
      .each(["bootstrap", "service-loaded"])(
      "resumes a SIGKILLed installer at %s without reenrollment",
      async (boundary) => {
        const root = await temporaryRoot();
        const home = join(root, "home");
        await mkdir(home, { mode: 0o700 });
        const layout = createMacUserLayout(home);
        await createMacUserDirectories(layout);
        const release = join(root, "release");
        await releaseFixture(release, "0.1.0");
        const modelPath = join(root, "model.onnx");
        const fixturePath = join(root, "fixture.wav");
        await writeFile(modelPath, "model");
        await writeFile(fixturePath, "fixture");
        const callsPath = join(root, "calls.txt");
        const servicePath = join(root, "service.json");
        const serviceCallsPath = join(root, "service-calls.txt");
        await writeFile(servicePath, "false");
        const inputPath = join(root, "input.json");
        await writeFile(
          inputPath,
          JSON.stringify({
            layout,
            callsPath,
            servicePath,
            serviceCallsPath,
            boundary,
            runtime: compatibleRuntime,
            identity: { machineId, workerId },
            artifacts: {
              schemaVersion: 1,
              installationId: "cb56441d-f2df-4b44-a320-6f37dfa81f7f",
              platform: "darwin-arm64",
              releaseVersion: "0.1.0",
              release: { releaseRoot: release },
              model: {
                path: modelPath,
                bytes: 5,
                sha256: createHash("sha256").update("model").digest("hex"),
              },
              fixture: {
                path: fixturePath,
                sha256: createHash("sha256").update("fixture").digest("hex"),
              },
            },
          }),
          { mode: 0o600 },
        );
        const run = (mode: string) =>
          fork(
            new URL("./fixtures/interrupted-install.mjs", import.meta.url),
            [new URL("../src/", import.meta.url).href, inputPath, mode],
            {
              execArgv: ["--experimental-transform-types"],
              stdio: ["ignore", "ignore", "pipe", "ipc"],
            },
          );
        const child = run("install");
        let errors = "";
        child.stderr!.on("data", (chunk) => {
          errors += String(chunk);
        });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
        try {
          const [message] = await Promise.race([
            once(child, "message"),
            once(child, "exit").then(() => {
              throw new Error(errors);
            }),
          ]);
          expect(message).toEqual({ boundary });
          const journalPath = join(
            layout.transactionRoot,
            "install",
            "finalization.json",
          );
          const journal = JSON.parse(await readFile(journalPath, "utf8"));
          const credential = await readFile(layout.credentialPath, "utf8");
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
          await setLocalLifecycleIntent(layout.lifecyclePath, "paused");
          const recovery = run("recover");
          recovery.stderr!.on("data", (chunk) => {
            errors += String(chunk);
          });
          const recoveryTimeout = setTimeout(
            () => recovery.kill("SIGKILL"),
            8000,
          );
          try {
            expect((await once(recovery, "exit"))[0], errors).toBe(0);
          } finally {
            clearTimeout(recoveryTimeout);
          }
          expect(await readFile(callsPath, "utf8")).toBe("prepare\nenroll\n");
          expect(await readFile(serviceCallsPath, "utf8")).toBe("bootstrap\n");
          expect(await readFile(layout.credentialPath, "utf8")).toBe(
            credential,
          );
          expect((await loadLocalLifecycle(layout.lifecyclePath)).intent).toBe(
            "paused",
          );
          expect(
            JSON.parse(await readFile(layout.installationStatePath, "utf8")),
          ).toMatchObject({
            installedAt: journal.installedAt,
            machineId,
            releaseVersion: "0.1.0",
          });
          await expect(readFile(journalPath)).rejects.toMatchObject({
            code: "ENOENT",
          });
          expect(
            await readPendingMacUserEnrollmentCredential(layout),
          ).toBeNull();
          expect(await readFile(servicePath, "utf8")).toBe("true");
        } finally {
          clearTimeout(timeout);
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
          }
        }
      },
      20_000,
    );
    it.each([false, true])(
      "stages and recovers installation with bootstrap interruption=%s",
      async (interrupt) => {
        const root = await temporaryRoot();
        const home = join(root, "home");
        const sourceRelease = join(root, "release");
        const modelSource = join(root, "Kim_Vocal_2.onnx");
        const fixtureSource = join(root, "qualification.wav");
        await mkdir(home, { mode: 0o700 });
        await releaseFixture(sourceRelease, "0.1.0");
        const model = Buffer.from("model");
        const fixture = Buffer.from("fixture");
        await writeFile(modelSource, model, { mode: 0o600 });
        await writeFile(fixtureSource, fixture, { mode: 0o600 });
        const layout = createMacUserLayout(home);
        const prepare = vi.fn(
          async (
            arguments_: string[],
            _reuse?: { reusableModelPath?: string },
          ) => {
            const output = arguments_[arguments_.indexOf("--output") + 1]!;
            await writeFile(
              join(output, "installation-artifacts.json"),
              `${JSON.stringify({
                schemaVersion: 1,
                installationId: "cb56441d-f2df-4b44-a320-6f37dfa81f7f",
                platform: "darwin-arm64",
                releaseVersion: "0.1.0",
                release: { releaseRoot: sourceRelease },
                model: {
                  path: modelSource,
                  bytes: model.length,
                  sha256: createHash("sha256").update(model).digest("hex"),
                },
                fixture: {
                  path: fixtureSource,
                  sha256: createHash("sha256").update(fixture).digest("hex"),
                },
              })}\n`,
              { mode: 0o600 },
            );
          },
        );
        const enroll = vi.fn(async (arguments_: string[]) => {
          const output = arguments_[arguments_.indexOf("--output") + 1]!;
          await writeFile(
            join(output, ".enrollment-state.json"),
            `${JSON.stringify({ machineId, workerId })}\n`,
            { mode: 0o600 },
          );
          await writeFile(
            join(output, "machine.credential"),
            `${"m".repeat(43)}\n`,
            {
              mode: 0o600,
            },
          );
        });
        const qualificationPath = join(layout.stateRoot, "qualification.json");
        const qualify = vi.fn(async () => qualificationPath);
        let loaded = false;
        let failBootstrap = interrupt;
        const launchAgent = {
          kickstart: vi.fn(async () => undefined),
          bootstrap: vi.fn(async () => {
            if (failBootstrap) throw new Error("fixture interrupted bootstrap");
            loaded = true;
          }),
          bootout: vi.fn(async () => {
            loaded = false;
          }),
          status: vi.fn(async () => ({ loaded, running: loaded })),
        };

        const installation = installMacUserWorker({
          layout,
          uid: process.getuid!(),
          enrollmentCredential: "x".repeat(43),
          label: "Studio Mac",
          launchAgent,
          prepare,
          enroll,
          qualify,
          inspectRuntime: vi.fn(async () => compatibleRuntime),
        });
        if (interrupt) {
          await expect(installation).rejects.toThrow(
            "fixture interrupted bootstrap",
          );
          expect(
            await readPendingMacUserEnrollmentCredential(layout),
          ).not.toBeNull();
          failBootstrap = false;
          await setLocalLifecycleIntent(layout.lifecyclePath, "paused");
          await expect(
            runMacUserCommand("install", [], {
              layout,
              host: {
                platform: "darwin",
                arch: "arm64",
                uid: process.getuid!(),
                home,
              },
              launchAgent,
              stdout: vi.fn(),
              readEnrollmentCode: async () => {
                throw new Error("Must not consume another code");
              },
            }),
          ).resolves.toBe(0);
          expect((await loadLocalLifecycle(layout.lifecyclePath)).intent).toBe(
            "paused",
          );
          expect(enroll).toHaveBeenCalledTimes(1);
          expect(prepare).toHaveBeenCalledTimes(1);
        } else
          await expect(installation).resolves.toMatchObject({
            machineId,
            releaseVersion: "0.1.0",
            serviceLoaded: true,
          });
        await expect(
          resumeMacUserInstallation({
            layout,
            uid: process.getuid!(),
            launchAgent,
          }),
        ).resolves.toBeNull();
        await expect(
          lstat(join(layout.transactionRoot, "install")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        const config = await loadRuntimeConfig(layout.configPath, {
          platform: "darwin",
          arch: "arm64",
        });
        expect(config).toMatchObject({
          backendBaseUrl: `${PRODUCTION_BACKEND_BASE_URL}/`,
          machineId,
          localLifecyclePath: layout.lifecyclePath,
          credential: "m".repeat(43),
          slots: [
            {
              recipeIds: [...MAC_RECIPE_IDS],
            },
          ],
        });
        expect(launchAgent.bootstrap).toHaveBeenCalledWith(layout.plistPath);
        expect(prepare).toHaveBeenCalledWith(expect.any(Array), {
          reusableModelPath: join(
            layout.modelRoot,
            "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
            "Kim_Vocal_2.onnx",
          ),
        });
        expect(await readFile(layout.plistPath, "utf8")).toContain(
          "com.musicmute.worker",
        );
        expect(
          JSON.parse(await readFile(layout.installationStatePath, "utf8")),
        ).toMatchObject({
          releaseVersion: "0.1.0",
          runtimePreflight: {
            node: { decision: "reuse", installedVersion: "24.18.0" },
            ffmpeg: { decision: "reuse", installedVersion: "8.0.3" },
            ffprobe: { decision: "reuse", installedVersion: "8.0.3" },
          },
        });
      },
    );

    it("builds only the production HTTPS base URL by default", () => {
      const layout = createMacUserLayout("/Users/tester");
      expect(
        buildMacUserRuntimeConfig(layout, PRODUCTION_BACKEND_BASE_URL, false, {
          machineId,
          workerId,
        }),
      ).toMatchObject({
        backendBaseUrl: "https://api.music-mute.com/",
        localLifecyclePath: layout.lifecyclePath,
      });
    });

    it.each([false, "output", "workspace"] as const)(
      "reuses exact qualification after enrollment interruption (accepted report=%s)",
      async (accepted) => {
        const f = await qualificationRetryFixture();
        await expect(installMacUserWorker(f.options)).rejects.toThrow(
          "fixture enrollment unavailable",
        );
        if (accepted) {
          const state = JSON.parse(await readFile(f.statePath, "utf8"));
          state.reportRevision = 1;
          await writeFile(f.statePath, JSON.stringify(state), { mode: 0o600 });
          if (accepted === "workspace")
            await rm(dirname(f.outputPath), { recursive: true });
          else await rm(f.outputPath);
        }
        await expect(installMacUserWorker(f.options)).resolves.toMatchObject({
          machineId,
          serviceLoaded: true,
        });
        expect(f.qualify).toHaveBeenCalledTimes(1);
        expect(f.enroll).toHaveBeenCalledTimes(2);
        expect(f.enroll.mock.calls[0]![0]).toEqual(f.enroll.mock.calls[1]![0]);
        expect(await readFile(f.options.layout.credentialPath, "utf8")).toBe(
          `${"m".repeat(43)}\n`,
        );
      },
    );

    it.each(["dangling-output", "dangling-ancestor", "writable-ancestor"])(
      "rejects %s even when enrollment already accepted the report",
      async (target) => {
        const f = await qualificationRetryFixture();
        await expect(installMacUserWorker(f.options)).rejects.toThrow(
          "fixture enrollment unavailable",
        );
        const state = JSON.parse(await readFile(f.statePath, "utf8"));
        state.reportRevision = 1;
        await writeFile(f.statePath, JSON.stringify(state), { mode: 0o600 });
        await rm(f.outputPath);
        if (target === "dangling-output")
          await symlink(
            join(dirname(f.outputPath), "absent-result"),
            f.outputPath,
          );
        if (target === "dangling-ancestor") {
          await rm(dirname(f.outputPath), { recursive: true });
          await symlink(
            join(f.options.layout.workRoot, "absent-workspace"),
            dirname(f.outputPath),
          );
        }
        if (target === "writable-ancestor")
          await chmod(dirname(f.outputPath), 0o777);
        await expect(installMacUserWorker(f.options)).rejects.toThrow();
        expect(f.enroll).toHaveBeenCalledTimes(1);
        expect(f.qualify).toHaveBeenCalledTimes(1);
        await expect(lstat(f.options.layout.configPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );

    it.each([
      "report",
      "output",
      "installation",
      "release",
      "fixture",
      "symlink",
    ])(
      "rejects swapped or tampered %s instead of reusing qualification",
      async (target) => {
        const f = await qualificationRetryFixture();
        await expect(installMacUserWorker(f.options)).rejects.toThrow(
          "fixture enrollment unavailable",
        );
        if (target === "report")
          await writeFile(
            f.reportPath,
            `${await readFile(f.reportPath, "utf8")}\n`,
            { mode: 0o600 },
          );
        if (target === "output")
          await writeFile(f.outputPath, "changed output", { mode: 0o600 });
        if (target === "installation") f.setInstallationId(randomUUID());
        if (target === "release") await f.changeRelease();
        if (target === "fixture")
          await writeFile(f.fixturePath, "changed fixture", { mode: 0o600 });
        if (target === "symlink") {
          await rm(f.reportPath);
          await symlink(f.outputPath, f.reportPath);
        }
        await expect(installMacUserWorker(f.options)).rejects.toThrow();
        expect(f.qualify).toHaveBeenCalledTimes(1);
        expect(f.enroll).toHaveBeenCalledTimes(1);
        await expect(lstat(f.options.layout.configPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      },
    );

    it("reactivates a preserved verified release without enrollment", async () => {
      const root = await temporaryRoot();
      const home = join(root, "home");
      await mkdir(home, { mode: 0o700 });
      const layout = createMacUserLayout(home);
      await createMacUserDirectories(layout);
      await releaseFixture(join(layout.releasesRoot, "0.1.0"), "0.1.0");
      await writeFile(layout.configPath, "{}\n", { mode: 0o600 });
      await writeFile(layout.credentialPath, `${"m".repeat(43)}\n`, {
        mode: 0o600,
      });
      await writeFile(
        layout.installationStatePath,
        `${JSON.stringify({ releaseVersion: "0.1.0" })}\n`,
        { mode: 0o600 },
      );
      const launchAgent = {
        bootstrap: vi.fn(async () => undefined),
        bootout: vi.fn(async () => undefined),
        status: vi.fn(async () => ({ loaded: true, running: true })),
      };

      await expect(
        recoverMacUserWorker({
          layout,
          uid: process.getuid!(),
          launchAgent,
          confirmHealthy: async () => true,
        }),
      ).resolves.toEqual({ releaseVersion: "0.1.0", serviceLoaded: true });
      expect(
        await import("node:fs/promises").then(({ readlink }) =>
          readlink(layout.currentLink),
        ),
      ).toBe("releases/0.1.0");
      expect(launchAgent.bootstrap).toHaveBeenCalledWith(layout.plistPath);
    });

    it("rolls recovery back when the restored runtime is unhealthy", async () => {
      const root = await temporaryRoot();
      const home = join(root, "home");
      await mkdir(home, { mode: 0o700 });
      const layout = createMacUserLayout(home);
      await createMacUserDirectories(layout);
      await releaseFixture(join(layout.releasesRoot, "0.1.0"), "0.1.0");
      await writeFile(layout.configPath, "{}\n", { mode: 0o600 });
      await writeFile(layout.credentialPath, `${"m".repeat(43)}\n`, {
        mode: 0o600,
      });
      await writeFile(
        layout.installationStatePath,
        `${JSON.stringify({ releaseVersion: "0.1.0" })}\n`,
        { mode: 0o600 },
      );
      const launchAgent = {
        bootstrap: vi.fn(async () => undefined),
        bootout: vi.fn(async () => undefined),
        status: vi.fn(async () => ({ loaded: true, running: true })),
      };

      await expect(
        recoverMacUserWorker({
          layout,
          uid: process.getuid!(),
          launchAgent,
          confirmHealthy: async () => false,
        }),
      ).rejects.toThrow("failed runtime doctor");
      await expect(
        import("node:fs/promises").then(({ lstat }) =>
          lstat(layout.currentLink),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(launchAgent.bootout).toHaveBeenCalledOnce();
    });

    it("reads only a private valid pending enrollment credential", async () => {
      const root = await temporaryRoot();
      const home = join(root, "home");
      await mkdir(home, { mode: 0o700 });
      const layout = createMacUserLayout(home);
      await createMacUserDirectories(layout);
      const pending = join(
        layout.transactionRoot,
        "install",
        "enrollment.credential",
      );
      await mkdir(dirname(pending), { recursive: true, mode: 0o700 });
      await writeFile(pending, `${"p".repeat(43)}\n`, { mode: 0o600 });
      await expect(
        readPendingMacUserEnrollmentCredential(layout),
      ).resolves.toBe("p".repeat(43));
      await chmod(pending, 0o644);
      await expect(
        readPendingMacUserEnrollmentCredential(layout),
      ).rejects.toThrow("unsafe");
    });

    it("refuses to replace a code after an installation identity exists", async () => {
      const root = await temporaryRoot();
      const home = join(root, "home");
      await mkdir(home, { mode: 0o700 });
      const layout = createMacUserLayout(home);
      await createMacUserDirectories(layout);
      const pendingRoot = join(layout.transactionRoot, "install");
      await mkdir(pendingRoot, { recursive: true, mode: 0o700 });
      const credentialPath = join(pendingRoot, "enrollment.credential");
      await writeFile(credentialPath, `${"p".repeat(43)}\n`, { mode: 0o600 });
      await writeFile(
        join(pendingRoot, ".enrollment-state.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          exchangeRequestId: "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
          reportRequestId: "32410a14-e85a-4a1d-bb99-61fa54b07eab",
          activationRequestId: "32410a14-e85a-4a1d-bb99-61fa54b07eac",
          installationId: "32410a14-e85a-4a1d-bb99-61fa54b07ead",
        })}\n`,
        { mode: 0o600 },
      );

      await expect(resetPendingMacUserEnrollment(layout)).rejects.toThrow(
        "has progressed",
      );
      await expect(readFile(credentialPath, "utf8")).resolves.toBe(
        `${"p".repeat(43)}\n`,
      );
    });

    it("archives a confirmed expired unactivated transaction without removing prepared data", async () => {
      const f = await expiredEnrollmentFixture();
      await expect(
        inspectPendingMacUserEnrollment(f.layout, f.stopped),
      ).resolves.toEqual({
        replacement: "expired-unactivated",
      });
      await resetPendingMacUserEnrollment(f.layout, {
        launchAgent: f.service,
        confirmExpiredInstallation: f.expired,
      });
      expect(f.expired).toHaveBeenCalledWith(
        f.state.installationId,
        f.state.installationCredential,
      );
      await expect(lstat(f.transaction)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const archives = (await readdir(f.layout.transactionRoot)).filter(
        (name) => name.startsWith("expired-install-"),
      );
      expect(archives).toHaveLength(1);
      const archive = join(f.layout.transactionRoot, archives[0]!);
      expect((await lstat(archive)).mode & 0o777).toBe(0o700);
      expect(
        await readFile(join(archive, ".enrollment-state.json"), "utf8"),
      ).toBe(JSON.stringify(f.state));
      expect(
        await readFile(join(archive, "enrollment.credential"), "utf8"),
      ).toBe(`${"p".repeat(43)}\n`);
      expect(
        await readFile(
          join(archive, "installation-artifacts", "fixture.wav"),
          "utf8",
        ),
      ).toBe("fixture");
      expect(
        await readFile(join(f.layout.stateRoot, "qualification.json"), "utf8"),
      ).toBe("retained PASS report");
      expect(await readFile(f.outputPath, "utf8")).toBe(
        "retained qualification output",
      );
      expect(await readFile(f.modelPath, "utf8")).toBe("model");
      expect((await lstat(f.releaseRoot)).isDirectory()).toBe(true);
    });

    it.each(["reportRevision", "machineId", "credentialRevision"])(
      "preserves activation-ambiguous state containing %s",
      async (field) => {
        const f = await expiredEnrollmentFixture();
        await writeFile(
          join(f.transaction, ".enrollment-state.json"),
          JSON.stringify({
            ...f.state,
            [field]: field === "machineId" ? machineId : 1,
          }),
        );
        await expect(
          inspectPendingMacUserEnrollment(f.layout, f.stopped),
        ).resolves.toEqual({ replacement: null });
        await expect(
          resetPendingMacUserEnrollment(f.layout, {
            launchAgent: f.service,
            confirmExpiredInstallation: f.expired,
          }),
        ).rejects.toThrow("cannot be safely excluded");
        expect(f.expired).not.toHaveBeenCalled();
        expect((await lstat(f.transaction)).isDirectory()).toBe(true);
      },
    );

    it.each([
      new WorkerEnrollmentError("WORKER_UNAUTHENTICATED", 401, false),
      new WorkerEnrollmentError("WORKER_EXPIRED", 401, false),
      new WorkerEnrollmentError("NETWORK_UNAVAILABLE", 0, true),
      new Error("network unavailable"),
    ])(
      "preserves the transaction when expiry is not confirmed: %s",
      async (error) => {
        const f = await expiredEnrollmentFixture();
        const confirm = vi.fn(async () => {
          throw error;
        });
        await expect(
          resetPendingMacUserEnrollment(f.layout, {
            launchAgent: f.service,
            confirmExpiredInstallation: confirm,
          }),
        ).rejects.toBe(error);
        expect((await lstat(f.transaction)).isDirectory()).toBe(true);
        expect(
          (await readdir(f.layout.transactionRoot)).some((name) =>
            name.startsWith("expired-install-"),
          ),
        ).toBe(false);
      },
    );

    it("refuses a loaded service and a successful nonexpired backend response", async () => {
      const f = await expiredEnrollmentFixture();
      f.service.status.mockResolvedValue({ loaded: true, running: false });
      await expect(
        inspectPendingMacUserEnrollment(f.layout, {
          loaded: true,
          running: false,
        }),
      ).resolves.toEqual({ replacement: null });
      await expect(
        resetPendingMacUserEnrollment(f.layout, {
          launchAgent: f.service,
          confirmExpiredInstallation: f.expired,
        }),
      ).rejects.toThrow("Stop the worker");
      expect(f.expired).not.toHaveBeenCalled();
      f.service.status.mockResolvedValue(f.stopped);
      await expect(
        resetPendingMacUserEnrollment(f.layout, {
          launchAgent: f.service,
          confirmExpiredInstallation: async () => ({}),
        }),
      ).rejects.toThrow("has not expired");
      expect((await lstat(f.transaction)).isDirectory()).toBe(true);
    });

    it.each([
      "machine.json",
      "finalization.json",
      "unrecognized.json",
      "symlink",
      "config",
      "credential",
    ])("preserves unsafe or already installed state: %s", async (entry) => {
      const f = await expiredEnrollmentFixture();
      if (entry === "symlink")
        await symlink(
          f.modelPath,
          join(f.transaction, "installation-artifacts", "linked.wav"),
        );
      else
        await writeFile(
          entry === "config"
            ? f.layout.configPath
            : entry === "credential"
              ? f.layout.credentialPath
              : join(f.transaction, entry),
          "{}",
          { mode: 0o600 },
        );
      await expect(
        inspectPendingMacUserEnrollment(f.layout, f.stopped),
      ).resolves.toEqual({ replacement: null });
      await expect(
        resetPendingMacUserEnrollment(f.layout, {
          launchAgent: f.service,
          confirmExpiredInstallation: f.expired,
        }),
      ).rejects.toThrow();
      expect(f.expired).not.toHaveBeenCalled();
      expect((await lstat(f.transaction)).isDirectory()).toBe(true);
    });

    it("rechecks transaction and service identity after expiry confirmation", async () => {
      const f = await expiredEnrollmentFixture();
      const confirm = async () => {
        await writeFile(
          join(f.transaction, ".enrollment-state.json"),
          JSON.stringify({ ...f.state, workerId: randomUUID() }),
        );
        throw new WorkerEnrollmentError("WORKER_EXPIRED", 410, false);
      };
      await expect(
        resetPendingMacUserEnrollment(f.layout, {
          launchAgent: f.service,
          confirmExpiredInstallation: confirm,
        }),
      ).rejects.toThrow();
      expect((await lstat(f.transaction)).isDirectory()).toBe(true);
      const next = await expiredEnrollmentFixture();
      next.service.status
        .mockResolvedValueOnce(next.stopped)
        .mockResolvedValueOnce({ loaded: true, running: true });
      await expect(
        resetPendingMacUserEnrollment(next.layout, {
          launchAgent: next.service,
          confirmExpiredInstallation: next.expired,
        }),
      ).rejects.toThrow("changed during expiry confirmation");
      expect((await lstat(next.transaction)).isDirectory()).toBe(true);
    });
  },
);

async function expiredEnrollmentFixture() {
  const root = await temporaryRoot();
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const layout = createMacUserLayout(home);
  await createMacUserDirectories(layout);
  const transaction = join(layout.transactionRoot, "install");
  const artifactRoot = join(transaction, "installation-artifacts");
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const releaseRoot = join(layout.releasesRoot, "app-fixture");
  await mkdir(releaseRoot, { mode: 0o700 });
  const modelPath = join(layout.modelRoot, "model.onnx");
  const outputPath = join(layout.workRoot, "qualification-output.mp3");
  await writeFile(modelPath, "model", { mode: 0o600 });
  await writeFile(outputPath, "retained qualification output", { mode: 0o600 });
  await writeFile(
    join(layout.stateRoot, "qualification.json"),
    "retained PASS report",
    { mode: 0o600 },
  );
  await writeFile(join(artifactRoot, "fixture.wav"), "fixture", {
    mode: 0o600,
  });
  const state = {
    schemaVersion: 1,
    exchangeRequestId: randomUUID(),
    reportRequestId: randomUUID(),
    activationRequestId: randomUUID(),
    qualificationGrantRequestId: randomUUID(),
    qualificationConfirmRequestId: randomUUID(),
    installationId: randomUUID(),
    installationCredential: "i".repeat(43),
    machineCredential: "m".repeat(43),
    workerId: randomUUID(),
  };
  await writeFile(
    join(transaction, "enrollment.credential"),
    `${"p".repeat(43)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(transaction, ".enrollment-state.json"),
    JSON.stringify(state),
    { mode: 0o600 },
  );
  await writeFile(
    join(transaction, "machine.credential"),
    `${state.machineCredential}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(transaction, "installation-artifacts.json"),
    JSON.stringify({
      schemaVersion: 1,
      installationId: state.installationId,
      releaseVersion: "app-fixture",
      release: { releaseRoot },
      model: { path: modelPath, bytes: 5, sha256: "a".repeat(64) },
      fixture: {
        path: join(artifactRoot, "fixture.wav"),
        sha256: "b".repeat(64),
      },
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(transaction, ".qualification-receipt.json"),
    JSON.stringify({ installationId: state.installationId }),
    { mode: 0o600 },
  );
  const stopped = { loaded: false, running: false };
  const service = { status: vi.fn(async () => stopped) };
  const expired = vi.fn(async () => {
    throw new WorkerEnrollmentError("WORKER_EXPIRED", 410, false);
  });
  return {
    layout,
    transaction,
    state,
    stopped,
    service,
    expired,
    releaseRoot,
    modelPath,
    outputPath,
  };
}

describe.skipIf(process.platform !== "darwin")(
  "deleted machine registration cleanup",
  () => {
    it("archives only confirmed deleted identity state and preserves runtime, model and history", async () => {
      const f = await deletedFixture();
      await f.write("models/model.onnx", "model");
      await f.write("runtime/releases/retained/binding.json", "binding");
      await symlink("releases/retained", f.layout.currentLink);
      await f.write("logs/worker.stderr.log", "historical service log");
      await f.write("jobs/attempts/history.mp3", "historical output");
      await f.write("cache/retained", "cache");
      await f.write("state/qualified-rollback.json", "rollback");
      await f.write(
        "state/transactions/install/.enrollment-state.json",
        "old protected enrollment",
      );
      await f.write("config/restart-budget.json", "old permanent failure");
      await writeMachineDeletionNotice(f.layout, f.machineId);
      await expect(f.reset()).resolves.toEqual({
        deleted: true,
        registrationReset: true,
      });
      for (const [path, contents] of [
        ["models/model.onnx", "model"],
        ["runtime/releases/retained/binding.json", "binding"],
        ["logs/worker.stderr.log", "historical service log"],
        ["jobs/attempts/history.mp3", "historical output"],
        ["cache/retained", "cache"],
        ["state/qualified-rollback.json", "rollback"],
      ])
        expect(await readFile(join(f.layout.installRoot, path!), "utf8")).toBe(
          contents,
        );
      expect(await lstat(f.layout.currentLink)).toBeDefined();
      for (const path of [
        f.layout.installationStatePath,
        f.layout.runtimeStatusPath,
        f.layout.lifecyclePath,
        f.layout.unpairReceiptPath,
        join(f.layout.configRoot, "restart-budget.json"),
        join(f.layout.transactionRoot, "install"),
      ])
        await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
      const journal = JSON.parse(
        await readFile(
          join(f.layout.stateRoot, "deleted-registration.json"),
          "utf8",
        ),
      );
      const archive = join(
        f.layout.stateRoot,
        "deleted-registrations",
        journal.archiveId,
      );
      expect((await lstat(archive)).mode & 0o777).toBe(0o700);
      expect(
        await readFile(join(archive, "config__restart-budget.json"), "utf8"),
      ).toBe("old permanent failure");
      expect(journal.phase).toBe("complete");
      expect(f.service.bootout).toHaveBeenCalledOnce();
      await expect(f.reset()).resolves.toEqual({
        deleted: true,
        registrationReset: true,
      });
      await expect(
        finishDeletedMacRegistration(f.layout, f.machineId),
      ).rejects.toThrow("conflicts");
      await finishDeletedMacRegistration(f.layout, randomUUID());
      await expect(
        lstat(join(f.layout.stateRoot, "deleted-registration.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await lstat(archive)).toBeDefined();
    });

    it.each([
      "state/installation.json",
      "state/runtime-status.json",
      "state/unpaired.json",
    ])(
      "resumes exact archive moves after interruption at %s",
      async (boundary) => {
        const f = await deletedFixture();
        await expect(
          resetDeletedMacRegistration({
            layout: f.layout,
            service: f.service,
            afterArchive: async (path) => {
              if (path === boundary) throw new Error("interrupted");
            },
          }),
        ).rejects.toThrow("interrupted");
        const prior = JSON.parse(
          await readFile(
            join(f.layout.stateRoot, "deleted-registration.json"),
            "utf8",
          ),
        );
        expect(prior.phase).toBe("archiving");
        await expect(f.reset()).resolves.toMatchObject({
          registrationReset: true,
        });
        const next = JSON.parse(
          await readFile(
            join(f.layout.stateRoot, "deleted-registration.json"),
            "utf8",
          ),
        );
        expect(next.archiveId).toBe(prior.archiveId);
        expect(next.phase).toBe("complete");
      },
    );

    it("preserves old diagnostic bytes while new identity delivers only a fresh stream", async () => {
      const f = await deletedFixture();
      const logs = join(f.layout.installRoot, "jobs", "logs");
      const oldSpool = new DiagnosticSpool(logs);
      await oldSpool.initialize();
      oldSpool.record({ kind: "old-machine-private-event" });
      await oldSpool.flush();
      const oldForwarder = new DiagnosticForwarder(
        join(logs, "delivery.json"),
        oldSpool,
        {
          appendDiagnosticLogs: async () => {
            throw new Error("lost ack");
          },
        },
        { sessionId: randomUUID(), incarnation: randomUUID() },
      );
      await expect(oldForwarder.pump()).rejects.toThrow("lost ack");
      oldForwarder.stop();
      await f.reset();
      const journal = JSON.parse(
        await readFile(
          join(f.layout.stateRoot, "deleted-registration.json"),
          "utf8",
        ),
      );
      const archived = join(
        f.layout.stateRoot,
        "deleted-registrations",
        journal.archiveId,
      );
      expect(
        await readFile(join(archived, "jobs__logs__events.jsonl"), "utf8"),
      ).toContain("old-machine-private-event");
      expect(
        await readFile(join(archived, "jobs__logs__delivery.json"), "utf8"),
      ).toContain("old-machine-private-event");
      const newSpool = new DiagnosticSpool(logs);
      await newSpool.initialize();
      newSpool.record({ kind: "new-machine-event" });
      await newSpool.flush();
      const append = vi.fn(async (batch: { sequenceEnd: number }) => ({
        acknowledgedSequence: batch.sequenceEnd,
        replayed: false,
      }));
      const fresh = new DiagnosticForwarder(
        join(logs, "delivery.json"),
        newSpool,
        { appendDiagnosticLogs: append },
        { sessionId: randomUUID(), incarnation: randomUUID() },
      );
      await fresh.pump();
      expect(JSON.stringify(append.mock.calls)).toContain("new-machine-event");
      expect(JSON.stringify(append.mock.calls)).not.toContain(
        "old-machine-private-event",
      );
      fresh.stop();
    });

    it.each([
      "ordinary-revocation",
      "old-credential",
      "active-attempt",
      "unknown-runtime",
      "personal-reservation",
      "receipt-mismatch",
      "receipt-symlink",
      "archive-symlink",
    ])("refuses %s before archiving", async (guard) => {
      const f = await deletedFixture();
      if (guard === "ordinary-revocation")
        await writeConfirmedUnpairReceipt(
          f.layout.unpairReceiptPath,
          f.machineId,
        );
      if (guard === "old-credential")
        await f.write("credentials/machine.credential", "synthetic");
      if (guard === "active-attempt")
        await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [
          randomUUID(),
        ]);
      if (guard === "unknown-runtime") await rm(f.layout.runtimeStatusPath);
      if (guard === "personal-reservation")
        await f.write("state/personal-admission.json", "unknown ownership");
      if (guard === "receipt-mismatch")
        await writeConfirmedUnpairReceipt(
          f.layout.unpairReceiptPath,
          randomUUID(),
          new Date(),
          true,
        );
      if (guard === "receipt-symlink") {
        const receipt = f.layout.unpairReceiptPath;
        await renameForTest(receipt, `${receipt}.retained`);
        await symlink(`${receipt}.retained`, receipt);
      }
      if (guard === "archive-symlink") {
        const outside = join(f.layout.homeRoot, "outside");
        await mkdir(outside, { mode: 0o700 });
        await symlink(
          outside,
          join(f.layout.stateRoot, "deleted-registrations"),
        );
      }
      await expect(f.reset()).rejects.toThrow();
      expect(await lstat(f.layout.installationStatePath)).toBeDefined();
      await expect(
        lstat(join(f.layout.stateRoot, "deleted-registration.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("exposes only a validated token-free local deletion notice", async () => {
      const f = await deletedFixture();
      await writeMachineDeletionNotice(f.layout, f.machineId);
      await expect(loadMachineDeletionNotice(f.layout)).resolves.toMatchObject({
        code: "WORKER_MACHINE_DELETED",
        httpStatus: 410,
      });
      await f.write(
        "state/machine-deleted.json",
        JSON.stringify({
          schemaVersion: 1,
          code: "WORKER_UNAUTHENTICATED",
          httpStatus: 410,
          detectedAt: new Date().toISOString(),
        }),
      );
      await expect(loadMachineDeletionNotice(f.layout)).rejects.toThrow(
        "invalid",
      );
    });
  },
);

describe.skipIf(process.platform !== "darwin")(
  "deleted registration ownership fences",
  () => {
    it("does not archive while the service or recorded supervisor is still alive", async () => {
      const f = await deletedFixture();
      const service = {
        status: async () => ({ loaded: true, running: true }),
        bootout: vi.fn(async () => undefined),
      };
      await expect(
        resetDeletedMacRegistration({ layout: f.layout, service }),
      ).rejects.toThrow("did not stop");
      await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [], {
        processId: process.pid,
        childState: "stopped",
      });
      await expect(f.reset()).rejects.toThrow("ENGINE_EXIT_UNCONFIRMED");
      expect(await lstat(f.layout.installationStatePath)).toBeDefined();
    });
    it("rejects replaced archive files and preserves a newer pending enrollment", async () => {
      const f = await deletedFixture();
      await f.write(
        "state/transactions/install/.enrollment-state.json",
        "old enrollment",
      );
      await f.reset();
      await f.write(
        "state/transactions/install/.enrollment-state.json",
        "new protected enrollment",
      );
      await expect(f.reset()).rejects.toThrow("archive identity changed");
      expect(
        await readFile(
          join(f.layout.transactionRoot, "install", ".enrollment-state.json"),
          "utf8",
        ),
      ).toBe("new protected enrollment");
      await rm(join(f.layout.transactionRoot, "install"), { recursive: true });
      const journal = JSON.parse(
        await readFile(
          join(f.layout.stateRoot, "deleted-registration.json"),
          "utf8",
        ),
      );
      const archived = join(
        f.layout.stateRoot,
        "deleted-registrations",
        journal.archiveId,
        "state__installation.json",
      );
      await renameForTest(archived, `${archived}.retained`);
      await writeFile(archived, "{}", { mode: 0o600 });
      await expect(f.reset()).rejects.toThrow("archive identity changed");
    });
  },
);

async function deletedFixture() {
  const root = await temporaryRoot();
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const layout = createMacUserLayout(home);
  await createMacUserDirectories(layout);
  const machineId = randomUUID();
  const write = async (path: string, contents: string) => {
    const target = join(layout.installRoot, path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, contents, { mode: 0o600 });
  };
  await write(
    "state/installation.json",
    JSON.stringify({ schemaVersion: 1, machineId }),
  );
  await writeLocalRuntimeStatus(layout.runtimeStatusPath, [], {
    childState: "stopped",
    currentAttempts: [],
  });
  await write("state/lifecycle.json", "old draining lifecycle");
  await writeConfirmedUnpairReceipt(
    layout.unpairReceiptPath,
    machineId,
    new Date(),
    true,
  );
  let loaded = true;
  const service = {
    status: vi.fn(async () => ({ loaded, running: loaded })),
    bootout: vi.fn(async () => {
      loaded = false;
    }),
  };
  return {
    layout,
    machineId,
    write,
    service,
    reset: () => resetDeletedMacRegistration({ layout, service }),
  };
}

async function renameForTest(from: string, to: string) {
  const { rename } = await import("node:fs/promises");
  await rename(from, to);
}

async function releaseFixture(root: string, version: string): Promise<void> {
  for (const path of [
    "app/dist/src/cli/main.js",
    "runtime/node/bin/node",
    "runtime/python/bin/python3.13",
    "runtime/bin/ffmpeg",
    "runtime/bin/ffprobe",
  ]) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(absolute, 0o755);
  }
  await symlink(
    "python3.13",
    join(root, "runtime", "python", "bin", "python3"),
  );
  await mkdir(join(root, "app", "engine"), { recursive: true });
  await writeFile(join(root, "app", "engine", "module.py"), "VALUE = 1\n");
  await writeFile(
    join(root, "app", "package.json"),
    '{"name":"@music-mute/worker","version":"0.1.0"}\n',
  );
  for (const [path, value] of [
    ["runtime/licenses/ffmpeg/COPYING.LGPLv2.1", "license\n"],
    ["runtime/licenses/lame/COPYING", "license\n"],
    ["runtime/media-source-manifest.json", '{"schemaVersion":1}\n'],
  ] as const) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, value);
  }
  await writeMacReleaseManifest(root, version);
}

async function qualificationRetryFixture() {
  const root = await temporaryRoot();
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const layout = createMacUserLayout(home);
  const sourceRelease = join(root, "release");
  await releaseFixture(sourceRelease, "0.1.0");
  const modelPath = join(root, "model.onnx");
  const fixturePath = join(root, "fixture.wav");
  await writeFile(modelPath, "model", { mode: 0o600 });
  await writeFile(fixturePath, "fixture", { mode: 0o600 });
  const modelDigest = createHash("sha256").update("model").digest("hex");
  const fixtureDigest = createHash("sha256").update("fixture").digest("hex");
  const transaction = join(layout.transactionRoot, "install");
  const statePath = join(transaction, ".enrollment-state.json");
  const reportPath = join(layout.stateRoot, "qualification.json");
  const outputPath = join(
    layout.workRoot,
    `qualification-${randomUUID()}`,
    "vocals.mp3",
  );
  let installationId: string = randomUUID();
  let releaseVersion = "0.1.0";
  const seed = {
    schemaVersion: 1,
    installationId,
    installationCredential: "i".repeat(43),
    machineCredential: "m".repeat(43),
    workerId,
    exchangeRequestId: randomUUID(),
    reportRequestId: randomUUID(),
    activationRequestId: randomUUID(),
    qualificationGrantRequestId: randomUUID(),
    qualificationConfirmRequestId: randomUUID(),
  };
  const prepare = vi.fn(async (args: string[]) => {
    const output = args[args.indexOf("--output") + 1]!;
    await writeFile(
      join(output, "installation-artifacts.json"),
      JSON.stringify({
        schemaVersion: 1,
        installationId,
        platform: "darwin-arm64",
        releaseVersion,
        release: { releaseRoot: sourceRelease },
        model: { path: modelPath, bytes: 5, sha256: modelDigest },
        fixture: { path: fixturePath, sha256: fixtureDigest },
      }),
      { mode: 0o600 },
    );
    try {
      await lstat(statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(statePath, JSON.stringify(seed), { mode: 0o600 });
    }
  });
  const qualify = vi.fn(async (_layout: MacUserLayout, releaseRoot: string) => {
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    await writeFile(outputPath, "qualified output", { mode: 0o600 });
    const outputDigest = createHash("sha256")
      .update("qualified output")
      .digest("hex");
    await writeFile(
      reportPath,
      JSON.stringify({
        schemaVersion: 1,
        status: "PASS",
        platform: "darwin-arm64",
        provider: "mps",
        gpuId: "gpu0",
        directmlDeviceId: 0,
        serviceIdentity: "tester",
        releaseManifestDigest: createHash("sha256")
          .update(await readFile(join(releaseRoot, "release-manifest.json")))
          .digest("hex"),
        modelDigest,
        fixtureDigest,
        providerDispatch: {
          expectedProvider: "MPS",
          profileCount: 0,
          acceleratedNodeEvents: 2,
          cpuNodeEvents: 0,
          proven: true,
        },
        recipes: MAC_RECIPE_IDS.map((recipeId) => ({
          recipeId,
          recipeDigest: "c".repeat(64),
          resultDigest: outputDigest,
          resultBytes: 16,
          sourceDurationSeconds: 6,
          outputDurationSeconds: 6,
          endToEndSeconds: 1,
        })),
        uploadCandidate: {
          path: outputPath,
          resultDigest: outputDigest,
          resultBytes: 16,
          contentType: "audio/mpeg",
        },
        totalSeconds: 2,
      }),
      { mode: 0o600 },
    );
    return reportPath;
  });
  const enroll = vi.fn(async (_args: string[]) => {
    if (enroll.mock.calls.length === 1)
      throw new Error("fixture enrollment unavailable");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    await writeFile(
      statePath,
      JSON.stringify({ ...state, machineId, workerId }),
      { mode: 0o600 },
    );
    await writeFile(
      join(transaction, "machine.credential"),
      `${"m".repeat(43)}\n`,
      { mode: 0o600 },
    );
  });
  let loaded = false;
  const launchAgent = {
    status: vi.fn(async () => ({ loaded, running: loaded })),
    bootstrap: vi.fn(async () => {
      loaded = true;
    }),
    bootout: vi.fn(async () => {
      loaded = false;
    }),
  };
  const options: MacUserInstallationOptions = {
    layout,
    uid: process.getuid!(),
    label: "Retry Mac",
    enrollmentCredential: "x".repeat(43),
    prepare,
    qualify,
    enroll,
    launchAgent,
    inspectRuntime: async () => compatibleRuntime,
  };
  return {
    options,
    qualify,
    enroll,
    statePath,
    reportPath,
    outputPath,
    fixturePath,
    setInstallationId: (value: string) => {
      installationId = value;
    },
    changeRelease: async () => {
      releaseVersion = "0.1.1";
      await rm(join(sourceRelease, "release-manifest.json"));
      await writeMacReleaseManifest(sourceRelease, releaseVersion);
    },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-installer-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
