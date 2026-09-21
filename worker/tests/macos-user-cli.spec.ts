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
import { initializeLocalLifecycle } from "../src/runtime/local-lifecycle.js";
import { writeLocalRuntimeStatus } from "../src/runtime/local-runtime-status.js";
import {
  initializeMacUserServiceFiles,
  runMacUserCommand,
} from "../src/platform/macos/user-cli.js";
import { createMacUserLayout } from "../src/platform/macos/user-paths.js";

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
      provider: "coreml",
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
      "MusicMute Worker Benchmark\n\nPlatform: darwin-arm64\nProvider: coreml",
    );
    await expect(
      runMacUserCommand("benchmark", ["--json"], context),
    ).resolves.toBe(0);
    expect(benchmark).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.output.pop()!)).toMatchObject({ provider: "coreml" });
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
      remote: {
        available: true,
        state: { status: "paused", claimsAllowed: false },
      },
      effectiveClaimsAllowed: false,
      healthy: true,
    });
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
    expect(f.output.at(-1)).toBe("MusicMute Worker Start\n\nResult: Success");
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
    expect(f.launchAgent.kickstart).toHaveBeenCalledOnce();
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
    expect(f.launchAgent.bootout).toHaveBeenCalledOnce();
    expect(f.launchAgent.bootstrap).toHaveBeenCalledWith(f.layout.plistPath);
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
    status: vi.fn(async () => ({ loaded: false, running: false })),
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
