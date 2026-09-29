import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  runWindowsUserCommand,
  currentRuntimeSnapshot,
} from "../src/platform/windows/user-cli.js";
import type { WindowsServiceStatus } from "../src/platform/windows/native-service.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-windows-cli-"));
  roots.push(root);
  await chmod(root, 0o700);
  const original = createWindowsServiceLayout();
  const layout = Object.fromEntries(
    Object.entries(original).map(([key, value]) => [
      key,
      join(root, ...win32.relative(original.installRoot, value).split("\\")),
    ]),
  ) as unknown as WindowsServiceLayout;
  await mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
  await writeFile(layout.configPath, '{"schemaVersion":1}', { mode: 0o600 });
  await initializeLocalLifecycle(layout.lifecyclePath);
  await writeLocalRuntimeStatus(layout.runtimeStatusPath, [], {
    processId: 1001,
    childState: "ready",
  });
  let state: WindowsServiceStatus["state"] = "running";
  const service = {
    inspect: vi.fn(async (): Promise<WindowsServiceStatus> => ({
      state,
      processId: state === "running" ? 1000 : null,
      runtimeProcessId: state === "running" ? 1001 : null,
      runtimeStartedAt: state === "running" ? "2026-01-01T00:00:00Z" : null,
    })),
    start: vi.fn(async () => {
      state = "running";
    }),
    stop: vi.fn(async () => {
      state = "stopped";
    }),
    assertPrivateInstallation: vi.fn(async () => undefined),
  };
  const output: string[] = [];
  const context = {
    host: { platform: "win32" as const, arch: "x64" },
    layout,
    service,
    stdout: (line: string) => output.push(line),
    drainTimeoutMs: 1000,
    wait: async () => {
      const lifecycle = await loadLocalLifecycle(layout.lifecyclePath);
      await writeLocalRuntimeStatus(layout.runtimeStatusPath, [], {
        processId: 1001,
        childState: "ready",
        observedLifecycle: {
          revision: lifecycle.revision,
          intent: lifecycle.intent,
        },
      });
    },
  };
  return {
    layout,
    service,
    output,
    context,
    run: (command: string, flags: string[] = ["--json"]) =>
      runWindowsUserCommand(command, flags, context),
  };
}

describe("Windows operator lifecycle", () => {
  it("exports diagnostics with a safe unavailable status when local status is corrupt", async () => {
    const f = await fixture();
    await writeFile(f.layout.runtimeStatusPath, "{", { mode: 0o600 });
    const diagnostics = vi.fn(async () => ({
      schemaVersion: 1 as const,
      path: "archive.zip",
      files: ["manifest.json"],
      createdAt: new Date().toISOString(),
    }));
    const health = vi.fn(async () => ({
      schemaVersion: 1 as const,
      healthy: false,
      checks: [],
    }));
    const context = { ...f.context, health, diagnostics };
    expect(
      await runWindowsUserCommand(
        "diagnostics",
        ["--job", "507461bf507461bf507461bf", "--since", "1d", "--json"],
        context,
      ),
    ).toBe(0);
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "507461bf507461bf507461bf",
        since: expect.any(Number),
        status: expect.objectContaining({ status: "unavailable" }),
      }),
    );
    await expect(
      runWindowsUserCommand("diagnostics", ["--job", "invalid"], context),
    ).rejects.toThrow("24 hex");
    expect(diagnostics).toHaveBeenCalledOnce();
  });

  it("waits through model loading and reports readiness without restarting a running service", async () => {
    const f = await fixture();
    await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [], {
      processId: 1001,
      childState: "loading",
    });
    expect(await f.run("start", ["--wait-ready", "--json"])).toBe(0);
    expect(f.service.start).not.toHaveBeenCalled();
    expect(f.output.map((line) => JSON.parse(line).phase)).toContain("loading");
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({
      action: "start",
      outcome: "already-running",
      readiness: { modelReady: true, phase: "ready" },
    });
  });

  it("bounds readiness waiting and preserves the running service on timeout", async () => {
    const f = await fixture();
    await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [], {
      processId: 1001,
      childState: "unavailable",
    });
    let clock = 0;
    await expect(
      runWindowsUserCommand("start", ["--wait-ready", "--json"], {
        ...f.context,
        readinessTimeoutMs: 2000,
        monotonicNow: () => clock,
        wait: async (milliseconds) => {
          clock += milliseconds;
        },
      }),
    ).rejects.toThrow("child-unavailable");
    expect(f.service.stop).not.toHaveBeenCalled();
  });

  it("does not report readiness from an old heartbeat belonging to the same process", async () => {
    const f = await fixture();
    await writeFile(
      f.layout.runtimeStatusPath,
      JSON.stringify({
        schemaVersion: 1,
        activeAttemptIds: [],
        processId: 1001,
        childState: "ready",
        updatedAt: new Date(Date.now() - 181_000).toISOString(),
      }),
      { mode: 0o600 },
    );
    expect(await f.run("status")).toBe(1);
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({
      healthy: false,
      staleRuntimeStatus: true,
      readiness: { modelReady: false, blockers: ["runtime-heartbeat-stale"] },
    });
  });

  it("interrupts status watch and removes its signal handlers without service mutations", async () => {
    const f = await fixture();
    const before = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
    expect(
      await runWindowsUserCommand("status", ["--local", "--watch", "--json"], {
        ...f.context,
        wait: async () => {
          process.emit("SIGINT");
        },
      }),
    ).toBe(0);
    expect(f.output).toHaveLength(1);
    expect(f.service.start).not.toHaveBeenCalled();
    expect(f.service.stop).not.toHaveBeenCalled();
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(before);
  });

  it("reports a ready child as unhealthy while installation recovery is pending", async () => {
    const f = await fixture();
    await mkdir(join(f.layout.serviceRoot, "operation-recovery"), {
      recursive: true,
    });
    expect(await f.run("status")).toBe(1);
    expect(JSON.parse(f.output[0]!)).toMatchObject({
      maintenancePending: true,
      healthy: false,
    });
  });

  it("dispatches recovery without requiring runtime config or a second lock", async () => {
    const f = await fixture();
    await rm(f.layout.configPath);
    const recover = vi.fn(async () => ({
      action: "recover",
      status: "ok",
      service: await f.service.inspect(),
    }));
    const lock = vi.fn();
    expect(
      await runWindowsUserCommand(
        "recover",
        ["--release-version", "0.1.0-test", "--json"],
        { ...f.context, recover, lock },
      ),
    ).toBe(0);
    expect(recover).toHaveBeenCalledWith({
      layout: f.layout,
      service: f.service,
      releaseVersion: "0.1.0-test",
    });
    expect(lock).not.toHaveBeenCalled();
    expect(JSON.parse(f.output[0]!).status).toBe("ok");
    await expect(
      runWindowsUserCommand("recover", ["--force"], {
        ...f.context,
        recover,
      }),
    ).rejects.toThrow();
    expect(recover).toHaveBeenCalledOnce();
  });

  it("dispatches all-recipe capacity runs and reports a failed qualification gate", async () => {
    const f = await fixture();
    const benchmarkFile = vi.fn(async () => ({ status: "FAIL" }));
    const arguments_ = [
      "--workers",
      "2",
      "--input",
      "C:\\MusicMuteBuild\\fixture.wav",
      "--json",
    ];
    expect(
      await runWindowsUserCommand("benchmark", arguments_, {
        ...f.context,
        benchmarkFile,
      }),
    ).toBe(2);
    expect(benchmarkFile).toHaveBeenCalledWith({
      inputPath: "C:\\MusicMuteBuild\\fixture.wav",
      workers: 2,
      warmupRuns: 1,
      measuredRuns: 3,
    });
    await expect(
      runWindowsUserCommand(
        "benchmark",
        [...arguments_, "--warmup-runs", "0"],
        { ...f.context, benchmarkFile },
      ),
    ).rejects.toThrow("warm-up");
    expect(benchmarkFile).toHaveBeenCalledOnce();
  });

  it("dispatches native file benchmarks without holding a second installer lock", async () => {
    const f = await fixture();
    const benchmarkFile = vi.fn(async () => ({ status: "PASS" }));
    const lock = vi.fn();
    const run = (flags: string[]) =>
      runWindowsUserCommand("benchmark-file", flags, {
        ...f.context,
        benchmarkFile,
        lock,
      });
    await run([
      "--input",
      "C:\\MusicMuteBuild\\input.wav",
      "--release-version",
      "0.1.0-test",
      "--json",
    ]);
    expect(benchmarkFile).toHaveBeenCalledWith({
      inputPath: "C:\\MusicMuteBuild\\input.wav",
      recipeId: "kim-vocals-v2",
      warmupRuns: 1,
      measuredRuns: 3,
      releaseVersion: "0.1.0-test",
    });
    expect(lock).not.toHaveBeenCalled();
    await expect(
      run(["--input", "C:\\input.wav", "--measured-runs", "1"]),
    ).rejects.toThrow("measured runs");
    expect(benchmarkFile).toHaveBeenCalledOnce();
  });

  it("blocks lifecycle mutations while a durable recovery journal exists", async () => {
    const f = await fixture();
    await mkdir(join(f.layout.serviceRoot, "operation-recovery"), {
      recursive: true,
    });
    await expect(f.run("start")).rejects.toThrow("maintenance recovery");
    expect(f.service.start).not.toHaveBeenCalled();
  });

  it("uses shared sanitized log and investigation commands behind the Windows ACL boundary", async () => {
    const f = await fixture();
    await mkdir(f.layout.logRoot, { recursive: true, mode: 0o700 });
    await writeFile(f.layout.stdoutPath, "Worker ready\n", { mode: 0o600 });
    await f.run("logs", ["--lines", "1", "--json"]);
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({
      stdout: "Worker ready",
    });
    expect(await f.run("job", ["507461bf507461bf507461bf", "--json"])).toBe(2);
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({ foundLocally: false });
    await f.run("errors", ["--since", "1d", "--json"]);
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({ groups: [] });
    await f.run("explain", ["GPU_OOM", "--json"]);
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({
      observedCountInRetainedHistory: 0,
    });
    await f.run("perf");
    expect(f.service.assertPrivateInstallation).toHaveBeenCalledTimes(5);
    expect(f.service.start).not.toHaveBeenCalled();
    await expect(
      f.run("logs", ["--lines", "1", "--lines", "2"]),
    ).rejects.toThrow("duplicated");
    f.service.assertPrivateInstallation.mockRejectedValue(
      new Error("unsafe permissions"),
    );
    await expect(f.run("logs")).rejects.toThrow("unsafe permissions");
  });

  it("keeps repeated start and resume from restarting an active service", async () => {
    const f = await fixture();
    await f.run("start");
    await f.run("resume");
    expect(f.service.start).not.toHaveBeenCalled();
    expect(f.service.stop).not.toHaveBeenCalled();
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).revision).toBe(1);
  });

  it("drains with acknowledgement, stops and restores prior intent before restart", async () => {
    const f = await fixture();
    await f.run("pause");
    const stop = f.service.stop.getMockImplementation()!;
    f.service.stop.mockImplementation(async () => {
      expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
        "draining",
      );
      await stop();
    });
    await f.run("restart");
    expect(f.service.stop).toHaveBeenCalledOnce();
    expect(f.service.start).toHaveBeenCalledOnce();
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
      "paused",
    );
  });

  it("leaves drain intent persisted and the service loaded", async () => {
    const f = await fixture();
    await f.run("drain");
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
      "draining",
    );
    expect(f.service.stop).not.toHaveBeenCalled();
  });

  it("refuses stale zero-attempt status and supports explicit forced stop", async () => {
    const f = await fixture();
    await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [], {
      processId: 999,
    });
    await expect(f.run("stop")).rejects.toThrow(
      "Current Windows runtime status is unavailable",
    );
    expect(f.service.stop).not.toHaveBeenCalled();
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
      "active",
    );
    await f.run("stop", ["--force", "--json"]);
    expect(f.service.stop).toHaveBeenCalledOnce();
  });

  it("requires private ACLs before state mutation and rejects unsupported flags", async () => {
    const f = await fixture();
    f.service.assertPrivateInstallation.mockRejectedValue(
      new Error("unsafe permissions"),
    );
    await expect(f.run("pause")).rejects.toThrow("unsafe permissions");
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).intent).toBe(
      "active",
    );
    await expect(f.run("stop", ["--force", "--force"])).rejects.toThrow(
      "flags",
    );
  });

  it("requires the live service child and its start time for status proof", async () => {
    const f = await fixture();
    expect(await f.run("status")).toBe(0);
    const native = await f.service.inspect();
    const old = {
      schemaVersion: 1 as const,
      activeAttemptIds: [],
      processId: 1001,
      updatedAt: "2025-01-01T00:00:00Z",
    };
    expect(currentRuntimeSnapshot(native, old)).toBe(false);
    expect(
      currentRuntimeSnapshot(
        { ...native, state: "stopped" },
        { ...old, updatedAt: new Date().toISOString() },
      ),
    ).toBe(false);
  });
});
