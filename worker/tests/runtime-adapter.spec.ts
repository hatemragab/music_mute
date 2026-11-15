import { describe, expect, it } from "vitest";
import { runtimePlatformAdapter } from "../src/platform/runtime-adapter.js";

describe("qualified runtime platform adapters", () => {
  it("maps macOS ARM64 to MPS, launchd and owner-only credentials", () => {
    const adapter = runtimePlatformAdapter({
      platform: "darwin",
      arch: "arm64",
    });
    expect(adapter).toMatchObject({
      id: "macos-arm64-mps-v1",
      provider: "mps",
      serviceKind: "launchd",
      credentialProtection: "posix-owner-only",
    });
    expect(adapter.credentialModeIsSafe(0o100600)).toBe(true);
    expect(adapter.credentialModeIsSafe(0o100640)).toBe(false);
    expect(adapter.deviceIdIsSafe(undefined)).toBe(true);
    expect(adapter.deviceIdIsSafe(0)).toBe(false);
  });

  it("maps Windows x64 to DirectML adapter 0 and LocalService ACLs", () => {
    const adapter = runtimePlatformAdapter({
      platform: "win32",
      arch: "x64",
    });
    expect(adapter).toMatchObject({
      id: "windows-x64-directml-v1",
      provider: "directml",
      serviceKind: "windows-service",
      credentialProtection: "ntfs-local-service-acl",
    });
    expect(adapter.deviceIdIsSafe(0)).toBe(true);
    expect(adapter.deviceIdIsSafe(undefined)).toBe(false);
    expect(adapter.deviceIdIsSafe(1)).toBe(false);
  });

  it("keeps Linux, CUDA, MIGraphX and unqualified architectures disabled", () => {
    expect(() =>
      runtimePlatformAdapter({ platform: "linux", arch: "x64" }),
    ).toThrow("no qualified runtime adapter");
    expect(() =>
      runtimePlatformAdapter({ platform: "darwin", arch: "x64" }),
    ).toThrow("no qualified runtime adapter");
    expect(() =>
      runtimePlatformAdapter({ platform: "win32", arch: "arm64" }),
    ).toThrow("no qualified runtime adapter");
  });

  it("requires an explicit Windows user profile for selected GPU ordinals and user credentials", () => {
    const adapter = runtimePlatformAdapter(
      { platform: "win32", arch: "x64" },
      "windows-user",
    );
    expect(adapter).toMatchObject({
      id: "windows-x64-user-directml-v1",
      serviceKind: "windows-login-session",
      credentialProtection: "ntfs-current-user-acl",
    });
    expect(adapter.deviceIdIsSafe(0)).toBe(true);
    expect(adapter.deviceIdIsSafe(3)).toBe(true);
    for (const value of [undefined, -1, 16, 0.5, NaN])
      expect(adapter.deviceIdIsSafe(value)).toBe(false);
    for (const host of [
      { platform: "win32" as const, arch: "arm64" },
      { platform: "darwin" as const, arch: "arm64" },
    ])
      expect(() => runtimePlatformAdapter(host, "windows-user")).toThrow(
        "no qualified user runtime adapter",
      );
  });
});
