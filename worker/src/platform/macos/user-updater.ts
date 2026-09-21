import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  statfs,
} from "node:fs/promises";
import { join } from "node:path";
import { downloadVerifiedArtifact } from "../../enrollment/artifact-download.js";
import { prepareInstallationRelease } from "../../enrollment/release-archive.js";
import { WorkerControlPlaneClient } from "../../runtime/control-plane-client.js";
import {
  loadLocalLifecycle,
  setLocalLifecycleIntent,
} from "../../runtime/local-lifecycle.js";
import { loadRuntimeConfig } from "../../runtime/runtime-config.js";
import { inspectInstalledMacRuntime } from "./install-preflight.js";
import {
  MacLaunchAgentController,
  writeLaunchAgentPlist,
} from "./launch-agent.js";
import { qualifyMacUserRelease } from "./user-installer.js";
import type { MacUserLayout } from "./user-paths.js";
import {
  activateMacUserRelease,
  rollbackMacUserRelease,
  stageMacUserRelease,
} from "./user-release.js";
import {
  verifyMacUpdateMetadata,
  type MacUpdateCandidate,
  type MacUpdateMetadata,
} from "./update-metadata.js";
import { waitForLocalDrain } from "./local-drain.js";
import { inspectMacUserHealth } from "./user-health.js";

export const BUILT_IN_MAC_UPDATE_TRUST: Readonly<Record<string, string>> =
  Object.freeze({
    "worker-release-2026-01": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAyvKiex1Pd72WMrIatuQ4JtNmeFZx+yYNa3gZZrDb6IA=
-----END PUBLIC KEY-----
`,
  });

interface UpdateState {
  schemaVersion: 1;
  highestSequence: number;
  status: "none" | "staged" | "activating" | "healthy" | "rolled-back";
  knownGoodVersion?: string;
  candidateVersion?: string;
  quarantinedVersions: string[];
  updatedAt: string;
  failure?: string;
}

export interface MacUserUpdateCheck {
  currentVersion: string;
  availableVersion: string;
  sequence: number;
  updateAvailable: boolean;
  candidate: MacUpdateCandidate;
  metadata: MacUpdateMetadata;
  state: UpdateState;
  installationState: Record<string, unknown>;
}

export async function checkMacUserUpdate(
  layout: MacUserLayout,
  dependencies: {
    candidate?: () => Promise<MacUpdateCandidate>;
    now?: Date;
    download?: boolean;
  } = {},
): Promise<MacUserUpdateCheck> {
  const config = await loadRuntimeConfig(layout.configPath);
  const installation = await readPrivateRecord(layout.installationStatePath);
  const currentVersion = requiredText(
    installation.releaseVersion,
    "Installed release version",
  );
  const state = await loadUpdateState(layout.updateStatePath);
  const trust = await loadMacUpdateTrust(layout.updateTrustPath);
  const candidate = await (
    dependencies.candidate ??
    (() =>
      new WorkerControlPlaneClient({
        baseUrl: config.backendBaseUrl,
        credential: config.credential,
        allowInsecureLoopback: config.allowInsecureLoopback,
      }).macUpdateCandidate(dependencies.download === true))
  )();
  const metadata = verifyMacUpdateMetadata(candidate.signed, {
    publicKeys: trust,
    minimumSequence: state.highestSequence,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  if (state.quarantinedVersions.includes(metadata.releaseVersion))
    throw new Error("Update candidate is locally quarantined");
  return {
    currentVersion,
    availableVersion: metadata.releaseVersion,
    sequence: metadata.sequence,
    updateAvailable: currentVersion !== metadata.releaseVersion,
    candidate,
    metadata,
    state,
    installationState: installation,
  };
}

export async function updateMacUserWorker(options: {
  layout: MacUserLayout;
  uid: number;
  force?: boolean;
  launchAgent?: Pick<
    MacLaunchAgentController,
    "bootstrap" | "bootout" | "status"
  >;
  candidate?: () => Promise<MacUpdateCandidate>;
  qualify?: typeof qualifyMacUserRelease;
  now?: Date;
  fetch?: typeof fetch;
  confirmStarted?: () => Promise<boolean>;
  health?: () => Promise<boolean>;
  availableDiskBytes?: () => Promise<number>;
}): Promise<{
  status: "current" | "updated";
  releaseVersion: string;
  sequence: number;
}> {
  const checked = await checkMacUserUpdate(options.layout, {
    ...(options.candidate === undefined
      ? {}
      : { candidate: options.candidate }),
    ...(options.now === undefined ? {} : { now: options.now }),
    download: true,
  });
  if (!checked.updateAvailable)
    return {
      status: "current",
      releaseVersion: checked.currentVersion,
      sequence: checked.sequence,
    };
  const launchAgent =
    options.launchAgent ?? new MacLaunchAgentController(options.uid);
  const transactionRoot = join(
    options.layout.transactionRoot,
    "updates",
    String(checked.sequence),
  );
  if (checked.candidate.grant === undefined)
    throw new TypeError("Update download grant is missing");
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  await chmod(transactionRoot, 0o700);
  await assertUpdateDiskBudget(
    transactionRoot,
    checked.metadata.release.bytes,
    options.availableDiskBytes,
  );
  const archivePath = join(transactionRoot, checked.metadata.release.filename);
  await downloadVerifiedArtifact({
    url: checked.candidate.grant.url,
    outputPath: archivePath,
    expectedBytes: checked.metadata.release.bytes,
    expectedSha256: checked.metadata.release.sha256,
    expectedContentType: checked.metadata.release.contentType,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const prepared = await prepareInstallationRelease({
    archivePath,
    outputRoot: transactionRoot,
    platform: "darwin-arm64",
    releaseVersion: checked.metadata.releaseVersion,
  });
  const runtime = await inspectInstalledMacRuntime({
    nodeCandidates: [join(prepared.path, "runtime", "node", "bin", "node")],
    ffmpegCandidates: [join(prepared.path, "runtime", "bin", "ffmpeg")],
    ffprobeCandidates: [join(prepared.path, "runtime", "bin", "ffprobe")],
    uid: options.uid,
  });
  if (
    Object.values(runtime).some((component) => component.decision !== "reuse")
  )
    throw new TypeError("Update candidate contains an incompatible runtime");
  const staged = await stageMacUserRelease(options.layout, prepared.path);
  const previousLifecycle = await loadLocalLifecycle(
    options.layout.lifecyclePath,
  );
  await setLocalLifecycleIntent(options.layout.lifecyclePath, "draining");
  const serviceWasLoaded = (await launchAgent.status()).loaded;
  if (serviceWasLoaded) {
    await waitForLocalDrain({
      runtimeStatusPath: options.layout.runtimeStatusPath,
      force: options.force === true,
    });
    await launchAgent.bootout();
  }
  await writeUpdateState(options.layout.updateStatePath, {
    ...checked.state,
    status: "staged",
    candidateVersion: staged.releaseVersion,
    updatedAt: new Date().toISOString(),
  });
  const fixturePath = join(options.layout.stateRoot, "qualification.wav");
  const fixtureSha256 = await sha256(fixturePath);
  const qualify = options.qualify ?? qualifyMacUserRelease;
  let previousRelease: string | null = null;
  try {
    await qualify(
      options.layout,
      staged.releaseRoot,
      fixturePath,
      fixtureSha256,
      launchAgent,
    );
    await writeUpdateState(options.layout.updateStatePath, {
      ...checked.state,
      status: "activating",
      candidateVersion: staged.releaseVersion,
      updatedAt: new Date().toISOString(),
    });
    previousRelease = await activateMacUserRelease(
      options.layout,
      staged.releaseVersion,
    );
    await writeLaunchAgentPlist(options.layout);
    await setLocalLifecycleIntent(
      options.layout.lifecyclePath,
      previousLifecycle.intent,
    );
    await launchAgent.bootstrap(options.layout.plistPath);
    const service = await (
      options.confirmStarted ?? (() => waitForLoadedService(launchAgent))
    )();
    if (!service) throw new Error("Updated LaunchAgent failed to start");
    const healthy = await (
      options.health ??
      (async () =>
        (await inspectMacUserHealth(options.layout, launchAgent)).healthy)
    )();
    if (!healthy) throw new Error("Updated worker failed runtime doctor");
    await writePrivateRecord(options.layout.installationStatePath, {
      ...checked.installationState,
      releaseVersion: staged.releaseVersion,
      updatedAt: new Date().toISOString(),
    });
    await writeUpdateState(options.layout.updateStatePath, {
      schemaVersion: 1,
      highestSequence: checked.sequence,
      status: "healthy",
      knownGoodVersion: staged.releaseVersion,
      candidateVersion: staged.releaseVersion,
      quarantinedVersions: checked.state.quarantinedVersions.filter(
        (version) => version !== staged.releaseVersion,
      ),
      updatedAt: new Date().toISOString(),
    });
    return {
      status: "updated",
      releaseVersion: staged.releaseVersion,
      sequence: checked.sequence,
    };
  } catch (error) {
    if ((await launchAgent.status()).loaded)
      await launchAgent.bootout().catch(() => undefined);
    if (previousRelease !== null)
      await rollbackMacUserRelease(options.layout, previousRelease);
    await writeLaunchAgentPlist(options.layout);
    await setLocalLifecycleIntent(
      options.layout.lifecyclePath,
      previousLifecycle.intent,
    );
    if (serviceWasLoaded)
      await launchAgent
        .bootstrap(options.layout.plistPath)
        .catch(() => undefined);
    await writePrivateRecord(
      options.layout.installationStatePath,
      checked.installationState,
    ).catch(() => undefined);
    await writeUpdateState(options.layout.updateStatePath, {
      ...checked.state,
      status: "rolled-back",
      candidateVersion: staged.releaseVersion,
      quarantinedVersions: [
        ...new Set([
          ...checked.state.quarantinedVersions,
          staged.releaseVersion,
        ]),
      ],
      updatedAt: new Date().toISOString(),
      failure: error instanceof Error ? error.message.slice(0, 240) : "unknown",
    });
    throw error;
  }
}

async function waitForLoadedService(
  launchAgent: Pick<MacLaunchAgentController, "status">,
): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await launchAgent.status();
    if (status.loaded && status.running) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export async function loadMacUpdateTrust(
  path: string,
): Promise<Record<string, string>> {
  let record: Record<string, unknown>;
  try {
    record = await readPrivateRecord(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...BUILT_IN_MAC_UPDATE_TRUST };
    throw error;
  }
  if (Object.keys(record).length < 1 || Object.keys(record).length > 8)
    throw new TypeError("Update trust store is empty or too large");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key) ||
      typeof value !== "string" ||
      value.length > 8192
    )
      throw new TypeError("Update trust store is invalid");
    if (
      BUILT_IN_MAC_UPDATE_TRUST[key] !== undefined &&
      BUILT_IN_MAC_UPDATE_TRUST[key] !== value
    )
      throw new TypeError("Update trust store cannot replace a built-in key");
    result[key] = value;
  }
  const merged = { ...result, ...BUILT_IN_MAC_UPDATE_TRUST };
  if (Object.keys(merged).length > 8)
    throw new TypeError("Update trust store is too large");
  return merged;
}

async function loadUpdateState(path: string): Promise<UpdateState> {
  try {
    const record = await readPrivateRecord(path);
    const allowed = new Set([
      "schemaVersion",
      "highestSequence",
      "status",
      "knownGoodVersion",
      "candidateVersion",
      "quarantinedVersions",
      "updatedAt",
      "failure",
    ]);
    if (
      Object.keys(record).some((key) => !allowed.has(key)) ||
      record.schemaVersion !== 1 ||
      !Number.isSafeInteger(record.highestSequence) ||
      (record.highestSequence as number) < 0 ||
      !["none", "staged", "activating", "healthy", "rolled-back"].includes(
        String(record.status),
      ) ||
      !Array.isArray(record.quarantinedVersions) ||
      record.quarantinedVersions.length > 100 ||
      record.quarantinedVersions.some(
        (value) =>
          typeof value !== "string" ||
          !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(value),
      ) ||
      new Set(record.quarantinedVersions).size !==
        record.quarantinedVersions.length ||
      typeof record.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(record.updatedAt)) ||
      (record.knownGoodVersion !== undefined &&
        (typeof record.knownGoodVersion !== "string" ||
          !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(
            record.knownGoodVersion,
          ))) ||
      (record.candidateVersion !== undefined &&
        (typeof record.candidateVersion !== "string" ||
          !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(
            record.candidateVersion,
          ))) ||
      (record.failure !== undefined &&
        (typeof record.failure !== "string" || record.failure.length > 240))
    )
      throw new TypeError("Update state is invalid");
    return record as unknown as UpdateState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      schemaVersion: 1,
      highestSequence: 0,
      status: "none",
      quarantinedVersions: [],
      updatedAt: new Date(0).toISOString(),
    };
  }
}

async function writeUpdateState(
  path: string,
  state: UpdateState,
): Promise<void> {
  await writePrivateRecord(path, state as unknown as Record<string, unknown>);
}

async function writePrivateRecord(
  path: string,
  state: Record<string, unknown>,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readPrivateRecord(
  path: string,
): Promise<Record<string, unknown>> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 64 * 1024 ||
    (info.mode & 0o077) !== 0
  )
    throw new TypeError("Private update file is unsafe");
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Private update file is invalid");
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100 ||
    value.trim() !== value
  )
    throw new TypeError(`${label} is invalid`);
  return value;
}

async function sha256(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

async function assertUpdateDiskBudget(
  path: string,
  archiveBytes: number,
  availableDiskBytes?: () => Promise<number>,
): Promise<void> {
  const available = await (
    availableDiskBytes ??
    (async () => {
      const filesystem = await statfs(path);
      return filesystem.bavail * filesystem.bsize;
    })
  )();
  const required = archiveBytes * 3 + 512 * 1024 * 1024;
  if (!Number.isSafeInteger(available) || available < required)
    throw new Error("Insufficient disk space for verified update and rollback");
}
