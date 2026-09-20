import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  WORKER_PLATFORMS,
  type WorkerPlatform,
} from "../../protocol/v1/protocol.js";
import {
  WorkerEnrollmentClient,
  assertInstallationReport,
  type ExchangeResult,
  type WorkerInstallationReport,
} from "./enrollment-client.js";
import { downloadInstallationArtifacts } from "./artifact-download.js";
import { buildServiceRuntimeConfig } from "./runtime-config-builder.js";
import {
  createEnrollmentReport,
  parseQualificationEvidence,
} from "./report-builder.js";
import { uploadQualificationResult } from "./qualification-upload.js";
import { prepareInstallationRelease } from "./release-archive.js";
import { verifyWindowsRelease } from "../platform/windows/release-manifest.js";

const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/u;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REPORT_LIMIT_BYTES = 64 * 1024;
const STATE_FILE = ".enrollment-state.json";
const MACHINE_FILE = "machine.json";
const CREDENTIAL_FILE = "machine.credential";
const ARTIFACTS_DIRECTORY = "installation-artifacts";
const ARTIFACTS_FILE = "installation-artifacts.json";
const RUNTIME_CONFIG_FILE = "runtime.json";

export const ENROLLMENT_USAGE = `Usage:
  musicmute-worker prepare-installation --backend-url <api-base-url> --enrollment-file <absolute-path> --platform <darwin-arm64|windows-amd64> --output <existing-protected-directory> [--allow-insecure-loopback <true|false>]
  musicmute-worker enroll --backend-url <api-base-url> --enrollment-file <absolute-path> --report <absolute-path> --output <existing-protected-directory> [--allow-insecure-loopback <true|false>]
  musicmute-worker enroll --backend-url <api-base-url> --enrollment-file <absolute-path> --release <absolute-path> [--diagnostics <absolute-path>] --qualification <absolute-path> --label <name> [--group-id <id>] [--service-root <absolute-path>] --output <existing-protected-directory> [--allow-insecure-loopback <true|false>]`;

interface EnrollmentState {
  schemaVersion: 1;
  exchangeRequestId: string;
  reportRequestId: string;
  activationRequestId: string;
  qualificationGrantRequestId?: string;
  qualificationConfirmRequestId?: string;
  installationId?: string;
  installationCredential?: string;
  reportRevision?: number;
  machineId?: string;
  machineCredential?: string;
  credentialRevision?: number;
  workerId?: string;
}

export async function runInstallationPreparationCommand(
  arguments_: string[],
): Promise<void> {
  const flags = parseFlags(arguments_);
  exactFlags(
    flags,
    new Set([
      "backend-url",
      "enrollment-file",
      "platform",
      "output",
      "allow-insecure-loopback",
    ]),
  );
  const backendBaseUrl = requiredFlag(flags, "backend-url");
  const enrollmentPath = absoluteFlag(flags, "enrollment-file");
  const outputRoot = absoluteFlag(flags, "output");
  const platform = platformFlag(flags);
  const allowInsecureLoopback = booleanFlag(
    flags,
    "allow-insecure-loopback",
    false,
  );
  await assertProtectedOutputDirectory(outputRoot);
  const enrollmentCredential = await readCredential(
    enrollmentPath,
    "Enrollment credential",
  );
  const statePath = join(outputRoot, STATE_FILE);
  const initialState = await loadOrCreateState(statePath);
  const client = new WorkerEnrollmentClient({
    baseUrl: backendBaseUrl,
    allowInsecureLoopback,
  });
  const { exchange, state } = await exchangeInstallation(
    client,
    enrollmentCredential,
    initialState,
    statePath,
  );
  const manifest = await client.artifacts(
    exchange.installationId,
    exchange.credential,
    platform,
  );
  const artifactRoot = join(outputRoot, ARTIFACTS_DIRECTORY);
  await ensureProtectedDirectory(artifactRoot);
  const downloads = await downloadInstallationArtifacts(manifest, {
    outputRoot: artifactRoot,
    allowInsecureLoopback,
  });
  const release = await prepareInstallationRelease({
    archivePath: downloads.release.path,
    outputRoot: artifactRoot,
    platform,
    releaseVersion: manifest.release.version,
  });
  await writeStablePrivateFile(
    join(outputRoot, ARTIFACTS_FILE),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        installationId: state.installationId,
        platform,
        releaseVersion: manifest.release.version,
        release: {
          ...localArtifact(downloads.release, manifest.release.contentType),
          releaseRoot: release.path,
        },
        model: localArtifact(downloads.model, manifest.model.contentType),
        fixture: localArtifact(downloads.fixture, manifest.fixture.contentType),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    JSON.stringify({
      status: "ok",
      action: "prepare-installation",
      installationId: exchange.installationId,
      platform,
      releaseVersion: manifest.release.version,
      artifactRoot,
      releaseRoot: release.path,
      reused:
        Object.values(downloads).every((artifact) => artifact.reused) &&
        release.reused,
    }),
  );
}

export async function runEnrollmentCommand(
  arguments_: string[],
): Promise<void> {
  const flags = parseFlags(arguments_);
  exactFlags(
    flags,
    new Set([
      "backend-url",
      "enrollment-file",
      "report",
      "release",
      "diagnostics",
      "qualification",
      "label",
      "group-id",
      "service-root",
      "output",
      "allow-insecure-loopback",
    ]),
  );
  const backendBaseUrl = requiredFlag(flags, "backend-url");
  const enrollmentPath = absoluteFlag(flags, "enrollment-file");
  const outputRoot = absoluteFlag(flags, "output");
  const allowInsecureLoopback = booleanFlag(
    flags,
    "allow-insecure-loopback",
    false,
  );
  validateReportMode(flags, backendBaseUrl, allowInsecureLoopback);
  await assertProtectedOutputDirectory(outputRoot);
  const enrollmentCredential = await readCredential(
    enrollmentPath,
    "Enrollment credential",
  );
  const statePath = join(outputRoot, STATE_FILE);
  let state = await loadOrCreateState(statePath);
  state = {
    ...state,
    qualificationGrantRequestId:
      state.qualificationGrantRequestId ?? randomUUID(),
    qualificationConfirmRequestId:
      state.qualificationConfirmRequestId ?? randomUUID(),
  };
  const machineCredential =
    state.machineCredential ?? randomBytes(32).toString("base64url");
  const workerId = state.workerId ?? randomUUID();
  state = { ...state, machineCredential, workerId };
  await writePrivateJson(statePath, state);
  await writeStablePrivateFile(
    join(outputRoot, CREDENTIAL_FILE),
    `${machineCredential}\n`,
  );
  const client = new WorkerEnrollmentClient({
    baseUrl: backendBaseUrl,
    allowInsecureLoopback,
  });

  const exchanged = await exchangeInstallation(
    client,
    enrollmentCredential,
    state,
    statePath,
  );
  const exchange = exchanged.exchange;
  state = exchanged.state;

  if (exchange.phase !== "activated") {
    const report = flags.has("report")
      ? await reportFromFileMode(flags, backendBaseUrl, allowInsecureLoopback)
      : await reportAndUploadQualification(
          flags,
          client,
          exchange.installationId,
          exchange.credential,
          state,
        );
    const reported = await client.report(
      exchange.installationId,
      exchange.credential,
      state.reportRequestId,
      0,
      report,
    );
    assertStableNumber(
      state.reportRevision,
      reported.revision,
      "Installation report revision changed",
    );
    state = { ...state, reportRevision: reported.revision };
    await writePrivateJson(statePath, state);
  }
  if (state.reportRevision === undefined)
    throw new TypeError("Enrollment state is missing its report revision");

  const activated = await client.activate(
    exchange.installationId,
    exchange.credential,
    state.activationRequestId,
    state.reportRevision,
    createHash("sha256").update(machineCredential).digest("hex"),
  );
  assertStableValue(
    state.machineId,
    activated.machineId,
    "Machine identity changed",
  );
  assertStableNumber(
    state.credentialRevision,
    activated.credentialRevision,
    "Machine credential revision changed",
  );
  state = {
    ...state,
    machineId: activated.machineId,
    credentialRevision: activated.credentialRevision,
  };
  await writePrivateJson(statePath, state);
  await writeStablePrivateFile(
    join(outputRoot, MACHINE_FILE),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        backendBaseUrl,
        machineId: activated.machineId,
        credentialRevision: activated.credentialRevision,
      },
      null,
      2,
    )}\n`,
  );
  let runtimeConfigPath: string | undefined;
  if (!flags.has("report")) {
    runtimeConfigPath = await writeServiceRuntimeConfig(
      flags,
      outputRoot,
      backendBaseUrl,
      allowInsecureLoopback,
      activated.machineId,
      workerId,
    );
  }
  console.log(
    JSON.stringify({
      status: "ok",
      action: "enroll",
      machineId: activated.machineId,
      credentialRevision: activated.credentialRevision,
      replayed: exchange.replayed || activated.replayed,
      outputRoot,
      ...(runtimeConfigPath === undefined ? {} : { runtimeConfigPath }),
    }),
  );
}

async function reportAndUploadQualification(
  flags: ReadonlyMap<string, string>,
  client: WorkerEnrollmentClient,
  installationId: string,
  installationCredential: string,
  state: EnrollmentState,
): Promise<WorkerInstallationReport> {
  if (
    state.qualificationGrantRequestId === undefined ||
    state.qualificationConfirmRequestId === undefined
  )
    throw new TypeError("Enrollment state is missing qualification requests");
  const qualificationPath = absoluteFlag(flags, "qualification");
  const qualification = parseQualificationEvidence(
    await readBoundedJson(qualificationPath, "Qualification report"),
  );
  await uploadQualificationResult({
    client,
    installationId,
    installationCredential,
    grantRequestId: state.qualificationGrantRequestId,
    confirmRequestId: state.qualificationConfirmRequestId,
    outputPath: qualification.uploadCandidate.path,
    expectedBytes: qualification.uploadCandidate.resultBytes,
    expectedSha256: qualification.uploadCandidate.resultDigest,
  });
  return await reportFromRuntimeMode(flags);
}

async function exchangeInstallation(
  client: WorkerEnrollmentClient,
  enrollmentCredential: string,
  state: EnrollmentState,
  statePath: string,
): Promise<{ exchange: ExchangeResult; state: EnrollmentState }> {
  const exchange = await client.exchange(
    enrollmentCredential,
    state.exchangeRequestId,
  );
  assertStableValue(
    state.installationId,
    exchange.installationId,
    "Installation identity changed",
  );
  assertStableValue(
    state.installationCredential,
    exchange.credential,
    "Installation credential changed",
  );
  const updated = {
    ...state,
    installationId: exchange.installationId,
    installationCredential: exchange.credential,
  };
  await writePrivateJson(statePath, updated);
  return { exchange, state: updated };
}

function localArtifact(
  artifact: { path: string; bytes: number; sha256: string },
  contentType: string,
) {
  return {
    path: artifact.path,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    contentType,
  };
}

async function reportFromFileMode(
  flags: ReadonlyMap<string, string>,
  backendBaseUrl: string,
  allowInsecureLoopback: boolean,
): Promise<WorkerInstallationReport> {
  if (!allowInsecureLoopback || !isLoopbackUrl(backendBaseUrl))
    throw new TypeError("Prebuilt reports are restricted to loopback testing");
  if (
    [
      "release",
      "diagnostics",
      "qualification",
      "label",
      "group-id",
      "service-root",
    ].some((name) => flags.has(name))
  )
    throw new TypeError("Enrollment report modes cannot be combined");
  return await readReport(absoluteFlag(flags, "report"));
}

function validateReportMode(
  flags: ReadonlyMap<string, string>,
  backendBaseUrl: string,
  allowInsecureLoopback: boolean,
): void {
  if (flags.has("report")) {
    if (!allowInsecureLoopback || !isLoopbackUrl(backendBaseUrl))
      throw new TypeError(
        "Prebuilt reports are restricted to loopback testing",
      );
    if (
      [
        "release",
        "diagnostics",
        "qualification",
        "label",
        "group-id",
        "service-root",
      ].some((name) => flags.has(name))
    )
      throw new TypeError("Enrollment report modes cannot be combined");
    absoluteFlag(flags, "report");
    return;
  }
  absoluteFlag(flags, "release");
  if (flags.has("diagnostics")) absoluteFlag(flags, "diagnostics");
  absoluteFlag(flags, "qualification");
  requiredFlag(flags, "label");
}

function isLoopbackUrl(value: string): boolean {
  const url = new URL(value);
  return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

async function reportFromRuntimeMode(
  flags: ReadonlyMap<string, string>,
): Promise<WorkerInstallationReport> {
  const groupId = flags.get("group-id");
  return await createEnrollmentReport({
    releaseRoot: absoluteFlag(flags, "release"),
    ...(flags.has("diagnostics")
      ? { diagnosticsPath: absoluteFlag(flags, "diagnostics") }
      : {}),
    qualificationPath: absoluteFlag(flags, "qualification"),
    label: requiredFlag(flags, "label"),
    ...(groupId === undefined ? {} : { groupId }),
  });
}

async function writeServiceRuntimeConfig(
  flags: ReadonlyMap<string, string>,
  outputRoot: string,
  backendBaseUrl: string,
  allowInsecureLoopback: boolean,
  machineId: string,
  workerId: string,
): Promise<string> {
  const qualification = parseQualificationEvidence(
    await readBoundedJson(
      absoluteFlag(flags, "qualification"),
      "Qualification report",
    ),
  );
  const releaseRoot = absoluteFlag(flags, "release");
  const releaseVersion =
    qualification.platform === "windows-amd64"
      ? (await verifyWindowsRelease(releaseRoot)).releaseVersion
      : undefined;
  const serviceRoot = flags.has("service-root")
    ? absoluteFlag(flags, "service-root")
    : undefined;
  const document = buildServiceRuntimeConfig({
    platform: qualification.platform,
    backendBaseUrl,
    machineId,
    workerId,
    ...(serviceRoot === undefined ? {} : { installRoot: serviceRoot }),
    ...(releaseVersion === undefined ? {} : { releaseVersion }),
    allowInsecureLoopback,
  });
  const path = join(outputRoot, RUNTIME_CONFIG_FILE);
  await writeStablePrivateFile(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}

export function enrollmentCommandErrorSummary(error: unknown): string {
  if (!(error instanceof Error)) return "operation failed";
  const message = error.message.replaceAll(/[\r\n\t]/gu, " ").slice(0, 240);
  if (
    [
      "Enrollment ",
      "Installation ",
      "Machine ",
      "Worker ",
      "Output ",
      "Report ",
    ].some((prefix) => message.startsWith(prefix))
  )
    return message;
  return "operation failed";
}

async function readReport(path: string): Promise<WorkerInstallationReport> {
  const parsed = await readBoundedJson(path, "Report");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new TypeError("Report file must contain an object");
  const report = parsed as WorkerInstallationReport;
  assertInstallationReport(report);
  return report;
}

async function readBoundedJson(path: string, label: string): Promise<unknown> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > REPORT_LIMIT_BYTES
  )
    throw new TypeError(`${label} file is unsafe`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new TypeError(`${label} file is not valid JSON`);
  }
  return parsed;
}

async function readCredential(path: string, label: string): Promise<string> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 43 ||
    info.size > 128
  )
    throw new TypeError(`${label} file is unsafe`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new TypeError(`${label} file permissions are unsafe`);
  const value = (await readFile(path, "utf8")).trim();
  if (!CREDENTIAL.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

async function assertProtectedOutputDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new TypeError("Output directory is unsafe");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    throw new TypeError("Output directory permissions are unsafe");
}

async function ensureProtectedDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  await assertProtectedOutputDirectory(path);
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function loadOrCreateState(path: string): Promise<EnrollmentState> {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 2 ||
      info.size > REPORT_LIMIT_BYTES ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    )
      throw new TypeError("Enrollment state file is unsafe");
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parseState(parsed);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const state: EnrollmentState = {
    schemaVersion: 1,
    exchangeRequestId: randomUUID(),
    reportRequestId: randomUUID(),
    activationRequestId: randomUUID(),
    qualificationGrantRequestId: randomUUID(),
    qualificationConfirmRequestId: randomUUID(),
  };
  await writePrivateJson(path, state);
  return state;
}

function parseState(value: unknown): EnrollmentState {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Enrollment state is invalid");
  const state = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "exchangeRequestId",
    "reportRequestId",
    "activationRequestId",
    "qualificationGrantRequestId",
    "qualificationConfirmRequestId",
    "installationId",
    "installationCredential",
    "reportRevision",
    "machineId",
    "machineCredential",
    "credentialRevision",
    "workerId",
  ]);
  if (
    state.schemaVersion !== 1 ||
    Object.keys(state).some((key) => !allowed.has(key))
  )
    throw new TypeError("Enrollment state is invalid");
  for (const key of [
    "exchangeRequestId",
    "reportRequestId",
    "activationRequestId",
  ] as const) {
    if (typeof state[key] !== "string" || !UUID_V4.test(state[key]))
      throw new TypeError("Enrollment state request identity is invalid");
  }
  for (const key of [
    "qualificationGrantRequestId",
    "qualificationConfirmRequestId",
  ] as const) {
    if (
      state[key] !== undefined &&
      (typeof state[key] !== "string" || !UUID_V4.test(state[key]))
    )
      throw new TypeError(
        "Enrollment qualification request identity is invalid",
      );
  }
  for (const key of ["installationId", "machineId", "workerId"] as const) {
    if (
      state[key] !== undefined &&
      (typeof state[key] !== "string" || !UUID_V4.test(state[key]))
    )
      throw new TypeError("Enrollment state resource identity is invalid");
  }
  for (const key of ["installationCredential", "machineCredential"] as const) {
    if (
      state[key] !== undefined &&
      (typeof state[key] !== "string" || !CREDENTIAL.test(state[key]))
    )
      throw new TypeError("Enrollment state credential is invalid");
  }
  for (const key of ["reportRevision", "credentialRevision"] as const) {
    if (
      state[key] !== undefined &&
      (typeof state[key] !== "number" ||
        !Number.isSafeInteger(state[key]) ||
        state[key] < 0)
    )
      throw new TypeError("Enrollment state revision is invalid");
  }
  return state as unknown as EnrollmentState;
}

async function writePrivateJson(
  path: string,
  value: EnrollmentState,
): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrivateFile(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeStablePrivateFile(
  path: string,
  value: string,
): Promise<void> {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    )
      throw new TypeError("Enrollment output file is unsafe");
    if ((await readFile(path, "utf8")) !== value)
      throw new TypeError("Enrollment output conflicts with existing state");
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseFlags(arguments_: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith("--") ||
      value.startsWith("--") ||
      flag.length < 3
    )
      throw new TypeError("Enrollment command arguments are invalid");
    const name = flag.slice(2);
    if (result.has(name))
      throw new TypeError(`Enrollment command flag is duplicated: --${name}`);
    result.set(name, value);
  }
  return result;
}

function exactFlags(
  flags: ReadonlyMap<string, string>,
  allowed: ReadonlySet<string>,
): void {
  for (const name of flags.keys()) {
    if (!allowed.has(name))
      throw new TypeError(`Enrollment command flag is unknown: --${name}`);
  }
}

function requiredFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = flags.get(name);
  if (value === undefined || value.length < 1 || value.trim() !== value)
    throw new TypeError(`Enrollment command flag is required: --${name}`);
  return value;
}

function absoluteFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = requiredFlag(flags, name);
  if (!isAbsolute(value))
    throw new TypeError(`Enrollment command path must be absolute: --${name}`);
  return value;
}

function platformFlag(flags: ReadonlyMap<string, string>): WorkerPlatform {
  const value = requiredFlag(flags, "platform");
  if (!WORKER_PLATFORMS.includes(value as WorkerPlatform))
    throw new TypeError("Enrollment command platform is invalid");
  return value as WorkerPlatform;
}

function booleanFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
  fallback: boolean,
): boolean {
  const value = flags.get(name);
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`Enrollment command boolean is invalid: --${name}`);
}

function assertStableValue(
  previous: string | undefined,
  current: string,
  message: string,
): void {
  if (previous !== undefined && previous !== current)
    throw new TypeError(message);
}

function assertStableNumber(
  previous: number | undefined,
  current: number,
  message: string,
): void {
  if (previous !== undefined && previous !== current)
    throw new TypeError(message);
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
