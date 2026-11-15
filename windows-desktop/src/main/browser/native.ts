import { lstat } from "node:fs/promises";
import { join, win32 } from "node:path";
import {
  createConsumerNativeTransport,
  WindowsConsumerNative,
  type ConsumerAccountAppPin,
  type ConsumerMutexLease,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  assertPackagedPublisher,
  readPackagedResource,
  readPostSignAppPin,
} from "./package-trust.js";
import type { HostContext } from "../host-context.js";
import { StoreNativeAuthority } from "./store-native.js";
async function boundedResource(path: string): Promise<Record<string, unknown>> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < 2 ||
    info.size > 1024
  )
    throw new Error("BROWSER_HOST_UNAVAILABLE");
  const value = parseStrictJson(
    new TextDecoder("utf-8", { fatal: true }).decode(
      await (path.endsWith("account-authority-manifest.json")
        ? readPostSignAppPin(path, 1024)
        : readPackagedResource(path, 1024)),
    ),
  ) as Record<string, unknown>;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.version !== 1
  )
    throw new Error("BROWSER_HOST_UNAVAILABLE");
  return value;
}
export async function loadBrowserAccountAppPin(
  resourcesRoot: string,
): Promise<ConsumerAccountAppPin> {
  const row = await boundedResource(
    join(resourcesRoot, "native", "account-authority-manifest.json"),
  );
  if (
    Object.keys(row).sort().join() !== "bytes,publisherSha256,sha256,version" ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.sha256) ||
    typeof row.publisherSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.publisherSha256) ||
    !Number.isSafeInteger(row.bytes) ||
    (row.bytes as number) < 1 ||
    (row.bytes as number) > 256 * 1024 ** 2
  )
    throw new Error("BROWSER_HOST_UNAVAILABLE");
  assertPackagedPublisher(row.publisherSha256);
  return {
    sha256: row.sha256,
    bytes: row.bytes as number,
    publisherSha256: row.publisherSha256,
  };
}
/** Small pinned app helper, available before a model or worker has ever been prepared. */
export async function openBrowserNative(
  host: Pick<HostContext, "identity">,
  resourcesRoot: string,
): Promise<WindowsConsumerNative> {
  const native = await openPinnedBrowserNative(resourcesRoot);
  try {
    const identity = await native.identity();
    if (
      identity.sid !== host.identity.sid ||
      identity.sessionId !== host.identity.sessionId
    )
      throw new Error("PEER_DENIED");
    return native;
  } catch (error) {
    await native.close();
    throw error;
  }
}
export async function openPinnedBrowserNative(
  resourcesRoot: string,
): Promise<WindowsConsumerNative> {
  if (
    (process as NodeJS.Process & { windowsStore?: boolean }).windowsStore ===
    true
  ) {
    const authority = await StoreNativeAuthority.open();
    try {
      if (
        win32.resolve(resourcesRoot).toLowerCase() !==
        win32
          .join(authority.receipt.package.installedLocation, "app", "resources")
          .toLowerCase()
      )
        throw new Error("BROWSER_HOST_UNAVAILABLE");
      return await authority.openGuiDataNative();
    } catch (error) {
      await authority.close();
      throw error;
    }
  }
  const row = await boundedResource(
    join(resourcesRoot, "native", "manifest.json"),
  );
  if (
    Object.keys(row).sort().join() !== "sha256,version" ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.sha256)
  )
    throw new Error("BROWSER_HOST_UNAVAILABLE");
  const native = new WindowsConsumerNative(
    await createConsumerNativeTransport(
      join(resourcesRoot, "native", "musicmute-native.exe"),
      row.sha256,
    ),
  );
  return native;
}
export type DesktopAccountAuthorityGate =
  | {
      state: "acquired";
      native: WindowsConsumerNative;
      lease: ConsumerMutexLease;
      close(): Promise<void>;
    }
  | { state: "same-session-existing"; owner: ConsumerProcessIdentity };

/** Injectable policy boundary; production supplies only a verified packaged helper. */
export async function acquireDesktopAccountAuthorityGate(
  native: WindowsConsumerNative,
): Promise<DesktopAccountAuthorityGate> {
  try {
    let lease: ConsumerMutexLease | null;
    try {
      lease = await native.acquireMutex("account");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "WINDOWS_SESSION_ALREADY_ACTIVE"
      )
        throw error;
      lease = null;
    }
    if (!lease) {
      const previous = await native.inspectSingletonOwner("account");
      if (previous.state !== "active" || !previous.sameSession)
        throw new Error("WINDOWS_SESSION_ALREADY_ACTIVE");
      await native.close();
      return { state: "same-session-existing", owner: previous.owner };
    }
    let closing: Promise<void> | undefined;
    return {
      state: "acquired",
      native,
      lease,
      close: () =>
        (closing ??= (async () => {
          try {
            await native.releaseMutex(lease);
          } finally {
            await native.close();
          }
        })()),
    };
  } catch (error) {
    await native.close().catch(() => {});
    throw error;
  }
}
/** Call before Electron instance forwarding, HostContext construction or account restore. */
export async function openDesktopAccountAuthorityGate(
  resourcesRoot: string,
): Promise<DesktopAccountAuthorityGate> {
  return acquireDesktopAccountAuthorityGate(
    await openPinnedBrowserNative(resourcesRoot),
  );
}
