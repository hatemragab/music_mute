import { PACKAGE_DATA_ROOT_NAMES } from "../../shared/package-build-profile.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { verifyWindowsRelease } from "../../../../worker/src/platform/windows/release-manifest.js";
import type { WindowsConsumerNative } from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import { writePrivateAtomic } from "../prepare/private-files.js";
import { parseSessionAgentConfiguration } from "./bootstrap.js";
import type { SessionAgentConfiguration } from "./context.js";
import { loadSessionBackendOrigin } from "./backend-origin.js";
import { publishWorkerLoginCapsule } from "./login-capsule.js";

export interface SessionActivationSnapshot {
  release: string;
  releaseRoot: string;
  manifestSha256: string;
  nativeSha256: string;
}
export interface SessionBootstrapReceipt {
  version: 1;
  installationProfile: "windows-user";
  sid: string;
  release: string;
  configSha256: string;
  nodeSha256: string;
  agentSha256: string;
  nativeSha256: string;
  launcherSha256: string;
}
/** Call after signed archive activation, before enabling login startup or launching the independent agent. */
export async function prepareSessionActivation(
  host: HostContext,
  snapshot: SessionActivationSnapshot,
  options: {
    native: WindowsConsumerNative;
    launcher: { sha256: string; bytes: number };
    registerStartup?: boolean;
    publicResourcesRoot?: string;
  },
): Promise<{
  configuration: SessionAgentConfiguration;
  receipt: SessionBootstrapReceipt;
  startup: string;
}> {
  if (
    !/^[a-f0-9]{64}$/u.test(options.launcher.sha256) ||
    !Number.isSafeInteger(options.launcher.bytes) ||
    options.launcher.bytes < 1 ||
    options.launcher.bytes > 16 * 1024 * 1024 ||
    win32.resolve(snapshot.releaseRoot).toLowerCase() !==
      win32
        .join(host.personalRoot, "runtime", "releases", snapshot.release)
        .toLowerCase()
  )
    throw new Error("SESSION_INTEGRITY_INVALID");
  const manifest = await verifyWindowsRelease(
    snapshot.releaseRoot,
    "windows-user",
  );
  if (
    createHash("sha256")
      .update(
        await readFile(
          win32.join(snapshot.releaseRoot, "release-manifest.json"),
        ),
      )
      .digest("hex") !== snapshot.manifestSha256
  )
    throw new Error("SESSION_INTEGRITY_INVALID");
  const launchFiles: Record<string, string> = {};
  for (const path of [
    "runtime/node/node.exe",
    "runtime/native/musicmute-native.exe",
    "agent/session-agent.cjs",
    "agent/personal.cjs",
    "agent/fleet.cjs",
  ]) {
    const entry = manifest.entries.find(
      (entry) => entry.kind === "file" && entry.path === path,
    );
    if (entry?.kind !== "file") throw new Error("SESSION_INTEGRITY_INVALID");
    launchFiles[path] = entry.sha256;
  }
  if (
    launchFiles["runtime/native/musicmute-native.exe"] !== snapshot.nativeSha256
  )
    throw new Error("SESSION_INTEGRITY_INVALID");
  await options.native.verifySessionLauncher(
    options.launcher.sha256,
    options.launcher.bytes,
  );
  const backendOrigin = options.publicResourcesRoot
    ? await loadSessionBackendOrigin(options.publicResourcesRoot)
    : undefined;
  const configuration = parseSessionAgentConfiguration({
    version: 1,
    kind: "session-agent",
    installationProfile: "windows-user",
    release: snapshot.release,
    releaseRoot: snapshot.releaseRoot,
    nativeSha256: snapshot.nativeSha256,
    personalRoot: host.personalRoot,
    fleetRoot: win32.join(
      host.identity.localAppData,
      PACKAGE_DATA_ROOT_NAMES.fleet,
    ),
    launchFiles,
    ...(backendOrigin ? { backendOrigin } : {}),
  });
  const bytes = Buffer.from(JSON.stringify(configuration));
  const receipt: SessionBootstrapReceipt = {
    version: 1,
    installationProfile: "windows-user",
    sid: host.identity.sid,
    release: snapshot.release,
    configSha256: createHash("sha256").update(bytes).digest("hex"),
    nodeSha256: launchFiles["runtime/node/node.exe"]!,
    agentSha256: launchFiles["agent/session-agent.cjs"]!,
    nativeSha256: snapshot.nativeSha256,
    launcherSha256: options.launcher.sha256,
  };
  // An interrupted two-file commit leaves a hash mismatch, never an invented runnable bootstrap.
  const publication = await options.native.acquireMutex("activation");
  if (!publication) throw new Error("WINDOWS_SESSION_ALREADY_ACTIVE");
  try {
    await writePrivateAtomic(host, "consumer-config.json", bytes);
    await host.native.vaultWrite(
      "fleet",
      "agent_bootstrap",
      Buffer.from(JSON.stringify(receipt)),
    );
    await publishWorkerLoginCapsule(host, options.native, manifest, receipt);
    const startup = options.registerStartup
      ? await options.native.registerStartup(options.launcher.sha256)
      : await options.native.inspectStartup();
    return { configuration, receipt, startup };
  } finally {
    await options.native.releaseMutex(publication);
  }
}
