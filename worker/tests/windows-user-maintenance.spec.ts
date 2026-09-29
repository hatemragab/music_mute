import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeWindowsServiceManager } from "../src/platform/windows/cli.js";
import { verifyWindowsRelease } from "../src/platform/windows/release-manifest.js";
import {
  createWindowsReleaseLayout,
  createWindowsServiceLayout,
} from "../src/platform/windows/service-definition.js";
import { readWindowsActiveVersion } from "../src/platform/windows/active-release.js";
import { recoverWindowsOperation } from "../src/platform/windows/user-maintenance.js";

vi.mock("../src/platform/windows/cli.js", () => ({
  executeWindowsServiceManager: vi.fn(),
}));
vi.mock("../src/platform/windows/release-manifest.js", () => ({
  verifyWindowsRelease: vi.fn(),
}));
vi.mock("../src/platform/windows/active-release.js", () => ({
  readWindowsActiveVersion: vi.fn(),
}));

const layout = createWindowsServiceLayout();
const version = "0.1.0-test";
const native = {
  state: "absent" as const,
  processId: null,
  runtimeProcessId: null,
  runtimeStartedAt: null,
};
const service = {
  assertPrivateInstallation: vi.fn(),
  inspect: vi.fn(async () => native),
  start: vi.fn(),
  stop: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  service.inspect.mockResolvedValue(native);
  vi.mocked(readWindowsActiveVersion).mockResolvedValue(version);
  vi.mocked(verifyWindowsRelease).mockResolvedValue({
    schemaVersion: 1,
    platform: "win32",
    architecture: "x64",
    releaseVersion: version,
    entries: [],
  });
});

describe("Windows normal CLI recovery", () => {
  it("can restore without restarting a runtime that needs offline repair", async () => {
    await recoverWindowsOperation({
      layout,
      service,
      releaseVersion: version,
      leaveStopped: true,
    });
    expect(executeWindowsServiceManager).toHaveBeenCalledWith(
      expect.any(String),
      [
        "-Action",
        "Recover",
        "-InstallRoot",
        layout.installRoot,
        "-LeaveStopped",
      ],
    );
    expect(service.start).not.toHaveBeenCalled();
  });
  it("uses the journal's verified recovery release after an interrupted update", async () => {
    const candidate = "0.2.0-test";
    vi.mocked(verifyWindowsRelease).mockResolvedValue({
      schemaVersion: 1,
      platform: "win32",
      architecture: "x64",
      releaseVersion: candidate,
      entries: [],
    });
    await recoverWindowsOperation({
      layout,
      service,
      recoveryVersion: async () => candidate,
    });
    expect(verifyWindowsRelease).toHaveBeenCalledWith(
      createWindowsReleaseLayout(layout, candidate).releaseRoot,
    );
    expect(readWindowsActiveVersion).not.toHaveBeenCalled();
  });
  it("uses the verified active release without loading runtime configuration", async () => {
    const result = await recoverWindowsOperation({ layout, service });
    const release = createWindowsReleaseLayout(layout, version);
    expect(verifyWindowsRelease).toHaveBeenCalledWith(release.releaseRoot);
    expect(executeWindowsServiceManager).toHaveBeenCalledWith(
      join(release.releaseRoot, "installer", "manage-windows-service.ps1"),
      ["-Action", "Recover", "-InstallRoot", layout.installRoot],
    );
    expect(result).toEqual({
      action: "recover",
      status: "ok",
      service: native,
    });
    expect(service.start).not.toHaveBeenCalled();
  });

  it("supports explicit recovery after an interrupted first installation", async () => {
    await recoverWindowsOperation({ layout, service, releaseVersion: version });
    expect(readWindowsActiveVersion).not.toHaveBeenCalled();
    expect(executeWindowsServiceManager).toHaveBeenCalledOnce();
  });

  it("never executes an unsafe or mismatched release", async () => {
    for (const releaseVersion of ["..\\outside", "wrong-version"]) {
      await expect(
        recoverWindowsOperation({ layout, service, releaseVersion }),
      ).rejects.toThrow();
    }
    vi.mocked(verifyWindowsRelease).mockRejectedValue(
      new Error("Changed file"),
    );
    await expect(
      recoverWindowsOperation({ layout, service, releaseVersion: version }),
    ).rejects.toThrow("Changed file");
    expect(executeWindowsServiceManager).not.toHaveBeenCalled();
  });

  it("propagates failed private-installation checks and failed recovery", async () => {
    service.assertPrivateInstallation.mockRejectedValueOnce(new Error("ACL"));
    await expect(recoverWindowsOperation({ layout, service })).rejects.toThrow(
      "ACL",
    );
    expect(verifyWindowsRelease).not.toHaveBeenCalled();
    vi.mocked(executeWindowsServiceManager).mockRejectedValueOnce(
      new Error("Journal"),
    );
    await expect(recoverWindowsOperation({ layout, service })).rejects.toThrow(
      "Journal",
    );
    expect(service.inspect).not.toHaveBeenCalled();
  });
});
