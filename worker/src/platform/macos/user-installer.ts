import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  link,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  runEnrollmentCommand,
  runInstallationPreparationCommand,
} from "../../enrollment/cli.js";
import { parseQualificationEvidence } from "../../enrollment/report-builder.js";
import {
  WorkerEnrollmentClient,
  WorkerEnrollmentError,
} from "../../enrollment/enrollment-client.js";
import { cleanupQualificationWorkspace } from "../../enrollment/qualification-cleanup.js";
import {
  initializeLocalLifecycle,
  loadLocalLifecycle,
} from "../../runtime/local-lifecycle.js";
import { writeLocalRuntimeStatus } from "../../runtime/local-runtime-status.js";
import {
  MacLaunchAgentController,
  writeLaunchAgentPlist,
  type LaunchAgentStatus,
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
import {
  assertSafeExistingAncestors,
  createMacUserDirectories,
  type MacUserLayout,
} from "./user-paths.js";
import { inspectMacUserHealth } from "./user-health.js";
import {
  verifyManagedMacRelease as verifyMacRelease,
  resolveMacAppExecutionLayout,
} from "./app-installation-binding.js";
import { MAC_RECIPE_IDS } from "./runtime-recipes.js";
import { finishDeletedMacRegistration } from "./deleted-registration.js";

export const PRODUCTION_BACKEND_BASE_URL = "https://api.music-mute.com";

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

interface InstallationQualificationReceipt {
  schemaVersion: 1;
  installationId: string;
  releaseVersion: string;
  releaseManifestDigest: string;
  modelDigest: string;
  fixtureDigest: string;
  reportDigest: string;
  outputPath: string;
  outputDigest: string;
  outputBytes: number;
}

export interface MacQualificationClock {
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
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
  inspectRuntime?: typeof inspectInstalledMacRuntime;
  beforeQualification?: () => Promise<void>;
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

type PendingEnrollmentReplacement = "pre-exchange" | "expired-unactivated";

interface PendingEnrollmentSnapshot {
  replacement: PendingEnrollmentReplacement;
  fingerprint: string;
  installationId?: string;
  installationCredential?: string;
}

/** Local eligibility only. Expiration must still be confirmed by the original backend credential. */
export async function inspectPendingMacUserEnrollment(
  layout: MacUserLayout,
  service: Pick<LaunchAgentStatus, "loaded" | "running">,
): Promise<{ replacement: PendingEnrollmentReplacement | null }> {
  if (service.loaded || service.running) return { replacement: null };
  try {
    const pending = await readPendingEnrollmentSnapshot(layout);
    return { replacement: pending?.replacement ?? null };
  } catch {
    return { replacement: null };
  }
}

async function readPendingEnrollmentSnapshot(
  layout: MacUserLayout,
): Promise<PendingEnrollmentSnapshot | null> {
  const transactionRoot = join(layout.transactionRoot, "install");
  await assertSafeExistingAncestors(layout.homeRoot, transactionRoot);
  const identities: unknown[] = [];
  const content: unknown[] = [];
  const allowed = new Set([
    "enrollment.credential",
    ".enrollment-state.json",
    "installation-artifacts.json",
    ".qualification-receipt.json",
    "machine.credential",
    "installation-artifacts",
  ]);
  let entries: string[];
  try {
    const info = await lstat(transactionRoot);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new TypeError("Pending enrollment directory is unsafe");
    entries = (await readdir(transactionRoot)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (entries.some((entry) => !allowed.has(entry)))
    throw new Error(
      "Pending installation has progressed; its enrollment code cannot be replaced",
    );
  if (entries.length === 0) return null;
  for (const path of [
    layout.configPath,
    layout.credentialPath,
    layout.installationStatePath,
    join(layout.stateRoot, "app-activation.json"),
  ])
    if (await exists(path))
      throw new Error(
        "Pending installation has progressed; its enrollment code cannot be replaced",
      );
  // Bound this metadata walk. The app transaction contains only its fixture and
  // small journals; larger or unfamiliar transactions require operator review.
  async function inspect(path: string, depth = 0): Promise<void> {
    const info = await lstat(path);
    if (
      identities.length >= 256 ||
      depth > 8 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.isSymbolicLink() ||
      (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
    )
      throw new TypeError("Pending enrollment transaction is unsafe");
    identities.push([
      path,
      info.dev,
      info.ino,
      info.mode,
      info.uid,
      info.nlink,
      info.size,
      info.mtimeMs,
      info.ctimeMs,
    ]);
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        await inspect(join(path, name), depth + 1);
    }
  }
  await inspect(transactionRoot);
  for (const name of entries) {
    if (name === "installation-artifacts") continue;
    const bytes = await readOwnedPrivateBytes(
      join(transactionRoot, name),
      64 * 1024,
    );
    content.push([name, bytes.toString("utf8")]);
  }
  const credentialPath = join(transactionRoot, "enrollment.credential");
  const credential = (await readOwnedPrivateBytes(credentialPath, 128))
    .toString("utf8")
    .trim();
  if (!CREDENTIAL.test(credential))
    throw new TypeError("Pending enrollment credential is invalid");
  const statePath = join(transactionRoot, ".enrollment-state.json");
  const value: unknown = entries.includes(".enrollment-state.json")
    ? JSON.parse(
        (await readOwnedPrivateBytes(statePath, 64 * 1024)).toString("utf8"),
      )
    : null;
  const fingerprint = () =>
    createHash("sha256")
      .update(JSON.stringify([identities, content]))
      .digest("hex");
  if (
    entries.every((name) =>
      ["enrollment.credential", ".enrollment-state.json"].includes(name),
    ) &&
    (value === null || isPreExchangeEnrollmentState(value))
  )
    return { replacement: "pre-exchange", fingerprint: fingerprint() };
  const state = asRecord(value, "Pending enrollment state");
  const stateKeys = new Set([
    "schemaVersion",
    "exchangeRequestId",
    "reportRequestId",
    "activationRequestId",
    "qualificationGrantRequestId",
    "qualificationConfirmRequestId",
    "installationId",
    "installationCredential",
    "machineCredential",
    "workerId",
  ]);
  if (
    state.schemaVersion !== 1 ||
    Object.keys(state).some((key) => !stateKeys.has(key)) ||
    ![
      "exchangeRequestId",
      "reportRequestId",
      "activationRequestId",
      "installationId",
    ].every(
      (key) => typeof state[key] === "string" && UUID_V4.test(state[key]),
    ) ||
    ![
      "qualificationGrantRequestId",
      "qualificationConfirmRequestId",
      "workerId",
    ].every(
      (key) =>
        state[key] === undefined ||
        (typeof state[key] === "string" && UUID_V4.test(state[key])),
    ) ||
    typeof state.installationCredential !== "string" ||
    !CREDENTIAL.test(state.installationCredential) ||
    (state.machineCredential === undefined) !==
      (state.workerId === undefined) ||
    (state.machineCredential !== undefined &&
      (typeof state.machineCredential !== "string" ||
        !CREDENTIAL.test(state.machineCredential)))
  )
    throw new Error(
      "Pending installation has progressed; activation cannot be safely excluded",
    );
  if (entries.includes("machine.credential")) {
    const machine = (
      await readOwnedPrivateBytes(
        join(transactionRoot, "machine.credential"),
        128,
      )
    )
      .toString("utf8")
      .trim();
    if (machine !== state.machineCredential)
      throw new TypeError("Pending machine credential identity changed");
  } else if (state.machineCredential !== undefined) {
    throw new TypeError("Pending machine credential is missing");
  }
  if (entries.includes("installation-artifacts.json")) {
    const receipt = await readInstallationReceipt(
      join(transactionRoot, "installation-artifacts.json"),
    );
    if (receipt.installationId !== state.installationId)
      throw new TypeError("Pending installation artifact identity changed");
  }
  if (entries.includes(".qualification-receipt.json")) {
    const receipt = asRecord(
      JSON.parse(
        (
          await readOwnedPrivateBytes(
            join(transactionRoot, ".qualification-receipt.json"),
            16 * 1024,
          )
        ).toString("utf8"),
      ),
      "Pending qualification receipt",
    );
    if (receipt.installationId !== state.installationId)
      throw new TypeError(
        "Pending qualification installation identity changed",
      );
  }
  return {
    replacement: "expired-unactivated",
    fingerprint: fingerprint(),
    installationId: state.installationId as string,
    installationCredential: state.installationCredential,
  };
}

/** Caller holds the command lock. Preserve progressed transactions unless the server confirms expiry. */
export async function resetPendingMacUserEnrollment(
  layout: MacUserLayout,
  options: {
    launchAgent?: Pick<MacLaunchAgentController, "status">;
    confirmExpiredInstallation?: (
      installationId: string,
      credential: string,
    ) => Promise<unknown>;
  } = {},
): Promise<void> {
  const pending = await readPendingEnrollmentSnapshot(layout);
  if (!pending) return;
  const transactionRoot = join(layout.transactionRoot, "install");
  const service =
    options.launchAgent ??
    new MacLaunchAgentController(process.getuid?.() ?? 0);
  const stopped = await service.status();
  if (stopped.loaded || stopped.running)
    throw new Error("Stop the worker before replacing expired enrollment");
  if (pending.replacement === "pre-exchange") {
    await rm(join(transactionRoot, "enrollment.credential"), { force: true });
    await rm(join(transactionRoot, ".enrollment-state.json"), { force: true });
    return;
  }
  const confirm =
    options.confirmExpiredInstallation ??
    ((id: string, credential: string) =>
      new WorkerEnrollmentClient({
        baseUrl: PRODUCTION_BACKEND_BASE_URL,
      }).artifacts(id, credential, "darwin-arm64"));
  try {
    await confirm(pending.installationId!, pending.installationCredential!);
    throw new Error("Pending worker installation has not expired");
  } catch (error) {
    if (
      !(error instanceof WorkerEnrollmentError) ||
      error.code !== "WORKER_EXPIRED" ||
      error.status !== 410
    )
      throw error;
  }
  const checked = await readPendingEnrollmentSnapshot(layout);
  const latest = await service.status();
  if (
    !checked ||
    checked.fingerprint !== pending.fingerprint ||
    latest.loaded ||
    latest.running
  )
    throw new Error(
      "Pending worker installation changed during expiry confirmation",
    );
  await rename(
    transactionRoot,
    join(layout.transactionRoot, `expired-install-${randomUUID()}`),
  );
  await syncDirectory(layout.transactionRoot);
}

function isPreExchangeEnrollmentState(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const state = value as Record<string, unknown>;
  const required = [
    "exchangeRequestId",
    "reportRequestId",
    "activationRequestId",
  ];
  const optional = [
    "qualificationGrantRequestId",
    "qualificationConfirmRequestId",
  ];
  if (state.schemaVersion !== 1) return false;
  if (required.some((key) => !UUID_V4.test(String(state[key] ?? ""))))
    return false;
  if (
    optional.some(
      (key) => state[key] !== undefined && !UUID_V4.test(String(state[key])),
    )
  )
    return false;
  return Object.keys(state).every(
    (key) =>
      key === "schemaVersion" ||
      required.includes(key) ||
      optional.includes(key),
  );
}

export async function recoverMacUserWorker(options: {
  layout: MacUserLayout;
  uid: number;
  launchAgent?: Pick<
    MacLaunchAgentController,
    "bootstrap" | "bootout" | "status"
  >;
  confirmHealthy?: () => Promise<boolean>;
  beforeStart?: () => Promise<void>;
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
    await options.beforeStart?.();
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
  const preparedLayout = await resolveMacAppExecutionLayout(
    options.layout,
    receipt.release.releaseRoot,
  );
  const inspectRuntime = options.inspectRuntime ?? inspectInstalledMacRuntime;
  const runtime = await inspectRuntime({
    nodeCandidates: [
      preparedLayout.nodePath === options.layout.nodePath
        ? join(receipt.release.releaseRoot, "runtime", "node", "bin", "node")
        : preparedLayout.nodePath,
    ],
    ffmpegCandidates: [
      preparedLayout.ffmpegPath === options.layout.ffmpegPath
        ? join(receipt.release.releaseRoot, "runtime", "bin", "ffmpeg")
        : preparedLayout.ffmpegPath,
    ],
    ffprobeCandidates: [
      preparedLayout.ffprobePath === options.layout.ffprobePath
        ? join(receipt.release.releaseRoot, "runtime", "bin", "ffprobe")
        : preparedLayout.ffprobePath,
    ],
    uid: options.uid,
  });
  assertCompatiblePreparedRuntime(runtime);
  const release = await installMacUserRelease(
    options.layout,
    receipt.release.releaseRoot,
  );
  const executionLayout = await resolveMacAppExecutionLayout(
    options.layout,
    release.releaseRoot,
  );
  if (release.releaseVersion !== receipt.releaseVersion) {
    await rollbackMacUserRelease(options.layout, release.previousRelease);
    throw new TypeError("Prepared release version does not match its receipt");
  }
  let backendActivated = false;
  try {
    const model = await installMacUserModel({
      layout: executionLayout,
      sourcePath: receipt.model.path,
      filename: "Kim_Vocal_2.onnx",
      bytes: receipt.model.bytes,
      sha256: receipt.model.sha256,
    });
    const launchAgent =
      options.launchAgent ?? new MacLaunchAgentController(options.uid);
    const qualify = options.qualify ?? qualifyMacUserRelease;
    let qualificationPath = await reusableInstallationQualification(
      executionLayout,
      receipt,
      release.releaseRoot,
    );
    if (qualificationPath === null) {
      await options.beforeQualification?.();
      qualificationPath = await qualify(
        executionLayout,
        release.releaseRoot,
        receipt.fixture.path,
        receipt.fixture.sha256,
        launchAgent,
      );
      // Enrollment still validates missing reports from injected qualification
      // implementations. Only actual verified evidence becomes reusable.
      if (await exists(qualificationPath)) {
        const verified = await verifyInstallationQualification(
          executionLayout,
          receipt,
          release.releaseRoot,
          qualificationPath,
        );
        await writePrivateJson(
          installationQualificationPath(executionLayout),
          verified,
        );
      }
    }
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
      "--service-root",
      options.layout.homeRoot,
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
    await writePrivateJson(join(transactionRoot, "finalization.json"), {
      schemaVersion: 1,
      backendBaseUrl,
      allowInsecureLoopback,
      enrollmentState,
      installationId: receipt.installationId,
      installedAt: new Date().toISOString(),
      result: {
        machineId: enrollmentState.machineId,
        releaseVersion: release.releaseVersion,
        reusedRelease: release.reused,
        reusedModel: model.reused,
        serviceLoaded: true,
        runtime,
      },
    });
    const result = await resumeMacUserInstallation({
      layout: executionLayout,
      uid: options.uid,
      launchAgent,
      ...(options.beforeQualification
        ? { beforeStart: options.beforeQualification }
        : {}),
    });
    if (!result)
      throw new Error("Installation finalization journal disappeared");
    return result;
  } catch (error) {
    if (!backendActivated)
      await rollbackMacUserRelease(options.layout, release.previousRelease);
    throw error;
  }
}

function installationQualificationPath(layout: MacUserLayout): string {
  return join(layout.transactionRoot, "install", ".qualification-receipt.json");
}

async function reusableInstallationQualification(
  layout: MacUserLayout,
  receipt: InstallationReceipt,
  releaseRoot: string,
): Promise<string | null> {
  let saved: Record<string, unknown>;
  try {
    saved = asRecord(
      JSON.parse(
        (
          await readOwnedPrivateBytes(
            installationQualificationPath(layout),
            16 * 1024,
          )
        ).toString("utf8"),
      ),
      "Installation qualification receipt",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const path = join(layout.stateRoot, "qualification.json");
  const verified = await verifyInstallationQualification(
    layout,
    receipt,
    releaseRoot,
    path,
  );
  if (
    Object.keys(saved).length !== Object.keys(verified).length ||
    Object.entries(verified).some(([key, value]) => saved[key] !== value)
  )
    throw new TypeError("Installation qualification identity changed");
  return path;
}

async function verifyInstallationQualification(
  layout: MacUserLayout,
  receipt: InstallationReceipt,
  releaseRoot: string,
  reportPath: string,
): Promise<InstallationQualificationReceipt> {
  if (reportPath !== join(layout.stateRoot, "qualification.json"))
    throw new TypeError("Installation qualification report path is unsafe");
  const bytes = await readOwnedPrivateBytes(reportPath, 64 * 1024);
  const evidence = parseQualificationEvidence(
    JSON.parse(bytes.toString("utf8")),
  );
  const releaseManifestDigest = await sha256(
    join(releaseRoot, "release-manifest.json"),
  );
  if (
    evidence.platform !== "darwin-arm64" ||
    evidence.provider !== "mps" ||
    evidence.releaseManifestDigest !== releaseManifestDigest ||
    evidence.modelDigest !== receipt.model.sha256 ||
    evidence.fixtureDigest !== receipt.fixture.sha256 ||
    createHash("sha256")
      .update(await readOwnedPrivateBytes(receipt.fixture.path, 30_000_000))
      .digest("hex") !== receipt.fixture.sha256
  )
    throw new TypeError(
      "Installation qualification does not match its prepared artifacts",
    );
  const candidate = evidence.uploadCandidate;
  const parts = relative(layout.workRoot, candidate.path).split(sep);
  if (
    resolve(candidate.path) !== candidate.path ||
    !/^qualification-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      parts[0] ?? "",
    ) ||
    !(
      (parts.length === 2 && parts[1] === "vocals.mp3") ||
      (parts.length === 4 &&
        UUID_V4.test(parts[1] ?? "") &&
        parts[2] === "output" &&
        parts[3] === "vocals.mp3")
    )
  )
    throw new TypeError("Installation qualification output path is unsafe");
  try {
    if (
      (await realpath(candidate.path)) !==
      join(await realpath(layout.workRoot), ...parts)
    )
      throw new TypeError(
        "Installation qualification output contains a symbolic link",
      );
    const output = await readOwnedPrivateBytes(candidate.path, 30_000_000);
    if (
      output.length !== candidate.resultBytes ||
      createHash("sha256").update(output).digest("hex") !==
        candidate.resultDigest
    )
      throw new TypeError("Installation qualification output identity changed");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await assertSafeExistingAncestors(
      layout.installRoot,
      dirname(candidate.path),
    );
    const present = await lstat(candidate.path).catch((missing: unknown) => {
      if ((missing as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw missing;
    });
    if (
      present !== null ||
      !(await installationReportAccepted(layout, receipt.installationId))
    )
      throw error;
    // Enrollment removes scratch only after the report was durably accepted.
    // The immutable receipt below still binds that accepted output's identity.
  }
  return {
    schemaVersion: 1,
    installationId: receipt.installationId,
    releaseVersion: receipt.releaseVersion,
    releaseManifestDigest,
    modelDigest: evidence.modelDigest,
    fixtureDigest: evidence.fixtureDigest,
    reportDigest: createHash("sha256").update(bytes).digest("hex"),
    outputPath: candidate.path,
    outputDigest: candidate.resultDigest,
    outputBytes: candidate.resultBytes,
  };
}

async function installationReportAccepted(
  layout: MacUserLayout,
  installationId: string,
): Promise<boolean> {
  try {
    const state = asRecord(
      JSON.parse(
        (
          await readOwnedPrivateBytes(
            join(layout.transactionRoot, "install", ".enrollment-state.json"),
            64 * 1024,
          )
        ).toString("utf8"),
      ),
      "Installation enrollment state",
    );
    return (
      state.installationId === installationId &&
      typeof state.installationCredential === "string" &&
      CREDENTIAL.test(state.installationCredential) &&
      [
        "exchangeRequestId",
        "reportRequestId",
        "activationRequestId",
        "qualificationGrantRequestId",
        "qualificationConfirmRequestId",
      ].every(
        (key) => typeof state[key] === "string" && UUID_V4.test(state[key]),
      ) &&
      Number.isSafeInteger(state.reportRevision) &&
      Number(state.reportRevision) >= 1
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readOwnedPrivateBytes(
  path: string,
  maximum: number,
): Promise<Buffer> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    const uid = process.getuid?.();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (uid !== undefined && before.uid !== uid) ||
      (before.mode & 0o077) !== 0 ||
      before.size < 1 ||
      before.size > maximum
    )
      throw new TypeError("Installation qualification private file is unsafe");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      bytes.length !== before.size ||
      bytes.length > maximum ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.nlink !== before.nlink ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.mode !== before.mode ||
      current.uid !== before.uid ||
      current.nlink !== before.nlink ||
      current.isSymbolicLink()
    )
      throw new TypeError(
        "Installation qualification private file changed while reading",
      );
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Caller holds the CLI command lock. No enrollment exchange is repeated here. */
export async function resumeMacUserInstallation(options: {
  layout: MacUserLayout;
  uid: number;
  launchAgent?: Pick<
    MacLaunchAgentController,
    "bootstrap" | "bootout" | "status"
  >;
  beforeStart?: () => Promise<void>;
}): Promise<MacUserInstallationResult | null> {
  const { layout } = options;
  const transactionRoot = join(layout.transactionRoot, "install");
  const journalPath = join(transactionRoot, "finalization.json");
  let raw: unknown;
  try {
    raw = await readPrivateJson(journalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const journal = asRecord(raw, "Installation finalization journal");
  const identity = asRecord(journal.enrollmentState, "Enrollment identity");
  const result = asRecord(journal.result, "Installation result");
  if (
    journal.schemaVersion !== 1 ||
    typeof journal.backendBaseUrl !== "string" ||
    typeof journal.allowInsecureLoopback !== "boolean" ||
    !UUID_V4.test(String(journal.installationId)) ||
    typeof journal.installedAt !== "string" ||
    !Number.isFinite(Date.parse(journal.installedAt)) ||
    typeof result.releaseVersion !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(result.releaseVersion) ||
    typeof identity.machineId !== "string" ||
    typeof identity.workerId !== "string" ||
    result.machineId !== identity.machineId ||
    result.serviceLoaded !== true ||
    typeof result.reusedRelease !== "boolean" ||
    typeof result.reusedModel !== "boolean"
  )
    throw new TypeError("Installation finalization journal is invalid");
  const runtime = asRecord(result.runtime, "Installation runtime");
  for (const name of ["node", "ffmpeg", "ffprobe"]) {
    const component = asRecord(runtime[name], "Installation runtime component");
    if (
      component.decision !== "reuse" ||
      typeof component.installedVersion !== "string"
    )
      throw new TypeError("Installation runtime evidence is invalid");
  }
  const executionLayout = await resolveMacAppExecutionLayout(
    layout,
    join(layout.releasesRoot, String(result.releaseVersion)),
  );
  const config = buildMacUserRuntimeConfig(
    executionLayout,
    journal.backendBaseUrl,
    journal.allowInsecureLoopback,
    { machineId: identity.machineId, workerId: identity.workerId },
  );
  if (
    (await readlink(layout.currentLink)) !== `releases/${result.releaseVersion}`
  )
    throw new Error("Installation recovery found an unrelated active release");
  await verifyMacRelease(join(layout.releasesRoot, result.releaseVersion));
  await installMachineCredential(
    join(transactionRoot, "machine.credential"),
    layout.credentialPath,
  );
  await writePrivateJson(layout.configPath, config);
  try {
    await loadLocalLifecycle(layout.lifecyclePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await initializeLocalLifecycle(layout.lifecyclePath);
  }
  if (!(await exists(layout.runtimeStatusPath)))
    await writeLocalRuntimeStatus(layout.runtimeStatusPath, []);
  await writeLaunchAgentPlist(layout);
  await writePrivateJson(layout.installationStatePath, {
    schemaVersion: 1,
    installationId: journal.installationId,
    machineId: identity.machineId,
    releaseVersion: result.releaseVersion,
    runtimePreflight: result.runtime,
    installedAt: journal.installedAt,
  });
  const service =
    options.launchAgent ?? new MacLaunchAgentController(options.uid);
  if (!(await service.status()).loaded) {
    await options.beforeStart?.();
    await service.bootstrap(layout.plistPath);
  }
  if (!(await service.status()).loaded)
    throw new Error("MusicMute worker LaunchAgent did not load");
  await finishDeletedMacRegistration(layout, String(identity.machineId));
  await rm(join(transactionRoot, "enrollment.credential"), { force: true });
  await rm(journalPath);
  await syncDirectory(transactionRoot);
  // Rename after committing finalization so recovery never mistakes cleanup
  // leftovers for an installation that still needs backend activation.
  const completedRoot = join(
    layout.transactionRoot,
    `.install-${randomUUID()}.completed`,
  );
  try {
    await rename(transactionRoot, completedRoot);
    await syncDirectory(layout.transactionRoot);
    await rm(completedRoot, { recursive: true, force: true });
  } catch {
    console.warn("Worker completed installation cleanup deferred.");
  }
  return result as unknown as MacUserInstallationResult;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
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
    url.search !== "" ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && !(allowInsecureLoopback && loopback))
  )
    throw new TypeError("Worker backend URL is unsafe");
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
    validatedMaxWorkersPerGpu: 1 as const,
    capacityValidationFile: layout.capacityValidationPath,
    slots: [
      {
        workerId: enrollment.workerId,
        gpuId: "gpu0",
        slotIndex: 0,
        recipeIds: [...MAC_RECIPE_IDS],
        provider: "mps" as const,
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
  retainUploadCandidate = true,
  clock: MacQualificationClock = {},
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
  let uploadCandidatePath: string | undefined;
  const now = clock.now ?? (() => performance.now());
  const wait =
    clock.wait ??
    ((milliseconds) =>
      new Promise<void>((resolveWait) =>
        setTimeout(resolveWait, milliseconds),
      ));
  try {
    await launchAgent.bootstrap(layout.plistPath);
    const started = now();
    let observedRunning = false;
    while (now() - started < 2_400_000) {
      if (await exists(reportPath)) {
        const evidence = parseQualificationEvidence(
          JSON.parse(await readFile(reportPath, "utf8")) as unknown,
        );
        uploadCandidatePath = evidence.uploadCandidate.path;
        if (evidence.fixtureDigest !== fixtureSha256)
          throw new TypeError("Qualification fixture identity changed");
        return reportPath;
      }
      const service = await launchAgent.status();
      if (service.loaded && service.running) observedRunning = true;
      else if (observedRunning || now() - started >= 15_000) {
        // Publication may race this local service read. Completed evidence wins
        // even when the one-shot process has already exited normally.
        if (await exists(reportPath)) continue;
        throw new Error(
          "MPS qualification service stopped before publishing its report",
        );
      }
      await wait(250);
    }
    throw new Error("MPS qualification timed out");
  } finally {
    if ((await launchAgent.status()).loaded) await launchAgent.bootout();
    if (!retainUploadCandidate && uploadCandidatePath !== undefined)
      await cleanupQualificationWorkspace({
        workRoot: layout.workRoot,
        outputPath: uploadCandidatePath,
      }).catch(() => {
        console.warn("Worker qualification workspace cleanup deferred.");
      });
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
  try {
    await link(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
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
