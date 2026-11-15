import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createConsumerNativeTransport,
  WindowsConsumerNative,
  sameConsumerProcess,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import { readPackagedResource } from "../browser/package-trust.js";
import { readPrivateBytes } from "../prepare/private-files.js";
import { parseReadyReceipt } from "../prepare/operations.js";
import { parseSessionAgentConfiguration } from "./bootstrap.js";
import { SessionClient, parseSessionTicket } from "./control.js";
import {
  prepareSessionActivation,
  type SessionActivationSnapshot,
  type SessionBootstrapReceipt,
} from "./activation.js";

async function manifest(
  path: string,
  keys: string[],
): Promise<Record<string, unknown>> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < 1 ||
    info.size > 1024
  )
    throw new Error("HELPER_INTEGRITY_INVALID");
  const value = JSON.parse(
    (await readPackagedResource(path, 1024)).toString("utf8"),
  ) as Record<string, unknown>;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join() ||
    value.version !== 1 ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256)
  )
    throw new Error("HELPER_INTEGRITY_INVALID");
  return value;
}
/** UI lifetime owns only its client helper. Cached readiness never republishes activation. */
export async function openDesktopSessionClient(
  host: HostContext,
  resourcesRoot: string,
  options: { launchIfAbsent?: boolean } = {},
): Promise<{
  client: SessionClient;
  native: WindowsConsumerNative;
  launcher: { sha256: string; bytes: number };
  close(): Promise<void>;
}> {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("UNSUPPORTED_HOST");
  const helper = await manifest(
    join(resourcesRoot, "native", "manifest.json"),
    ["version", "sha256"],
  );
  const launcher = await manifest(
    join(resourcesRoot, "native", "launcher-manifest.json"),
    ["version", "sha256", "bytes"],
  );
  if (
    !Number.isSafeInteger(launcher.bytes) ||
    (launcher.bytes as number) < 1 ||
    (launcher.bytes as number) > 16 * 1024 * 1024
  )
    throw new Error("HELPER_INTEGRITY_INVALID");
  const native = new WindowsConsumerNative(
    await createConsumerNativeTransport(
      join(resourcesRoot, "native", "musicmute-native.exe"),
      helper.sha256 as string,
    ),
  );
  try {
    const identity = await native.identity();
    if (
      identity.sid !== host.identity.sid ||
      identity.sessionId !== host.identity.sessionId
    )
      throw new Error("SESSION_IDENTITY_CONFLICT");
    await native.verifySessionLauncher(
      launcher.sha256 as string,
      launcher.bytes as number,
    );
    const receiptBytes = await native.vaultRead("fleet", "agent_bootstrap");
    if (!receiptBytes) throw new Error("PREPARE_REQUIRED");
    let receipt: SessionBootstrapReceipt;
    try {
      receipt = JSON.parse(
        receiptBytes.toString("utf8"),
      ) as SessionBootstrapReceipt;
      if (
        Object.keys(receipt).sort().join() !==
          [
            "version",
            "installationProfile",
            "sid",
            "release",
            "configSha256",
            "nodeSha256",
            "agentSha256",
            "nativeSha256",
            "launcherSha256",
          ]
            .sort()
            .join() ||
        receipt.version !== 1 ||
        receipt.installationProfile !== "windows-user" ||
        receipt.sid !== identity.sid ||
        receipt.launcherSha256 !== launcher.sha256 ||
        [
          receipt.release,
          receipt.configSha256,
          receipt.nodeSha256,
          receipt.agentSha256,
          receipt.nativeSha256,
        ].some(
          (hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash),
        )
      )
        throw new Error("SESSION_INTEGRITY_INVALID");
    } finally {
      receiptBytes.fill(0);
    }
    const configBytes = await readPrivateBytes(
      host,
      "consumer-config.json",
      16384,
    );
    const configuration = parseSessionAgentConfiguration(
      JSON.parse(configBytes.toString("utf8")),
    );
    if (
      createHash("sha256").update(configBytes).digest("hex") !==
        receipt.configSha256 ||
      configuration.release !== receipt.release
    )
      throw new Error("SESSION_INTEGRITY_INVALID");
    const running = async () => {
      const bytes = await native.vaultRead("fleet", "session_ticket");
      if (!bytes) return false;
      try {
        const ticket = parseSessionTicket(JSON.parse(bytes.toString("utf8")));
        const current = await native.processIdentity(ticket.owner.identity.pid);
        return (
          ticket.owner.identity.sid === identity.sid &&
          ticket.owner.identity.sessionId === identity.sessionId &&
          current !== null &&
          sameConsumerProcess(current, ticket.owner.identity)
        );
      } catch {
        return false;
      } finally {
        bytes.fill(0);
      }
    };
    if (!(await running())) {
      if (options.launchIfAbsent === false)
        throw new Error("SESSION_UNAVAILABLE");
      // Existing authenticated controls remain reachable without GPU readiness.
      // A new authority must still have strict current-witness Ready before launch.
      const readyBytes = await native.vaultRead("account", "ready_receipt");
      if (!readyBytes) throw new Error("PREPARE_REQUIRED");
      try {
        const value = JSON.parse(readyBytes.toString("utf8")) as {
          target: string;
        };
        const ready = parseReadyReceipt(
          value,
          {
            sid: identity.sid,
            identity: value.target,
          },
          await native.bootIdentity(),
        ).receipt;
        if (
          ready.release !== receipt.release ||
          ready.release !== configuration.release
        )
          throw new Error("SESSION_INTEGRITY_INVALID");
      } finally {
        readyBytes.fill(0);
      }
      await native.launchSessionAgent(launcher.sha256 as string);
    }
    const until = Date.now() + 30000;
    while (!(await running())) {
      if (Date.now() >= until) throw new Error("SESSION_UNAVAILABLE");
      await delay(100);
    }
    const eventHelpers = new Set<WindowsConsumerNative>();
    const client = new SessionClient(native, async () => {
      const eventHelper = new WindowsConsumerNative(
        await createConsumerNativeTransport(
          join(resourcesRoot, "native", "musicmute-native.exe"),
          helper.sha256 as string,
        ),
      );
      eventHelpers.add(eventHelper);
      return eventHelper;
    });
    // Establish the actual authority response; a CreateProcess success is not readiness.
    const authority = await client.command({
      version: 1,
      request_id: randomUUID(),
      action: "status",
    });
    if (authority.release !== configuration.release)
      throw new Error("SESSION_INTEGRITY_INVALID");
    return {
      client,
      native,
      launcher: {
        sha256: launcher.sha256 as string,
        bytes: launcher.bytes as number,
      },
      close: async () => {
        await Promise.allSettled(
          [...eventHelpers].map((helper) => helper.close()),
        );
        await native.close();
      },
    };
  } catch (error) {
    await native.close();
    throw error;
  }
}

/** Explicit Prepare/repair activation. Ordinary cached launches never enter this path. */
export async function activateDesktopSession(
  host: HostContext,
  resourcesRoot: string,
  snapshot: SessionActivationSnapshot,
): Promise<void> {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("UNSUPPORTED_HOST");
  const helper = await manifest(
      join(resourcesRoot, "native", "manifest.json"),
      ["version", "sha256"],
    ),
    launcher = await manifest(
      join(resourcesRoot, "native", "launcher-manifest.json"),
      ["version", "sha256", "bytes"],
    );
  if (
    !Number.isSafeInteger(launcher.bytes) ||
    (launcher.bytes as number) < 1 ||
    (launcher.bytes as number) > 16 * 1024 * 1024
  )
    throw new Error("HELPER_INTEGRITY_INVALID");
  const native = new WindowsConsumerNative(
    await createConsumerNativeTransport(
      join(resourcesRoot, "native", "musicmute-native.exe"),
      helper.sha256 as string,
    ),
  );
  try {
    const identity = await native.identity();
    if (
      identity.sid !== host.identity.sid ||
      identity.sessionId !== host.identity.sessionId
    )
      throw new Error("SESSION_IDENTITY_CONFLICT");
    await prepareSessionActivation(host, snapshot, {
      native,
      launcher: {
        sha256: launcher.sha256 as string,
        bytes: launcher.bytes as number,
      },
      registerStartup: true,
      publicResourcesRoot: resourcesRoot,
    });
  } finally {
    await native.close();
  }
}
