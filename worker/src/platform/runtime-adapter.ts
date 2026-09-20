export type RuntimeProvider = "coreml" | "directml";
export type PlatformServiceKind = "launchd" | "windows-service";
export type CredentialProtection =
  "posix-owner-only" | "ntfs-local-service-acl";

export interface RuntimePlatformAdapter {
  id: "macos-arm64-coreml-v1" | "windows-x64-directml-v1";
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
    id: "macos-arm64-coreml-v1",
    platform: "darwin",
    arch: "arm64",
    provider: "coreml",
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

export function runtimePlatformAdapter(host: {
  platform: NodeJS.Platform;
  arch: string;
}): RuntimePlatformAdapter {
  const adapter = ADAPTERS.find(
    (candidate) =>
      candidate.platform === host.platform && candidate.arch === host.arch,
  );
  if (!adapter)
    throw new TypeError("Worker platform has no qualified runtime adapter");
  return adapter;
}
