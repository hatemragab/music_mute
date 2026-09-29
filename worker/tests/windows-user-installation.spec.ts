import { describe, expect, it, vi } from "vitest";
import { win32 } from "node:path";
import { buildServiceRuntimeConfig } from "../src/enrollment/runtime-config-builder.js";
import { createWindowsServiceLayout } from "../src/platform/windows/service-definition.js";
import {
  preservedWindowsRelease,
  reactivateWindowsInstallation,
} from "../src/platform/windows/user-installation.js";
import type { WindowsServiceStatus } from "../src/platform/windows/native-service.js";
import { runWindowsUserCommand } from "../src/platform/windows/user-cli.js";

const layout = createWindowsServiceLayout();
const version = "0.1.0-test.9";
function fixture() {
  const config = buildServiceRuntimeConfig({
    platform: "windows-amd64",
    installRoot: layout.installRoot,
    releaseVersion: version,
    backendBaseUrl: "https://api.example.invalid",
    machineId: "00000000-0000-4000-8000-000000000010",
    workerId: "00000000-0000-4000-8000-000000000011",
  });
  let state: WindowsServiceStatus["state"] = "absent";
  const service = {
    assertPrivateInstallation: vi.fn(async () => {}),
    start: vi.fn(),
    stop: vi.fn(),
    inspect: vi.fn(async (): Promise<WindowsServiceStatus> => ({
      state,
      processId: state === "running" ? 100 : null,
      runtimeProcessId: null,
      runtimeStartedAt: null,
    })),
  };
  const manager = vi.fn(async () => {
    state = "running";
  });
  const options = {
    layout,
    service,
    manager,
    inspect: vi.fn(async () => preservedWindowsRelease(layout, { ...config })),
    pending: vi.fn(async () => false),
    activeVersion: vi.fn(async () => version),
  };
  return {
    config,
    service,
    manager,
    options,
    setState: (value: WindowsServiceStatus["state"]) => {
      state = value;
    },
  };
}

describe("Windows preserved installation", () => {
  it("resolves only the exact managed release and state paths", () => {
    const f = fixture();
    expect(preservedWindowsRelease(layout, { ...f.config }).version).toBe(
      version,
    );
    for (const key of [
      "engineRoot",
      "pythonPath",
      "ffmpegPath",
      "ffprobePath",
      "credentialFile",
      "workRoot",
      "modelCacheRoot",
      "localLifecyclePath",
      "localRuntimeStatusPath",
      "capacityValidationFile",
    ]) {
      expect(() =>
        preservedWindowsRelease(layout, {
          ...f.config,
          [key]: "C:\\foreign\\file",
        }),
      ).toThrow();
    }
    for (const path of [
      win32.join(layout.releasesRoot, version, "app", "engine") +
        "\\..\\engine",
      "C:\\ProgramData\\MusicMuteWorker-foreign\\releases\\0.1.0\\app\\engine",
      "\\\\host\\share\\app\\engine",
    ]) {
      expect(() =>
        preservedWindowsRelease(layout, { ...f.config, engineRoot: path }),
      ).toThrow();
    }
  });
  it("reactivates through the verified release manager and confirms the active release", async () => {
    const f = fixture();
    await expect(
      reactivateWindowsInstallation(f.options),
    ).resolves.toMatchObject({
      status: "reactivated",
      releaseVersion: version,
    });
    expect(f.manager).toHaveBeenCalledWith(
      win32.join(
        layout.releasesRoot,
        version,
        "installer",
        "manage-windows-service.ps1",
      ),
      [
        "-Action",
        "Reactivate",
        "-InstallRoot",
        layout.installRoot,
        "-Release",
        win32.join(layout.releasesRoot, version),
      ],
    );
    expect(f.service.start).not.toHaveBeenCalled();
  });
  it("leaves an existing stopped installation stopped", async () => {
    const f = fixture();
    f.setState("stopped");
    await expect(
      reactivateWindowsInstallation(f.options),
    ).resolves.toMatchObject({ status: "already-installed" });
    expect(f.manager).not.toHaveBeenCalled();
    expect(f.service.start).not.toHaveBeenCalled();
  });
  it("refuses trust, recovery and release mismatch failures before mutation", async () => {
    const f = fixture();
    f.service.assertPrivateInstallation.mockRejectedValueOnce(new Error("ACL"));
    await expect(reactivateWindowsInstallation(f.options)).rejects.toThrow(
      "ACL",
    );
    expect(f.options.inspect).not.toHaveBeenCalled();
    f.options.pending.mockResolvedValueOnce(true);
    await expect(reactivateWindowsInstallation(f.options)).rejects.toThrow(
      "Recover",
    );
    f.options.inspect.mockRejectedValueOnce(new Error("capacity expired"));
    await expect(reactivateWindowsInstallation(f.options)).rejects.toThrow(
      "capacity expired",
    );
    f.setState("stopped");
    f.options.activeVersion.mockResolvedValueOnce("other");
    await expect(reactivateWindowsInstallation(f.options)).rejects.toThrow(
      "disagree",
    );
    expect(f.manager).not.toHaveBeenCalled();
  });
  it("propagates manager failures and rejects incomplete native activation", async () => {
    const f = fixture();
    f.manager.mockRejectedValueOnce(new Error("rollback completed"));
    await expect(reactivateWindowsInstallation(f.options)).rejects.toThrow(
      "rollback completed",
    );
    f.manager.mockImplementationOnce(async () => {});
    await expect(reactivateWindowsInstallation(f.options)).rejects.toThrow(
      "expected running release",
    );
  });
  it("routes install without enrollment flags to preserved activation", async () => {
    const f = fixture();
    const stdout = vi.fn();
    const reactivate = vi.fn(async () => ({
      action: "install",
      status: "reactivated",
      releaseVersion: version,
    }));
    expect(
      await runWindowsUserCommand("install", ["--json"], {
        host: { platform: "win32", arch: "x64" },
        layout,
        service: f.service,
        stdout,
        reactivate,
      }),
    ).toBe(0);
    expect(reactivate).toHaveBeenCalledWith({ layout, service: f.service });
    expect(JSON.parse(stdout.mock.calls[0]![0] as string)).toMatchObject({
      status: "reactivated",
    });
  });
});
