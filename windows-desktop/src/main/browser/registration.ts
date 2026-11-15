import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  createConsumerNativeTransport,
  WindowsConsumerNative,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import { readPackagedResource } from "./package-trust.js";
import {
  registerStoreBrowserIntegration,
  removeStoreBrowserIntegration,
  verifyStoreBrowserIntegration,
} from "./store-registration.js";
export interface BrowserIntegrationManifest {
  version: 1;
  extensionId: string;
  hostSha256: string;
  hostBytes: number;
  entrySha256: string;
  entryBytes: number;
}
const HASH = /^[a-f0-9]{64}$/u;
async function readBounded(path: string, max: number): Promise<Buffer> {
  if (process.platform === "win32" && process.windowsStore === true)
    return readPackagedResource(path, max);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < 1 ||
    info.size > max
  )
    throw new Error("BROWSER_HOST_UNAVAILABLE");
  const bytes = await readPackagedResource(path, max);
  if (bytes.length !== info.size) throw new Error("BROWSER_HOST_UNAVAILABLE");
  return bytes;
}
export function extensionIdFromManifest(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("BROWSER_HOST_UNAVAILABLE");
  const row = value as Record<string, unknown>;
  if (
    row.manifest_version !== 3 ||
    typeof row.key !== "string" ||
    !/^[A-Za-z0-9+/=]+$/u.test(row.key)
  )
    throw new Error("BROWSER_HOST_UNAVAILABLE");
  const key = Buffer.from(row.key, "base64");
  if (
    key.length < 128 ||
    key.length > 4096 ||
    key.toString("base64") !== row.key
  )
    throw new Error("BROWSER_HOST_UNAVAILABLE");
  return Array.from(
    createHash("sha256").update(key).digest("hex").slice(0, 32),
    (hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)),
  ).join("");
}
export async function loadBrowserIntegrationManifest(
  resourcesRoot: string,
): Promise<BrowserIntegrationManifest> {
  const row = JSON.parse(
    (
      await readBounded(
        join(resourcesRoot, "native", "browser-manifest.json"),
        4096,
      )
    ).toString("utf8"),
  ) as BrowserIntegrationManifest;
  const extension = JSON.parse(
    (
      await readBounded(
        join(resourcesRoot, "extension", "manifest.json"),
        32768,
      )
    ).toString("utf8"),
  );
  if (
    !row ||
    typeof row !== "object" ||
    Object.keys(row).sort().join() !==
      "entryBytes,entrySha256,extensionId,hostBytes,hostSha256,version" ||
    row.version !== 1 ||
    row.extensionId !== extensionIdFromManifest(extension) ||
    !HASH.test(row.hostSha256) ||
    !HASH.test(row.entrySha256) ||
    !Number.isSafeInteger(row.hostBytes) ||
    row.hostBytes < 1 ||
    row.hostBytes > 16 * 1024 * 1024 ||
    !Number.isSafeInteger(row.entryBytes) ||
    row.entryBytes < 1 ||
    row.entryBytes > 32 * 1024 * 1024
  )
    throw new Error("BROWSER_HOST_UNAVAILABLE");
  const entry = await readBounded(
    join(resourcesRoot, "native", "browser-host.cjs"),
    32 * 1024 * 1024,
  );
  if (
    entry.length !== row.entryBytes ||
    createHash("sha256").update(entry).digest("hex") !== row.entrySha256
  )
    throw new Error("BROWSER_HOST_UNAVAILABLE");
  return structuredClone(row);
}
async function openNative(
  resourcesRoot: string,
): Promise<WindowsConsumerNative> {
  const row = JSON.parse(
    (
      await readBounded(join(resourcesRoot, "native", "manifest.json"), 1024)
    ).toString("utf8"),
  ) as { version: number; sha256: string };
  if (
    !row ||
    Object.keys(row).sort().join() !== "sha256,version" ||
    row.version !== 1 ||
    !HASH.test(row.sha256)
  )
    throw new Error("BROWSER_HOST_UNAVAILABLE");
  return new WindowsConsumerNative(
    await createConsumerNativeTransport(
      join(resourcesRoot, "native", "musicmute-native.exe"),
      row.sha256,
    ),
  );
}
export async function registerBrowserIntegration(
  host: HostContext,
  resourcesRoot: string,
): Promise<boolean> {
  if (host.storeAuthority)
    return registerStoreBrowserIntegration(host.storeAuthority);
  if (
    (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore ===
    true
  )
    throw new Error("STORE_AUTHORITY_DENIED");
  const manifest = await loadBrowserIntegrationManifest(resourcesRoot),
    native = await openNative(resourcesRoot);
  try {
    const identity = await native.identity();
    if (
      identity.sid !== host.identity.sid ||
      identity.sessionId !== host.identity.sessionId
    )
      throw new Error("BROWSER_HOST_UNAVAILABLE");
    await native.registerBrowser(manifest);
    return true;
  } finally {
    await native.close();
  }
}
export async function removeBrowserIntegration(
  host: HostContext,
  resourcesRoot: string,
): Promise<void> {
  if (host.storeAuthority)
    return removeStoreBrowserIntegration(host.storeAuthority);
  if (
    (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore ===
    true
  )
    throw new Error("STORE_AUTHORITY_DENIED");
  const native = await openNative(resourcesRoot);
  try {
    const identity = await native.identity();
    if (
      identity.sid !== host.identity.sid ||
      identity.sessionId !== host.identity.sessionId
    )
      throw new Error("BROWSER_HOST_UNAVAILABLE");
    await native.unregisterBrowser();
  } finally {
    await native.close();
  }
}
/** Read-only registration/binary binding check; this does not bypass browser policy or prove a Chrome handshake. */
export async function verifyBrowserIntegration(
  host: HostContext,
  resourcesRoot: string,
): Promise<boolean> {
  if (host.storeAuthority)
    return verifyStoreBrowserIntegration(host.storeAuthority);
  if (
    (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore ===
    true
  )
    return false;
  try {
    const metadata = await loadBrowserIntegrationManifest(resourcesRoot),
      native = await openNative(resourcesRoot);
    try {
      const identity = await native.identity();
      if (
        identity.sid !== host.identity.sid ||
        identity.sessionId !== host.identity.sessionId
      )
        return false;
      return await native.verifyBrowser(metadata);
    } finally {
      await native.close();
    }
  } catch {
    return false;
  }
}
