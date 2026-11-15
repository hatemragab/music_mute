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
import {
  runtimePlatformAdapter,
  type RuntimeProfile,
} from "../platform/runtime-adapter.js";
import { MAC_RELEASE_MANIFEST } from "../platform/macos/release-manifest.js";
import { verifyManagedMacRelease as verifyMacRelease } from "../platform/macos/app-installation-binding.js";
import { DEFAULT_MAC_RECIPE_ID } from "../platform/macos/runtime-recipes.js";
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
  provider: "MPS" | "DmlExecutionProvider";
  torch?: string;
  modelSha256: string;
}

export interface QualificationEvidence {
  runtimeProfile: RuntimeProfile;
  directmlDeviceId: number;
  serviceIdentity: string;
  gpuIdentity?: DirectmlGpuIdentity;
  platform: "darwin-arm64" | "windows-amd64";
  provider: "mps" | "directml";
  gpuId: string;
  releaseManifestDigest: string;
  modelDigest: string;
  fixtureDigest: string;
  runtimeDiagnostics?: ServiceDiagnostics;
  recipeIds: (typeof WORKER_RECIPE_IDS)[number][];
  recipeDigests: Record<string, string>;
  uploadCandidate: QualificationUploadCandidate;
}

export interface QualificationUploadCandidate {
  path: string;
  resultDigest: string;
  resultBytes: number;
  contentType: "audio/mpeg";
}

export interface EnrollmentReportBaseOptions {
  runtimeProfile?: RuntimeProfile;
  expectedUserSid?: string;
  expectedFixtureDigest?: string;
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

export interface WindowsUserRuntimeReportObservations {
  label: string;
  host: HostInformation;
  expectedUserSid: string;
  expectedFixtureDigest: string;
  workerVersion: string;
  manifestDigest: string;
  modelDigest: string;
  diagnostics: unknown;
  qualification: unknown;
  currentGpus: readonly unknown[];
  recipeDigests: Readonly<Record<(typeof WORKER_RECIPE_IDS)[number], string>>;
}

/** Validated report data only. The Store caller must independently retain its
 * genuine protected code owner and reobserve its actual native SID/GPU before
 * and after this function. These observations cannot grant code or enrollment. */
export function createWindowsUserReportFromRuntimeObservations(
  options: WindowsUserRuntimeReportObservations,
): WorkerInstallationReport {
  const adapter = runtimePlatformAdapter(options.host, "windows-user"),
    diagnostics = parseDiagnostics(options.diagnostics),
    qualification = parseQualificationEvidence(options.qualification, {
      runtimeProfile: "windows-user",
      expectedUserSid: options.expectedUserSid,
      expectedFixtureDigest: options.expectedFixtureDigest,
    });
  assertDiagnosticsMatchHost(diagnostics, adapter.platform, adapter.provider);
  if (!SHA256.test(options.manifestDigest) || !SHA256.test(options.modelDigest))
    throw new TypeError("Windows user runtime digests are invalid");
  assertQualificationMatchesHost(
    qualification,
    adapter.platform,
    adapter.provider,
    options.manifestDigest,
    options.modelDigest,
  );
  if (
    !qualification.runtimeDiagnostics ||
    qualification.runtimeDiagnostics.onnxRuntime !== diagnostics.onnxRuntime ||
    diagnostics.modelSha256 !== options.modelDigest
  )
    throw new TypeError("Qualification provider runtime version changed");
  const recipes = strictRecord(
    options.recipeDigests,
    new Set(WORKER_RECIPE_IDS),
    "Windows user recipe catalog",
  );
  if (
    WORKER_RECIPE_IDS.some(
      (recipe) => recipes[recipe] !== qualification.recipeDigests[recipe],
    )
  )
    throw new TypeError(
      "Qualification recipes do not match the verified runtime",
    );
  const selected = resolveQualifiedGpuIdentity(
      qualification.gpuIdentity!,
      options.currentGpus,
    ),
    hardware = qualifiedWindowsHardware(options.host, qualification, selected);
  const report: WorkerInstallationReport = {
    label: boundedText(options.label, "machine label", 120),
    hardware,
    runtime: {
      installationProfile: "windows-user",
      workerVersion: parsePackage({ version: options.workerVersion }).version,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      manifestDigest: options.manifestDigest,
      modelDigest: options.modelDigest,
      providerRuntimeVersion: `onnxruntime ${diagnostics.onnxRuntime}`,
    },
    capabilities: [
      {
        platform: "windows-amd64",
        provider: "directml",
        gpuId: hardware.gpus[0]!.id,
        recipeIds: qualification.recipeIds,
        maxSlots: 1,
      },
    ],
    summary:
      "qualified Windows user DirectML runtime; current-user Kim dispatch passed",
  };
  assertInstallationReport(report);
  return report;
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

export interface DirectmlGpuIdentity {
  source: "DXGI EnumAdapters1/GetDesc1";
  deviceIndex: number;
  name: string;
  vendorId: number;
  deviceId: number;
  subsystemId: number;
  revision: number;
  driverVersion: string;
  luid: string;
  dedicatedVideoMemoryBytes: number;
  sharedSystemMemoryLimitBytes: number;
}

export interface QualificationContext {
  runtimeProfile?: RuntimeProfile;
  expectedUserSid?: string;
  expectedFixtureDigest?: string;
}

export async function createEnrollmentReport(
  options: EnrollmentReportOptions,
): Promise<WorkerInstallationReport> {
  const qualification = JSON.parse(
    (await readBoundedFile(options.qualificationPath)).toString("utf8"),
  ) as unknown;
  const parsedQualification = parseQualificationEvidence(
    qualification,
    options,
  );
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
  const adapter = runtimePlatformAdapter(host, options.runtimeProfile);
  const releaseManifest =
    adapter.platform === "darwin"
      ? await verifyMacRelease(options.releaseRoot)
      : await verifyWindowsRelease(
          options.releaseRoot,
          options.runtimeProfile === "windows-user"
            ? "windows-user"
            : undefined,
        );
  const manifestName =
    adapter.platform === "darwin"
      ? MAC_RELEASE_MANIFEST
      : WINDOWS_RELEASE_MANIFEST;
  if (
    options.runtimeProfile === "windows-user" &&
    (releaseManifest as { installationProfile?: unknown })
      .installationProfile !== "windows-user"
  )
    throw new TypeError(
      "Consumer qualification requires a Windows user release",
    );
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
  const qualification = parseQualificationEvidence(
    options.qualification,
    options,
  );
  assertQualificationMatchesHost(
    qualification,
    adapter.platform,
    adapter.provider,
    manifestDigest,
    diagnostics.modelSha256,
  );
  if (
    qualification.runtimeProfile === "windows-user" &&
    (qualification.runtimeDiagnostics === undefined ||
      qualification.runtimeDiagnostics.onnxRuntime !== diagnostics.onnxRuntime)
  )
    throw new TypeError("Qualification provider runtime version changed");
  const hardware = await collectHardware(
    host,
    options.command ?? runCommand,
    qualification,
    options,
  );
  const report: WorkerInstallationReport = {
    label: boundedText(options.label, "machine label", 120),
    ...(options.groupId === undefined
      ? {}
      : { groupId: boundedText(options.groupId, "machine group ID", 100) }),
    hardware,
    runtime: {
      ...(options.runtimeProfile === "windows-user"
        ? { installationProfile: "windows-user" as const }
        : {}),
      workerVersion: packageValue.version,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      manifestDigest,
      modelDigest: diagnostics.modelSha256,
      providerRuntimeVersion:
        diagnostics.provider === "MPS"
          ? `torch ${diagnostics.torch}`
          : `onnxruntime ${diagnostics.onnxRuntime}`,
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
    summary: `qualified ${adapter.id}; release ${releaseManifest.releaseVersion}; ${qualification.runtimeProfile === "windows-user" ? "current-user" : "service-context"} Kim dispatch passed`,
  };
  assertInstallationReport(report);
  return report;
}

export function parseQualificationEvidence(
  value: unknown,
  context: QualificationContext = {},
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
      "preloadSeconds",
      "totalSeconds",
      "runtimeProfile",
      "gpuIdentity",
      "gpuOnlyPolicy",
      "resourceObservations",
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
    ["mps", "directml"] as const,
    "qualification provider",
  );
  const gpuId = boundedText(object.gpuId, "qualification GPU ID", 128);
  const runtimeProfile = context.runtimeProfile ?? "legacy-service";
  if (runtimeProfile !== "legacy-service" && runtimeProfile !== "windows-user")
    throw new TypeError("Qualification runtime profile is unsupported");
  if (
    runtimeProfile === "legacy-service" &&
    object.runtimeProfile !== undefined
  )
    throw new TypeError(
      "Consumer qualification requires an explicit user context",
    );
  if (
    runtimeProfile === "windows-user" &&
    (object.runtimeProfile !== runtimeProfile ||
      platform !== "windows-amd64" ||
      provider !== "directml")
  )
    throw new TypeError("Qualification user runtime profile is invalid");
  if (runtimeProfile === "legacy-service" && object.directmlDeviceId !== 0)
    throw new TypeError("Qualification device ID is invalid");
  const directmlDeviceId = boundedInteger(
    object.directmlDeviceId,
    0,
    runtimeProfile === "windows-user" ? 15 : 0,
    "qualification device ID",
  );
  const serviceIdentity = boundedText(
    object.serviceIdentity,
    "qualification service identity",
    100,
  );
  if (
    (platform === "darwin-arm64" &&
      (serviceIdentity === "root" ||
        !/^[A-Za-z_][A-Za-z0-9._-]{0,99}$/u.test(serviceIdentity))) ||
    (platform === "windows-amd64" &&
      runtimeProfile === "legacy-service" &&
      serviceIdentity !== "S-1-5-19") ||
    (runtimeProfile === "windows-user" &&
      (serviceIdentity !== context.expectedUserSid ||
        !/^S-1-(?:\d+-){1,14}\d+$/u.test(serviceIdentity) ||
        ["S-1-5-18", "S-1-5-19", "S-1-5-20"].includes(serviceIdentity)))
  )
    throw new TypeError("Qualification service identity is invalid");
  const gpuIdentity =
    runtimeProfile === "windows-user"
      ? parseDirectmlGpuIdentity(object.gpuIdentity)
      : undefined;
  if (gpuIdentity !== undefined) {
    if (
      gpuIdentity.deviceIndex !== directmlDeviceId ||
      gpuId !== `dxgi-${gpuIdentity.luid}` ||
      object.gpuOnlyPolicy !== "onnxruntime-disable-cpu-fallback-v1"
    )
      throw new TypeError("Qualification GPU identity is invalid");
    const observations = strictRecord(
      object.resourceObservations,
      new Set([
        "dedicatedVideoMemoryLimitBytes",
        "sharedSystemMemoryLimitBytes",
        "inferenceSlots",
      ]),
      "Qualification GPU observations",
    );
    if (
      observations.inferenceSlots !== 1 ||
      observations.dedicatedVideoMemoryLimitBytes !==
        gpuIdentity.dedicatedVideoMemoryBytes ||
      observations.sharedSystemMemoryLimitBytes !==
        gpuIdentity.sharedSystemMemoryLimitBytes
    )
      throw new TypeError("Qualification GPU observations are invalid");
  } else if (
    object.gpuIdentity !== undefined ||
    object.resourceObservations !== undefined
  ) {
    throw new TypeError(
      "Consumer GPU evidence requires an explicit user context",
    );
  }
  if (
    object.gpuOnlyPolicy !== undefined &&
    (provider !== "directml" ||
      object.gpuOnlyPolicy !== "onnxruntime-disable-cpu-fallback-v1")
  )
    throw new TypeError("Qualification GPU-only policy is invalid");
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
  if (
    runtimeProfile === "windows-user" &&
    (context.expectedFixtureDigest === undefined ||
      fixtureDigest !==
        sha256Text(context.expectedFixtureDigest, "expected fixture digest"))
  )
    throw new TypeError(
      "Qualification fixture does not match the approved fixture",
    );
  const expectedProvider = provider === "mps" ? "MPS" : "DmlExecutionProvider";
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
  if (object.preloadSeconds !== undefined)
    positiveFinite(object.preloadSeconds, "qualification preload duration");

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
      provider === "mps" ? 0 : 1,
      32,
      "qualification profile count",
    ) < (provider === "mps" ? 0 : 1) ||
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
        "outputBitrateKbps",
        "stageTimings",
      ]),
      "Qualification recipe result",
    );
    const recipeId = oneOf(
      recipe.recipeId,
      WORKER_RECIPE_IDS,
      "qualification recipe ID",
    );
    const recipeDigest = sha256Text(
      recipe.recipeDigest,
      "qualification recipe digest",
    );
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
    if (recipe.outputBitrateKbps !== undefined)
      boundedInteger(
        recipe.outputBitrateKbps,
        160,
        160,
        "qualification output bitrate",
      );
    if (recipe.stageTimings !== undefined) {
      const timings = strictRecord(
        recipe.stageTimings,
        new Set([
          "modelValidation",
          "inputIdentity",
          "mediaValidation",
          "preparation",
          "modelLoad",
          "separation",
          "denoise",
          "trim",
          "encode",
          "outputValidation",
        ]),
        "Qualification stage timings",
      );
      for (const [stage, seconds] of Object.entries(timings))
        positiveFinite(seconds, `qualification ${stage} duration`);
    }
    return { recipeId, recipeDigest, resultDigest, resultBytes };
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
    (result) => result.recipeId === DEFAULT_MAC_RECIPE_ID,
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
    runtimeProfile,
    directmlDeviceId,
    serviceIdentity,
    ...(gpuIdentity === undefined ? {} : { gpuIdentity }),
    platform,
    provider,
    gpuId,
    releaseManifestDigest,
    modelDigest,
    fixtureDigest,
    ...(runtimeDiagnostics === undefined ? {} : { runtimeDiagnostics }),
    recipeIds,
    recipeDigests: Object.fromEntries(
      recipeResults.map((recipe) => [recipe.recipeId, recipe.recipeDigest]),
    ),
    uploadCandidate,
  };
}

function assertQualificationMatchesHost(
  qualification: QualificationEvidence,
  platform: NodeJS.Platform,
  provider: "mps" | "directml",
  releaseManifestDigest: string,
  modelDigest: string,
): void {
  const expectedPlatform =
    platform === "darwin" ? "darwin-arm64" : "windows-amd64";
  if (
    qualification.platform !== expectedPlatform ||
    qualification.provider !== provider ||
    (qualification.runtimeProfile === "legacy-service" &&
      qualification.gpuId !== "gpu0") ||
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

export function parseDirectmlGpuIdentity(value: unknown): DirectmlGpuIdentity {
  const gpu = strictRecord(
    value,
    new Set([
      "source",
      "deviceIndex",
      "name",
      "vendorId",
      "deviceId",
      "subsystemId",
      "revision",
      "driverVersion",
      "luid",
      "dedicatedVideoMemoryBytes",
      "sharedSystemMemoryLimitBytes",
    ]),
    "DirectML GPU identity",
  );
  if (gpu.source !== "DXGI EnumAdapters1/GetDesc1")
    throw new TypeError("DirectML GPU identity source is invalid");
  const name = boundedText(gpu.name, "DirectML GPU name", 128);
  const driverVersion = boundedText(
    gpu.driverVersion,
    "DirectML GPU driver",
    100,
  );
  const luid = boundedText(gpu.luid, "DirectML GPU LUID", 16);
  if (
    /\p{Cc}/u.test(name) ||
    !/^[a-f0-9]{16}$/u.test(luid) ||
    !/^\d{1,5}(?:\.\d{1,5}){3}$/u.test(driverVersion)
  )
    throw new TypeError("DirectML GPU identity is invalid");
  return {
    source: "DXGI EnumAdapters1/GetDesc1",
    deviceIndex: boundedInteger(gpu.deviceIndex, 0, 15, "DirectML GPU ordinal"),
    name,
    vendorId: boundedInteger(
      gpu.vendorId,
      1,
      0xffffffff,
      "DirectML GPU vendor",
    ),
    deviceId: boundedInteger(
      gpu.deviceId,
      0,
      0xffffffff,
      "DirectML GPU device",
    ),
    subsystemId: boundedInteger(
      gpu.subsystemId,
      0,
      0xffffffff,
      "DirectML GPU subsystem",
    ),
    revision: boundedInteger(
      gpu.revision,
      0,
      0xffffffff,
      "DirectML GPU revision",
    ),
    driverVersion,
    luid,
    dedicatedVideoMemoryBytes: boundedInteger(
      gpu.dedicatedVideoMemoryBytes,
      0,
      Number.MAX_SAFE_INTEGER,
      "DirectML dedicated GPU memory",
    ),
    sharedSystemMemoryLimitBytes: boundedInteger(
      gpu.sharedSystemMemoryLimitBytes,
      0,
      Number.MAX_SAFE_INTEGER,
      "DirectML shared GPU memory",
    ),
  };
}

export function resolveQualifiedGpuIdentity(
  qualified: DirectmlGpuIdentity,
  current: readonly unknown[],
): DirectmlGpuIdentity {
  const expected = parseDirectmlGpuIdentity(qualified);
  const adapters = current.map(parseDirectmlGpuIdentity);
  if (
    adapters.length > 16 ||
    new Set(adapters.map((gpu) => gpu.luid)).size !== adapters.length ||
    new Set(adapters.map((gpu) => gpu.deviceIndex)).size !== adapters.length
  )
    throw new TypeError("DirectML GPU enumeration is invalid");
  const binding = ({
    deviceIndex: _ordinal,
    ...identity
  }: DirectmlGpuIdentity) => JSON.stringify(identity);
  const matches = adapters.filter((gpu) => binding(gpu) === binding(expected));
  if (matches.length !== 1)
    throw new TypeError(
      "Qualified GPU or driver changed; qualification is required",
    );
  return matches[0]!;
}

function qualifiedWindowsHardware(
  host: HostInformation,
  qualification: QualificationEvidence,
  selected: DirectmlGpuIdentity,
): WorkerHardwareReport {
  const build = /^(?:10\.0\.)?(\d{5})(?:\.\d+)?$/.exec(host.release);
  if (
    host.platform !== "win32" ||
    host.arch !== "x64" ||
    !build ||
    Number(build[1]) < 19045
  )
    throw new TypeError("Windows user host is unsupported");
  return {
    os: "Windows",
    osBuild: boundedText(host.release, "host OS build", 100),
    architecture: "x86_64",
    cpu: boundedText(host.cpu, "host CPU", 200),
    memoryBytes: boundedInteger(
      host.memoryBytes,
      1,
      Number.MAX_SAFE_INTEGER,
      "host memory",
    ),
    gpus: [
      {
        id: qualification.gpuId,
        name: selected.name,
        driverVersion: selected.driverVersion,
        ...(selected.dedicatedVideoMemoryBytes > 0
          ? { memoryBytes: selected.dedicatedVideoMemoryBytes }
          : {}),
      },
    ],
  };
}

async function collectHardware(
  host: HostInformation,
  command: CommandRunner,
  qualification: QualificationEvidence,
  options: EnrollmentReportBaseOptions,
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
  if (qualification.runtimeProfile === "windows-user") {
    const native = strictRecord(
      JSON.parse(
        await command(
          join(options.releaseRoot, "runtime", "python", "python.exe"),
          [
            "-I",
            "-B",
            "-c",
            "import json,sys;sys.path.insert(0,sys.argv[1]);from musicmute_engine.windows_gpu import enumerate_adapters;from musicmute_engine.qualification import service_identity;from musicmute_engine.recipes import RECIPE_DEFINITIONS,recipe_snapshot;print(json.dumps({'sid':service_identity(),'gpus':enumerate_adapters(),'recipes':{key:recipe_snapshot(key)['recipeDigest'] for key in RECIPE_DEFINITIONS}}))",
            join(options.releaseRoot, "app", "engine"),
          ],
        ),
      ) as unknown,
      new Set(["sid", "gpus", "recipes"]),
      "Windows user GPU discovery",
    );
    if (
      native.sid !== options.expectedUserSid ||
      native.sid !== qualification.serviceIdentity ||
      !Array.isArray(native.gpus)
    )
      throw new TypeError("Windows user GPU discovery context changed");
    const recipes = strictRecord(
      native.recipes,
      new Set(WORKER_RECIPE_IDS),
      "Windows user recipe catalog",
    );
    if (
      WORKER_RECIPE_IDS.some(
        (recipe) => recipes[recipe] !== qualification.recipeDigests[recipe],
      )
    )
      throw new TypeError(
        "Qualification recipes do not match the verified runtime",
      );
    const selected = resolveQualifiedGpuIdentity(
      qualification.gpuIdentity!,
      native.gpus,
    );
    return qualifiedWindowsHardware(host, qualification, selected);
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
      "torch",
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
    ["MPS", "DmlExecutionProvider"] as const,
    "diagnostic provider",
  );
  const modelSha256 = boundedText(
    object.modelSha256,
    "diagnostic model digest",
    64,
  );
  if (!SHA256.test(modelSha256))
    throw new TypeError("Diagnostic model digest is invalid");
  const torch =
    object.torch === undefined
      ? undefined
      : boundedText(object.torch, "PyTorch version", 100);
  if (provider === "MPS" && torch === undefined)
    throw new TypeError("MPS diagnostics are missing PyTorch version");
  return {
    platform,
    architecture,
    provider,
    modelSha256,
    onnxRuntime: boundedText(object.onnxRuntime, "ONNX Runtime version", 100),
    ...(torch === undefined ? {} : { torch }),
  };
}

function assertDiagnosticsMatchHost(
  diagnostics: ServiceDiagnostics,
  platform: NodeJS.Platform,
  provider: "mps" | "directml",
): void {
  if (
    (platform === "darwin" &&
      (diagnostics.platform !== "darwin" ||
        diagnostics.architecture !== "arm64" ||
        diagnostics.provider !== "MPS")) ||
    (platform === "win32" &&
      (diagnostics.platform !== "win32" ||
        diagnostics.architecture !== "x64" ||
        diagnostics.provider !== "DmlExecutionProvider")) ||
    (provider === "mps" && diagnostics.provider !== "MPS") ||
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
