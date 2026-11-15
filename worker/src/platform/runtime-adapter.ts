export type RuntimeProvider = "mps" | "directml";
export type RuntimeProfile = "legacy-service" | "windows-user";
export type PlatformServiceKind =
  "launchd" | "windows-service" | "windows-login-session";
export type CredentialProtection =
  "posix-owner-only" | "ntfs-local-service-acl" | "ntfs-current-user-acl";

export interface RuntimePlatformAdapter {
  id:
    | "macos-arm64-mps-v1"
    | "windows-x64-directml-v1"
    | "windows-x64-user-directml-v1";
  platform: NodeJS.Platform;
  arch: "arm64" | "x64";
  provider: RuntimeProvider;
  serviceKind: PlatformServiceKind;
  credentialProtection: CredentialProtection;
  credentialModeIsSafe(mode: number): boolean;
  deviceIdIsSafe(deviceId: number | undefined): boolean;
}

const ADAPTERS: readonly RuntimePlatformAdapter[] = [
  {
    id: "macos-arm64-mps-v1",
    platform: "darwin",
    arch: "arm64",
    provider: "mps",
    serviceKind: "launchd",
    credentialProtection: "posix-owner-only",
    credentialModeIsSafe: (mode) => (mode & 0o077) === 0,
    deviceIdIsSafe: (deviceId) => deviceId === undefined,
  },
  {
    id: "windows-x64-directml-v1",
    platform: "win32",
    arch: "x64",
    provider: "directml",
    serviceKind: "windows-service",
    credentialProtection: "ntfs-local-service-acl",
    credentialModeIsSafe: () => true,
    deviceIdIsSafe: (deviceId) => deviceId === 0,
  },
];

export function runtimePlatformAdapter(
  host: {
    platform: NodeJS.Platform;
    arch: string;
  },
  runtimeProfile: RuntimeProfile = "legacy-service",
): RuntimePlatformAdapter {
  if (runtimeProfile === "windows-user") {
    if (host.platform !== "win32" || host.arch !== "x64")
      throw new TypeError(
        "Worker platform has no qualified user runtime adapter",
      );
    return {
      id: "windows-x64-user-directml-v1",
      platform: "win32",
      arch: "x64",
      provider: "directml",
      serviceKind: "windows-login-session",
      credentialProtection: "ntfs-current-user-acl",
      credentialModeIsSafe: () => true, // Native SID/ACL validation is required.
      deviceIdIsSafe: (deviceId) =>
        Number.isInteger(deviceId) &&
        deviceId !== undefined &&
        deviceId >= 0 &&
        deviceId <= 15,
    };
  }
  if (runtimeProfile !== "legacy-service")
    throw new TypeError("Worker runtime profile is unsupported");
  const adapter = ADAPTERS.find(
    (candidate) =>
      candidate.platform === host.platform && candidate.arch === host.arch,
  );
  if (!adapter)
    throw new TypeError("Worker platform has no qualified runtime adapter");
  return adapter;
}
