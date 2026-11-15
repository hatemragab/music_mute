import { posix, win32 } from "node:path";
import type { ProviderId } from "./protocol.js";

export interface LocalPlatformDescriptor {
  readonly id: "macos-arm64" | "windows-x64";
  readonly platform: "darwin" | "win32";
  readonly architecture: "arm64" | "x64";
  readonly provider: "mps" | "directml";
  readonly providerId: Extract<ProviderId, "LOCAL_MACOS" | "LOCAL_WINDOWS">;
  readonly runtimeProfile: "macos-user" | "windows-user";
  readonly privateTransport: "unix-socket" | "named-pipe";
}
export interface LocalHostIdentity {
  platform: string;
  architecture: string;
  nativeArchitecture: string;
  osBuild?: number;
}
export function localPlatform(
  host: LocalHostIdentity,
): LocalPlatformDescriptor {
  if (
    host.platform === "darwin" &&
    host.architecture === "arm64" &&
    host.nativeArchitecture === "arm64"
  )
    return {
      id: "macos-arm64",
      platform: "darwin",
      architecture: "arm64",
      provider: "mps",
      providerId: "LOCAL_MACOS",
      runtimeProfile: "macos-user",
      privateTransport: "unix-socket",
    };
  if (
    host.platform === "win32" &&
    host.architecture === "x64" &&
    host.nativeArchitecture === "x64" &&
    Number.isInteger(host.osBuild) &&
    Number(host.osBuild) >= 19045
  )
    return {
      id: "windows-x64",
      platform: "win32",
      architecture: "x64",
      provider: "directml",
      providerId: "LOCAL_WINDOWS",
      runtimeProfile: "windows-user",
      privateTransport: "named-pipe",
    };
  throw new TypeError("UNSUPPORTED_PLATFORM");
}

/** Drive-local paths only. Native operations additionally validate handles/ACL/reparse points. */
export function safeWindowsAbsolutePath(value: string): boolean {
  if (
    !/^[a-zA-Z]:[\\/]/u.test(value) ||
    value.length > 32760 ||
    /[\p{Cc}\p{Cf}<>"|?*]/u.test(value)
  )
    return false;
  const canonical = value.replaceAll("/", "\\");
  if (!win32.isAbsolute(canonical) || canonical.slice(2).includes(":"))
    return false;
  const parts = canonical.slice(3).split("\\");
  if (parts.length === 1 && parts[0] === "") return true;
  return parts.every(
    (part) =>
      !!part &&
      part !== "." &&
      part !== ".." &&
      !/[. ]$/u.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part),
  );
}
export function desktopInputPathIsSafe(
  value: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32"
    ? safeWindowsAbsolutePath(value)
    : posix.isAbsolute(value) && !value.includes("\0");
}
export interface WindowsLocalPaths {
  root: string;
  workerRoot: string;
  cacheRoot: string;
  modelsRoot: string;
  logsRoot: string;
  runtimeRoot: string;
  chromeManifest: string;
}
export function windowsLocalPaths(localAppData: string): WindowsLocalPaths {
  if (!safeWindowsAbsolutePath(localAppData))
    throw new TypeError("INVALID_LOCAL_CONFIG");
  const root = win32.join(localAppData, "MusicMuteLocal");
  return {
    root,
    workerRoot: win32.join(localAppData, "MusicMuteWorker"),
    cacheRoot: win32.join(root, "cache"),
    modelsRoot: win32.join(root, "models"),
    logsRoot: win32.join(root, "logs"),
    runtimeRoot: win32.join(root, "runtime"),
    chromeManifest: win32.join(root, "integration", "com.musicmute.local.json"),
  };
}

/** Trusted adapter API. Browser/renderer contracts never contain these capabilities. */
export interface PersonalPlatformOperations {
  readonly descriptor: LocalPlatformDescriptor;
  assertPrivateDirectory(path: string): Promise<void>;
  assertPrivateFile(path: string): Promise<void>;
  processIdentity(pid: number): Promise<string | null>;
  terminateOwnedProcess(pid: number, expectedIdentity: string): Promise<void>;
  acquireLock(name: string, signal: AbortSignal): Promise<() => Promise<void>>;
}
