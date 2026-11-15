import { PACKAGE_DATA_ROOT_NAMES } from "../../shared/package-build-profile.js";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import {
  createConsumerNativeTransport,
  WindowsConsumerNative,
  sameConsumerProcess,
  type ConsumerOwnedRole,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { SessionRole } from "../../shared/session-contracts.js";
import type { SessionNativePort } from "./supervisor.js";
import { SessionPreparationGate } from "./preparation-gate.js";
import { validateSessionBackendOrigin } from "./backend-origin.js";
import type {
  SessionAgentConfiguration,
  SessionChildContext,
  SessionRuntimeContext,
} from "./context.js";

const HASH = /^[a-f0-9]{64}$/u;
const FIXED_FILES = [
  "runtime/node/node.exe",
  "runtime/native/musicmute-native.exe",
  "agent/session-agent.cjs",
  "agent/personal.cjs",
  "agent/fleet.cjs",
];
function equalPath(first: string, second: string): boolean {
  return (
    win32.resolve(first).toLowerCase() === win32.resolve(second).toLowerCase()
  );
}
async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < 1 ||
    info.size > limit
  )
    throw new Error("SESSION_INTEGRITY_INVALID");
  const bytes = await readFile(path);
  if (bytes.length !== info.size) throw new Error("SESSION_INTEGRITY_INVALID");
  return bytes;
}
export function parseSessionAgentConfiguration(
  value: unknown,
): SessionAgentConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SESSION_CONFIG_INVALID");
  const row = value as SessionAgentConfiguration;
  if (
    Object.keys(row).sort().join() !==
      [
        "version",
        "kind",
        "installationProfile",
        "release",
        "releaseRoot",
        "nativeSha256",
        "personalRoot",
        "fleetRoot",
        "launchFiles",
        ...(Object.hasOwn(row, "backendOrigin") ? ["backendOrigin"] : []),
      ]
        .sort()
        .join() ||
    row.version !== 1 ||
    row.kind !== "session-agent" ||
    row.installationProfile !== "windows-user" ||
    !HASH.test(row.release) ||
    !HASH.test(row.nativeSha256) ||
    typeof row.personalRoot !== "string" ||
    typeof row.fleetRoot !== "string" ||
    typeof row.releaseRoot !== "string" ||
    !equalPath(
      row.releaseRoot,
      win32.join(row.personalRoot, "runtime", "releases", row.release),
    ) ||
    !row.launchFiles ||
    typeof row.launchFiles !== "object" ||
    Array.isArray(row.launchFiles) ||
    Object.keys(row.launchFiles).sort().join() !==
      [...FIXED_FILES].sort().join() ||
    Object.values(row.launchFiles).some((hash) => !HASH.test(hash)) ||
    row.launchFiles["runtime/native/musicmute-native.exe"] !== row.nativeSha256
  )
    throw new Error("SESSION_CONFIG_INVALID");
  if (Object.hasOwn(row, "backendOrigin"))
    validateSessionBackendOrigin(row.backendOrigin);
  return structuredClone(row);
}
/** Only small binaries and role configuration are read; the qualified model is not hashed at login. */
export async function openSessionRuntimeContext(configPath: string): Promise<
  SessionRuntimeContext & {
    sessionNative: SessionNativePort;
    completeStartup(): Promise<void>;
    close(): Promise<void>;
  }
> {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("SESSION_CONTEXT_INVALID");
  const configuration = parseSessionAgentConfiguration(
    JSON.parse((await boundedFile(configPath, 16384)).toString("utf8")),
  );
  if (
    !equalPath(
      configPath,
      win32.join(configuration.personalRoot, "consumer-config.json"),
    ) ||
    !equalPath(
      process.execPath,
      win32.join(configuration.releaseRoot, "runtime", "node", "node.exe"),
    ) ||
    !equalPath(
      process.argv[1] ?? "",
      win32.join(configuration.releaseRoot, "agent", "session-agent.cjs"),
    )
  )
    throw new Error("SESSION_CONTEXT_INVALID");
  const helpers = new Set<WindowsConsumerNative>();
  const guardians = new Map<SessionRole, WindowsConsumerNative>();
  const helperPath = win32.join(
    configuration.releaseRoot,
    "runtime",
    "native",
    "musicmute-native.exe",
  );
  let closed = false;
  let singleton: Awaited<ReturnType<WindowsConsumerNative["acquireMutex"]>> =
    null;
  const verifyFile = async (path: string) => {
    const hash = configuration.launchFiles[path];
    if (!hash) throw new Error("SESSION_INTEGRITY_INVALID");
    const bytes = await boundedFile(
      win32.join(configuration.releaseRoot, ...path.split("/")),
      256 * 1024 * 1024,
    );
    if (createHash("sha256").update(bytes).digest("hex") !== hash)
      throw new Error("SESSION_INTEGRITY_INVALID");
  };
  const verify = async (role: ConsumerOwnedRole, release: string) => {
    if (
      (role !== "personal" && role !== "fleet") ||
      release !== configuration.release
    )
      throw new Error("SESSION_CONTEXT_INVALID");
    await verifyFile("runtime/node/node.exe");
    await verifyFile(`agent/${role}.cjs`);
    await native.validatePath(
      role === "fleet" ? "fleet" : "personal",
      role === "fleet" ? "consumer-config.json" : "personal-config.json",
      "file",
    );
  };
  const openNative = async () => {
    if (closed) throw new Error("SESSION_UNAVAILABLE");
    const helper = new WindowsConsumerNative(
      await createConsumerNativeTransport(
        helperPath,
        configuration.nativeSha256,
      ),
      { verify },
    );
    helpers.add(helper);
    helper.onClosed(() => {
      helpers.delete(helper);
    });
    return helper;
  };
  const native = await openNative();
  const preparationGate = new SessionPreparationGate(native);
  try {
    const identity = await native.identity();
    // SID-wide gate must precede configuration publication by role factories or
    // session ticket intake. A second same-SID logon never overwrites the first.
    singleton = await native.acquireMutex("session");
    if (!singleton) throw new Error("WINDOWS_SESSION_ALREADY_ACTIVE");
    await preparationGate.beginStartup();
    if (
      !equalPath(
        configuration.personalRoot,
        win32.join(identity.localAppData, PACKAGE_DATA_ROOT_NAMES.personal),
      ) ||
      !equalPath(
        configuration.fleetRoot,
        win32.join(identity.localAppData, PACKAGE_DATA_ROOT_NAMES.fleet),
      )
    )
      throw new Error("SESSION_CONTEXT_INVALID");
    await native.validatePath("personal", "consumer-config.json", "file");
    // Protect the boot configuration with a DPAPI receipt written only after verified activation.
    const protectedConfig = await native.vaultRead("fleet", "agent_bootstrap");
    if (!protectedConfig) throw new Error("SESSION_INTEGRITY_INVALID");
    try {
      const receipt = JSON.parse(protectedConfig.toString("utf8")) as {
        version?: number;
        configSha256?: string;
        release?: string;
      };
      if (
        receipt.version !== 1 ||
        receipt.release !== configuration.release ||
        receipt.configSha256 !==
          createHash("sha256")
            .update(await boundedFile(configPath, 16384))
            .digest("hex")
      )
        throw new Error("SESSION_INTEGRITY_INVALID");
    } finally {
      protectedConfig.fill(0);
    }
    await verifyFile("runtime/node/node.exe");
    await verifyFile("agent/session-agent.cjs");
    const guardian = async (role: SessionRole) => {
      let helper = guardians.get(role);
      if (!helper) {
        helper = await openNative();
        guardians.set(role, helper);
      }
      return helper;
    };
    const close = async () => {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled(
        [...helpers].map((helper) => helper.close()),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("CHILD_SHUTDOWN_PENDING");
    };
    return {
      configuration,
      completeStartup: () => preparationGate.completeStartup(),
      native,
      openNative,
      guardian,
      close,
      verifyOwnedPeer: async (owner, peer) => {
        if (
          (owner.role !== "personal" && owner.role !== "fleet") ||
          !(await (await guardian(owner.role)).isOwnedProcess(owner, peer))
        )
          throw new Error("GPU_OWNER_DENIED");
      },
      sessionNative: {
        identity: () => native.identity(),
        acquireSessionLock: async () => {
          singleton ??= await native.acquireMutex("session");
          if (!singleton) throw new Error("SESSION_IDENTITY_CONFLICT");
          return singleton;
        },
        releaseSessionLock: async (nonce) => {
          if (!singleton || singleton.nonce !== nonce)
            throw new Error("SESSION_IDENTITY_CONFLICT");
          await native.releaseMutex(singleton);
          singleton = null;
        },
        processIdentity: (pid) => native.processIdentity(pid),
        launchOwned: async (role, release) =>
          preparationGate.launch(async () =>
            (await guardian(role)).launchOwned(role, release),
          ),
        stopOwned: async (owner) => {
          if (owner.role !== "personal" && owner.role !== "fleet")
            throw new Error("SESSION_IDENTITY_CONFLICT");
          await (await guardian(owner.role)).stopOwned(owner);
        },
        ownedTreeExited: (owner) => native.ownedTreeExited(owner),
        inspectStartup: () => native.inspectStartup(),
        legacyWorkerConflict: () => native.legacyWorkerConflict(),
        close: async () => {
          await Promise.allSettled(
            [...guardians.values()].map((guardian) => guardian.close()),
          );
          await native.close();
        },
      },
    };
  } catch (error) {
    closed = true;
    await Promise.allSettled([...helpers].map((helper) => helper.close()));
    throw error;
  }
}

/** Capture and erase the parent-only role nonce before importing runtime/tool modules. */
export async function openSessionChildContext(
  configPath: string,
  role: SessionRole,
): Promise<SessionChildContext> {
  const nonce = process.env.MUSICMUTE_OWNERSHIP_NONCE,
    actualRole = process.env.MUSICMUTE_OWNERSHIP_ROLE;
  delete process.env.MUSICMUTE_OWNERSHIP_NONCE;
  delete process.env.MUSICMUTE_OWNERSHIP_ROLE;
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    actualRole !== role ||
    !nonce ||
    !HASH.test(nonce)
  )
    throw new Error("SESSION_CONTEXT_INVALID");
  const config = JSON.parse(
    (await boundedFile(configPath, 16384)).toString("utf8"),
  ) as Record<string, unknown>;
  if (
    config.version !== 1 ||
    config.kind !== role ||
    config.installationProfile !== "windows-user" ||
    typeof config.releaseRoot !== "string" ||
    typeof config.personalRoot !== "string" ||
    typeof config.nativeSha256 !== "string" ||
    !HASH.test(config.nativeSha256)
  )
    throw new Error("SESSION_CONFIG_INVALID");
  const releaseRoot = config.releaseRoot,
    personalRoot = config.personalRoot,
    fleetRoot =
      typeof config.fleetRoot === "string"
        ? config.fleetRoot
        : win32.join(
            win32.dirname(personalRoot),
            PACKAGE_DATA_ROOT_NAMES.fleet,
          );
  if (
    !equalPath(
      process.execPath,
      win32.join(releaseRoot, "runtime", "node", "node.exe"),
    ) ||
    !equalPath(
      process.argv[1] ?? "",
      win32.join(releaseRoot, "agent", `${role}.cjs`),
    ) ||
    !equalPath(
      configPath,
      win32.join(
        role === "fleet" ? fleetRoot : personalRoot,
        role === "fleet" ? "consumer-config.json" : "personal-config.json",
      ),
    )
  )
    throw new Error("SESSION_CONTEXT_INVALID");
  const openNative = async () =>
    new WindowsConsumerNative(
      await createConsumerNativeTransport(
        win32.join(releaseRoot, "runtime", "native", "musicmute-native.exe"),
        config.nativeSha256 as string,
      ),
    );
  const native = await openNative();
  try {
    const host = await native.identity(),
      ownerIdentity = await native.processIdentity(process.pid);
    if (
      !ownerIdentity ||
      !sameConsumerProcess(
        {
          ...host,
          pid: ownerIdentity.pid,
          creationTime: ownerIdentity.creationTime,
        },
        ownerIdentity,
      ) ||
      !equalPath(
        personalRoot,
        win32.join(host.localAppData, PACKAGE_DATA_ROOT_NAMES.personal),
      ) ||
      !equalPath(
        fleetRoot,
        win32.join(host.localAppData, PACKAGE_DATA_ROOT_NAMES.fleet),
      )
    )
      throw new Error("SESSION_CONTEXT_INVALID");
    await native.validatePath(
      role === "fleet" ? "fleet" : "personal",
      role === "fleet" ? "consumer-config.json" : "personal-config.json",
      "file",
    );
    await native.bindOwnedRole({ role, nonce, identity: ownerIdentity });
    return {
      releaseRoot,
      personalRoot,
      fleetRoot,
      role,
      ownershipNonce: nonce,
      native,
      ownerIdentity,
      openNative,
    };
  } catch (error) {
    await native.close();
    throw error;
  }
}
