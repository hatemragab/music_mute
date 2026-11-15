import {
  WORKER_PLATFORMS,
  WORKER_PROTOCOL_VERSION,
  WORKER_PROVIDERS,
  WORKER_RECIPE_IDS,
  type WorkerPlatform,
  type WorkerProvider,
  type WorkerRecipeId,
} from "../../protocol/v1/protocol.js";

const RESPONSE_LIMIT_BYTES = 64 * 1024;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024 * 1024;

export interface WorkerGpuReport {
  id: string;
  name: string;
  driverVersion: string;
  memoryBytes?: number;
}

export interface WorkerHardwareReport {
  os: string;
  osBuild: string;
  architecture: string;
  cpu: string;
  memoryBytes: number;
  gpus: WorkerGpuReport[];
}

export interface WorkerRuntimeReport {
  workerVersion: string;
  protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  manifestDigest: string;
  modelDigest: string;
  providerRuntimeVersion: string;
}

export interface WorkerCapabilityReport {
  platform: WorkerPlatform;
  provider: WorkerProvider;
  gpuId: string;
  recipeIds: WorkerRecipeId[];
  maxSlots: number;
}

export interface WorkerInstallationReport {
  label: string;
  groupId?: string;
  hardware: WorkerHardwareReport;
  runtime: WorkerRuntimeReport;
  capabilities: WorkerCapabilityReport[];
  summary: string;
}

export interface ExchangeResult {
  installationId: string;
  phase: "restricted" | "reported" | "activated";
  expiresAt: string;
  credential: string;
  replayed: boolean;
}

export interface ReportResult {
  installationId: string;
  phase: "reported";
  outcomeCode: string | null;
  revision: number;
  replayed: boolean;
}

export interface ActivationResult {
  machineId: string;
  status: "active";
  credentialRevision: number;
  replayed: boolean;
}

export interface InstallationArtifactGrant {
  filename: string;
  bytes: number;
  sha256: string;
  contentType: string;
  url: string;
  expiresAt: string;
}

export interface InstallationReleaseGrant extends InstallationArtifactGrant {
  version: string;
}

export interface InstallationModelDescriptor {
  filename: string;
  bytes: number;
  sha256: string;
  contentType: "application/octet-stream";
  url: string;
  sourcePolicy: "direct-owner-source-only";
  allowedHosts: string[];
  maxRedirects: number;
}

export interface InstallationArtifactsResult {
  schemaVersion: 1;
  platform: WorkerPlatform;
  release: InstallationReleaseGrant;
  model: InstallationModelDescriptor;
  fixture: InstallationArtifactGrant;
}

export interface QualificationUploadGrant {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface QualificationUploadGrantResult {
  requestId: string;
  reservation: {
    bytes: number;
    sha256: string;
    contentType: "audio/mpeg";
  };
  grant: QualificationUploadGrant | null;
  confirmed: boolean;
}

export interface QualificationUploadConfirmation {
  requestId: string;
  confirmed: true;
  replayed: boolean;
}

export interface WorkerEnrollmentClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  allowInsecureLoopback?: boolean;
  requestTimeoutMs?: number;
  maxAttempts?: number;
}

export class WorkerEnrollmentError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(`Worker enrollment request failed (${code})`);
    this.name = "WorkerEnrollmentError";
  }
}

export class WorkerEnrollmentClient {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly allowInsecureLoopback: boolean;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;

  constructor(options: WorkerEnrollmentClientOptions) {
    this.allowInsecureLoopback = options.allowInsecureLoopback === true;
    this.baseUrl = validatedBaseUrl(
      options.baseUrl,
      this.allowInsecureLoopback,
    );
    this.fetchImplementation = options.fetch ?? fetch;
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? 10_000,
      100,
      60_000,
      "request timeout",
    );
    this.maxAttempts = boundedInteger(
      options.maxAttempts ?? 3,
      1,
      5,
      "request attempts",
    );
  }

  async artifacts(
    installationId: string,
    installationCredential: string,
    platform: WorkerPlatform,
    signal?: AbortSignal,
  ): Promise<InstallationArtifactsResult> {
    assertUuid(installationId, "Installation ID");
    assertCredential(installationCredential, "Installation credential");
    oneOf(platform, WORKER_PLATFORMS, "worker platform");
    const value = strictRecord(
      await this.request(
        `worker/v1/installations/${installationId}/artifacts`,
        installationCredential,
        { platform },
        signal,
      ),
      new Set(["schemaVersion", "platform", "release", "model", "fixture"]),
      "Installation artifacts response",
    );
    if (value.schemaVersion !== 1)
      throw new TypeError("Installation artifacts schema is invalid");
    const responsePlatform = oneOf(
      value.platform,
      WORKER_PLATFORMS,
      "installation artifact platform",
    );
    if (responsePlatform !== platform)
      throw new TypeError("Installation artifact platform changed");
    const release = parseArtifactGrant(
      value.release,
      "release",
      platform === "darwin-arm64" ? "application/gzip" : "application/zip",
      this.allowInsecureLoopback,
      true,
    );
    const model = parseModelDescriptor(value.model, this.allowInsecureLoopback);
    const fixture = parseArtifactGrant(
      value.fixture,
      "fixture",
      "audio/wav",
      this.allowInsecureLoopback,
      false,
    );
    if (
      new Set([release.filename, model.filename, fixture.filename]).size !== 3
    )
      throw new TypeError("Installation artifact filenames conflict");
    return {
      schemaVersion: 1,
      platform: responsePlatform,
      release,
      model,
      fixture,
    };
  }

  async exchange(
    enrollmentCredential: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ExchangeResult> {
    assertCredential(enrollmentCredential, "Enrollment credential");
    assertUuid(requestId, "Exchange request ID");
    const value = strictRecord(
      await this.request(
        "worker/v1/installations",
        enrollmentCredential,
        { requestId },
        signal,
      ),
      new Set([
        "installationId",
        "phase",
        "expiresAt",
        "credential",
        "replayed",
      ]),
      "Exchange response",
    );
    const installationId = uuid(value.installationId, "installation ID");
    const phase = oneOf(
      value.phase,
      ["restricted", "reported", "activated"] as const,
      "installation phase",
    );
    const expiresAt = isoDate(value.expiresAt, "installation expiry");
    const credential = credentialValue(
      value.credential,
      "Installation credential",
    );
    return {
      installationId,
      phase,
      expiresAt,
      credential,
      replayed: booleanValue(value.replayed, "exchange replay flag"),
    };
  }

  async report(
    installationId: string,
    installationCredential: string,
    requestId: string,
    expectedRevision: number,
    report: WorkerInstallationReport,
    signal?: AbortSignal,
  ): Promise<ReportResult> {
    assertUuid(installationId, "Installation ID");
    assertCredential(installationCredential, "Installation credential");
    assertUuid(requestId, "Report request ID");
    boundedInteger(
      expectedRevision,
      0,
      Number.MAX_SAFE_INTEGER - 1,
      "expected report revision",
    );
    assertInstallationReport(report);
    const value = strictRecord(
      await this.request(
        `worker/v1/installations/${installationId}/report`,
        installationCredential,
        { requestId, expectedRevision, ...report },
        signal,
      ),
      new Set([
        "installationId",
        "phase",
        "outcomeCode",
        "revision",
        "replayed",
      ]),
      "Report response",
    );
    if (value.installationId !== installationId)
      throw new TypeError("Report response installation identity changed");
    return {
      installationId,
      phase: oneOf(value.phase, ["reported"] as const, "report phase"),
      outcomeCode:
        value.outcomeCode === null
          ? null
          : boundedText(value.outcomeCode, "report outcome", 100),
      revision: boundedInteger(
        value.revision,
        0,
        Number.MAX_SAFE_INTEGER,
        "report revision",
      ),
      replayed: booleanValue(value.replayed, "report replay flag"),
    };
  }

  async qualificationUploadGrant(
    installationId: string,
    installationCredential: string,
    requestId: string,
    bytes: number,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<QualificationUploadGrantResult> {
    assertUuid(installationId, "Installation ID");
    assertCredential(installationCredential, "Installation credential");
    assertUuid(requestId, "Qualification upload request ID");
    boundedInteger(bytes, 1, 30_000_000, "qualification output size");
    if (!SHA256.test(sha256))
      throw new TypeError("Qualification output digest is invalid");
    const value = strictRecord(
      await this.request(
        `worker/v1/installations/${installationId}/qualification-output/grant`,
        installationCredential,
        { requestId, bytes, sha256 },
        signal,
      ),
      new Set(["requestId", "reservation", "grant", "confirmed"]),
      "Qualification upload grant response",
    );
    if (value.requestId !== requestId)
      throw new TypeError("Qualification upload request identity changed");
    const reservation = strictRecord(
      value.reservation,
      new Set(["bytes", "sha256", "contentType"]),
      "Qualification upload reservation",
    );
    if (
      reservation.bytes !== bytes ||
      reservation.sha256 !== sha256 ||
      reservation.contentType !== "audio/mpeg"
    )
      throw new TypeError("Qualification upload reservation changed");
    const confirmed = booleanValue(
      value.confirmed,
      "qualification upload confirmation",
    );
    const grant =
      value.grant === null
        ? null
        : parseQualificationUploadGrant(
            value.grant,
            sha256,
            this.allowInsecureLoopback,
          );
    if (confirmed !== (grant === null))
      throw new TypeError("Qualification upload grant state is invalid");
    return {
      requestId,
      reservation: { bytes, sha256, contentType: "audio/mpeg" },
      grant,
      confirmed,
    };
  }

  async confirmQualificationUpload(
    installationId: string,
    installationCredential: string,
    requestId: string,
    versionId: string,
    signal?: AbortSignal,
  ): Promise<QualificationUploadConfirmation> {
    assertUuid(installationId, "Installation ID");
    assertCredential(installationCredential, "Installation credential");
    assertUuid(requestId, "Qualification confirmation request ID");
    if (!/^[A-Za-z0-9+/=_.,:-]{1,1024}$/u.test(versionId))
      throw new TypeError("Qualification upload version is invalid");
    const value = strictRecord(
      await this.request(
        `worker/v1/installations/${installationId}/qualification-output/confirm`,
        installationCredential,
        { requestId, versionId },
        signal,
      ),
      new Set(["requestId", "confirmed", "replayed"]),
      "Qualification upload confirmation response",
    );
    if (value.requestId !== requestId || value.confirmed !== true)
      throw new TypeError("Qualification upload confirmation is invalid");
    return {
      requestId,
      confirmed: true,
      replayed: booleanValue(
        value.replayed,
        "qualification upload confirmation replay flag",
      ),
    };
  }

  async activate(
    installationId: string,
    installationCredential: string,
    requestId: string,
    expectedRevision: number,
    machineCredentialDigest: string,
    signal?: AbortSignal,
  ): Promise<ActivationResult> {
    assertUuid(installationId, "Installation ID");
    assertCredential(installationCredential, "Installation credential");
    assertUuid(requestId, "Activation request ID");
    boundedInteger(
      expectedRevision,
      0,
      Number.MAX_SAFE_INTEGER - 1,
      "expected activation revision",
    );
    if (!SHA256.test(machineCredentialDigest))
      throw new TypeError("Machine credential digest is invalid");
    const value = strictRecord(
      await this.request(
        `worker/v1/installations/${installationId}/activate`,
        installationCredential,
        {
          requestId,
          expectedRevision,
          credentialDigest: machineCredentialDigest,
        },
        signal,
      ),
      new Set(["machineId", "status", "credentialRevision", "replayed"]),
      "Activation response",
    );
    return {
      machineId: uuid(value.machineId, "machine ID"),
      status: oneOf(value.status, ["active"] as const, "machine status"),
      credentialRevision: boundedInteger(
        value.credentialRevision,
        1,
        Number.MAX_SAFE_INTEGER,
        "credential revision",
      ),
      replayed: booleanValue(value.replayed, "activation replay flag"),
    };
  }

  private async request(
    path: string,
    credential: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin)
      throw new TypeError("Enrollment request escaped the configured origin");
    const serialized = JSON.stringify(body);
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason;
      const timeout = AbortSignal.timeout(this.requestTimeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      try {
        const response = await this.fetchImplementation(url, {
          method: "POST",
          redirect: "error",
          signal: requestSignal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${credential}`,
            "Content-Type": "application/json",
          },
          body: serialized,
        });
        if (response.ok) return await readJson(response);
        const error = await responseError(response);
        if (!error.retryable || attempt === this.maxAttempts) throw error;
        lastError = error;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof WorkerEnrollmentError && !error.retryable)
          throw error;
        lastError = error;
        if (attempt === this.maxAttempts) break;
      }
      await abortableDelay(Math.min(2_000, 200 * 2 ** (attempt - 1)), signal);
    }
    if (lastError instanceof WorkerEnrollmentError) throw lastError;
    throw new WorkerEnrollmentError("NETWORK_UNAVAILABLE", 0, true);
  }
}

function parseModelDescriptor(
  value: unknown,
  allowInsecureLoopback: boolean,
): InstallationModelDescriptor {
  const record = strictRecord(
    value,
    new Set([
      "filename",
      "bytes",
      "sha256",
      "contentType",
      "url",
      "sourcePolicy",
      "allowedHosts",
      "maxRedirects",
    ]),
    "Installation model descriptor",
  );
  const filename = boundedText(
    record.filename,
    "installation model filename",
    120,
  );
  if (!SAFE_FILENAME.test(filename))
    throw new TypeError("installation model filename is invalid");
  const bytes = boundedInteger(
    record.bytes,
    1,
    MAX_ARTIFACT_BYTES,
    "installation model size",
  );
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256))
    throw new TypeError("installation model digest is invalid");
  if (
    record.contentType !== "application/octet-stream" ||
    record.sourcePolicy !== "direct-owner-source-only" ||
    !Array.isArray(record.allowedHosts) ||
    record.allowedHosts.length < 1 ||
    record.allowedHosts.length > 8 ||
    record.allowedHosts.some(
      (host) =>
        typeof host !== "string" ||
        !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(host),
    )
  )
    throw new TypeError("installation model source policy is invalid");
  const allowedHosts = record.allowedHosts as string[];
  if (new Set(allowedHosts).size !== allowedHosts.length)
    throw new TypeError("installation model source hosts contain duplicates");
  const url = safeArtifactUrl(
    record.url,
    "installation model URL",
    allowInsecureLoopback,
  );
  if (!allowedHosts.includes(new URL(url).hostname))
    throw new TypeError("installation model URL host is not approved");
  const maxRedirects = boundedInteger(
    record.maxRedirects,
    0,
    4,
    "installation model redirects",
  );
  return {
    filename,
    bytes,
    sha256: record.sha256,
    contentType: "application/octet-stream",
    url,
    sourcePolicy: "direct-owner-source-only",
    allowedHosts,
    maxRedirects,
  };
}

function parseArtifactGrant(
  value: unknown,
  label: string,
  expectedContentType: string,
  allowInsecureLoopback: boolean,
  release: true,
): InstallationReleaseGrant;
function parseArtifactGrant(
  value: unknown,
  label: string,
  expectedContentType: string,
  allowInsecureLoopback: boolean,
  release: false,
): InstallationArtifactGrant;
function parseArtifactGrant(
  value: unknown,
  label: string,
  expectedContentType: string,
  allowInsecureLoopback: boolean,
  release: boolean,
): InstallationArtifactGrant | InstallationReleaseGrant {
  const record = strictRecord(
    value,
    new Set([
      ...(release ? ["version"] : []),
      "filename",
      "bytes",
      "sha256",
      "contentType",
      "url",
      "expiresAt",
    ]),
    `Installation ${label} artifact`,
  );
  const filename = boundedText(
    record.filename,
    `installation ${label} filename`,
    120,
  );
  if (!SAFE_FILENAME.test(filename))
    throw new TypeError(`installation ${label} filename is invalid`);
  const bytes = boundedInteger(
    record.bytes,
    1,
    MAX_ARTIFACT_BYTES,
    `installation ${label} size`,
  );
  if (typeof record.sha256 !== "string" || !SHA256.test(record.sha256))
    throw new TypeError(`installation ${label} digest is invalid`);
  if (record.contentType !== expectedContentType)
    throw new TypeError(`installation ${label} content type is invalid`);
  const url = safeArtifactUrl(
    record.url,
    `installation ${label} URL`,
    allowInsecureLoopback,
  );
  const expiresAt = isoDate(record.expiresAt, `installation ${label} expiry`);
  const artifact: InstallationArtifactGrant = {
    filename,
    bytes,
    sha256: record.sha256,
    contentType: expectedContentType,
    url,
    expiresAt,
  };
  if (!release) return artifact;
  return {
    version: boundedText(record.version, "installation release version", 100),
    ...artifact,
  };
}

function safeArtifactUrl(
  value: unknown,
  label: string,
  allowInsecureLoopback: boolean,
): string {
  if (typeof value !== "string" || value.length > 8_192)
    throw new TypeError(`${label} is invalid`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(allowInsecureLoopback && loopback))
  )
    throw new TypeError(`${label} is unsafe`);
  return url.toString();
}

function parseQualificationUploadGrant(
  value: unknown,
  sha256: string,
  allowInsecureLoopback: boolean,
): QualificationUploadGrant {
  const record = strictRecord(
    value,
    new Set(["method", "url", "headers", "expiresAt"]),
    "Qualification upload grant",
  );
  if (record.method !== "PUT")
    throw new TypeError("Qualification upload method is invalid");
  const headers = strictRecord(
    record.headers,
    new Set(["Content-Type", "x-amz-checksum-sha256", "If-None-Match"]),
    "Qualification upload headers",
  );
  const expectedChecksum = Buffer.from(sha256, "hex").toString("base64");
  if (
    headers["Content-Type"] !== "audio/mpeg" ||
    headers["x-amz-checksum-sha256"] !== expectedChecksum ||
    headers["If-None-Match"] !== "*"
  )
    throw new TypeError("Qualification upload headers are invalid");
  return {
    method: "PUT",
    url: safeArtifactUrl(
      record.url,
      "qualification upload URL",
      allowInsecureLoopback,
    ),
    headers: {
      "Content-Type": "audio/mpeg",
      "x-amz-checksum-sha256": expectedChecksum,
      "If-None-Match": "*",
    },
    expiresAt: isoDate(record.expiresAt, "qualification upload expiry"),
  };
}

export function assertInstallationReport(
  report: WorkerInstallationReport,
): void {
  const value = strictRecord(
    report,
    new Set([
      "label",
      "groupId",
      "hardware",
      "runtime",
      "capabilities",
      "summary",
    ]),
    "Installation report",
  );
  boundedText(value.label, "report label", 120);
  if (value.groupId !== undefined)
    boundedText(value.groupId, "report group ID", 100);
  boundedText(value.summary, "report summary", 2_000);
  const hardware = strictRecord(
    value.hardware,
    new Set(["os", "osBuild", "architecture", "cpu", "memoryBytes", "gpus"]),
    "Hardware report",
  );
  boundedText(hardware.os, "hardware OS", 100);
  boundedText(hardware.osBuild, "hardware OS build", 100);
  boundedText(hardware.architecture, "hardware architecture", 50);
  boundedText(hardware.cpu, "hardware CPU", 200);
  boundedInteger(
    hardware.memoryBytes,
    1,
    Number.MAX_SAFE_INTEGER,
    "hardware memory",
  );
  if (
    !Array.isArray(hardware.gpus) ||
    hardware.gpus.length < 1 ||
    hardware.gpus.length > 8
  )
    throw new TypeError("Hardware GPU list is invalid");
  for (const item of hardware.gpus) {
    const gpu = strictRecord(
      item,
      new Set(["id", "name", "driverVersion", "memoryBytes"]),
      "GPU report",
    );
    boundedText(gpu.id, "GPU ID", 128);
    boundedText(gpu.name, "GPU name", 200);
    boundedText(gpu.driverVersion, "GPU driver version", 100);
    if (gpu.memoryBytes !== undefined)
      boundedInteger(gpu.memoryBytes, 1, Number.MAX_SAFE_INTEGER, "GPU memory");
  }
  const runtime = strictRecord(
    value.runtime,
    new Set([
      "workerVersion",
      "protocolVersion",
      "manifestDigest",
      "modelDigest",
      "providerRuntimeVersion",
    ]),
    "Runtime report",
  );
  boundedText(runtime.workerVersion, "worker version", 100);
  if (runtime.protocolVersion !== WORKER_PROTOCOL_VERSION)
    throw new TypeError("Worker protocol version is invalid");
  if (
    typeof runtime.manifestDigest !== "string" ||
    typeof runtime.modelDigest !== "string" ||
    !SHA256.test(runtime.manifestDigest) ||
    !SHA256.test(runtime.modelDigest)
  )
    throw new TypeError("Runtime digest is invalid");
  boundedText(runtime.providerRuntimeVersion, "provider runtime version", 100);
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.length < 1 ||
    value.capabilities.length > 16
  )
    throw new TypeError("Worker capability list is invalid");
  for (const item of value.capabilities) {
    const capability = strictRecord(
      item,
      new Set(["platform", "provider", "gpuId", "recipeIds", "maxSlots"]),
      "Worker capability",
    );
    oneOf(capability.platform, WORKER_PLATFORMS, "worker platform");
    oneOf(capability.provider, WORKER_PROVIDERS, "worker provider");
    boundedText(capability.gpuId, "capability GPU ID", 128);
    if (
      !Array.isArray(capability.recipeIds) ||
      capability.recipeIds.length < 1 ||
      capability.recipeIds.length > 16 ||
      capability.recipeIds.some((recipe) => {
        try {
          oneOf(recipe, WORKER_RECIPE_IDS, "worker recipe");
          return false;
        } catch {
          return true;
        }
      })
    )
      throw new TypeError("Worker recipe list is invalid");
    boundedInteger(capability.maxSlots, 1, 2, "worker slot count");
  }
}

function validatedBaseUrl(value: string, allowInsecureLoopback: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new TypeError("Enrollment URL contains forbidden components");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLoopback && loopback))
    throw new TypeError("Enrollment URL must use HTTPS");
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json"))
    throw new WorkerEnrollmentError("RESPONSE_INVALID", response.status, false);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > RESPONSE_LIMIT_BYTES)
    throw new WorkerEnrollmentError(
      "RESPONSE_TOO_LARGE",
      response.status,
      false,
    );
  const reader = response.body?.getReader();
  if (!reader)
    throw new WorkerEnrollmentError("RESPONSE_INVALID", response.status, false);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw new WorkerEnrollmentError(
        "RESPONSE_TOO_LARGE",
        response.status,
        false,
      );
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new WorkerEnrollmentError("RESPONSE_INVALID", response.status, false);
  }
}

async function responseError(
  response: Response,
): Promise<WorkerEnrollmentError> {
  let code = `HTTP_${response.status}`;
  try {
    const body = strictRecord(
      await readJson(response),
      new Set(["statusCode", "code", "message", "path", "timestamp"]),
      "Enrollment error response",
      false,
    );
    if (typeof body.code === "string" && body.code.length <= 100)
      code = body.code;
  } catch {
    // The bounded status is sufficient when an upstream omitted safe JSON.
  }
  return new WorkerEnrollmentError(
    code,
    response.status,
    RETRYABLE_STATUS.has(response.status),
  );
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

function uuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_V4.test(value))
    throw new TypeError(`${label} is invalid`);
  return value;
}

function assertUuid(value: string, label: string): void {
  uuid(value, label);
}

function credentialValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !CREDENTIAL.test(value))
    throw new TypeError(`${label} is invalid`);
  return value;
}

function assertCredential(value: string, label: string): void {
  credentialValue(value, label);
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

function isoDate(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new TypeError(`${label} is invalid`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} is invalid`);
  return value;
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

async function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
