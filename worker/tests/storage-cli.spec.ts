import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as storage from "../src/platform/shared/storage-maintenance.js";
import { runMacUserCommand } from "../src/platform/macos/user-cli.js";
import { createMacUserLayout } from "../src/platform/macos/user-paths.js";
import { runWindowsUserCommand } from "../src/platform/windows/user-cli.js";
import {
  createWindowsServiceLayout,
  type WindowsServiceLayout,
} from "../src/platform/windows/service-definition.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const preview: storage.WorkerStorageCleanup = {
  action: "cleanup",
  mode: "dry-run",
  status: "ok",
  reclaimableBytes: 1234,
  reclaimedBytes: 0,
  cacheLimitBytes: storage.WORKER_CACHE_LIMIT_BYTES,
  keptReleaseVersions: ["0.1.3"],
  entries: [],
  warnings: [],
};

async function macFixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-cleanup-cli-"));
  roots.push(root);
  const layout = createMacUserLayout(root);
  await mkdir(layout.configRoot, { recursive: true, mode: 0o700 });
  await mkdir(layout.credentialRoot, { recursive: true, mode: 0o700 });
  await mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(join(layout.releasesRoot, "0.1.3"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(layout.configPath, "{}", { mode: 0o600 });
  await writeFile(layout.credentialPath, "credential", { mode: 0o600 });
  await symlink("releases/0.1.3", layout.currentLink);
  const output: string[] = [];
  let running = true;
  const launchAgent = {
    bootstrap: async () => undefined,
    bootout: async () => undefined,
    kickstart: async () => undefined,
    status: async () => ({ loaded: running, running }),
  };
  return {
    output,
    stop: () => {
      running = false;
    },
    run: (flags: string[]) =>
      runMacUserCommand("cleanup", flags, {
        layout,
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid?.() ?? 501,
          home: root,
        },
        launchAgent,
        stdout: (text) => output.push(text),
      }),
  };
}

describe.skipIf(process.platform !== "darwin")("macOS cleanup command", () => {
  it("defaults to preview, refuses live apply and applies only with the worker stopped", async () => {
    const cleanup = vi
      .spyOn(storage, "cleanupWorkerStorage")
      .mockResolvedValue(preview);
    const f = await macFixture();
    expect(await f.run(["--json"])).toBe(0);
    expect(cleanup).toHaveBeenLastCalledWith(
      expect.objectContaining({ apply: false }),
    );
    expect(JSON.parse(f.output[0]!).reclaimedBytes).toBe(0);
    cleanup.mockClear();
    await expect(f.run(["--apply"])).rejects.toThrow("Drain and stop");
    expect(cleanup).not.toHaveBeenCalled();
    f.stop();
    expect(await f.run(["--apply", "--json"])).toBe(0);
    expect(cleanup).toHaveBeenLastCalledWith(
      expect.objectContaining({ apply: true }),
    );
    await expect(f.run(["--apply", "--dry-run"])).rejects.toThrow(
      "Choose cleanup",
    );
  });
});

describe("Windows cleanup command", () => {
  it("uses the private-installation guard and operator lock; live apply is refused", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "musicmute-windows-cleanup-cli-"),
    );
    roots.push(root);
    const original = createWindowsServiceLayout();
    const layout = Object.fromEntries(
      Object.entries(original).map(([key, path]) => [
        key,
        join(root, ...win32.relative(original.installRoot, path).split("\\")),
      ]),
    ) as unknown as WindowsServiceLayout;
    const cleanup = vi
      .spyOn(storage, "cleanupWorkerStorage")
      .mockResolvedValue(preview);
    let running = true;
    const service = {
      inspect: async () => ({
        state: running ? ("running" as const) : ("stopped" as const),
        processId: running ? 100 : null,
        runtimeProcessId: null,
        runtimeStartedAt: null,
      }),
      assertPrivateInstallation: vi.fn(async () => undefined),
      start: async () => undefined,
      stop: async () => undefined,
    };
    const lock = vi.fn();
    const withLock = async <T>(
      path: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      lock(path);
      return operation();
    };
    const context = {
      layout,
      service,
      lock: withLock,
      host: { platform: "win32" as const, arch: "x64" },
      stdout: () => undefined,
    };
    expect(
      await runWindowsUserCommand("cleanup", ["--dry-run", "--json"], context),
    ).toBe(0);
    expect(lock).toHaveBeenCalledWith(layout.commandLockPath);
    expect(service.assertPrivateInstallation).toHaveBeenCalled();
    cleanup.mockClear();
    await expect(
      runWindowsUserCommand("cleanup", ["--apply"], context),
    ).rejects.toThrow("Drain and stop");
    expect(cleanup).not.toHaveBeenCalled();
    running = false;
    expect(await runWindowsUserCommand("cleanup", ["--apply"], context)).toBe(
      0,
    );
    expect(cleanup).toHaveBeenLastCalledWith(
      expect.objectContaining({ apply: true }),
    );
  });
});
