import { randomUUID } from "node:crypto";
import {
  parseClaimResponse,
  parseConfigResponse,
  parseInputGrantResponse,
  parseLeaseResponse,
  parseOutputGrantResponse,
  parseSessionResponse,
  parseWorkerHintTicket,
  type ClaimResponse,
  type ConfigResponse,
  type InputGrantResponse,
  type LeaseResult,
  type OutputGrantResponse,
  type SessionResponse,
  type WorkerCommandResult,
  type WorkerRecipeId,
} from "./contracts.js";
import {
  parseMacUpdateCandidate,
  type MacUpdateCandidate,
} from "../platform/macos/update-metadata.js";

const RESPONSE_LIMIT_BYTES = 64 * 1024;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const WORKER_ERROR_CODES = new Set([
  "WORKER_INVALID_REQUEST",
  "WORKER_UNAUTHENTICATED",
  "WORKER_FORBIDDEN",
  "WORKER_NOT_FOUND",
  "WORKER_CONFLICT",
  "WORKER_EXPIRED",
  "WORKER_DEPENDENCY_UNAVAILABLE",
]);

export interface WorkerIdentity {
  workerId: string;
  sessionId: string;
  incarnation: string;
}

export interface WorkerMachineStatus {
  machineId: string;
  status: "pending" | "active" | "paused" | "draining";
  groupId: string | null;
  policyRevision: number;
  revision: number;
  lastSeenAt: string | null;
  activeAttempts: number;
  claimsAllowed: boolean;
}

export interface ControlPlaneClientOptions {
  baseUrl: string;
  credential: string;
  fetch?: typeof fetch;
  allowInsecureLoopback?: boolean;
  requestTimeoutMs?: number;
  maxAttempts?: number;
}

export class ControlPlaneError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(`Worker control-plane request failed (${code})`);
    this.name = "ControlPlaneError";
  }
}

export class WorkerControlPlaneClient {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly options: ControlPlaneClientOptions) {
    this.baseUrl = validatedBaseUrl(
      options.baseUrl,
      options.allowInsecureLoopback === true,
    );
    if (!/^[A-Za-z0-9_-]{43}$/u.test(options.credential))
      throw new TypeError("Machine credential is invalid");
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

  async openSession(
    sessionId: string,
    incarnation: string,
    signal?: AbortSignal,
  ): Promise<SessionResponse> {
    return parseSessionResponse(
      await this.request(
        "worker/v1/session",
        "POST",
        {
          sessionId,
          incarnation,
        },
        signal,
      ),
    );
  }

  async config(
    sessionId: string,
    incarnation: string,
    signal?: AbortSignal,
  ): Promise<ConfigResponse> {
    const query = new URLSearchParams({ sessionId, incarnation });
    return parseConfigResponse(
      await this.request(
        `worker/v1/config?${query.toString()}`,
        "GET",
        null,
        signal,
      ),
    );
  }

  async hintTicket(
    signal?: AbortSignal,
  ): Promise<{ socketUrl: string; expiresAt: string }> {
    const ticket = parseWorkerHintTicket(
      await this.request("worker/v1/hints/ticket", "POST", {}, signal),
    );
    const socketUrl = new URL(ticket.path, this.baseUrl);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set("ticket", ticket.ticket);
    return { socketUrl: socketUrl.toString(), expiresAt: ticket.expiresAt };
  }

  async applyConfig(
    sessionId: string,
    incarnation: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const requestId = randomUUID();
    const response = await this.request(
      "worker/v1/config/applied",
      "POST",
      { requestId, sessionId, incarnation, revision },
      signal,
    );
    assertRequestId(response, requestId);
  }

  async registerSlot(
    identity: WorkerIdentity,
    gpuId: string,
    slotIndex: number,
    recipeIds: readonly WorkerRecipeId[],
    signal?: AbortSignal,
  ): Promise<void> {
    const response = asRecord(
      await this.request(
        "worker/v1/slots",
        "POST",
        { ...identity, gpuId, slotIndex, recipeIds },
        signal,
      ),
    );
    if (response.workerId !== identity.workerId)
      throw new TypeError("Slot response identity changed");
  }

  claim(
    identity: WorkerIdentity,
    gpuId: string,
    slotIndex: number,
    appliedPolicyRevision: number,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ClaimResponse> {
    return this.request(
      "worker/v1/claims",
      "POST",
      {
        requestId,
        ...identity,
        gpuId,
        slotIndex,
        appliedPolicyRevision,
      },
      signal,
    ).then(parseClaimResponse);
  }

  async renew(
    sessionId: string,
    incarnation: string,
    leases: Array<{ jobId: string; attemptId: string; workerId: string }>,
    signal?: AbortSignal,
  ): Promise<{ serverTime: string; results: LeaseResult[] }> {
    const requestId = randomUUID();
    const response = parseLeaseResponse(
      await this.request(
        "worker/v1/leases/renew",
        "POST",
        { requestId, sessionId, incarnation, leases },
        signal,
      ),
    );
    if (response.requestId !== requestId)
      throw new TypeError("Lease response request ID changed");
    return response;
  }

  async inputGrant(
    attemptId: string,
    identity: WorkerIdentity,
    signal?: AbortSignal,
  ): Promise<InputGrantResponse> {
    const requestId = randomUUID();
    const response = parseInputGrantResponse(
      await this.request(
        `worker/v1/attempts/${attemptId}/input-grant`,
        "POST",
        { requestId, ...identity },
        signal,
      ),
    );
    assertAttemptResponse(response, requestId, attemptId);
    return response;
  }

  async outputGrant(
    attemptId: string,
    identity: WorkerIdentity,
    output: {
      bytes: number;
      sha256: string;
      contentType: "audio/mpeg";
      measuredDurationSeconds: number;
    },
    signal?: AbortSignal,
  ): Promise<OutputGrantResponse> {
    const requestId = randomUUID();
    const response = parseOutputGrantResponse(
      await this.request(
        `worker/v1/attempts/${attemptId}/output-grant`,
        "POST",
        { requestId, ...identity, ...output },
        signal,
      ),
    );
    assertAttemptResponse(response, requestId, attemptId);
    return response;
  }

  async complete(
    attemptId: string,
    identity: WorkerIdentity,
    completion: {
      versionId: string;
      recipeId: WorkerRecipeId;
      recipeRevision: number;
      recipeDigest: string;
      modelDigest: string;
      trimEnabled: boolean;
      denoiseEnabled: boolean;
      outputFormat: "mp3";
      outputBitrateKbps: 320;
      stageTimings: Array<{ stage: string; durationMs: number }>;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const response = asRecord(
      await this.request(
        `worker/v1/attempts/${attemptId}/complete`,
        "POST",
        { requestId: randomUUID(), ...identity, ...completion },
        signal,
      ),
    );
    if (response.attemptId !== attemptId || response.status !== "ready")
      throw new TypeError("Completion response is invalid");
  }

  async fail(
    attemptId: string,
    identity: WorkerIdentity,
    failure: { code: WorkerFailureCode; summary: string },
    signal?: AbortSignal,
  ): Promise<void> {
    const response = asRecord(
      await this.request(
        `worker/v1/attempts/${attemptId}/fail`,
        "POST",
        { requestId: randomUUID(), ...identity, ...failure },
        signal,
      ),
    );
    if (response.attemptId !== attemptId)
      throw new TypeError("Failure response is invalid");
  }

  async completeCommand(
    commandId: string,
    sessionId: string,
    incarnation: string,
    requestId: string,
    result: WorkerCommandResult,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!UUID_V4.test(commandId) || !UUID_V4.test(requestId))
      throw new TypeError("Worker command identity is invalid");
    const response = asRecord(
      await this.request(
        `worker/v1/commands/${commandId}/result`,
        "POST",
        { requestId, sessionId, incarnation, ...result },
        signal,
      ),
    );
    if (
      response.commandId !== commandId ||
      response.state !== result.outcome ||
      typeof response.replayed !== "boolean"
    )
      throw new TypeError("Worker command completion response is invalid");
  }

  async unpair(
    force = false,
    signal?: AbortSignal,
  ): Promise<{
    machineId: string;
    status: "revoked";
    confirmed: true;
    revision: number;
  }> {
    const response = asRecord(
      await this.request("worker/v1/unpair", "POST", { force }, signal),
    );
    if (
      typeof response.machineId !== "string" ||
      !UUID_V4.test(response.machineId) ||
      response.status !== "revoked" ||
      response.confirmed !== true ||
      !Number.isSafeInteger(response.revision) ||
      (response.revision as number) < 1
    )
      throw new TypeError("Unpair response is invalid");
    return {
      machineId: response.machineId,
      status: "revoked",
      confirmed: true,
      revision: response.revision as number,
    };
  }

  async machineStatus(signal?: AbortSignal): Promise<WorkerMachineStatus> {
    const response = asRecord(
      await this.request("worker/v1/status", "GET", null, signal),
    );
    const allowed = new Set([
      "machineId",
      "status",
      "groupId",
      "policyRevision",
      "revision",
      "lastSeenAt",
      "activeAttempts",
      "claimsAllowed",
    ]);
    if (
      Object.keys(response).some((key) => !allowed.has(key)) ||
      typeof response.machineId !== "string" ||
      !UUID_V4.test(response.machineId) ||
      !["pending", "active", "paused", "draining"].includes(
        String(response.status),
      ) ||
      (response.groupId !== null && typeof response.groupId !== "string") ||
      !boundedStatusInteger(response.policyRevision) ||
      !boundedStatusInteger(response.revision) ||
      !boundedStatusInteger(response.activeAttempts) ||
      (response.lastSeenAt !== null &&
        (typeof response.lastSeenAt !== "string" ||
          !Number.isFinite(Date.parse(response.lastSeenAt)))) ||
      typeof response.claimsAllowed !== "boolean"
    )
      throw new TypeError("Machine status response is invalid");
    return response as unknown as WorkerMachineStatus;
  }

  async macUpdateCandidate(
    download = false,
    signal?: AbortSignal,
  ): Promise<MacUpdateCandidate> {
    return parseMacUpdateCandidate(
      await this.request(
        "worker/v1/update",
        "POST",
        { platform: "darwin-arm64", download },
        signal,
      ),
    );
  }

  private async request(
    path: string,
    method: "GET" | "POST",
    body: Record<string, unknown> | null,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin)
      throw new TypeError(
        "Control-plane request escaped the configured origin",
      );
    const serialized = body === null ? undefined : JSON.stringify(body);
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason;
      const timeout = AbortSignal.timeout(this.requestTimeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      try {
        const response = await this.fetchImplementation(url, {
          method,
          redirect: "error",
          signal: requestSignal,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.options.credential}`,
            ...(serialized === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(serialized === undefined ? {} : { body: serialized }),
        });
        if (response.ok) return await readJson(response);
        const error = await responseError(response);
        if (!error.retryable || attempt === this.maxAttempts) throw error;
        lastError = error;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof ControlPlaneError && !error.retryable) throw error;
        lastError = error;
        if (attempt === this.maxAttempts) break;
      }
      await abortableDelay(Math.min(2_000, 200 * 2 ** (attempt - 1)), signal);
    }
    if (lastError instanceof ControlPlaneError) throw lastError;
    throw new ControlPlaneError("NETWORK_UNAVAILABLE", 0, true);
  }
}

export type WorkerFailureCode =
  | "INVALID_AUDIO"
  | "INPUT_TOO_LONG"
  | "INPUT_CHECKSUM_MISMATCH"
  | "SEPARATOR_FAILED"
  | "OUTPUT_INVALID"
  | "DOWNLOAD_FAILED"
  | "OUTPUT_UPLOAD_FAILED";

function validatedBaseUrl(value: string, allowInsecureLoopback: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new TypeError("Control-plane URL contains forbidden components");
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowInsecureLoopback && loopback))
    throw new TypeError("Control-plane URL must use HTTPS");
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json"))
    throw new ControlPlaneError("RESPONSE_INVALID", response.status, false);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > RESPONSE_LIMIT_BYTES)
    throw new ControlPlaneError("RESPONSE_TOO_LARGE", response.status, false);
  const reader = response.body?.getReader();
  if (!reader)
    throw new ControlPlaneError("RESPONSE_INVALID", response.status, false);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw new ControlPlaneError("RESPONSE_TOO_LARGE", response.status, false);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ControlPlaneError("RESPONSE_INVALID", response.status, false);
  }
}

function boundedStatusInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

async function responseError(response: Response): Promise<ControlPlaneError> {
  let code = `HTTP_${response.status}`;
  try {
    const body = asRecord(await readJson(response));
    if (typeof body.code === "string" && WORKER_ERROR_CODES.has(body.code))
      code = body.code;
  } catch {
    // The bounded status code is sufficient when an upstream omitted JSON.
  }
  return new ControlPlaneError(
    code,
    response.status,
    RETRYABLE_STATUS.has(response.status),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Control-plane response must be an object");
  return value as Record<string, unknown>;
}

function assertRequestId(value: unknown, requestId: string): void {
  if (asRecord(value).requestId !== requestId)
    throw new TypeError("Control-plane response request ID changed");
}

function assertAttemptResponse(
  value: { requestId: string; attemptId: string },
  requestId: string,
  attemptId: string,
): void {
  if (value.requestId !== requestId || value.attemptId !== attemptId)
    throw new TypeError("Attempt response identity changed");
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
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
