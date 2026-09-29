import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeLocalLifecycle,
  loadLocalLifecycle,
} from "../src/runtime/local-lifecycle.js";
import { writeLocalRuntimeStatus } from "../src/runtime/local-runtime-status.js";
import {
  createWindowsServiceLayout,
  type WindowsServiceLayout,
} from "../src/platform/windows/service-definition.js";
import {
  unpairWindowsWorker,
  uninstallWindowsWorker,
  windowsUnpairReceiptPath,
} from "../src/platform/windows/user-removal.js";
import { writeConfirmedUnpairReceipt } from "../src/platform/shared/unpair-receipt.js";
import type { WindowsServiceStatus } from "../src/platform/windows/native-service.js";
import { runWindowsUserCommand } from "../src/platform/windows/user-cli.js";

// Native ACL enforcement is covered separately; these fixtures test operation ordering and persisted state.
vi.mock("../src/platform/windows/private-data.js", () => ({
  assertWindowsPrivateDataFile: vi.fn(async () => undefined),
  assertWindowsAdministratorDataFile: vi.fn(async () => undefined),
  assertWindowsPrivateDirectory: vi.fn(async () => undefined),
}));
const roots: string[] = [];
const machineId = "32410a14-e85a-4a1d-bb99-61fa54b07eaa";
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-removal-"));
  roots.push(root);
  await chmod(root, 0o700);
  const original = createWindowsServiceLayout();
  const layout = Object.fromEntries(
    Object.entries(original).map(([key, value]) => [
      key,
      join(root, ...win32.relative(original.installRoot, value).split("\\")),
    ]),
  ) as unknown as WindowsServiceLayout;
  for (const path of [
    layout.stateRoot,
    layout.serviceRoot,
    layout.releasesRoot,
  ])
    await mkdir(path, { recursive: true, mode: 0o700 });
  for (const path of [
    layout.credentialPath,
    layout.serviceConfigPath,
    layout.serviceExecutablePath,
    layout.activeReleasePath,
  ])
    await writeFile(path, "retained-data", { mode: 0o600 });
  await writeFile(layout.configPath, JSON.stringify({ machineId }), {
    mode: 0o600,
  });
  await initializeLocalLifecycle(layout.lifecyclePath);
  await writeLocalRuntimeStatus(layout.runtimeStatusPath, [], {
    processId: 1234,
    childState: "ready",
  });
  let state: WindowsServiceStatus["state"] = "running";
  const service = {
    assertPrivateInstallation: vi.fn(async () => undefined),
    inspect: vi.fn(async (): Promise<WindowsServiceStatus> => ({
      state,
      processId: state === "running" ? 1233 : null,
      runtimeProcessId: state === "running" ? 1234 : null,
      runtimeStartedAt:
        state === "running" ? new Date(Date.now() - 60000).toISOString() : null,
    })),
    start: vi.fn(async () => {
      state = "running";
    }),
    stop: vi.fn(async () => {
      state = "stopped";
    }),
  };
  const uninstallService = vi.fn(async () => {
    state = "absent";
  });
  const connection = vi.fn(async () => ({
    machineId,
    backendBaseUrl: "https://example.invalid",
    credential: "x".repeat(43),
    allowInsecureLoopback: false,
  }));
  const unpair = vi.fn(async () => ({ machineId, confirmed: true as const }));
  const options = {
    layout,
    service,
    connection,
    unpair,
    uninstallService,
    lock: async <T>(_path: string, operation: () => Promise<T>) => operation(),
    wait: async () => {
      const lifecycle = await loadLocalLifecycle(layout.lifecyclePath);
      await writeLocalRuntimeStatus(layout.runtimeStatusPath, [], {
        processId: 1234,
        childState: "ready",
        observedLifecycle: {
          intent: lifecycle.intent,
          revision: lifecycle.revision,
        },
      });
    },
  };
  return {
    layout,
    service,
    options,
    unpair,
    connection,
    uninstallService,
    setState: (value: WindowsServiceStatus["state"]) => {
      state = value;
    },
  };
}

describe("Windows removal", () => {
  it("drains a service that restarted after the initial stopped snapshot", async () => {
    const f = await fixture();
    f.setState("stopped");
    const inspect = f.service.inspect.getMockImplementation()!;
    f.service.inspect.mockImplementationOnce(async () => {
      const stopped = await inspect();
      f.setState("running");
      return stopped;
    });
    const stop = f.service.stop.getMockImplementation()!;
    f.service.stop.mockImplementation(async () => {
      const status = JSON.parse(
        await readFile(f.layout.runtimeStatusPath, "utf8"),
      );
      const lifecycle = await loadLocalLifecycle(f.layout.lifecyclePath);
      expect(status.observedLifecycle).toMatchObject({
        intent: "draining",
        revision: lifecycle.revision,
      });
      await stop();
    });
    await uninstallWindowsWorker({ ...f.options, purge: false });
    expect(f.service.stop).toHaveBeenCalledOnce();
  });
  it("blocks claims before stopping an already stopped service with a queued restart", async () => {
    const f = await fixture();
    f.setState("stopped");
    await rm(f.layout.runtimeStatusPath);
    const stop = f.service.stop.getMockImplementation()!;
    f.service.stop.mockImplementation(async () => {
      expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
        "draining",
      );
      await stop();
    });
    await uninstallWindowsWorker({ ...f.options, purge: false });
    expect(f.service.stop).toHaveBeenCalledOnce();
    expect(f.uninstallService).toHaveBeenCalledOnce();
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
      "active",
    );
  });
  it("drains and stops, then persists matching confirmation before deleting credentials", async () => {
    const f = await fixture();
    f.unpair.mockImplementationOnce(async () => {
      expect((await f.service.inspect()).state).toBe("stopped");
      expect(await readFile(f.layout.credentialPath, "utf8")).toBe(
        "retained-data",
      );
      return { confirmed: true, machineId };
    });
    expect(
      await unpairWindowsWorker({ ...f.options, force: false }),
    ).toMatchObject({ confirmed: true, replayed: false });
    expect(
      JSON.parse(await readFile(windowsUnpairReceiptPath(f.layout), "utf8")),
    ).toMatchObject({ machineId });
    await expect(readFile(f.layout.credentialPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(f.layout.configPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
      "draining",
    );
    expect(f.unpair).toHaveBeenCalledWith(false);
    expect(f.service.start).not.toHaveBeenCalled();
    expect(
      await unpairWindowsWorker({ ...f.options, force: false }),
    ).toMatchObject({ replayed: true });
    expect(f.unpair).toHaveBeenCalledOnce();
  });
  it("preserves credentials on backend failure and mismatched confirmation", async () => {
    const f = await fixture();
    f.unpair.mockRejectedValueOnce(new Error("Backend unavailable"));
    await expect(
      unpairWindowsWorker({ ...f.options, force: true }),
    ).rejects.toThrow("Backend unavailable");
    expect(await readFile(f.layout.credentialPath, "utf8")).toBe(
      "retained-data",
    );
    f.unpair.mockResolvedValueOnce({
      confirmed: true,
      machineId: "82410a14-e85a-4a1d-bb99-61fa54b07eaa",
    });
    await expect(
      unpairWindowsWorker({ ...f.options, force: true }),
    ).rejects.toThrow("does not match");
    await expect(
      readFile(windowsUnpairReceiptPath(f.layout)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.layout.configPath, "utf8")).toContain(machineId);
  });
  it("replays interrupted cleanup without another backend request", async () => {
    const f = await fixture();
    f.setState("stopped");
    await writeConfirmedUnpairReceipt(
      windowsUnpairReceiptPath(f.layout),
      machineId,
    );
    await rm(f.layout.credentialPath);
    await unpairWindowsWorker({ ...f.options, force: false });
    expect(f.connection).not.toHaveBeenCalled();
    expect(f.unpair).not.toHaveBeenCalled();
    await expect(readFile(f.layout.configPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("refuses to apply an old confirmation to a different pairing", async () => {
    const f = await fixture();
    f.setState("stopped");
    await writeConfirmedUnpairReceipt(
      windowsUnpairReceiptPath(f.layout),
      "82410a14-e85a-4a1d-bb99-61fa54b07eaa",
    );
    await expect(
      unpairWindowsWorker({ ...f.options, force: false }),
    ).rejects.toThrow("does not match");
    expect(await readFile(f.layout.credentialPath, "utf8")).toBe(
      "retained-data",
    );
    expect(f.unpair).not.toHaveBeenCalled();
  });
  it("blocks removal while maintenance recovery is pending", async () => {
    const f = await fixture();
    await mkdir(join(f.layout.serviceRoot, "operation-recovery"));
    await expect(
      unpairWindowsWorker({ ...f.options, force: true }),
    ).rejects.toThrow("mw recover");
    await expect(
      uninstallWindowsWorker({ ...f.options, purge: false }),
    ).rejects.toThrow("mw recover");
    expect(f.service.stop).not.toHaveBeenCalled();
    expect(f.uninstallService).not.toHaveBeenCalled();
  });
  it("preserves data on uninstall and allows repeated removal", async () => {
    const f = await fixture();
    expect(
      await uninstallWindowsWorker({ ...f.options, purge: false }),
    ).toMatchObject({ preservedData: true });
    expect(await readFile(f.layout.credentialPath, "utf8")).toBe(
      "retained-data",
    );
    expect(await readFile(f.layout.configPath, "utf8")).toContain(machineId);
    await expect(
      readFile(f.layout.serviceExecutablePath),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
      "active",
    );
    await expect(
      uninstallWindowsWorker({ ...f.options, purge: false }),
    ).resolves.toMatchObject({ preservedData: true });
  });
  it("requires confirmation and credential cleanup before purge", async () => {
    const f = await fixture();
    await expect(
      uninstallWindowsWorker({ ...f.options, purge: true }),
    ).rejects.toThrow("confirmed unpair");
    await writeConfirmedUnpairReceipt(
      windowsUnpairReceiptPath(f.layout),
      machineId,
    );
    await expect(
      uninstallWindowsWorker({ ...f.options, purge: true }),
    ).rejects.toThrow("confirmed unpair");
    expect(f.uninstallService).not.toHaveBeenCalled();
    await unpairWindowsWorker({ ...f.options, force: true });
    await expect(
      uninstallWindowsWorker({
        ...f.options,
        purge: true,
        executablePath: join(f.layout.releasesRoot, "node.exe"),
      }),
    ).rejects.toThrow("outside");
    expect(
      await uninstallWindowsWorker({ ...f.options, purge: true }),
    ).toMatchObject({ preservedData: false });
    await expect(readFile(f.layout.configPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await uninstallWindowsWorker({ ...f.options, purge: true }),
    ).toMatchObject({ replayed: true });
  });
  it("does not delete installation files when SCM removal fails", async () => {
    const f = await fixture();
    f.uninstallService.mockRejectedValueOnce(new Error("SCM failure"));
    await expect(
      uninstallWindowsWorker({ ...f.options, purge: false }),
    ).rejects.toThrow("SCM failure");
    expect(await readFile(f.layout.serviceExecutablePath, "utf8")).toBe(
      "retained-data",
    );
  });
  it("routes only supported flags before invoking removal", async () => {
    const f = await fixture();
    const unpair = vi.fn(async () => ({
      status: "ok",
      action: "unpair",
      confirmed: true as const,
      machineId,
      replayed: false,
    }));
    const context = {
      host: { platform: "win32" as const, arch: "x64" },
      layout: f.layout,
      service: f.service,
      unpair,
      stdout: vi.fn(),
    };
    expect(
      await runWindowsUserCommand("unpair", ["--force", "--json"], context),
    ).toBe(0);
    expect(unpair).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
    await expect(
      runWindowsUserCommand("unpair", ["--purge"], context),
    ).rejects.toThrow("arguments");
    expect(unpair).toHaveBeenCalledOnce();
  });
});
