import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recoverMacAppMaintenance,
  hasMacPersonalReservation,
  withMacAppMaintenance,
} from "../src/platform/macos/app-control-maintenance.js";
import { createMacUserLayout } from "../src/platform/macos/user-paths.js";
import {
  initializeLocalLifecycle,
  loadLocalLifecycle,
  setLocalLifecycleIntent,
  type LocalLifecycleIntent,
} from "../src/runtime/local-lifecycle.js";
import { runMacUserCommand } from "../src/platform/macos/user-cli.js";
import { writeLocalRuntimeStatus } from "../src/runtime/local-runtime-status.js";
import { withDarwinFileLock } from "../src/runtime/darwin-file-lock.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed maintenance preserves local service intent", () => {
  it("refuses active or unknown personal reservations before changing worker intent", async () => {
    const f = await fixture("active", true);
    const reservation = join(f.layout.stateRoot, "personal-admission.json");
    expect(await hasMacPersonalReservation(f.layout)).toBe(false);
    for (const value of [
      "{}",
      "unknown",
      '{"request_id":"7161b679-e633-4280-bbb5-831992549700"}',
    ]) {
      await writeFile(reservation, value, { mode: 0o600 });
      expect(await hasMacPersonalReservation(f.layout)).toBe(true);
      await expect(
        withMacAppMaintenance({
          layout: f.layout,
          service: f.service,
          stop: f.stop,
          operation: async () => true,
        }),
      ).rejects.toThrow("WORKER_PERSONAL_BUSY");
      expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
        "active",
      );
      expect(f.service.bootout).not.toHaveBeenCalled();
      await expect(
        lstat(join(f.layout.stateRoot, "app-maintenance.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await rm(reservation);
    await symlink("/nonexistent-personal-reservation", reservation);
    await expect(
      withMacAppMaintenance({
        layout: f.layout,
        service: f.service,
        stop: f.stop,
        operation: async () => true,
      }),
    ).rejects.toThrow("WORKER_PERSONAL_BUSY");
  });

  it.skipIf(process.platform !== "darwin")(
    "uses the same admission lock as a concurrent personal grant",
    async () => {
      const f = await fixture("active", true);
      await withDarwinFileLock(
        join(f.layout.stateRoot, "app-admission.lock"),
        async () => {
          await expect(
            withMacAppMaintenance({
              layout: f.layout,
              service: f.service,
              stop: f.stop,
              operation: async () => true,
            }),
          ).rejects.toThrow("COMMAND_BUSY");
        },
      );
      expect(f.service.bootout).not.toHaveBeenCalled();
      await withMacAppMaintenance({
        layout: f.layout,
        service: f.service,
        stop: async () => {
          expect(
            await lstat(join(f.layout.stateRoot, "app-maintenance.json")),
          ).toBeDefined();
          await withDarwinFileLock(
            join(f.layout.stateRoot, "app-admission.lock"),
            async () => true,
          );
          await f.stop();
        },
        operation: async () => true,
      });
    },
  );

  it.each(["active", "paused", "draining"] as const)(
    "restores %s after successful or failed maintenance",
    async (intent) => {
      for (const fail of [false, true]) {
        const f = await fixture(intent, true);
        const operation = vi.fn(async () => {
          expect(
            (await loadLocalLifecycle(f.layout.lifecyclePath)).intent,
          ).toBe("draining");
          expect((await f.service.status()).loaded).toBe(false);
          if (fail) throw new Error("benchmark failed");
          return "measured";
        });
        const request = withMacAppMaintenance({
          layout: f.layout,
          service: f.service,
          stop: f.stop,
          operation,
        });
        if (fail) await expect(request).rejects.toThrow("benchmark failed");
        else await expect(request).resolves.toBe("measured");
        expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
          intent,
        );
        expect((await f.service.status()).running).toBe(true);
        expect(f.service.bootstrap).toHaveBeenCalledOnce();
        await expect(
          lstat(join(f.layout.stateRoot, "app-maintenance.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );

  it("leaves a previously stopped worker stopped", async () => {
    const f = await fixture("paused", false);
    await withMacAppMaintenance({
      layout: f.layout,
      service: f.service,
      stop: f.stop,
      operation: async () => true,
    });
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
      "paused",
    );
    expect((await f.service.status()).loaded).toBe(false);
    expect(f.service.bootstrap).not.toHaveBeenCalled();
  });

  it("restores intent without force stopping accepted work after a drain failure", async () => {
    const f = await fixture("active", true);
    const operation = vi.fn();
    await expect(
      withMacAppMaintenance({
        layout: f.layout,
        service: f.service,
        stop: async () => {
          await setLocalLifecycleIntent(f.layout.lifecyclePath, "draining");
          throw new Error("drain timeout");
        },
        operation,
      }),
    ).rejects.toThrow("drain timeout");
    expect(operation).not.toHaveBeenCalled();
    expect(f.service.bootout).not.toHaveBeenCalled();
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
      "active",
    );
  });

  it("refuses to restart a failed registration as an incidental maintenance side effect", async () => {
    const f = await fixture("active", true);
    f.service.status.mockResolvedValue({ loaded: true, running: false });
    await expect(
      withMacAppMaintenance({
        layout: f.layout,
        service: f.service,
        stop: f.stop,
        operation: async () => true,
      }),
    ).rejects.toThrow("MAINTENANCE_RECOVERY_REQUIRED");
    expect(f.service.bootout).not.toHaveBeenCalled();
  });

  it("recovers interrupted qualification with the normal supervisor plist and saved pause", async () => {
    const f = await fixture("draining", true);
    await writeFile(f.layout.plistPath, "temporary qualification", {
      mode: 0o600,
    });
    await writeFile(
      join(f.layout.stateRoot, "app-maintenance.json"),
      JSON.stringify({
        schemaVersion: 1,
        intent: "paused",
        loaded: true,
        stopped: true,
        phase: "restoring",
      }),
      { mode: 0o600 },
    );
    await recoverMacAppMaintenance(f.layout, f.service);
    expect(f.service.bootout).toHaveBeenCalledOnce();
    expect(f.service.bootstrap).toHaveBeenCalledOnce();
    expect(await readFile(f.layout.plistPath, "utf8")).toContain(
      "<string>run</string>",
    );
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
      "paused",
    );
  });

  it("retains a private recovery journal if restoration fails", async () => {
    const f = await fixture("paused", true);
    f.service.bootstrap.mockRejectedValue(new Error("launchctl failed"));
    await expect(
      withMacAppMaintenance({
        layout: f.layout,
        service: f.service,
        stop: f.stop,
        operation: async () => true,
      }),
    ).rejects.toThrow("MAINTENANCE_RECOVERY_REQUIRED");
    const path = join(f.layout.stateRoot, "app-maintenance.json");
    expect((await lstat(path)).mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      intent: "paused",
      loaded: true,
      stopped: true,
      phase: "restoring",
    });
  });

  it("rejects malformed or public recovery journals", async () => {
    const f = await fixture("active", false);
    const path = join(f.layout.stateRoot, "app-maintenance.json");
    await writeFile(path, "{}", { mode: 0o600 });
    await expect(recoverMacAppMaintenance(f.layout, f.service)).rejects.toThrow(
      "MAINTENANCE_RECOVERY_REQUIRED",
    );
    await chmod(path, 0o644);
    await expect(recoverMacAppMaintenance(f.layout, f.service)).rejects.toThrow(
      "MAINTENANCE_RECOVERY_REQUIRED",
    );
  });

  it("runs the existing benchmark guard under the same command lock and preserves pause", async () => {
    const f = await fixture("paused", true);
    await mkdir(f.layout.configRoot, { recursive: true, mode: 0o700 });
    await mkdir(f.layout.logRoot, { recursive: true, mode: 0o700 });
    await writeFile(f.layout.configPath, "{}", { mode: 0o600 });
    const benchmark = vi.fn(async (workers: 1 | 2) => {
      expect(workers).toBe(2);
      expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
        "draining",
      );
      expect((await f.service.status()).loaded).toBe(false);
      expect(await lstat(f.layout.commandLockPath)).toBeDefined();
      return { status: "PASS" };
    });
    await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, []);
    const output: string[] = [];
    const result = await runMacUserCommand(
      "benchmark",
      ["--workers", "2", "--json"],
      {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.service,
        appControl: true,
        benchmark,
        stdout: (value) => output.push(value),
        wait: async () => {
          const lifecycle = await loadLocalLifecycle(f.layout.lifecyclePath);
          await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [], {
            observedLifecycle: {
              intent: lifecycle.intent,
              revision: lifecycle.revision,
            },
          });
        },
      },
    );
    expect(result).toBe(0);
    expect(benchmark).toHaveBeenCalledOnce();
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
      "paused",
    );
    expect(JSON.parse(output[0]!)).toEqual({ status: "PASS" });
  });
});

async function fixture(intent: LocalLifecycleIntent, initialLoaded: boolean) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-app-maintenance-"));
  roots.push(root);
  await chmod(root, 0o700);
  const layout = createMacUserLayout(root);
  await mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(layout.launchAgentsRoot, { recursive: true, mode: 0o700 });
  await initializeLocalLifecycle(layout.lifecyclePath);
  await setLocalLifecycleIntent(layout.lifecyclePath, intent);
  let loaded = initialLoaded;
  const service = {
    status: vi.fn(async () => ({ loaded, running: loaded })),
    bootstrap: vi.fn(async (_path: string) => {
      loaded = true;
    }),
    bootout: vi.fn(async () => {
      loaded = false;
    }),
    kickstart: vi.fn(async () => undefined),
  };
  const stop = async () => {
    await setLocalLifecycleIntent(layout.lifecyclePath, "draining");
    if (loaded) await service.bootout();
  };
  return { layout, service, stop };
}
