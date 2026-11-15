export interface HostIdentity {
  platform: string;
  processArchitecture: string;
  nativeArchitecture: string;
  osBuild: number;
}
export type HostSupport =
  | { supported: true }
  | {
      supported: false;
      reason:
        "WINDOWS_REQUIRED" | "X64_REQUIRED" | "WINDOWS_VERSION_UNSUPPORTED";
    };
export function checkHostSupport(host: HostIdentity): HostSupport {
  if (host.platform !== "win32")
    return { supported: false, reason: "WINDOWS_REQUIRED" };
  if (host.processArchitecture !== "x64" || host.nativeArchitecture !== "x64")
    return { supported: false, reason: "X64_REQUIRED" };
  if (!Number.isInteger(host.osBuild) || host.osBuild < 19045)
    return { supported: false, reason: "WINDOWS_VERSION_UNSUPPORTED" };
  return { supported: true };
}
