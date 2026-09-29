import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeLocalLifecycle } from "../src/runtime/local-lifecycle.js";
import { writeLocalRuntimeStatus } from "../src/runtime/local-runtime-status.js";
import { createWindowsServiceLayout } from "../src/platform/windows/service-definition.js";
import { inspectWindowsUserHealth } from "../src/platform/windows/user-health.js";
import { runWindowsUserCommand } from "../src/platform/windows/user-cli.js";
import type { WindowsServiceStatus } from "../src/platform/windows/native-service.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-doctor-"));
  roots.push(root);
  const layout = {
    ...createWindowsServiceLayout(),
    stateRoot: root,
    serviceRoot: join(root, "service"),
    lifecyclePath: join(root, "lifecycle.json"),
    runtimeStatusPath: join(root, "runtime-status.json"),
  };
  await initializeLocalLifecycle(layout.lifecyclePath);
  await writeLocalRuntimeStatus(layout.runtimeStatusPath, [], {
    processId: 1234,
    childState: "ready",
  });
  const service = {
    assertPrivateInstallation: vi.fn(async () => undefined),
    inspect: vi.fn(async (): Promise<WindowsServiceStatus> => ({
      state: "running",
      processId: 1233,
      runtimeProcessId: 1234,
      runtimeStartedAt: new Date(Date.now() - 1000).toISOString(),
    })),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const dependencies = {
    privateFile: vi.fn(async () => undefined),
    activeVersion: vi.fn(async () => "test-release"),
    releaseVerifier: vi.fn(async () => undefined),
    configValidator: vi.fn(async () => undefined),
    runtimeDoctor: vi.fn(async () => undefined),
  };
  return {
    layout,
    service,
    dependencies,
    inspect: (depth: "quick" | "full" = "quick") =>
      inspectWindowsUserHealth(layout, service, { ...dependencies, depth }),
  };
}

describe("Windows doctor", () => {
  it("keeps quick inspection read-only and distinguishes unchecked integrity", async () => {
    const f = await fixture();
    const result = await f.inspect();
    expect(result.healthy).toBe(true);
    expect(
      result.checks
        .filter((check) => check.status === "not-run")
        .map((check) => check.name),
    ).toEqual(["release-manifest", "runtime-doctor"]);
    expect(f.dependencies.releaseVerifier).not.toHaveBeenCalled();
    expect(f.dependencies.runtimeDoctor).not.toHaveBeenCalled();
    expect(f.service.start).not.toHaveBeenCalled();
    expect(f.service.stop).not.toHaveBeenCalled();
  });
  it("verifies release integrity before invoking the full runtime doctor", async () => {
    const f = await fixture();
    const result = await f.inspect("full");
    expect(result.healthy).toBe(true);
    expect(f.dependencies.releaseVerifier).toHaveBeenCalledOnce();
    expect(f.dependencies.runtimeDoctor).toHaveBeenCalledOnce();
    expect(
      f.dependencies.releaseVerifier.mock.invocationCallOrder[0],
    ).toBeLessThan(f.dependencies.runtimeDoctor.mock.invocationCallOrder[0]!);
  });
  it("does not read private files or execute tools when installation trust fails", async () => {
    const f = await fixture();
    f.service.assertPrivateInstallation.mockRejectedValue(
      new Error("secret-credential"),
    );
    const result = await f.inspect("full");
    expect(result.healthy).toBe(false);
    expect(f.dependencies.privateFile).not.toHaveBeenCalled();
    expect(f.dependencies.runtimeDoctor).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-credential");
  });
  it("blocks installed execution after manifest failure and redacts raw errors", async () => {
    const f = await fixture();
    f.dependencies.releaseVerifier.mockRejectedValue(
      new Error("https://secret.invalid/?token=private"),
    );
    const result = await f.inspect("full");
    expect(result.healthy).toBe(false);
    expect(f.dependencies.runtimeDoctor).not.toHaveBeenCalled();
    expect(
      result.checks.find((check) => check.name === "runtime-doctor")?.status,
    ).toBe("not-run");
    expect(JSON.stringify(result)).not.toContain("secret.invalid");
  });
  it("does not consume an unsafe active marker or configuration", async () => {
    const f = await fixture();
    f.dependencies.privateFile.mockRejectedValue(new Error("bad ACL"));
    expect((await f.inspect("full")).healthy).toBe(false);
    expect(f.dependencies.activeVersion).not.toHaveBeenCalled();
    expect(f.dependencies.configValidator).not.toHaveBeenCalled();
    expect(f.dependencies.runtimeDoctor).not.toHaveBeenCalled();
  });
  it("inspects offline runtime integrity without starting a stopped service", async () => {
    const f = await fixture();
    f.service.inspect.mockResolvedValue({
      state: "stopped",
      processId: null,
      runtimeProcessId: null,
      runtimeStartedAt: null,
    });
    const result = await f.inspect("full");
    expect(result.healthy).toBe(false);
    expect(
      result.checks.find((check) => check.name === "service-control")?.code,
    ).toBe("SERVICE_NOT_RUNNING");
    expect(f.dependencies.runtimeDoctor).toHaveBeenCalledOnce();
    expect(f.service.start).not.toHaveBeenCalled();
  });
  it("rejects a heartbeat belonging to another native runtime", async () => {
    const f = await fixture();
    f.service.inspect.mockResolvedValue({
      state: "running",
      processId: 1233,
      runtimeProcessId: 5678,
      runtimeStartedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const result = await f.inspect();
    expect(
      result.checks.find((check) => check.name === "service-control")?.code,
    ).toBe("RUNTIME_STATUS_STALE");
  });
  it("reports pending maintenance while preserving recovery state", async () => {
    const f = await fixture();
    await mkdir(join(f.layout.serviceRoot, "operation-recovery"), {
      recursive: true,
    });
    const result = await f.inspect();
    expect(
      result.checks.find((check) => check.name === "maintenance-recovery")
        ?.code,
    ).toBe("MAINTENANCE_RECOVERY_REQUIRED");
  });
  it("routes normal CLI flags and returns a failure exit code for an unhealthy report", async () => {
    const f = await fixture();
    const output: string[] = [];
    const health = vi.fn(async () => ({
      schemaVersion: 1 as const,
      healthy: false,
      depth: "full" as const,
      checks: [],
    }));
    const context = {
      host: { platform: "win32" as const, arch: "x64" },
      layout: f.layout,
      service: f.service,
      health,
      stdout: (value: string) => output.push(value),
    };
    expect(
      await runWindowsUserCommand("doctor", ["--full", "--json"], context),
    ).toBe(1);
    expect(health).toHaveBeenCalledWith(f.layout, f.service, { depth: "full" });
    expect(JSON.parse(output[0]!)).toMatchObject({
      healthy: false,
      depth: "full",
    });
    await expect(
      runWindowsUserCommand("doctor", ["--output", "bad"], context),
    ).rejects.toThrow("doctor accepts");
    expect(health).toHaveBeenCalledOnce();
  });
});
