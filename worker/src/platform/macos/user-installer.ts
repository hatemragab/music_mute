import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  runEnrollmentCommand,
  runInstallationPreparationCommand,
} from "../../enrollment/cli.js";
import { parseQualificationEvidence } from "../../enrollment/report-builder.js";
import { WORKER_RECIPE_IDS } from "../../../protocol/v1/protocol.js";
import {
  initializeLocalLifecycle,
  loadLocalLifecycle,
} from "../../runtime/local-lifecycle.js";
import { writeLocalRuntimeStatus } from "../../runtime/local-runtime-status.js";
import {
  MacLaunchAgentController,
  writeLaunchAgentPlist,
} from "./launch-agent.js";
import {
  inspectInstalledMacRuntime,
  type RuntimePreflightResult,
} from "./install-preflight.js";
import {
  installMacUserModel,
  installMacUserRelease,
  macUserModelPath,
  activateMacUserRelease,
  rollbackMacUserRelease,
} from "./user-release.js";
import { createMacUserDirectories, type MacUserLayout } from "./user-paths.js";
import { inspectMacUserHealth } from "./user-health.js";

export const PRODUCTION_BACKEND_BASE_URL = "https://api.music-mute.com/api/v1";

const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface InstallationReceipt {
  installationId: string;
  releaseVersion: string;
  release: { releaseRoot: string };
  model: { path: string; bytes: number; sha256: string };
  fixture: { path: string; sha256: string };
}

interface EnrollmentState {
  machineId: string;
  workerId: string;
}

export interface MacUserInstallationOptions {
  layout: MacUserLayout;
  uid: number;
  enrollmentCredential: string;
  label: string;
  groupId?: string;
  backendBaseUrl?: string;
  allowInsecureLoopback?: boolean;
  launchAgent?: Pick<
    MacLaunchAgentController,
    "bootstrap" | "bootout" | "status"
  >;
  prepare?: typeof runInstallationPreparationCommand;
  enroll?: typeof runEnrollmentCommand;
  qualify?: (
    layout: MacUserLayout,
    releaseRoot: string,
    fixtureSource: string,
    fixtureSha256: string,
    launchAgent: Pick<
      MacLaunchAgentController,
      "bootstrap" | "bootout" | "status"
    >,
  ) => Promise<string>;
  legacyDaemonPath?: string;
  inspectRuntime?: typeof inspectInstalledMacRuntime;
}

export interface MacUserInstallationResult {
  machineId: string;
  releaseVersion: string;
  reusedRelease: boolean;
  reusedModel: boolean;
  serviceLoaded: boolean;
  runtime: RuntimePreflightResult;
}

export interface MacUserRecoveryResult {
  releaseVersion: string;
  serviceLoaded: boolean;
}

export async function readPendingMacUserEnrollmentCredential(
  layout: MacUserLayout,
): Promise<string | null> {
  const path = join(layout.transactionRoot, "install", "enrollment.credential");
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 43 ||
      info.size > 128 ||
      (info.mode & 0o077) !== 0
    )
      throw new TypeError("Pending enrollment credential is unsafe");
    const credential = (await readFile(path, "utf8")).trim();
    if (!CREDENTIAL.test(credential))
      throw new TypeError("Pending enrollment credential is invalid");
    return credential;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function recoverMacUserWorker(options: {
  layout: MacUserLayout;
  uid: number;
  launchAgent?: Pick<
    MacLaunchAgentController,
    "bootstrap" | "bootout" | "status"
  >;
  confirmHealthy?: () => Promise<boolean>;
}): Promise<MacUserRecoveryResult> {
  if (await exists(options.layout.currentLink))
    throw new Error("MusicMute worker runtime is already active");
  if (
    !(await exists(options.layout.configPath)) ||
    !(await exists(options.layout.credentialPath))
  )
    throw new Error("MusicMute worker recovery state is incomplete");
  const installation = asRecord(
    await readPrivateJson(options.layout.installationStatePath),
    "Installation state",
  );
  const releaseVersion = installation.releaseVersion;
  if (
    typeof releaseVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(releaseVersion)
  )
    throw new TypeError("Installed release version is invalid");
  const launchAgent =
    options.launchAgent ?? new MacLaunchAgentController(options.uid);
  let activated = false;
  try {
    const previous = await activateMacUserRelease(
      options.layout,
      releaseVersion,
    );
    if (previous !== null)
      throw new TypeError(
        "MusicMute recovery found an unexpected active release",
      );
    activated = true;
    await writeLaunchAgentPlist(options.layout);
    await launchAgent.bootstrap(options.layout.plistPath);
    const healthy = await (
      options.confirmHealthy ??
      (async () => {
        const service = await waitForRunningLaunchAgent(launchAgent);
        return (
          service &&
          (await inspectMacUserHealth(options.layout, launchAgent)).healthy
        );
      })
    )();
    if (!healthy) throw new Error("Recovered worker failed runtime doctor");
    return { releaseVersion, serviceLoaded: true };
  } catch (error) {
    if ((await launchAgent.status()).loaded)
      await launchAgent.bootout().catch(() => undefined);
    if (activated) await rollbackMacUserRelease(options.layout, null);
    await rm(options.layout.plistPath, { force: true });
    throw error;
  }
}

export async function installMacUserWorker(
  options: MacUserInstallationOptions,
): Promise<MacUserInstallationResult> {
  if (!CREDENTIAL.test(options.enrollmentCredential))
    throw new TypeError("Enrollment code is invalid");
  if (
    options.label.length < 1 ||
    options.label.length > 120 ||
    options.label.trim() !== options.label
  )
    throw new TypeError("Worker label is invalid");
  if (await exists(options.layout.configPath))
    throw new Error("MusicMute worker is already installed; use update");
  await rejectLegacyDaemon(
    options.legacyDaemonPath ??
      "/Library/LaunchDaemons/com.musicmute.worker.plist",
  );
  await createMacUserDirectories(options.layout);
  const transactionRoot = join(options.layout.transactionRoot, "install");
  await mkdir(transactionRoot, { recursive: true, mode: 0o700 });
  await chmod(transactionRoot, 0o700);
  const enrollmentPath = join(transactionRoot, "enrollment.credential");
  await writeStablePrivateText(
    enrollmentPath,
    `${options.enrollmentCredential}\n`,
  );
  const backendBaseUrl = options.backendBaseUrl ?? PRODUCTION_BACKEND_BASE_URL;
  const allowInsecureLoopback = options.allowInsecureLoopback === true;
  const prepare = options.prepare ?? runInstallationPreparationCommand;
  await prepare(
    [
      "--backend-url",
      backendBaseUrl,
      "--enrollment-file",
      enrollmentPath,
      "--platform",
      "darwin-arm64",
      "--output",
      transactionRoot,
      "--allow-insecure-loopback",
      String(allowInsecureLoopback),
    ],
    {
      reusableModelPath: macUserModelPath(
        options.layout,
        "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
        "Kim_Vocal_2.onnx",
      ),
    },
  );
  const receipt = await readInstallationReceipt(
    join(transactionRoot, "installation-artifacts.json"),
  );
  const inspectRuntime = options.inspectRuntime ?? inspectInstalledMacRuntime;
  const runtime = await inspectRuntime({
    nodeCandidates: [
      join(receipt.release.releaseRoot, "runtime", "node", "bin", "node"),
    ],
    ffmpegCandidates: [
      join(receipt.release.releaseRoot, "runtime", "bin", "ffmpeg"),
    ],
    ffprobeCandidates: [
      join(receipt.release.releaseRoot, "runtime", "bin", "ffprobe"),
    ],
    uid: options.uid,
  });
  assertCompatiblePreparedRuntime(runtime);
  const release = await installMacUserRelease(
    options.layout,
    receipt.release.releaseRoot,
  );
  if (release.releaseVersion !== receipt.releaseVersion) {
    await rollbackMacUserRelease(options.layout, release.previousRelease);
    throw new TypeError("Prepared release version does not match its receipt");
  }
  let backendActivated = false;
  try {
    const model = await installMacUserModel({
      layout: options.layout,
      sourcePath: receipt.model.path,
      filename: "Kim_Vocal_2.onnx",
      bytes: receipt.model.bytes,
      sha256: receipt.model.sha256,
    });
    const launchAgent =
      options.launchAgent ?? new MacLaunchAgentController(options.uid);
    const qualify = options.qualify ?? qualifyMacUserRelease;
    const qualificationPath = await qualify(
      options.layout,
      release.releaseRoot,
      receipt.fixture.path,
      receipt.fixture.sha256,
      launchAgent,
    );
    const enroll = options.enroll ?? runEnrollmentCommand;
    await enroll([
      "--backend-url",
      backendBaseUrl,
      "--enrollment-file",
      enrollmentPath,
      "--release",
      release.releaseRoot,
      "--qualification",
      qualificationPath,
      "--label",
      options.label,
      ...(options.groupId === undefined ? [] : ["--group-id", options.groupId]),
      "--output",
      transactionRoot,
      "--allow-insecure-loopback",
      String(allowInsecureLoopback),
    ]);
    backendActivated = true;
    const enrollmentState = await readEnrollmentState(
      join(transactionRoot, ".enrollment-state.json"),
    );
    await installMachineCredential(
      join(transactionRoot, "machine.credential"),
      options.layout.credentialPath,
    );
    await writePrivateJson(
      options.layout.configPath,
      buildMacUserRuntimeConfig(
        options.layout,
        backendBaseUrl,
        allowInsecureLoopback,
        enrollmentState,
      ),
    );
    try {
      await loadLocalLifecycle(options.layout.lifecyclePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await initializeLocalLifecycle(options.layout.lifecyclePath);
    }
    await writeLocalRuntimeStatus(options.layout.runtimeStatusPath, []);
    await writeLaunchAgentPlist(options.layout);
    await writePrivateJson(options.layout.installationStatePath, {
      schemaVersion: 1,
      installationId: receipt.installationId,
      machineId: enrollmentState.machineId,
      releaseVersion: release.releaseVersion,
      runtimePreflight: runtime,
      installedAt: new Date().toISOString(),
    });
    await launchAgent.bootstrap(options.layout.plistPath);
    const service = await launchAgent.status();
    if (!service.loaded)
      throw new Error("MusicMute worker LaunchAgent did not load");
    await rm(enrollmentPath, { force: true });
    return {
      machineId: enrollmentState.machineId,
      releaseVersion: release.releaseVersion,
      reusedRelease: release.reused,
      reusedModel: model.reused,
      serviceLoaded: true,
      runtime,
    };
  } catch (error) {
    if (!backendActivated)
      await rollbackMacUserRelease(options.layout, release.previousRelease);
    throw error;
  }
}

function assertCompatiblePreparedRuntime(
  runtime: RuntimePreflightResult,
): void {
  const incompatible = Object.entries(runtime).find(
    ([, component]) => component.decision !== "reuse",
  );
  if (incompatible !== undefined) {
    const [name, component] = incompatible;
    throw new TypeError(
      `Prepared ${name} runtime requires a private upgrade (${component.reason})`,
    );
  }
}

export function buildMacUserRuntimeConfig(
  layout: MacUserLayout,
  backendBaseUrl: string,
  allowInsecureLoopback: boolean,
  enrollment: EnrollmentState,
) {
  if (!UUID_V4.test(enrollment.machineId) || !UUID_V4.test(enrollment.workerId))
    throw new TypeError("Enrollment machine identity is invalid");
  const url = new URL(backendBaseUrl);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(allowInsecureLoopback && loopback))
  )
    throw new TypeError("Worker backend URL is unsafe");
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return {
    schemaVersion: 1,
    backendBaseUrl: url.toString(),
    machineId: enrollment.machineId,
    credentialFile: layout.credentialPath,
    localLifecyclePath: layout.lifecyclePath,
    localRuntimeStatusPath: layout.runtimeStatusPath,
    workRoot: layout.workRoot,
    modelCacheRoot: layout.modelRoot,
    engineRoot: layout.engineRoot,
    pythonPath: layout.pythonPath,
    ffmpegPath: layout.ffmpegPath,
    ffprobePath: layout.ffprobePath,
    allowInsecureLoopback,
    slots: [
      {
        workerId: enrollment.workerId,
        gpuId: "gpu0",
        slotIndex: 0,
        recipeIds: [...WORKER_RECIPE_IDS],
        provider: "coreml" as const,
      },
    ],
  };
}

export async function qualifyMacUserRelease(
  layout: MacUserLayout,
  releaseRoot: string,
  fixtureSource: string,
  fixtureSha256: string,
  launchAgent: Pick<
    MacLaunchAgentController,
    "bootstrap" | "bootout" | "status"
  >,
): Promise<string> {
  const fixturePath = join(layout.stateRoot, "qualification.wav");
  const reportPath = join(layout.stateRoot, "qualification.json");
  await copyFile(fixtureSource, fixturePath);
  await chmod(fixturePath, 0o600);
  if ((await sha256(fixturePath)) !== fixtureSha256)
    throw new TypeError("Qualification fixture digest does not match");
  await rm(reportPath, { force: true });
  if ((await launchAgent.status()).loaded) await launchAgent.bootout();
  await writeLaunchAgentPlist(layout, {
    fixturePath,
    fixtureSha256,
    reportPath,
    releaseRoot,
  });
  try {
    await launchAgent.bootstrap(layout.plistPath);
    for (let attempt = 0; attempt < 9_600; attempt += 1) {
      if (await exists(reportPath)) {
        const evidence = parseQualificationEvidence(
          JSON.parse(await readFile(reportPath, "utf8")) as unknown,
        );
        if (evidence.fixtureDigest !== fixtureSha256)
          throw new TypeError("Qualification fixture identity changed");
        return reportPath;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("CoreML qualification timed out");
  } finally {
    if ((await launchAgent.status()).loaded) await launchAgent.bootout();
    await writeLaunchAgentPlist(layout);
  }
}

async function readInstallationReceipt(
  path: string,
): Promise<InstallationReceipt> {
  const value = await readPrivateJson(path);
  const record = asRecord(value, "Installation receipt");
  const release = asRecord(record.release, "Installation release");
  const model = asRecord(record.model, "Installation model");
  const fixture = asRecord(record.fixture, "Installation fixture");
  if (
    typeof record.installationId !== "string" ||
    !UUID_V4.test(record.installationId) ||
    typeof record.releaseVersion !== "string" ||
    typeof release.releaseRoot !== "string" ||
    !isAbsolute(release.releaseRoot) ||
    typeof model.path !== "string" ||
    !isAbsolute(model.path) ||
    !Number.isSafeInteger(model.bytes) ||
    typeof model.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(model.sha256) ||
    typeof fixture.path !== "string" ||
    !isAbsolute(fixture.path) ||
    typeof fixture.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(fixture.sha256)
  )
    throw new TypeError("Installation receipt is invalid");
  return {
    installationId: record.installationId,
    releaseVersion: record.releaseVersion,
    release: { releaseRoot: release.releaseRoot },
    model: {
      path: model.path,
      bytes: model.bytes as number,
      sha256: model.sha256,
    },
    fixture: { path: fixture.path, sha256: fixture.sha256 },
  };
}

async function readEnrollmentState(path: string): Promise<EnrollmentState> {
  const record = asRecord(await readPrivateJson(path), "Enrollment state");
  if (
    typeof record.machineId !== "string" ||
    !UUID_V4.test(record.machineId) ||
    typeof record.workerId !== "string" ||
    !UUID_V4.test(record.workerId)
  )
    throw new TypeError("Enrollment state is incomplete");
  return { machineId: record.machineId, workerId: record.workerId };
}

async function installMachineCredential(
  source: string,
  destination: string,
): Promise<void> {
  const credential = (await readFile(source, "utf8")).trim();
  if (!CREDENTIAL.test(credential))
    throw new TypeError("Machine credential is invalid");
  await writeStablePrivateText(destination, `${credential}\n`);
}

async function readPrivateJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 1024 * 1024 ||
    (info.mode & 0o077) !== 0
  )
    throw new TypeError("Private JSON file is unsafe");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function writePrivateJson(path: string, value: object): Promise<void> {
  await writeStablePrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeStablePrivateText(
  path: string,
  value: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (await exists(path)) {
    if ((await readFile(path, "utf8")) !== value)
      throw new TypeError("Existing private installation state conflicts");
    return;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForRunningLaunchAgent(
  launchAgent: Pick<MacLaunchAgentController, "status">,
): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const status = await launchAgent.status();
    if (status.loaded && status.running) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

async function rejectLegacyDaemon(path: string): Promise<void> {
  if (await exists(path))
    throw new Error(
      "Legacy MusicMute LaunchDaemon detected; run the documented administrator migration first",
    );
}
