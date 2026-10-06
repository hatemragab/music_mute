import { BUILT_IN_UPDATE_TRUST } from "../src/platform/shared/update-trust.js";
import { compareWorkerReleaseVersions } from "../src/platform/shared/release-version.js";
import { capacityReport } from "./fixtures/capacity-benchmark.js";
import { parseCapacityBenchmarkReport } from "../src/platform/shared/capacity-benchmark.js";
import { createCapacityReceipt } from "../src/runtime/capacity-receipt.js";
import { observeFixtureLifecycle } from "./fixtures/lifecycle-observer.js";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  randomUUID,
} from "node:crypto";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInstallationReleaseArchive } from "../src/enrollment/release-archive.js";
import {
  initializeLocalLifecycle,
  loadLocalLifecycle,
  setLocalLifecycleIntent,
} from "../src/runtime/local-lifecycle.js";
import { writeLocalRuntimeStatus } from "../src/runtime/local-runtime-status.js";
import { writeMacReleaseManifest } from "../src/platform/macos/release-manifest.js";
import { buildMacUserRuntimeConfig } from "../src/platform/macos/user-installer.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";
import {
  installMacUserRelease,
  activateMacUserRelease,
  stageMacUserRelease,
} from "../src/platform/macos/user-release.js";
import {
  checkMacUserUpdate,
  loadUpdateState,
  loadMacUpdateTrust,
  recoverInterruptedMacUpdate,
  recoverMacUpdateAtStartup,
  MacUpdateStartupRecovered,
  updateMacUserWorker,
} from "../src/platform/macos/user-updater.js";
import {
  canonicalUpdateMetadata,
  type UpdateCandidate,
  type UpdateMetadata,
} from "../src/platform/shared/update-metadata.js";
import { withMacUserCommandLock } from "../src/platform/macos/command-lock.js";

import { installedCapacityIdentity } from "../src/runtime/capacity-identity.js";
import {
  loadRuntimeConfig,
  readMaintenanceConnection,
} from "../src/runtime/runtime-config.js";

const roots: string[] = [];
const stopObservers: Array<() => Promise<void>> = [];
const startupService = {
  status: async () => ({ loaded: true, running: true, pid: process.pid }),
};
const machineId = "32410a14-e85a-4a1d-bb99-61fa54b07eaa";
const workerId = "718bd89b-bd03-43f7-adb7-9cb5ff415918";

vi.setConfig({ testTimeout: 15_000 });

afterEach(async () => {
  await Promise.all(stopObservers.splice(0).map((stop) => stop()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// These fixtures exercise Darwin paths, UID ownership and POSIX permissions.
describe.skipIf(process.platform !== "darwin")(
  "macOS transactional updater",
  () => {
    it.skipIf(process.platform !== "darwin").each([
      { boundary: "stopped", twoSlots: false },
      { boundary: "activated", twoSlots: false },
      { boundary: "stopped", twoSlots: true },
      { boundary: "activated", twoSlots: true },
      { boundary: "qualifying", twoSlots: false },
    ])(
      "a fresh process recovers after $boundary (two slots=$twoSlots)",
      async ({ boundary, twoSlots }) => {
        const fixture = await updateFixture();
        if (twoSlots) await enableTwoSlots(fixture.layout);
        const originalConfig = JSON.parse(
          await readFile(fixture.layout.configPath, "utf8"),
        );
        const nativeLabel =
          process.env.MUSICMUTE_TEST_LAUNCHD === "true"
            ? `com.musicmute.recovery-test.${randomUUID()}`
            : undefined;
        await setLocalLifecycleIntent(fixture.layout.lifecyclePath, "paused");
        const servicePath = join(fixture.layout.stateRoot, "test-service.json");
        const inputPath = join(
          fixture.layout.stateRoot,
          "test-interruption.json",
        );
        await writeFile(servicePath, "true", { mode: 0o600 });
        await writeFile(
          inputPath,
          JSON.stringify({
            layout: fixture.layout,
            candidate: fixture.candidate,
            now: fixture.now,
            archivePath: fixture.archivePath,
            servicePath,
            boundary,
            nativeLabel,
          }),
          { mode: 0o600 },
        );
        const run = (mode: string) =>
          fork(
            new URL("./fixtures/interrupted-update.mjs", import.meta.url),
            [new URL("../src/", import.meta.url).href, inputPath, mode],
            {
              execArgv: ["--experimental-transform-types"],
              stdio: ["ignore", "ignore", "pipe", "ipc"],
            },
          );
        const child = run("update");
        let stderr = "";
        child.stderr!.on("data", (chunk) => {
          stderr += String(chunk);
        });
        const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
        try {
          const [message] = await Promise.race([
            once(child, "message"),
            once(child, "exit").then(() => {
              throw new Error(`Updater exited before boundary: ${stderr}`);
            }),
          ]);
          expect(message).toEqual({ boundary });
          expect(JSON.parse(await readFile(servicePath, "utf8"))).toBe(
            boundary === "activated" || boundary === "qualifying",
          );
          expect(
            JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
          ).toMatchObject({
            status: boundary === "activated" ? "activating" : "staged",
            recovery: {
              previousVersion: "0.1.0",
              intent: "paused",
              serviceWasLoaded: true,
            },
          });
          expect(await readlink(fixture.layout.currentLink)).toBe(
            boundary === "activated" ? "releases/0.2.0" : "releases/0.1.0",
          );
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          expect((await exited)[1]).toBe("SIGKILL");
          if (boundary === "qualifying")
            await rm(fixture.layout.runtimeStatusPath);
          const recovery = run("recover");
          recovery.stderr!.on("data", (chunk) => {
            stderr += String(chunk);
          });
          const recoveryDeadline = setTimeout(
            () => recovery.kill("SIGKILL"),
            10_000,
          );
          try {
            expect((await once(recovery, "exit"))[0], stderr).toBe(0);
          } finally {
            clearTimeout(recoveryDeadline);
          }
          expect(await readlink(fixture.layout.currentLink)).toBe(
            "releases/0.1.0",
          );
          expect(
            JSON.parse(await readFile(fixture.layout.configPath, "utf8")),
          ).toEqual(originalConfig);
          expect(
            (await loadRuntimeConfig(fixture.layout.configPath)).slots,
          ).toHaveLength(twoSlots ? 2 : 1);
          expect(
            (await loadLocalLifecycle(fixture.layout.lifecyclePath)).intent,
          ).toBe("paused");
          expect(JSON.parse(await readFile(servicePath, "utf8"))).toBe(true);
          expect(
            JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
          ).toMatchObject({
            status: "rolled-back",
            quarantinedVersions: ["0.2.0"],
          });
          expect(
            JSON.parse(
              await readFile(fixture.layout.installationStatePath, "utf8"),
            ),
          ).toMatchObject({ releaseVersion: "0.1.0" });
        } finally {
          clearTimeout(deadline);
          if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
          }
          if (nativeLabel) {
            const target = `gui/${process.getuid!()}/${nativeLabel}`;
            try {
              execFileSync("/bin/launchctl", ["bootout", target], {
                timeout: 8000,
                stdio: "pipe",
              });
            } catch (error) {
              expect([3, 113]).toContain((error as { status?: number }).status);
            }
            expect(() =>
              execFileSync("/bin/launchctl", ["print", target], {
                timeout: 3000,
                stdio: "pipe",
              }),
            ).toThrow();
          }
        }
      },
    );
    it.each([true, false])(
      "recovers before service processing and requests restart=%s",
      async (serviceWasLoaded) => {
        const fixture = await updateFixture();
        await writeFile(
          fixture.layout.updateStatePath,
          JSON.stringify({
            schemaVersion: 1,
            highestSequence: 0,
            status: "staged",
            candidateVersion: "0.2.0",
            quarantinedVersions: [],
            updatedAt: new Date().toISOString(),
            recovery: {
              previousVersion: "0.1.0",
              intent: "paused",
              serviceWasLoaded,
            },
          }),
          { mode: 0o600 },
        );
        await expect(
          recoverMacUpdateAtStartup(fixture.layout, startupService),
        ).rejects.toMatchObject({
          restart: serviceWasLoaded,
          constructor: MacUpdateStartupRecovered,
        });
        expect(
          (await loadLocalLifecycle(fixture.layout.lifecyclePath)).intent,
        ).toBe("paused");
        expect(
          JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8"))
            .status,
        ).toBe("rolled-back");
        await expect(
          recoverMacUpdateAtStartup(fixture.layout, startupService),
        ).resolves.toBeUndefined();
      },
    );

    it("allows a live updater candidate but refuses ambiguous startup ownership", async () => {
      const fixture = await updateFixture();
      await writeFile(
        fixture.layout.updateStatePath,
        JSON.stringify({
          schemaVersion: 1,
          highestSequence: 0,
          status: "activating",
          candidateVersion: "0.2.0",
          quarantinedVersions: [],
          updatedAt: new Date().toISOString(),
          recovery: {
            previousVersion: "0.1.0",
            intent: "paused",
            serviceWasLoaded: true,
          },
        }),
        { mode: 0o600 },
      );
      await expect(
        recoverMacUpdateAtStartup(fixture.layout, {
          status: async () => ({
            loaded: true,
            running: true,
            pid: process.pid + 1,
          }),
        }),
      ).rejects.toThrow("requires the managed service process");
      await withMacUserCommandLock(
        fixture.layout.commandLockPath,
        async () => {
          await expect(
            recoverMacUpdateAtStartup(fixture.layout, startupService),
          ).resolves.toBeUndefined();
        },
        "update",
      );
      await withMacUserCommandLock(
        fixture.layout.commandLockPath,
        async () => {
          await expect(
            recoverMacUpdateAtStartup(fixture.layout, startupService),
          ).rejects.toThrow("already running");
        },
        "pause",
      );
      await writeFile(fixture.layout.commandLockPath, "", { mode: 0o600 });
      await expect(
        recoverMacUpdateAtStartup(fixture.layout, startupService),
      ).rejects.toThrow("ownership is unknown");
      expect(
        JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8"))
          .status,
      ).toBe("activating");
    });

    it.each([
      ["0.1.0-mvp.11", "0.1.0-mvp.2", 1],
      ["0.1.0-mvp.2", "0.1.0-mvp.11", -1],
      ["0.2.0", "0.1.99", 1],
      ["1.0.0", "1.0.0-rc.9", 1],
      ["1.0.0+build.2", "1.0.0+build.1", 0],
    ] as const)("orders release %s against %s", (left, right, expected) => {
      expect(Math.sign(compareWorkerReleaseVersions(left, right))).toBe(
        expected,
      );
    });

    it("uses the built-in production key when the optional trust file is absent", async () => {
      const root = await temporaryRoot();
      const home = join(root, "home");
      await mkdir(home, { mode: 0o700 });
      const layout = createMacUserLayout(home);
      await createMacUserDirectories(layout);

      const trust = await loadMacUpdateTrust(layout.updateTrustPath);

      expect(trust).toEqual(BUILT_IN_UPDATE_TRUST);
      expect(
        createPublicKey(trust["worker-release-2026-09"]!).asymmetricKeyType,
      ).toBe("ed25519");
      await expect(lstat(layout.updateTrustPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("merges optional rotation keys without allowing built-in replacement", async () => {
      const root = await temporaryRoot();
      const home = join(root, "home");
      await mkdir(home, { mode: 0o700 });
      const layout = createMacUserLayout(home);
      await createMacUserDirectories(layout);
      const additional = generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString();
      await writeFile(
        layout.updateTrustPath,
        `${JSON.stringify({ "release-next": additional })}\n`,
        { mode: 0o600 },
      );

      await expect(loadMacUpdateTrust(layout.updateTrustPath)).resolves.toEqual(
        {
          "release-next": additional,
          ...BUILT_IN_UPDATE_TRUST,
        },
      );
      await writeFile(
        layout.updateTrustPath,
        `${JSON.stringify({ "worker-release-2026-09": additional })}\n`,
        { mode: 0o600 },
      );
      await expect(loadMacUpdateTrust(layout.updateTrustPath)).rejects.toThrow(
        "cannot replace a built-in key",
      );
    });

    it("checks signed metadata without downloading or changing the active release", async () => {
      const fixture = await updateFixture();
      const before = await readlink(fixture.layout.currentLink);
      const checked = await checkMacUserUpdate(fixture.layout, {
        candidate: async () => fixture.candidate,
        now: fixture.now,
      });
      expect(checked).toMatchObject({
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        sequence: 2,
        updateAvailable: true,
      });
      expect(await readlink(fixture.layout.currentLink)).toBe(before);
    });

    it("downloads, qualifies, atomically activates, and records a healthy update", async () => {
      const fixture = await updateFixture();
      const qualify = vi.fn(async () =>
        join(fixture.layout.stateRoot, "report.json"),
      );
      const result = await updateMacUserWorker({
        layout: fixture.layout,
        uid: process.getuid!(),
        candidate: async () => fixture.candidate,
        now: fixture.now,
        fetch: fixture.fetch,
        qualify,
        launchAgent: fixture.launchAgent,
        confirmStarted: async () => true,
        health: async () => true,
      });

      expect(result).toEqual({
        status: "updated",
        releaseVersion: "0.2.0",
        sequence: 2,
      });
      expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.2.0");
      expect(qualify).toHaveBeenCalledOnce();
      expect(qualify).toHaveBeenCalledWith(
        fixture.layout,
        join(fixture.layout.releasesRoot, "0.2.0"),
        join(fixture.layout.stateRoot, "qualification.wav"),
        expect.any(String),
        fixture.launchAgent,
        false,
      );
      expect(
        JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
      ).toMatchObject({
        highestSequence: 2,
        status: "healthy",
        knownGoodVersion: "0.2.0",
      });
      expect(
        JSON.parse(
          await readFile(fixture.layout.installationStatePath, "utf8"),
        ),
      ).toMatchObject({ releaseVersion: "0.2.0" });
      expect(
        JSON.parse(await readFile(fixture.layout.configPath, "utf8")),
      ).toMatchObject({ slots: [{ provider: "mps" }] });
      await expect(
        lstat(join(fixture.layout.transactionRoot, "updates", "2")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await lstat(join(fixture.layout.releasesRoot, "0.1.0"))).isDirectory(),
      ).toBe(true);
      expect(
        (await lstat(join(fixture.layout.releasesRoot, "0.2.0"))).isDirectory(),
      ).toBe(true);
    });

    it("keeps an accepted update healthy when scratch removal fails", async () => {
      const fixture = await updateFixture();
      const removeTransaction = vi.fn(async () => {
        throw new Error("permission denied with private path");
      });
      const result = await updateMacUserWorker({
        layout: fixture.layout,
        uid: process.getuid!(),
        candidate: async () => fixture.candidate,
        now: fixture.now,
        fetch: fixture.fetch,
        qualify: async () => "report.json",
        launchAgent: fixture.launchAgent,
        confirmStarted: async () => true,
        health: async () => true,
        removeTransaction,
      });
      expect(result).toEqual({
        status: "updated",
        releaseVersion: "0.2.0",
        sequence: 2,
        cleanupWarning:
          "Update scratch cleanup deferred; run mw cleanup --apply",
      });
      expect(removeTransaction).toHaveBeenCalledWith(
        join(fixture.layout.transactionRoot, "updates", "2"),
      );
      expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.2.0");
      expect(
        JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
      ).toMatchObject({ status: "healthy", highestSequence: 2 });
    });

    it("preserves the original update failure when scratch removal fails", async () => {
      const fixture = await updateFixture();
      const warning = vi
        .spyOn(process, "emitWarning")
        .mockImplementation(() => {});
      try {
        await expect(
          updateMacUserWorker({
            layout: fixture.layout,
            uid: process.getuid!(),
            candidate: async () => fixture.candidate,
            now: fixture.now,
            fetch: fixture.fetch,
            availableDiskBytes: async () => 0,
            launchAgent: fixture.launchAgent,
            removeTransaction: async () => {
              throw new Error("cleanup failure");
            },
          }),
        ).rejects.toThrow("Insufficient disk space");
        expect(warning).toHaveBeenCalledWith(
          "Update scratch cleanup deferred; run mw cleanup --apply",
          { code: "WORKER_CLEANUP_DEFERRED" },
        );
      } finally {
        warning.mockRestore();
      }
    });

    it("keeps scratch while rollback still has a pending restart", async () => {
      const fixture = await updateFixture();
      const removeTransaction = vi.fn(async () => {});
      fixture.launchAgent.bootstrap.mockRejectedValueOnce(
        new Error("recovery bootstrap failed"),
      );
      await expect(
        updateMacUserWorker({
          layout: fixture.layout,
          uid: process.getuid!(),
          candidate: async () => fixture.candidate,
          now: fixture.now,
          fetch: fixture.fetch,
          qualify: async () => {
            throw new Error("qualification failed");
          },
          launchAgent: fixture.launchAgent,
          removeTransaction,
        }),
      ).rejects.toThrow("recovery bootstrap failed");
      expect(removeTransaction).not.toHaveBeenCalled();
      expect(
        JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
      ).toMatchObject({
        status: "rolled-back",
        recovery: { serviceWasLoaded: true },
      });
      expect(
        (
          await lstat(join(fixture.layout.transactionRoot, "updates", "2"))
        ).isDirectory(),
      ).toBe(true);
    });

    it("restores lifecycle when failure occurs after service stop but before qualification", async () => {
      const fixture = await updateFixture();
      await setLocalLifecycleIntent(fixture.layout.lifecyclePath, "paused");
      await rm(join(fixture.layout.stateRoot, "qualification.wav"));
      await expect(
        updateMacUserWorker({
          layout: fixture.layout,
          uid: process.getuid!(),
          candidate: async () => fixture.candidate,
          now: fixture.now,
          fetch: fixture.fetch,
          launchAgent: fixture.launchAgent,
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        (await loadLocalLifecycle(fixture.layout.lifecyclePath)).intent,
      ).toBe("paused");
      expect((await fixture.launchAgent.status()).running).toBe(true);
      expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.1.0");
      expect(
        JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
      ).toMatchObject({ status: "rolled-back" });
    });

    it("preserves a deliberately stopped service across successful update", async () => {
      const fixture = await updateFixture();
      await fixture.launchAgent.bootout();
      await setLocalLifecycleIntent(fixture.layout.lifecyclePath, "paused");
      await updateMacUserWorker({
        layout: fixture.layout,
        uid: process.getuid!(),
        candidate: async () => fixture.candidate,
        now: fixture.now,
        fetch: fixture.fetch,
        qualify: async () => "report.json",
        launchAgent: fixture.launchAgent,
      });
      expect(fixture.launchAgent.bootstrap).not.toHaveBeenCalled();
      expect(
        (await loadLocalLifecycle(fixture.layout.lifecyclePath)).intent,
      ).toBe("paused");
      expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.2.0");
    });

    it.each(["staged", "activating"] as const)(
      "recovers an interrupted %s journal and preserves paused intent",
      async (status) => {
        const fixture = await updateFixture();
        await setLocalLifecycleIntent(fixture.layout.lifecyclePath, "draining");
        await fixture.launchAgent.bootout();
        const candidateRoot = join(
          fixture.layout.transactionRoot,
          "recovery-candidate",
        );
        await releaseFixture(candidateRoot, "0.2.0");
        await stageMacUserRelease(fixture.layout, candidateRoot);
        if (status === "activating") {
          await activateMacUserRelease(fixture.layout, "0.2.0");
          const installation = JSON.parse(
            await readFile(fixture.layout.installationStatePath, "utf8"),
          );
          await writeFile(
            fixture.layout.installationStatePath,
            JSON.stringify({ ...installation, releaseVersion: "0.2.0" }),
            { mode: 0o600 },
          );
        }
        await writeFile(
          fixture.layout.updateStatePath,
          JSON.stringify({
            schemaVersion: 1,
            highestSequence: 0,
            status,
            candidateVersion: "0.2.0",
            quarantinedVersions: [],
            updatedAt: new Date().toISOString(),
            recovery: {
              previousVersion: "0.1.0",
              intent: "paused",
              serviceWasLoaded: true,
            },
          }),
          { mode: 0o600 },
        );
        expect(
          await recoverInterruptedMacUpdate(
            fixture.layout,
            fixture.launchAgent,
          ),
        ).toBe(true);
        expect(await readlink(fixture.layout.currentLink)).toBe(
          "releases/0.1.0",
        );
        expect(
          (await loadLocalLifecycle(fixture.layout.lifecyclePath)).intent,
        ).toBe("paused");
        expect(
          JSON.parse(
            await readFile(fixture.layout.installationStatePath, "utf8"),
          ),
        ).toMatchObject({ releaseVersion: "0.1.0" });
        expect(
          JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
        ).toMatchObject({
          status: "rolled-back",
          quarantinedVersions: ["0.2.0"],
        });
        expect(
          await recoverInterruptedMacUpdate(
            fixture.layout,
            fixture.launchAgent,
          ),
        ).toBe(false);
        expect(fixture.launchAgent.bootstrap).toHaveBeenCalledTimes(1);
      },
    );

    it("recovers a temporary interrupted qualifier after durable fleet drain without requiring its nonexistent fleet status", async () => {
      const fixture = await updateFixture();
      await fixture.launchAgent.bootout();
      await rm(fixture.layout.runtimeStatusPath);
      const candidateRoot = join(
        fixture.layout.transactionRoot,
        "recovery-qualification",
      );
      await releaseFixture(candidateRoot, "0.2.0");
      await stageMacUserRelease(fixture.layout, candidateRoot);
      await writeFile(
        fixture.layout.updateStatePath,
        JSON.stringify({
          schemaVersion: 1,
          highestSequence: 7,
          status: "staged",
          candidateVersion: "0.2.0",
          quarantinedVersions: [],
          updatedAt: new Date().toISOString(),
          recovery: {
            previousVersion: "0.1.0",
            intent: "paused",
            serviceWasLoaded: true,
            fleetDrained: true,
          },
        }),
        { mode: 0o600 },
      );
      await fixture.launchAgent.bootstrap();
      const beforeStart = vi.fn(async () => {
        expect((await fixture.launchAgent.status()).loaded).toBe(false);
      });
      expect(
        await recoverInterruptedMacUpdate(
          fixture.layout,
          fixture.launchAgent,
          "Interrupted qualification",
          false,
          beforeStart,
        ),
      ).toBe(true);
      expect(beforeStart).toHaveBeenCalledOnce();
      expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.1.0");
      expect(
        (await loadUpdateState(fixture.layout.updateStatePath)).highestSequence,
      ).toBe(7);
      expect(
        (await loadLocalLifecycle(fixture.layout.lifecyclePath)).intent,
      ).toBe("paused");
    });

    it("never treats an activating candidate's uncertain accepted claims as a disposable qualifier", async () => {
      const fixture = await updateFixture();
      const candidateRoot = join(
        fixture.layout.transactionRoot,
        "recovery-accepted",
      );
      await releaseFixture(candidateRoot, "0.2.0");
      await stageMacUserRelease(fixture.layout, candidateRoot);
      await activateMacUserRelease(fixture.layout, "0.2.0");
      await rm(fixture.layout.runtimeStatusPath);
      await writeFile(
        fixture.layout.updateStatePath,
        JSON.stringify({
          schemaVersion: 1,
          highestSequence: 7,
          status: "activating",
          candidateVersion: "0.2.0",
          quarantinedVersions: [],
          updatedAt: new Date().toISOString(),
          recovery: {
            previousVersion: "0.1.0",
            intent: "active",
            serviceWasLoaded: true,
            fleetDrained: true,
          },
        }),
        { mode: 0o600 },
      );
      const beforeStart = vi.fn(async () => undefined);
      await expect(
        recoverInterruptedMacUpdate(
          fixture.layout,
          fixture.launchAgent,
          "Interrupted activation",
          false,
          beforeStart,
        ),
      ).rejects.toThrow("runtime status is unavailable");
      expect(fixture.launchAgent.bootout).not.toHaveBeenCalled();
      expect(beforeStart).not.toHaveBeenCalled();
      expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.2.0");
    });

    it("refuses to overwrite an unrelated active release during recovery", async () => {
      const fixture = await updateFixture();
      await writeFile(
        fixture.layout.updateStatePath,
        JSON.stringify({
          schemaVersion: 1,
          highestSequence: 0,
          status: "activating",
          candidateVersion: "0.2.0",
          quarantinedVersions: [],
          updatedAt: new Date().toISOString(),
          recovery: {
            previousVersion: "0.1.0",
            intent: "paused",
            serviceWasLoaded: true,
          },
        }),
        { mode: 0o600 },
      );
      await rm(fixture.layout.currentLink);
      await symlink("releases/0.3.0", fixture.layout.currentLink);
      await expect(
        recoverInterruptedMacUpdate(fixture.layout, fixture.launchAgent),
      ).rejects.toThrow("unrelated active release");
      expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.3.0");
      expect(fixture.launchAgent.bootout).not.toHaveBeenCalled();
      expect(
        (await loadLocalLifecycle(fixture.layout.lifecyclePath)).intent,
      ).toBe("active");
    });

    it("retains recovery intent when restoring the service fails", async () => {
      const fixture = await updateFixture();
      const journal = {
        schemaVersion: 1,
        highestSequence: 0,
        status: "staged",
        candidateVersion: "0.2.0",
        quarantinedVersions: [],
        updatedAt: new Date().toISOString(),
        recovery: {
          previousVersion: "0.1.0",
          intent: "active",
          serviceWasLoaded: true,
        },
      };
      await writeFile(fixture.layout.updateStatePath, JSON.stringify(journal), {
        mode: 0o600,
      });
      fixture.launchAgent.bootstrap.mockRejectedValueOnce(
        new Error("bootstrap failed"),
      );
      await expect(
        recoverInterruptedMacUpdate(fixture.layout, fixture.launchAgent),
      ).rejects.toThrow("bootstrap failed");
      expect(
        JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
      ).toMatchObject({ status: "rolled-back", recovery: journal.recovery });
      expect(
        await recoverInterruptedMacUpdate(fixture.layout, fixture.launchAgent),
      ).toBe(true);
    });

    it("restores the known-good release and quarantines a failed candidate", async () => {
      const fixture = await updateFixture();
      await expect(
        updateMacUserWorker({
          layout: fixture.layout,
          uid: process.getuid!(),
          candidate: async () => fixture.candidate,
          now: fixture.now,
          fetch: fixture.fetch,
          qualify: async () => join(fixture.layout.stateRoot, "report.json"),
          launchAgent: fixture.launchAgent,
          confirmStarted: async () => false,
        }),
      ).rejects.toThrow("failed to start");
      expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.1.0");
      expect(
        JSON.parse(await readFile(fixture.layout.configPath, "utf8")),
      ).toMatchObject({ slots: [{ provider: "mps" }] });
      expect(
        JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
      ).toMatchObject({
        status: "rolled-back",
        candidateVersion: "0.2.0",
        quarantinedVersions: ["0.2.0"],
      });
      await expect(
        lstat(join(fixture.layout.transactionRoot, "updates", "2")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("rolls back and quarantines a candidate that fails the runtime doctor", async () => {
      const fixture = await updateFixture();
      await expect(
        updateMacUserWorker({
          layout: fixture.layout,
          uid: process.getuid!(),
          candidate: async () => fixture.candidate,
          now: fixture.now,
          fetch: fixture.fetch,
          qualify: async () => join(fixture.layout.stateRoot, "report.json"),
          launchAgent: fixture.launchAgent,
          confirmStarted: async () => true,
          health: async () => false,
        }),
      ).rejects.toThrow("failed runtime doctor");
      expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.1.0");
      expect(
        JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
      ).toMatchObject({
        status: "rolled-back",
        candidateVersion: "0.2.0",
        quarantinedVersions: ["0.2.0"],
        failure: "Updated worker failed runtime doctor",
      });
    });

    it("rejects insufficient disk before download without changing the active release", async () => {
      const fixture = await updateFixture();
      const fetch = vi.fn(fixture.fetch);
      await expect(
        updateMacUserWorker({
          layout: fixture.layout,
          uid: process.getuid!(),
          candidate: async () => fixture.candidate,
          now: fixture.now,
          fetch,
          availableDiskBytes: async () => 1,
          launchAgent: fixture.launchAgent,
        }),
      ).rejects.toThrow("Insufficient disk space");
      expect(fetch).not.toHaveBeenCalled();
      expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.1.0");
      await expect(
        lstat(join(fixture.layout.transactionRoot, "updates", "2")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("preserves the active release when an offline download is interrupted", async () => {
      const fixture = await updateFixture();
      await expect(
        updateMacUserWorker({
          layout: fixture.layout,
          uid: process.getuid!(),
          candidate: async () => fixture.candidate,
          now: fixture.now,
          fetch: async () => {
            throw new TypeError("network offline");
          },
          availableDiskBytes: async () => Number.MAX_SAFE_INTEGER,
          launchAgent: fixture.launchAgent,
        }),
      ).rejects.toThrow("network offline");
      expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.1.0");
      await expect(
        readFile(fixture.layout.updateStatePath, "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("quarantines a candidate when MPS qualification fails", async () => {
      const fixture = await updateFixture();
      await expect(
        updateMacUserWorker({
          layout: fixture.layout,
          uid: process.getuid!(),
          candidate: async () => fixture.candidate,
          now: fixture.now,
          fetch: fixture.fetch,
          qualify: async () => {
            throw new Error("MPS qualification failed");
          },
          launchAgent: fixture.launchAgent,
        }),
      ).rejects.toThrow("MPS qualification failed");
      expect(await readlink(fixture.layout.currentLink)).toBe("releases/0.1.0");
      expect(
        JSON.parse(await readFile(fixture.layout.updateStatePath, "utf8")),
      ).toMatchObject({
        status: "rolled-back",
        candidateVersion: "0.2.0",
        quarantinedVersions: ["0.2.0"],
      });
    });
  },
);

it.skipIf(process.platform !== "darwin").each([true, false])(
  "updates two-slot installations safely (running=%s)",
  async (running) => {
    const fixture = await updateFixture();
    await enableTwoSlots(fixture.layout);
    if (!running) await fixture.launchAgent.bootout();
    await setLocalLifecycleIntent(fixture.layout.lifecyclePath, "paused");
    const result = await updateMacUserWorker({
      layout: fixture.layout,
      uid: process.getuid!(),
      candidate: async () => fixture.candidate,
      now: fixture.now,
      fetch: fixture.fetch,
      qualify: async () => "report.json",
      launchAgent: fixture.launchAgent,
      confirmStarted: async () => true,
      health: async () => {
        await loadRuntimeConfig(fixture.layout.configPath);
        return true;
      },
    });
    expect(result).toMatchObject({
      status: "updated",
      capacityRequalificationRequired: true,
    });
    const config = await loadRuntimeConfig(fixture.layout.configPath);
    expect(config.validatedMaxWorkersPerGpu).toBe(1);
    expect(config.slots).toHaveLength(1);
    expect(config.slots[0]!.workerId).toBe(workerId);
    const persisted = JSON.parse(
      await readFile(fixture.layout.configPath, "utf8"),
    );
    expect(persisted.inactiveSlots).toEqual([
      expect.objectContaining({
        workerId: "718bd89b-bd03-43f7-adb7-9cb5ff415919",
        slotIndex: 1,
      }),
    ]);
    expect((await fixture.launchAgent.status()).running).toBe(running);
    expect(
      (await loadLocalLifecycle(fixture.layout.lifecyclePath)).intent,
    ).toBe("paused");
  },
);

it.skipIf(process.platform !== "darwin")(
  "does not start a loaded but stopped service after update",
  async () => {
    const fixture = await updateFixture();
    fixture.launchAgent.status.mockResolvedValueOnce({
      loaded: true,
      running: false,
    });
    await updateMacUserWorker({
      layout: fixture.layout,
      uid: process.getuid!(),
      candidate: async () => fixture.candidate,
      now: fixture.now,
      fetch: fixture.fetch,
      qualify: async () => "report.json",
      launchAgent: fixture.launchAgent,
    });
    expect(fixture.launchAgent.bootout).toHaveBeenCalledOnce();
    expect(fixture.launchAgent.bootstrap).not.toHaveBeenCalled();
    expect((await fixture.launchAgent.status()).running).toBe(false);
  },
);

it.skipIf(process.platform !== "darwin")(
  "restores the complete two-slot configuration and approval after failed activation",
  async () => {
    const fixture = await updateFixture();
    await enableTwoSlots(fixture.layout);
    const original = JSON.parse(
      await readFile(fixture.layout.configPath, "utf8"),
    );
    const receipt = await readFile(
      fixture.layout.capacityValidationPath,
      "utf8",
    );
    const bootstrap = fixture.launchAgent.bootstrap.getMockImplementation()!;
    fixture.launchAgent.bootstrap.mockImplementation(async () => {
      if ((await readlink(fixture.layout.currentLink)) === "releases/0.1.0") {
        const journal = JSON.parse(
          await readFile(fixture.layout.updateStatePath, "utf8"),
        );
        expect(journal.status).toBe("rolled-back");
        expect(Object.keys(journal.recovery).sort()).toEqual([
          "intent",
          "previousVersion",
          "serviceWasLoaded",
        ]);
      }
      await bootstrap();
    });
    await expect(
      updateMacUserWorker({
        layout: fixture.layout,
        uid: process.getuid!(),
        candidate: async () => fixture.candidate,
        now: fixture.now,
        fetch: fixture.fetch,
        qualify: async () => "report.json",
        launchAgent: fixture.launchAgent,
        confirmStarted: async () => true,
        health: async () => false,
      }),
    ).rejects.toThrow("Updated worker failed runtime doctor");
    expect(
      JSON.parse(await readFile(fixture.layout.configPath, "utf8")),
    ).toEqual(original);
    expect(await readFile(fixture.layout.capacityValidationPath, "utf8")).toBe(
      receipt,
    );
    expect(
      (await loadRuntimeConfig(fixture.layout.configPath)).slots,
    ).toHaveLength(2);
  },
);

it.skipIf(process.platform !== "darwin")(
  "allows update checks and recovery updates with expired capacity evidence",
  async () => {
    const fixture = await updateFixture();
    await enableTwoSlots(fixture.layout, true);
    await expect(loadRuntimeConfig(fixture.layout.configPath)).rejects.toThrow(
      "Capacity benchmark evidence expired",
    );
    await expect(
      checkMacUserUpdate(fixture.layout, {
        candidate: async () => fixture.candidate,
        now: fixture.now,
      }),
    ).resolves.toMatchObject({ updateAvailable: true });
    expect(
      Object.keys(
        await readMaintenanceConnection(fixture.layout.configPath),
      ).sort(),
    ).toEqual([
      "allowInsecureLoopback",
      "backendBaseUrl",
      "credential",
      "machineId",
    ]);
    await fixture.launchAgent.bootout();
    await updateMacUserWorker({
      layout: fixture.layout,
      uid: process.getuid!(),
      candidate: async () => fixture.candidate,
      now: fixture.now,
      fetch: fixture.fetch,
      qualify: async () => "report.json",
      launchAgent: fixture.launchAgent,
    });
    expect(
      (await loadRuntimeConfig(fixture.layout.configPath))
        .validatedMaxWorkersPerGpu,
    ).toBe(1);
  },
);

async function enableTwoSlots(
  layout: ReturnType<typeof createMacUserLayout>,
  expired = false,
) {
  const config = JSON.parse(await readFile(layout.configPath, "utf8"));
  config.validatedMaxWorkersPerGpu = 2;
  config.slots.push({
    ...config.slots[0],
    workerId: "718bd89b-bd03-43f7-adb7-9cb5ff415919",
    slotIndex: 1,
  });
  const model = Buffer.from("synthetic-model");
  const modelDigest = createHash("sha256").update(model).digest("hex");
  await mkdir(join(config.modelCacheRoot, modelDigest), { recursive: true });
  await writeFile(
    join(config.modelCacheRoot, modelDigest, "Kim_Vocal_2.onnx"),
    model,
  );
  const identity = await installedCapacityIdentity({
    ...config,
    modelDigest,
    fixturePath: join(layout.stateRoot, "qualification.wav"),
  });
  const validatedAt = Date.now() - (expired ? 8 : 0) * 86400000;
  await writeFile(
    layout.capacityValidationPath,
    JSON.stringify(
      createCapacityReceipt({
        machineId,
        identity,
        now: validatedAt,
        measurements: parseCapacityBenchmarkReport(capacityReport(identity), {
          provider: "mps",
          fixtureDigest: identity.fixtureDigest,
          warmupRuns: 1,
          measuredRuns: 3,
        }),
      }),
    ),
    { mode: 0o600 },
  );
  await writeFile(layout.configPath, JSON.stringify(config), { mode: 0o600 });
}

async function updateFixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-update-"));
  roots.push(root);
  await chmod(root, 0o700);
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const layout = createMacUserLayout(home);
  await createMacUserDirectories(layout);
  const currentSource = join(root, "release-0.1.0");
  const candidateSource = join(root, "release-0.2.0");
  await releaseFixture(currentSource, "0.1.0");
  await releaseFixture(candidateSource, "0.2.0");
  await installMacUserRelease(layout, currentSource);
  await writeFile(layout.credentialPath, `${"m".repeat(43)}\n`, {
    mode: 0o600,
  });
  const generatedRuntimeConfig = buildMacUserRuntimeConfig(
    layout,
    "https://api.music-mute.com",
    false,
    {
      machineId,
      workerId,
    },
  );
  await writeFile(
    layout.configPath,
    `${JSON.stringify(generatedRuntimeConfig)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    layout.installationStatePath,
    `${JSON.stringify({ schemaVersion: 1, releaseVersion: "0.1.0" })}\n`,
    { mode: 0o600 },
  );
  await initializeLocalLifecycle(layout.lifecyclePath);
  await writeLocalRuntimeStatus(layout.runtimeStatusPath, []);
  stopObservers.push(observeFixtureLifecycle(layout));
  await writeFile(join(layout.stateRoot, "qualification.wav"), "fixture", {
    mode: 0o600,
  });
  const archivePath = join(root, "candidate.tar.gz");
  const archive = await createInstallationReleaseArchive({
    releaseRoot: candidateSource,
    outputPath: archivePath,
    platform: "darwin-arm64",
  });
  const bytes = await readFile(archivePath);
  const now = new Date("2026-09-22T00:00:00.000Z");
  const metadata: UpdateMetadata = {
    schemaVersion: 1,
    sequence: 2,
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
  const candidate: UpdateCandidate = {
    signed: {
      keyId: "release-test",
      metadata,
      signature: sign(
        null,
        Buffer.from(canonicalUpdateMetadata(metadata), "utf8"),
        privateKey,
      ).toString("base64url"),
    },
    grant: {
      url: "https://storage.example.invalid/candidate.tar.gz",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
  await writeFile(
    layout.updateTrustPath,
    `${JSON.stringify({
      "release-test": publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
    })}\n`,
    { mode: 0o600 },
  );
  let loaded = true;
  const launchAgent = {
    status: vi.fn(async () => ({ loaded, running: loaded })),
    bootout: vi.fn(async () => {
      loaded = false;
    }),
    bootstrap: vi.fn(async () => {
      loaded = true;
    }),
  };
  return {
    layout,
    archivePath,
    candidate,
    now,
    launchAgent,
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
  };
}

async function releaseFixture(root: string, version: string): Promise<void> {
  const executables = [
    [
      "runtime/node/bin/node",
      '#!/bin/sh\nif [ "$1" = "--version" ]; then printf \'v24.18.0\\n\'; else exec /bin/sleep 120; fi\n',
    ],
    ["runtime/python/bin/python3", "#!/bin/sh\nexit 0\n"],
    [
      "runtime/bin/ffmpeg",
      "#!/bin/sh\nprintf 'ffmpeg version 8.0.3 Copyright\\n'\n",
    ],
    [
      "runtime/bin/ffprobe",
      "#!/bin/sh\nprintf 'ffprobe version 8.0.3 Copyright\\n'\n",
    ],
    ["app/dist/src/cli/main.js", "#!/bin/sh\nexit 0\n"],
  ] as const;
  for (const [path, source] of executables) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o755 });
    await writeFile(absolute, source, { mode: 0o755 });
  }
  await mkdir(join(root, "app", "engine"), { recursive: true, mode: 0o755 });
  for (const [path, value] of [
    ["runtime/licenses/ffmpeg/COPYING.LGPLv2.1", "license\n"],
    ["runtime/licenses/lame/COPYING", "license\n"],
    ["runtime/media-source-manifest.json", '{"schemaVersion":1}\n'],
  ] as const) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true, mode: 0o755 });
    await writeFile(absolute, value, { mode: 0o644 });
  }
  await writeMacReleaseManifest(root, version);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-update-trust-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
