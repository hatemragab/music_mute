import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerEnrollmentError } from "../src/enrollment/enrollment-client.js";
import {
  initializeLocalLifecycle,
  loadLocalLifecycle,
} from "../src/runtime/local-lifecycle.js";
import {
  loadLocalRuntimeStatus,
  writeLocalRuntimeStatus,
} from "../src/runtime/local-runtime-status.js";
import {
  initializeMacUserServiceFiles,
  runMacUserCommand,
  waitForReady,
} from "../src/platform/macos/user-cli.js";
import { createMacUserLayout } from "../src/platform/macos/user-paths.js";
import type { LaunchAgentStatus } from "../src/platform/macos/launch-agent.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("macOS public user commands", () => {
  it("checks for updates without activating and runs explicit updates", async () => {
    const f = await fixture(true);
    const checkUpdate = vi.fn(
      async () =>
        ({
          currentVersion: "0.1.0",
          availableVersion: "0.2.0",
          sequence: 2,
          updateAvailable: true,
        }) as never,
    );
    const update = vi.fn(async (_force: boolean) => ({
      status: "updated" as const,
      releaseVersion: "0.2.0",
      sequence: 2,
    }));
    const context = {
      host: {
        platform: "darwin" as const,
        arch: "arm64",
        uid: process.getuid!(),
        home: f.layout.homeRoot,
      },
      layout: f.layout,
      launchAgent: f.launchAgent,
      stdout: (value: string) => f.output.push(value),
      checkUpdate,
      update,
    };

    await expect(
      runMacUserCommand("update", ["--check", "--json"], context),
    ).resolves.toBe(0);
    expect(update).not.toHaveBeenCalled();
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      action: "update-check",
      updateAvailable: true,
    });

    await expect(
      runMacUserCommand("update", ["--force", "--json"], context),
    ).resolves.toBe(0);
    expect(update).toHaveBeenCalledWith(true);
  });

  it("runs benchmark only through the explicit benchmark command", async () => {
    const f = await fixture(true);
    const benchmark = vi.fn(async () => ({
      platform: "darwin-arm64",
      provider: "mps",
      processingSeconds: 4.2,
    }));
    const context = {
      host: {
        platform: "darwin" as const,
        arch: "arm64",
        uid: process.getuid!(),
        home: f.layout.homeRoot,
      },
      layout: f.layout,
      launchAgent: f.launchAgent,
      benchmark,
      stdout: (value: string) => f.output.push(value),
    };
    await expect(runMacUserCommand("benchmark", [], context)).resolves.toBe(0);
    expect(f.output.pop()).toContain(
      "MusicMute Worker Benchmark\n\nPlatform: darwin-arm64\nProvider: mps",
    );
    await expect(
      runMacUserCommand("benchmark", ["--json"], context),
    ).resolves.toBe(0);
    await expect(
      runMacUserCommand("benchmark", ["--workers", "2", "--json"], context),
    ).resolves.toBe(0);
    expect(benchmark.mock.calls).toEqual([[1], [1], [2]]);
    expect(JSON.parse(f.output.pop()!)).toMatchObject({ provider: "mps" });
  });

  it("runs offline file benchmarks for plain and trimmed Kim Vocal 2", async () => {
    const f = await fixture(true);
    const benchmarkFile = vi.fn(async () => ({
      status: "PASS",
      scope: "local-engine-only",
      coldSeconds: 16.3,
      warm: { meanSeconds: 10.5 },
    }));
    const context = {
      host: {
        platform: "darwin" as const,
        arch: "arm64",
        uid: process.getuid!(),
        home: f.layout.homeRoot,
      },
      layout: f.layout,
      launchAgent: f.launchAgent,
      benchmarkFile,
      stdout: (value: string) => f.output.push(value),
    };

    await expect(
      runMacUserCommand(
        "benchmark-file",
        [
          "--input",
          "/Users/test/song.mp3",
          "--recipe",
          "kim-vocals-v2",
          "--runs",
          "4",
          "--json",
        ],
        context,
      ),
    ).resolves.toBe(0);
    expect(benchmarkFile).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPath: "/Users/test/song.mp3",
        recipeId: "kim-vocals-v2",
        warmupRuns: 1,
        measuredRuns: 4,
        groupSize: 1,
        onProgress: expect.any(Function),
      }),
    );
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      status: "PASS",
      scope: "local-engine-only",
    });
    benchmarkFile.mockClear();
    await expect(
      runMacUserCommand(
        "benchmark-file",
        ["--input", "/Users/test/song.mp3", "--json"],
        context,
      ),
    ).resolves.toBe(0);
    expect(benchmarkFile).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPath: "/Users/test/song.mp3",
        recipeId: "kim-vocals-v2-trim",
        warmupRuns: 1,
        measuredRuns: 3,
        groupSize: 1,
      }),
    );
    await expect(
      runMacUserCommand(
        "benchmark-file",
        ["--input", "/Users/test/song.mp3", "--group-size", "2"],
        context,
      ),
    ).resolves.toBe(0);
    expect(benchmarkFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ groupSize: 2 }),
    );
    await expect(
      runMacUserCommand(
        "benchmark-file",
        ["--input", "/Users/test/song.mp3", "--group-size", "3"],
        context,
      ),
    ).rejects.toThrow("window group must be 1, 2, or 4");
    await expect(
      runMacUserCommand(
        "benchmark-file",
        ["--input", "/Users/test/song.mp3", "--recipe", "denoise"],
        context,
      ),
    ).rejects.toThrow("kim-vocals-v2-trim");
  });

  it("reads the one-use enrollment code outside argv for install", async () => {
    const f = await fixture(false);
    const readEnrollmentCode = vi.fn(async () => "x".repeat(43));
    const install = vi.fn(async () => ({
      machineId: "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
      releaseVersion: "0.1.0",
      reusedRelease: false,
      reusedModel: false,
      serviceLoaded: true,
      runtime: {
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
      },
    }));

    await expect(
      runMacUserCommand(
        "install",
        ["--label", "Studio Mac", "--group-id", "primary", "--json"],
        {
          host: {
            platform: "darwin",
            arch: "arm64",
            uid: process.getuid!(),
            home: f.layout.homeRoot,
          },
          layout: f.layout,
          launchAgent: f.launchAgent,
          readEnrollmentCode,
          install,
          stdout: (value) => f.output.push(value),
        },
      ),
    ).resolves.toBe(0);
    expect(readEnrollmentCode).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith({
      enrollmentCredential: "x".repeat(43),
      label: "Studio Mac",
      groupId: "primary",
    });
    expect(JSON.parse(f.output[0]!)).toMatchObject({
      action: "install",
      status: "ok",
    });
  });

  it("does not request another enrollment code for an existing installation", async () => {
    const f = await fixture(true);
    const readEnrollmentCode = vi.fn(async () => "x".repeat(43));
    await expect(
      runMacUserCommand("install", ["--label", "Studio Mac"], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        readEnrollmentCode,
      }),
    ).rejects.toThrow("already installed");
    expect(readEnrollmentCode).not.toHaveBeenCalled();
  });

  it("reuses the protected one-use code when an interrupted install resumes", async () => {
    const f = await fixture(false);
    const pendingRoot = join(f.layout.transactionRoot, "install");
    await mkdir(pendingRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      join(pendingRoot, "enrollment.credential"),
      `${"p".repeat(43)}\n`,
      { mode: 0o600 },
    );
    const readEnrollmentCode = vi.fn(async () => "x".repeat(43));
    const install = vi.fn(async () => installationResult());

    await expect(
      runMacUserCommand("install", ["--label", "Studio Mac"], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        readEnrollmentCode,
        install,
        stdout: (value: string) => f.output.push(value),
      }),
    ).resolves.toBe(0);
    expect(readEnrollmentCode).not.toHaveBeenCalled();
    expect(install).toHaveBeenCalledWith({
      enrollmentCredential: "p".repeat(43),
      label: "Studio Mac",
    });
    expect(f.output[0]).toContain(
      "MusicMute Worker Install\n\nResult: Success",
    );
    expect(f.output[0]).not.toMatch(/^\s*\{/u);
  });

  it("prompts for a new code after explicitly resetting a pre-exchange attempt", async () => {
    const f = await fixture(false);
    const pendingRoot = join(f.layout.transactionRoot, "install");
    await mkdir(pendingRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      join(pendingRoot, "enrollment.credential"),
      `${"p".repeat(43)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(pendingRoot, ".enrollment-state.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        exchangeRequestId: "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
        reportRequestId: "32410a14-e85a-4a1d-bb99-61fa54b07eab",
        activationRequestId: "32410a14-e85a-4a1d-bb99-61fa54b07eac",
      })}\n`,
      { mode: 0o600 },
    );
    const readEnrollmentCode = vi.fn(async () => "x".repeat(43));
    const install = vi.fn(async () => installationResult());

    await expect(
      runMacUserCommand("install", ["--label", "Studio Mac", "--new-code"], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        readEnrollmentCode,
        install,
        stdout: (value: string) => f.output.push(value),
      }),
    ).resolves.toBe(0);
    expect(readEnrollmentCode).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith({
      enrollmentCredential: "x".repeat(43),
      label: "Studio Mac",
    });
    await expect(
      lstat(join(pendingRoot, "enrollment.credential")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(join(pendingRoot, ".enrollment-state.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("explains how to recover from a consumed-code conflict", async () => {
    const f = await fixture(false);
    const install = vi.fn(async () => {
      throw new WorkerEnrollmentError("WORKER_CONFLICT", 409, false);
    });
    await expect(
      runMacUserCommand("install", ["--label", "Studio Mac"], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        readEnrollmentCode: async () => "x".repeat(43),
        install,
      }),
    ).rejects.toThrow("retry install with --new-code");
  });

  it("recovers preserved pairing and release state after conservative uninstall", async () => {
    const f = await fixture(true);
    await expect(f.run("uninstall", ["--json"])).resolves.toBe(0);
    await expect(lstat(f.layout.currentLink)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const readEnrollmentCode = vi.fn(async () => "x".repeat(43));
    const recover = vi.fn(async () => ({
      releaseVersion: "0.1.0",
      serviceLoaded: true,
    }));

    await expect(
      runMacUserCommand("install", [], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        readEnrollmentCode,
        recover,
        stdout: (value) => f.output.push(value),
      }),
    ).resolves.toBe(0);
    expect(recover).toHaveBeenCalledOnce();
    expect(readEnrollmentCode).not.toHaveBeenCalled();
  });

  it("reports unhealthy before install with stable JSON", async () => {
    const f = await fixture(false);
    await expect(f.run("status", ["--json"])).resolves.toBe(1);
    expect(JSON.parse(f.output[0]!)).toMatchObject({
      installed: false,
      activeReleaseVersion: null,
      lifecycle: "unknown",
      healthy: false,
    });
  });

  it("shows a readable status by default", async () => {
    const f = await fixture(false);
    await expect(f.run("status", [])).resolves.toBe(1);
    expect(f.output[0]).toContain("MusicMute Worker Status");
    expect(f.output[0]).toContain("Overall: Needs attention");
    expect(f.output[0]).toContain("Installation: Not installed");
    expect(f.output[0]).toContain("Active release: Not available");
    expect(f.output[0]).not.toMatch(/^\s*\{/u);
  });

  it("shows readable doctor checks and keeps JSON opt-in", async () => {
    const f = await fixture(true);
    const health = vi.fn(async () => ({
      schemaVersion: 1 as const,
      healthy: false,
      checks: [
        { name: "runtime-config", ok: true, path: f.layout.configPath },
        { name: "runtime-doctor", ok: false, path: f.layout.pythonPath },
      ],
    }));
    const context = {
      host: {
        platform: "darwin" as const,
        arch: "arm64",
        uid: process.getuid!(),
        home: f.layout.homeRoot,
      },
      layout: f.layout,
      launchAgent: f.launchAgent,
      health,
      stdout: (value: string) => f.output.push(value),
    };

    await expect(runMacUserCommand("doctor", [], context)).resolves.toBe(1);
    expect(f.output.pop()).toContain(
      "MusicMute Worker Doctor\n\nOverall: Problems found\nChecks: 1 passed, 1 failed",
    );
    await expect(
      runMacUserCommand("doctor", ["--json"], context),
    ).resolves.toBe(1);
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      healthy: false,
      checks: [
        { name: "runtime-config", ok: true },
        { name: "runtime-doctor", ok: false },
      ],
    });
  });

  it("combines local intent with remote authority in status", async () => {
    const f = await fixture(true);
    await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [], {
      childState: "ready",
      sessionId: randomUUID(),
      incarnation: randomUUID(),
      processId: process.pid,
      slots: [{ workerId: randomUUID(), gpuId: "gpu-0", provider: "mps" }],
    });
    f.launchAgent.status.mockResolvedValue({ loaded: true, running: true });
    await expect(
      runMacUserCommand("status", ["--json"], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        stdout: (value) => f.output.push(value),
        remoteStatus: async () => ({
          machineId: "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
          status: "paused",
          groupId: null,
          policyRevision: 4,
          revision: 7,
          lastSeenAt: "2026-09-21T01:00:00.000Z",
          activeAttempts: 0,
          claimsAllowed: false,
        }),
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      activeReleaseVersion: "test",
      remote: {
        available: true,
        state: { status: "paused", claimsAllowed: false },
      },
      effectiveClaimsAllowed: false,
      readiness: {
        claimEligible: false,
        blockers: ["backend-paused", "backend-claims-disabled"],
      },
      healthy: true,
    });
  });

  it("reports local readiness without contacting the backend", async () => {
    const f = await fixture(true);
    const remoteStatus = vi.fn(async () => {
      throw new Error("must not call backend");
    });
    await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [], {
      childState: "ready",
      sessionId: randomUUID(),
      incarnation: randomUUID(),
      processId: process.pid,
      slots: [{ workerId: randomUUID(), gpuId: "gpu-0", provider: "mps" }],
      cachedPolicy: {
        machineStatus: "active",
        claimAllowed: true,
        revision: 3,
        observedAt: new Date().toISOString(),
      },
    });
    f.launchAgent.status.mockResolvedValue({
      loaded: true,
      running: true,
      pid: process.pid,
    });
    await expect(
      runMacUserCommand("status", ["--local", "--json"], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        remoteStatus,
        stdout: (value) => f.output.push(value),
      }),
    ).resolves.toBe(0);
    expect(remoteStatus).not.toHaveBeenCalled();
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      readiness: { phase: "ready", modelReady: true, claimEligible: null },
      remote: { available: false, checkedAt: null },
      runtime: { cachedPolicy: { machineStatus: "active" } },
    });
  });

  it("rejects a stale or wrong-process status as readiness proof", async () => {
    const f = await fixture(true);
    await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [], {
      childState: "ready",
      sessionId: randomUUID(),
      incarnation: randomUUID(),
      processId: process.pid,
      slots: [{ workerId: randomUUID(), gpuId: "gpu-0", provider: "mps" }],
    });
    f.launchAgent.status.mockResolvedValue({
      loaded: true,
      running: true,
      pid: process.pid + 1,
    });
    await expect(f.run("status", ["--local", "--json"])).resolves.toBe(1);
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      readiness: {
        modelReady: false,
        phase: "failed",
        blockers: ["runtime-process-mismatch"],
      },
    });
    const status = await loadLocalRuntimeStatus(f.layout.runtimeStatusPath);
    await writeFile(
      f.layout.runtimeStatusPath,
      `${JSON.stringify({ ...status, updatedAt: "2020-01-01T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    f.launchAgent.status.mockResolvedValue({
      loaded: true,
      running: true,
      pid: process.pid,
    });
    await expect(f.run("status", ["--local", "--json"])).resolves.toBe(1);
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      readiness: { modelReady: false, blockers: ["runtime-heartbeat-stale"] },
    });
  });

  it("shows full capacity and diagnostic blockage without killing processing", async () => {
    const f = await fixture(true);
    const workerId = randomUUID();
    const attemptId = randomUUID();
    await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [attemptId], {
      childState: "ready",
      sessionId: randomUUID(),
      incarnation: randomUUID(),
      processId: process.pid,
      slots: [{ workerId, gpuId: "gpu-0", provider: "mps" }],
      currentAttempts: [
        {
          workerId,
          attemptId,
          jobId: "64b000000000000000000001",
          stage: "separation",
          startedAt: new Date().toISOString(),
          stageStartedAt: new Date().toISOString(),
          lastProgressAt: "2020-01-01T00:00:00.000Z",
          work: { unit: "windows", completed: 2, total: 20 },
        },
      ],
      diagnostics: {
        blockedReason: "write-failed",
        earliestAvailableAt: null,
        incompleteHistory: true,
        retainedBytes: 100,
      },
    });
    f.launchAgent.status.mockResolvedValue({
      loaded: true,
      running: true,
      pid: process.pid,
    });
    await expect(f.run("status", ["--local", "--json"])).resolves.toBe(1);
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      readiness: {
        phase: "processing",
        modelReady: true,
        localReady: false,
        progressStale: true,
        blockers: ["diagnostics-write-failed", "capacity-full"],
      },
      runtime: {
        currentAttempts: [
          { stage: "separation", work: { completed: 2, total: 20 } },
        ],
      },
    });
  });

  it("stops status watch on interruption without mutating the service", async () => {
    const f = await fixture(true);
    const output: string[] = [];
    await expect(
      runMacUserCommand("status", ["--local", "--watch", "--json"], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        remoteStatus: vi.fn(async () => {
          throw new Error("must not call backend");
        }),
        wait: async () => {
          process.emit("SIGINT");
        },
        stdout: (value) => output.push(value),
      }),
    ).resolves.toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toHaveProperty("schemaVersion", 2);
    expect(f.launchAgent.bootout).not.toHaveBeenCalled();
    expect(f.launchAgent.kickstart).not.toHaveBeenCalled();
  });

  it("waits for a real ready child before returning from start", async () => {
    const f = await fixture(true);
    const identity = {
      sessionId: randomUUID(),
      incarnation: randomUUID(),
      processId: process.pid,
      slots: [
        { workerId: randomUUID(), gpuId: "gpu-0", provider: "mps" as const },
      ],
    };
    await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [], {
      ...identity,
      childState: "loading",
    });
    f.launchAgent.status.mockResolvedValue({
      loaded: true,
      running: true,
      pid: process.pid,
    });
    await expect(
      runMacUserCommand("start", ["--wait-ready", "--json"], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        remoteStatus: async () => ({
          machineId: randomUUID(),
          status: "active",
          groupId: null,
          policyRevision: 1,
          revision: 1,
          lastSeenAt: null,
          activeAttempts: 0,
          claimsAllowed: true,
        }),
        wait: async () => {
          await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [], {
            ...identity,
            childState: "ready",
          });
        },
        stdout: (value) => f.output.push(value),
      }),
    ).resolves.toBe(0);
    expect(f.output.map((value) => JSON.parse(value).phase)).toContain(
      "loading",
    );
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({
      action: "start",
      readiness: { modelReady: true, claimEligible: true },
    });
    expect(f.launchAgent.kickstart).not.toHaveBeenCalled();
  });

  it("times out wait-ready with the last observed blocker", async () => {
    let now = 0;
    const read = async () =>
      ({
        readiness: {
          phase: "loading",
          modelReady: false,
          blockers: ["model-loading"],
        },
      }) as never;
    await expect(
      waitForReady(
        read,
        async (milliseconds) => {
          now += milliseconds;
        },
        undefined,
        2_000,
        () => now,
      ),
    ).rejects.toThrow("model-loading");
  });

  it("starts, stops, and restarts through the user launchctl domain", async () => {
    const f = await fixture(true);
    f.launchAgent.status
      .mockResolvedValueOnce({ loaded: false, running: false })
      .mockResolvedValueOnce({ loaded: true, running: true })
      .mockResolvedValueOnce({ loaded: false, running: false })
      .mockResolvedValueOnce({ loaded: true, running: true })
      .mockResolvedValueOnce({ loaded: false, running: false })
      .mockResolvedValueOnce({ loaded: false, running: false });

    await expect(f.run("start", [])).resolves.toBe(0);
    expect(f.output.at(-1)).toBe(
      "MusicMute Worker Start\n\nResult: Success\nOutcome: Service Started",
    );
    expect(f.launchAgent.bootstrap).toHaveBeenCalledWith(f.layout.plistPath);
    await expect(f.run("stop", ["--json"])).resolves.toBe(0);
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({ action: "stop" });
    expect(f.launchAgent.bootout).toHaveBeenCalledOnce();
    await expect(f.run("restart", ["--json"])).resolves.toBe(0);
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({ action: "restart" });
    expect(f.launchAgent.bootout).toHaveBeenCalledTimes(2);
    expect(f.launchAgent.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("refuses to start when the private runtime preflight fails", async () => {
    const f = await fixture(true);
    await expect(
      runMacUserCommand("start", [], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        preflight: async () => false,
      }),
    ).rejects.toThrow("failed start preflight");
    expect(f.launchAgent.bootstrap).not.toHaveBeenCalled();
    expect(f.launchAgent.kickstart).not.toHaveBeenCalled();
  });

  it("keeps a running service and active attempt intact on repeated start", async () => {
    const f = await fixture(true);
    f.launchAgent.status.mockResolvedValue({
      loaded: true,
      running: true,
    });
    await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [
      "99f8016b-67f3-4f4b-beb4-205a7b87147e",
    ]);

    await f.run("start", ["--json"]);
    await f.run("start", ["--json"]);

    expect(f.output.map((value) => JSON.parse(value).outcome)).toEqual([
      "already-running",
      "already-running",
    ]);
    expect(f.launchAgent.kickstart).not.toHaveBeenCalled();
    expect(f.launchAgent.bootstrap).not.toHaveBeenCalled();
    expect(f.launchAgent.bootout).not.toHaveBeenCalled();
    expect(
      (await loadLocalRuntimeStatus(f.layout.runtimeStatusPath))
        .activeAttemptIds,
    ).toEqual(["99f8016b-67f3-4f4b-beb4-205a7b87147e"]);
  });

  it("starts a loaded but stopped service without replacing a running PID", async () => {
    const f = await fixture(true);
    f.launchAgent.status.mockResolvedValue({ loaded: true, running: false });

    await f.run("start", ["--json"]);

    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({
      action: "start",
      outcome: "service-started",
    });
    expect(f.launchAgent.kickstart).toHaveBeenCalledOnce();
    expect(f.launchAgent.bootstrap).not.toHaveBeenCalled();
  });

  it("unloads a stopped service without waiting on stale attempt state", async () => {
    const f = await fixture(true);
    f.launchAgent.status
      .mockResolvedValueOnce({ loaded: true, running: false })
      .mockResolvedValueOnce({ loaded: false, running: false });
    await writeLocalRuntimeStatus(f.layout.runtimeStatusPath, [
      "99f8016b-67f3-4f4b-beb4-205a7b87147e",
    ]);

    await f.run("stop", ["--json"]);

    expect(f.launchAgent.bootout).toHaveBeenCalledOnce();
    expect(f.launchAgent.kickstart).not.toHaveBeenCalled();
  });

  it("resume on a stopped service reports intent without starting it", async () => {
    const f = await fixture(true);
    await f.run("pause", ["--json"]);
    await f.run("resume", ["--json"]);
    const revision = (await loadLocalLifecycle(f.layout.lifecyclePath))
      .revision;
    await f.run("resume", ["--json"]);

    expect(f.output.map((value) => JSON.parse(value).outcome)).toEqual([
      "intent-updated",
      "intent-updated",
      "already-set",
    ]);
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({
      action: "active",
      serviceRunning: false,
    });
    expect((await loadLocalLifecycle(f.layout.lifecyclePath)).revision).toBe(
      revision,
    );
    expect(f.launchAgent.kickstart).not.toHaveBeenCalled();
    expect(f.launchAgent.bootstrap).not.toHaveBeenCalled();
  });

  it("persists pause, drain, and resume without changing backend authority", async () => {
    const f = await fixture(true);
    f.launchAgent.status.mockResolvedValue({ loaded: true, running: true });

    await f.run("pause", ["--json"]);
    await f.run("drain", ["--json"]);
    await f.run("resume", ["--json"]);

    expect(f.output.map((value) => JSON.parse(value).action)).toEqual([
      "paused",
      "draining",
      "active",
    ]);
    expect(f.launchAgent.kickstart).not.toHaveBeenCalled();
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({
      action: "active",
      outcome: "intent-updated",
      serviceRunning: true,
    });
  });

  it("reads bounded logs and validates arguments", async () => {
    const f = await fixture(true);
    await writeFile(f.layout.stdoutPath, "one\ntwo\nthree\n", { mode: 0o600 });
    await writeFile(f.layout.stderrPath, "problem\n", { mode: 0o600 });

    await expect(f.run("logs", ["--lines", "2", "--json"])).resolves.toBe(0);
    expect(JSON.parse(f.output[0]!)).toEqual({
      stdout: "three\n",
      stderr: "problem\n",
    });
    await expect(f.run("logs", ["--lines", "0"])).rejects.toThrow(
      "between 1 and 1000",
    );
  });

  it("exposes bounded local job and error investigations through the CLI", async () => {
    const f = await fixture(true);
    const jobId = "507461bf507461bf507461bf";
    await expect(f.run("job", [jobId, "--json"])).resolves.toBe(2);
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      scope: "local-worker-history",
      foundLocally: false,
    });
    await expect(
      f.run("errors", ["--since", "1d", "--limit", "10", "--json"]),
    ).resolves.toBe(0);
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      groups: [],
      groupLimit: 10,
    });
    await expect(f.run("explain", ["TIMEOUT", "--json"])).resolves.toBe(0);
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      code: "TIMEOUT",
      observedCountInRetainedHistory: 0,
    });
    await expect(f.run("perf", ["--last", "5", "--json"])).resolves.toBe(0);
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      scope: "local-worker-history",
      selectedAttempts: 0,
      last: 5,
    });
    await expect(f.run("errors", ["--limit", "101"])).rejects.toThrow("limit");
    await expect(f.run("perf", ["--last", "0"])).rejects.toThrow("count");
  });

  it("clears logs safely and restores a previously loaded service", async () => {
    const f = await fixture(true);
    await writeFile(f.layout.stdoutPath, "old stdout", { mode: 0o600 });
    await writeFile(f.layout.stderrPath, "old stderr", { mode: 0o600 });
    f.launchAgent.status
      .mockResolvedValueOnce({ loaded: true, running: true })
      .mockResolvedValueOnce({ loaded: true, running: true })
      .mockResolvedValueOnce({ loaded: false, running: false })
      .mockResolvedValueOnce({ loaded: false, running: false });

    await expect(
      runMacUserCommand("logs", ["--clear", "--json"], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        preflight: async () => true,
        stdout: (value) => f.output.push(value),
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(f.output.pop()!)).toMatchObject({
      action: "logs-cleared",
      filesCleared: 2,
    });
    expect((await lstat(f.layout.stdoutPath)).size).toBe(0);
    expect((await lstat(f.layout.stderrPath)).size).toBe(0);
    expect(f.launchAgent.bootout).not.toHaveBeenCalled();
    expect(f.launchAgent.bootstrap).not.toHaveBeenCalled();
    await expect(f.run("logs", ["--clear", "--events"])).rejects.toThrow(
      "cannot be combined",
    );
  });

  it("shows filtered structured events and errors", async () => {
    const f = await fixture(true);
    const attemptId = "cb56441d-f2df-4b44-a320-6f37dfa81f7f";
    const spoolRoot = join(f.layout.workRoot, "..", "logs");
    await mkdir(spoolRoot, { recursive: true, mode: 0o700 });
    await writeFile(f.layout.stderrPath, "unrelated raw stderr\n", {
      mode: 0o600,
    });
    await writeFile(
      join(spoolRoot, "events.jsonl"),
      `${JSON.stringify({ recordedAt: new Date().toISOString(), event: { kind: "attempt-failed", attemptId, code: "SEPARATOR_FAILED" } })}\n`,
      { mode: 0o600 },
    );
    await expect(
      f.run("logs", ["--errors", "--attempt-id", attemptId]),
    ).resolves.toBe(0);
    const filtered = f.output.pop()!;
    expect(filtered).toContain(
      `ERROR attempt-failed attempt=${attemptId} code=SEPARATOR_FAILED`,
    );
    expect(filtered).not.toContain("unrelated raw stderr");
    expect(filtered).not.toContain("== worker stderr ==");
    await expect(f.run("logs", ["--errors"])).resolves.toBe(0);
    expect(f.output.pop()).toContain("unrelated raw stderr");
    await expect(f.run("logs", ["--attempt-id", attemptId])).rejects.toThrow(
      "filters require",
    );
  });

  it("creates a sanitized diagnostic bundle through the public command", async () => {
    const f = await fixture(true);
    const diagnostics = vi.fn(async (outputPath?: string) => ({
      schemaVersion: 1 as const,
      path:
        outputPath ?? join(f.layout.homeRoot, "Downloads", "diagnostics.zip"),
      files: ["status.json", "doctor.json"],
      createdAt: "2026-09-21T12:00:00.000Z",
    }));
    await expect(
      runMacUserCommand(
        "diagnostics",
        ["--output", join(f.layout.homeRoot, "diagnostics.zip")],
        {
          host: {
            platform: "darwin",
            arch: "arm64",
            uid: process.getuid!(),
            home: f.layout.homeRoot,
          },
          layout: f.layout,
          launchAgent: f.launchAgent,
          diagnostics,
          health: async () => ({ schemaVersion: 1, healthy: true, checks: [] }),
          stdout: (value) => f.output.push(value),
        },
      ),
    ).resolves.toBe(0);
    expect(diagnostics).toHaveBeenCalledWith(
      join(f.layout.homeRoot, "diagnostics.zip"),
    );
    expect(f.output.pop()).toContain("MusicMute Worker Diagnostics");
  });

  it("redacts credentials, signed URLs, and user paths from displayed logs", async () => {
    const f = await fixture(true);
    await writeFile(
      f.layout.stdoutPath,
      [
        `credential=${"x".repeat(43)}`,
        "download=https://storage.example/object?X-Amz-Signature=secret",
        "path=/Users/private/MusicMuteWorker",
      ].join("\n"),
      { mode: 0o600 },
    );
    await expect(f.run("logs", ["--json"])).resolves.toBe(0);
    const output = JSON.stringify(JSON.parse(f.output[0]!));
    expect(output).toContain("credential=[REDACTED]");
    expect(output).toContain("[REDACTED_URL]");
    expect(output).toContain("/Users/[REDACTED]");
    expect(output).not.toContain("X-Amz-Signature");
    expect(output).not.toContain("x".repeat(43));
  });

  it("deletes the credential only after backend-confirmed forced unpair", async () => {
    const f = await fixture(true);
    f.launchAgent.status.mockResolvedValue({ loaded: true, running: true });
    const unpair = vi.fn(async () => ({
      confirmed: true as const,
      machineId: "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
    }));

    await expect(
      runMacUserCommand("unpair", ["--force"], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        unpair,
        stdout: (value) => f.output.push(value),
      }),
    ).resolves.toBe(0);
    expect(unpair).toHaveBeenCalledWith(true);
    await expect(lstat(f.layout.credentialPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(f.layout.configPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      JSON.parse(
        await import("node:fs/promises").then(({ readFile }) =>
          readFile(f.layout.unpairReceiptPath, "utf8"),
        ),
      ),
    ).toMatchObject({
      schemaVersion: 1,
      machineId: "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
    });
    expect(f.launchAgent.bootout).toHaveBeenCalled();

    const unexpectedBackendCall = vi.fn(async () => {
      throw new Error("backend should not be called on replay");
    });
    await expect(
      runMacUserCommand("unpair", ["--json"], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        unpair: unexpectedBackendCall,
        stdout: (value) => f.output.push(value),
      }),
    ).resolves.toBe(0);
    expect(unexpectedBackendCall).not.toHaveBeenCalled();
    expect(JSON.parse(f.output.at(-1)!)).toMatchObject({ replayed: true });
  });

  it("preserves data on uninstall and requires unpair before purge", async () => {
    const f = await fixture(true);
    f.launchAgent.status
      .mockResolvedValueOnce({ loaded: true, running: true })
      .mockResolvedValue({ loaded: false, running: false });
    await writeFile(f.layout.plistPath, "plist", { mode: 0o600 }).catch(
      async () => {
        await mkdir(f.layout.launchAgentsRoot, {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(f.layout.plistPath, "plist", { mode: 0o600 });
      },
    );
    await expect(f.run("uninstall", ["--json"])).resolves.toBe(0);
    expect(f.launchAgent.bootout).toHaveBeenCalledOnce();
    expect(await lstat(f.layout.installRoot)).toBeDefined();
    await expect(f.run("uninstall", ["--purge"])).rejects.toThrow(
      "requires a backend-confirmed unpair",
    );
    await rm(f.layout.credentialPath);
    await expect(f.run("uninstall", ["--purge"])).rejects.toThrow(
      "requires a backend-confirmed unpair",
    );
    await writeFile(f.layout.credentialPath, `${"x".repeat(43)}\n`, {
      mode: 0o600,
    });
    await expect(
      runMacUserCommand("unpair", ["--force"], {
        host: {
          platform: "darwin",
          arch: "arm64",
          uid: process.getuid!(),
          home: f.layout.homeRoot,
        },
        layout: f.layout,
        launchAgent: f.launchAgent,
        unpair: async () => ({
          confirmed: true,
          machineId: "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
        }),
        stdout: (value) => f.output.push(value),
      }),
    ).resolves.toBe(0);
    await expect(f.run("uninstall", ["--purge", "--json"])).resolves.toBe(0);
    await expect(lstat(f.layout.installRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("initializes private service state and a user LaunchAgent", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const layout = createMacUserLayout(home);

    await initializeMacUserServiceFiles(layout);

    const plist = await import("node:fs/promises").then(({ readFile }) =>
      readFile(layout.plistPath, "utf8"),
    );
    expect(plist).toContain("com.musicmute.worker");
    expect(plist).not.toContain("UserName");
  });
});

async function fixture(installed: boolean) {
  const root = await temporaryRoot();
  const home = join(root, "home");
  await mkdir(home, { mode: 0o700 });
  const layout = createMacUserLayout(home);
  await mkdir(layout.configRoot, { recursive: true, mode: 0o700 });
  await mkdir(layout.stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(layout.logRoot, { recursive: true, mode: 0o700 });
  if (installed) {
    await writeFile(layout.configPath, "{}\n", { mode: 0o600 });
    await mkdir(layout.credentialRoot, { recursive: true, mode: 0o700 });
    await writeFile(layout.credentialPath, `${"x".repeat(43)}\n`, {
      mode: 0o600,
    });
    await initializeLocalLifecycle(layout.lifecyclePath);
    await writeLocalRuntimeStatus(layout.runtimeStatusPath, []);
    await mkdir(join(layout.releasesRoot, "test"), {
      recursive: true,
      mode: 0o700,
    });
    await symlink("releases/test", layout.currentLink);
  }
  const launchAgent = {
    bootstrap: vi.fn(async () => undefined),
    bootout: vi.fn(async () => undefined),
    kickstart: vi.fn(async () => undefined),
    status: vi.fn(async (): Promise<LaunchAgentStatus> => ({
      loaded: false,
      running: false,
    })),
  };
  const output: string[] = [];
  const run = async (command: string, arguments_: string[]) =>
    await runMacUserCommand(command, arguments_, {
      host: { platform: "darwin", arch: "arm64", uid: process.getuid!(), home },
      layout,
      launchAgent,
      preflight: async () => true,
      stdout: (value) => output.push(value),
    });
  return { layout, launchAgent, output, run };
}

function installationResult() {
  return {
    machineId: "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
    releaseVersion: "0.1.0",
    reusedRelease: true,
    reusedModel: true,
    serviceLoaded: true,
    runtime: {
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
    },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-user-cli-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
