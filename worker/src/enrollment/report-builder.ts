import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { cpus, release, totalmem } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_RECIPE_IDS,
} from "../../protocol/v1/protocol.js";
import { runtimePlatformAdapter } from "../platform/runtime-adapter.js";
import {
  MAC_RELEASE_MANIFEST,
  verifyMacRelease,
} from "../platform/macos/release-manifest.js";
import {
  WINDOWS_RELEASE_MANIFEST,
  verifyWindowsRelease,
} from "../platform/windows/release-manifest.js";
import {
  assertInstallationReport,
  type WorkerHardwareReport,
  type WorkerInstallationReport,
} from "./enrollment-client.js";

const executeFile = promisify(execFile);
const FILE_LIMIT_BYTES = 64 * 1024;
const MANIFEST_LIMIT_BYTES = 16 * 1024 * 1024;
const COMMAND_LIMIT_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

interface ServiceDiagnostics {
  platform: "darwin" | "win32";
  architecture: "arm64" | "x64";
  onnxRuntime: string;
  provider: "CoreMLExecutionProvider" | "DmlExecutionProvider";
  modelSha256: string;
}

export interface QualificationEvidence {
  platform: "darwin-arm64" | "windows-amd64";
  provider: "coreml" | "directml";
  gpuId: string;
  releaseManifestDigest: string;
  modelDigest: string;
  fixtureDigest: string;
  runtimeDiagnostics?: ServiceDiagnostics;
  recipeIds: (typeof WORKER_RECIPE_IDS)[number][];
  uploadCandidate: QualificationUploadCandidate;
}

export interface QualificationUploadCandidate {
  path: string;
  resultDigest: string;
  resultBytes: number;
  contentType: "audio/mpeg";
}

export interface EnrollmentReportBaseOptions {
  releaseRoot: string;
  label: string;
  groupId?: string;
  host?: HostInformation;
  command?: CommandRunner;
}

export interface EnrollmentReportOptions extends EnrollmentReportBaseOptions {
  diagnosticsPath?: string;
  qualificationPath: string;
}

export interface EnrollmentReportDiagnosticsOptions extends EnrollmentReportBaseOptions {
  diagnostics: unknown;
  qualification: unknown;
}

export interface HostInformation {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  cpu: string;
  memoryBytes: number;
}

export type CommandRunner = (
  executable: string,
  arguments_: readonly string[],
) => Promise<string>;

export async function createEnrollmentReport(
  options: EnrollmentReportOptions,
): Promise<WorkerInstallationReport> {
  const qualification = JSON.parse(
    (await readBoundedFile(options.qualificationPath)).toString("utf8"),
  ) as unknown;
  const parsedQualification = parseQualificationEvidence(qualification);
  const diagnostics =
    options.diagnosticsPath === undefined
      ? parsedQualification.runtimeDiagnostics === undefined
        ? undefined
        : { status: "ok", ...parsedQualification.runtimeDiagnostics }
      : (JSON.parse(
          (await readBoundedFile(options.diagnosticsPath)).toString("utf8"),
        ) as unknown);
  if (diagnostics === undefined)
    throw new TypeError("Qualification runtime diagnostics are missing");
  return await createEnrollmentReportFromDiagnostics({
    ...options,
    diagnostics,
    qualification,
  });
}

export async function createEnrollmentReportFromDiagnostics(
  options: EnrollmentReportDiagnosticsOptions,
): Promise<WorkerInstallationReport> {
  const host = options.host ?? currentHost();
  const adapter = runtimePlatformAdapter(host);
  const releaseManifest =
    adapter.platform === "darwin"
      ? await verifyMacRelease(options.releaseRoot)
      : await verifyWindowsRelease(options.releaseRoot);
  const manifestName =
    adapter.platform === "darwin"
      ? MAC_RELEASE_MANIFEST
      : WINDOWS_RELEASE_MANIFEST;
  const manifestDigest = createHash("sha256")
    .update(
      await readBoundedFile(
        join(options.releaseRoot, manifestName),
        MANIFEST_LIMIT_BYTES,
      ),
    )
    .digest("hex");
  const packageValue = parsePackage(
    JSON.parse(
      (
        await readBoundedFile(join(options.releaseRoot, "app", "package.json"))
      ).toString("utf8"),
    ) as unknown,
  );
  const diagnostics = parseDiagnostics(options.diagnostics);
  assertDiagnosticsMatchHost(diagnostics, adapter.platform, adapter.provider);
  const qualification = parseQualificationEvidence(options.qualification);
  assertQualificationMatchesHost(
    qualification,
    adapter.platform,
    adapter.provider,
    manifestDigest,
    diagnostics.modelSha256,
  );
  const hardware = await collectHardware(host, options.command ?? runCommand);
  const report: WorkerInstallationReport = {
    label: boundedText(options.label, "machine label", 120),
    ...(options.groupId === undefined
      ? {}
      : { groupId: boundedText(options.groupId, "machine group ID", 100) }),
    hardware,
    runtime: {
      workerVersion: packageValue.version,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      manifestDigest,
      modelDigest: diagnostics.modelSha256,
      providerRuntimeVersion: `onnxruntime ${diagnostics.onnxRuntime}`,
    },
    capabilities: [
      {
        platform:
          adapter.platform === "darwin" ? "darwin-arm64" : "windows-amd64",
        provider: adapter.provider,
        gpuId: hardware.gpus[0]!.id,
        recipeIds: qualification.recipeIds,
        maxSlots: 1,
      },
    ],
    summary: `qualified ${adapter.id}; release ${releaseManifest.releaseVersion}; service-context Kim dispatch passed`,
  };
  assertInstallationReport(report);
  return report;
}

export function parseQualificationEvidence(
  value: unknown,
): QualificationEvidence {
  const object = strictRecord(
    value,
    new Set([
      "schemaVersion",
      "status",
      "platform",
      "provider",
      "gpuId",
      "directmlDeviceId",
      "serviceIdentity",
      "releaseManifestDigest",
      "modelDigest",
      "fixtureDigest",
      "runtimeDiagnostics",
      "providerDispatch",
      "recipes",
      "uploadCandidate",
      "totalSeconds",
    ]),
    "Qualification evidence",
  );
  if (object.schemaVersion !== 1 || object.status !== "PASS")
    throw new TypeError("Qualification evidence did not pass");
  const platform = oneOf(
    object.platform,
    ["darwin-arm64", "windows-amd64"] as const,
    "qualification platform",
  );
  const provider = oneOf(
    object.provider,
    ["coreml", "directml"] as const,
    "qualification provider",
  );
  const gpuId = boundedText(object.gpuId, "qualification GPU ID", 128);
  if (object.directmlDeviceId !== 0)
    throw new TypeError("Qualification device ID is invalid");
  const serviceIdentity = boundedText(
    object.serviceIdentity,
    "qualification service identity",
    100,
  );
  if (
    (platform === "darwin-arm64" && serviceIdentity !== "_musicmute") ||
    (platform === "windows-amd64" && serviceIdentity !== "S-1-5-19")
  )
    throw new TypeError("Qualification service identity is invalid");
  const modelDigest = sha256Text(
    object.modelDigest,
    "qualification model digest",
  );
  const releaseManifestDigest = sha256Text(
    object.releaseManifestDigest,
    "qualification release manifest digest",
  );
  const fixtureDigest = sha256Text(
    object.fixtureDigest,
    "qualification fixture digest",
  );
  const expectedProvider =
    provider === "coreml" ? "CoreMLExecutionProvider" : "DmlExecutionProvider";
  const runtimeDiagnostics =
    object.runtimeDiagnostics === undefined
      ? undefined
      : parseDiagnostics(object.runtimeDiagnostics);
  if (
    runtimeDiagnostics !== undefined &&
    (runtimeDiagnostics.platform !==
      (platform === "darwin-arm64" ? "darwin" : "win32") ||
      runtimeDiagnostics.architecture !==
        (platform === "darwin-arm64" ? "arm64" : "x64") ||
      runtimeDiagnostics.provider !== expectedProvider ||
      runtimeDiagnostics.modelSha256 !== modelDigest)
  )
    throw new TypeError(
      "Qualification runtime diagnostics do not match qualification",
    );
  positiveFinite(object.totalSeconds, "qualification duration");

  const dispatch = strictRecord(
    object.providerDispatch,
    new Set([
      "expectedProvider",
      "profileCount",
      "acceleratedNodeEvents",
      "cpuNodeEvents",
      "proven",
    ]),
    "Qualification provider dispatch",
  );
  if (
    dispatch.expectedProvider !== expectedProvider ||
    dispatch.proven !== true ||
    boundedInteger(
      dispatch.profileCount,
      1,
      32,
      "qualification profile count",
    ) < 1 ||
    boundedInteger(
      dispatch.acceleratedNodeEvents,
      1,
      Number.MAX_SAFE_INTEGER,
      "qualification accelerated node count",
    ) < 1 ||
    boundedInteger(
      dispatch.cpuNodeEvents,
      0,
      Number.MAX_SAFE_INTEGER,
      "qualification CPU node count",
    ) !== 0
  )
    throw new TypeError("Accelerated provider dispatch was not proven");

  if (
    !Array.isArray(object.recipes) ||
    object.recipes.length !== WORKER_RECIPE_IDS.length
  )
    throw new TypeError("Qualification recipe evidence is incomplete");
  const recipeResults = object.recipes.map((item) => {
    const recipe = strictRecord(
      item,
      new Set([
        "recipeId",
        "recipeDigest",
        "resultDigest",
        "resultBytes",
        "sourceDurationSeconds",
        "outputDurationSeconds",
        "endToEndSeconds",
      ]),
      "Qualification recipe result",
    );
    const recipeId = oneOf(
      recipe.recipeId,
      WORKER_RECIPE_IDS,
      "qualification recipe ID",
    );
    sha256Text(recipe.recipeDigest, "qualification recipe digest");
    const resultDigest = sha256Text(
      recipe.resultDigest,
      "qualification result digest",
    );
    const resultBytes = boundedInteger(
      recipe.resultBytes,
      1,
      Number.MAX_SAFE_INTEGER,
      "qualification result size",
    );
    positiveFinite(
      recipe.sourceDurationSeconds,
      "qualification source duration",
    );
    positiveFinite(
      recipe.outputDurationSeconds,
      "qualification output duration",
    );
    positiveFinite(recipe.endToEndSeconds, "qualification recipe duration");
    return { recipeId, resultDigest, resultBytes };
  });
  const recipeIds = recipeResults.map((result) => result.recipeId);
  if (
    new Set(recipeIds).size !== WORKER_RECIPE_IDS.length ||
    WORKER_RECIPE_IDS.some((recipeId) => !recipeIds.includes(recipeId))
  )
    throw new TypeError("Qualification recipe evidence is incomplete");
  const candidateValue = strictRecord(
    object.uploadCandidate,
    new Set(["path", "resultDigest", "resultBytes", "contentType"]),
    "Qualification upload candidate",
  );
  const candidatePath = boundedText(
    candidateValue.path,
    "qualification upload candidate path",
    4096,
  );
  if (candidateValue.contentType !== "audio/mpeg")
    throw new TypeError(
      "Qualification upload candidate content type is invalid",
    );
  const uploadCandidate: QualificationUploadCandidate = {
    path: candidatePath,
    resultDigest: sha256Text(
      candidateValue.resultDigest,
      "qualification upload candidate digest",
    ),
    resultBytes: boundedInteger(
      candidateValue.resultBytes,
      1,
      30_000_000,
      "qualification upload candidate size",
    ),
    contentType: "audio/mpeg",
  };
  const sourceResult = recipeResults.find(
    (result) => result.recipeId === "kim-vocals-v1",
  );
  const candidateIsAbsolute =
    platform === "windows-amd64"
      ? /^[A-Za-z]:\\[^\r\n]*$/u.test(candidatePath)
      : isAbsolute(candidatePath);
  if (
    !candidateIsAbsolute ||
    sourceResult === undefined ||
    sourceResult.resultDigest !== uploadCandidate.resultDigest ||
    sourceResult.resultBytes !== uploadCandidate.resultBytes
  )
    throw new TypeError("Qualification upload candidate is invalid");
  return {
    platform,
    provider,
    gpuId,
    releaseManifestDigest,
    modelDigest,
    fixtureDigest,
    ...(runtimeDiagnostics === undefined ? {} : { runtimeDiagnostics }),
    recipeIds,
    uploadCandidate,
  };
}

function assertQualificationMatchesHost(
  qualification: QualificationEvidence,
  platform: NodeJS.Platform,
  provider: "coreml" | "directml",
  releaseManifestDigest: string,
  modelDigest: string,
): void {
  const expectedPlatform =
    platform === "darwin" ? "darwin-arm64" : "windows-amd64";
  if (
    qualification.platform !== expectedPlatform ||
    qualification.provider !== provider ||
    qualification.gpuId !== "gpu0" ||
    qualification.releaseManifestDigest !== releaseManifestDigest ||
    qualification.modelDigest !== modelDigest
  )
    throw new TypeError(
      "Qualification evidence does not match the host runtime",
    );
}

export function currentHost(): HostInformation {
  const cpu = cpus()[0]?.model.trim();
  if (!cpu) throw new TypeError("Host CPU identity is unavailable");
  return {
    platform: process.platform,
    arch: process.arch,
    release: release(),
    cpu,
    memoryBytes: totalmem(),
  };
}

async function collectHardware(
  host: HostInformation,
  command: CommandRunner,
): Promise<WorkerHardwareReport> {
  const base = {
    os: host.platform === "darwin" ? "Darwin" : "Windows",
    osBuild: boundedText(host.release, "host OS build", 100),
    architecture: host.platform === "darwin" ? "arm64" : "x86_64",
    cpu: boundedText(host.cpu, "host CPU", 200),
    memoryBytes: boundedInteger(
      host.memoryBytes,
      1,
      Number.MAX_SAFE_INTEGER,
      "host memory",
    ),
  };
  if (host.platform === "darwin") {
    const value = JSON.parse(
      await command("/usr/sbin/system_profiler", [
        "SPDisplaysDataType",
        "-json",
      ]),
    ) as unknown;
    const root = strictRecord(
      value,
      new Set(["SPDisplaysDataType"]),
      "Mac display report",
      false,
    );
    if (!Array.isArray(root.SPDisplaysDataType))
      throw new TypeError("Mac display report is invalid");
    const candidates = root.SPDisplaysDataType.map((item) =>
      strictRecord(item, new Set(), "Mac GPU", false),
    ).filter(
      (item) =>
        typeof item.sppci_model === "string" &&
        /^Apple M\d/u.test(item.sppci_model),
    );
    if (candidates.length !== 1)
      throw new TypeError("Exactly one qualified Apple GPU is required");
    return {
      ...base,
      gpus: [
        {
          id: "gpu0",
          name: boundedText(candidates[0]!.sppci_model, "Mac GPU name", 200),
          driverVersion: base.osBuild,
        },
      ],
    };
  }
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const value = JSON.parse(
    await command(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress",
    ]),
  ) as unknown;
  const items = (Array.isArray(value) ? value : [value]).map((item) =>
    strictRecord(item, new Set(["Name", "DriverVersion"]), "Windows GPU"),
  );
  const candidates = items.filter(
    (item) =>
      typeof item.Name === "string" && /Radeon\s+RX\s+580/iu.test(item.Name),
  );
  if (candidates.length !== 1)
    throw new TypeError("Exactly one qualified Radeon RX 580 is required");
  return {
    ...base,
    gpus: [
      {
        id: "gpu0",
        name: boundedText(candidates[0]!.Name, "Windows GPU name", 200),
        driverVersion: boundedText(
          candidates[0]!.DriverVersion,
          "Windows GPU driver",
          100,
        ),
      },
    ],
  };
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
): Promise<string> {
  const result = await executeFile(executable, [...arguments_], {
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: COMMAND_LIMIT_BYTES,
    windowsHide: true,
  });
  return result.stdout;
}

async function readBoundedFile(
  path: string,
  maximumBytes = FILE_LIMIT_BYTES,
): Promise<Buffer> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > maximumBytes
  )
    throw new TypeError("Enrollment report input file is unsafe");
  return await readFile(path);
}

function parsePackage(value: unknown): { version: string } {
  const object = strictRecord(value, new Set(), "Worker package", false);
  return { version: boundedText(object.version, "worker version", 100) };
}

function parseDiagnostics(value: unknown): ServiceDiagnostics {
  const object = strictRecord(
    value,
    new Set([
      "status",
      "platform",
      "architecture",
      "python",
      "onnxRuntime",
      "audioSeparator",
      "provider",
      "modelSha256",
      "modelBytes",
      "ffmpeg",
      "ffprobe",
      "modelPath",
    ]),
    "Service diagnostics",
  );
  if (object.status !== "ok")
    throw new TypeError("Service diagnostics did not pass");
  const platform = oneOf(
    object.platform,
    ["darwin", "win32"] as const,
    "diagnostic platform",
  );
  const architecture = oneOf(
    object.architecture,
    ["arm64", "x64"] as const,
    "diagnostic architecture",
  );
  const provider = oneOf(
    object.provider,
    ["CoreMLExecutionProvider", "DmlExecutionProvider"] as const,
    "diagnostic provider",
  );
  const modelSha256 = boundedText(
    object.modelSha256,
    "diagnostic model digest",
    64,
  );
  if (!SHA256.test(modelSha256))
    throw new TypeError("Diagnostic model digest is invalid");
  return {
    platform,
    architecture,
    provider,
    modelSha256,
    onnxRuntime: boundedText(object.onnxRuntime, "ONNX Runtime version", 100),
  };
}

function assertDiagnosticsMatchHost(
  diagnostics: ServiceDiagnostics,
  platform: NodeJS.Platform,
  provider: "coreml" | "directml",
): void {
  if (
    (platform === "darwin" &&
      (diagnostics.platform !== "darwin" ||
        diagnostics.architecture !== "arm64" ||
        diagnostics.provider !== "CoreMLExecutionProvider")) ||
    (platform === "win32" &&
      (diagnostics.platform !== "win32" ||
        diagnostics.architecture !== "x64" ||
        diagnostics.provider !== "DmlExecutionProvider")) ||
    (provider === "coreml" &&
      diagnostics.provider !== "CoreMLExecutionProvider") ||
    (provider === "directml" && diagnostics.provider !== "DmlExecutionProvider")
  )
    throw new TypeError("Service diagnostics do not match the host adapter");
}

function strictRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
  rejectUnknown = true,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError(`${label} must be a plain object`);
  const result = value as Record<string, unknown>;
  if (rejectUnknown && Object.keys(result).some((key) => !allowed.has(key)))
    throw new TypeError(`${label} contains an unknown field`);
  return result;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value))
    throw new TypeError(`${label} is invalid`);
  return value as T[number];
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  )
    throw new TypeError(`${label} is invalid`);
  return value;
}

function sha256Text(value: unknown, label: string): string {
  const text = boundedText(value, label, 64);
  if (!SHA256.test(text)) throw new TypeError(`${label} is invalid`);
  return text;
}

function positiveFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new TypeError(`${label} is invalid`);
  return value;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new TypeError(`${label} is invalid`);
  return value;
}
