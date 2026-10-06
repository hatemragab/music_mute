import {
  NATIVE_HOST,
  PROTOCOL_VERSION,
  MVP_MAX_DURATION_SECONDS,
  isVideoId,
  parseYouTubeVideoId,
  type NativeCommand,
  type NativeReply,
  type MediaSource,
  type MediaClock,
  type DiagnosticInput,
  type HelloPayload,
  type NativeCapability,
} from "../shared/protocol";
import {
  pageJob,
  isExtensionMessage,
  isJobSnapshot,
  isErrorCode,
  isMediaClock,
  type ExtensionMessage,
  type ExtensionStatus,
  type PageJob,
} from "./messages";
import { loadSettings } from "./settings";
import { cloudHandoffUrl } from "../shared/app-handoff";
import { isErrorContext, type ErrorContext } from "../shared/error-context";
import { safeLocalErrors } from "./local-error-report";
import { TabAudio } from "./tab-audio";
import { PlaybackSessionStore } from "./playback-session";
import {
  isInstallationCheck,
  type InstallationCheck,
} from "../shared/installation-check";

let native: chrome.runtime.Port | null = null;
let hello: HelloPayload | null = null;
let job: PageJob | null = null;
let lastError: string | undefined;
let lastErrorContext: ErrorContext | undefined;
let negotiatedErrors = false;
let negotiatedPublication = false;
let updatePending = false;
let installationCheck: InstallationCheck | undefined;
let checkingInstallation: Promise<unknown> | undefined;
let cacheClearsInFlight = 0;
let helloHandoffsInFlight = 0;
const installationCheckKey = "musicmute_installation_check";
const STATUS_HANDOFF_GRACE_MS = 1000;
const IDLE_RETIREMENT_HANDOFF_MS = 1000;
let idleRetirementDeadline = 0;
let statusHandoff: {
  port: chrome.runtime.Port;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
function cancelStatusHandoff(): void {
  if (statusHandoff) clearTimeout(statusHandoff.timer);
  statusHandoff = null;
}
function retainStatusConnection(): void {
  if (
    !native ||
    !hello?.ready ||
    active ||
    pendingStart ||
    stopsInFlight ||
    pending.size ||
    offscreenLoading ||
    retained ||
    checkingInstallation ||
    cacheClearsInFlight ||
    helloHandoffsInFlight ||
    statusHandoff?.port === native
  )
    return;
  cancelStatusHandoff();
  const port = native;
  // A status reply can precede START or CHECK immediately. Reuse its helper
  // briefly so Chrome does not reopen while the old native host exits.
  statusHandoff = {
    port,
    timer: setTimeout(() => {
      if (statusHandoff?.port !== port) return;
      statusHandoff = null;
      closeIdleConnection();
      installPendingUpdate();
    }, STATUS_HANDOFF_GRACE_MS),
  };
}
function closeIdleConnection(): void {
  if (
    active ||
    pendingStart ||
    stopsInFlight ||
    pending.size ||
    offscreenLoading ||
    retained ||
    checkingInstallation ||
    cacheClearsInFlight ||
    helloHandoffsInFlight ||
    statusHandoff?.port === native
  )
    return;
  const port = native;
  if (port && !startupFailures.has(port))
    idleRetirementDeadline = Date.now() + IDLE_RETIREMENT_HANDOFF_MS;
  native = null;
  negotiatedErrors = false;
  negotiatedPublication = false;
  // Keep the last handshake for display/known-old-app guidance. Every future
  // local command opens a new port; Chrome closing this one releases its helper.
  try {
    port?.disconnect();
  } catch {
    /* The port is already retired. */
  }
}
function installPendingUpdate(): void {
  if (
    !updatePending ||
    active ||
    pendingStart ||
    stopsInFlight ||
    pending.size ||
    offscreenLoading ||
    retained ||
    checkingInstallation ||
    cacheClearsInFlight ||
    helloHandoffsInFlight
  )
    return;
  updatePending = false;
  cancelStatusHandoff();
  closeIdleConnection();
  chrome.runtime.reload();
}
interface ActiveSession {
  startedAt: number;
  firstPlaybackRecorded?: boolean;
  tabId: number;
  generation: number;
  videoId: string;
  durationSeconds: number;
  requestId: string;
  automatic: boolean;
  documentId?: string;
  lastSeenAt: number;
  jobId?: string;
  startReply?: Promise<NativeReply>;
  media?: MediaSource;
  clock?: MediaClock;
  publicationAcknowledged?: boolean;
  publicationAcknowledging?: boolean;
  publicationPlaying?: boolean;
  publicationAttempts?: number;
  publicationRetryTimer?: ReturnType<typeof setTimeout>;
}
let active: ActiveSession | null = null;
/** Reserve admission synchronously, before storage/native handoffs can yield. */
let pendingStart: ActiveSession | null = null;
const playbackSessions = new PlaybackSessionStore();
const tabAudio = new TabAudio();
let recovery: Promise<void> | null = null;
let stopsInFlight = 0;
const RELOAD_GRACE_MS = 5000;
interface RetainedSession {
  owner: ActiveSession;
  snapshot: PageJob | null;
  port: chrome.runtime.Port;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  handoff: Promise<void>;
}
let retained: RetainedSession | null = null;
function takeRetained(value: RetainedSession): boolean {
  if (retained !== value) return false;
  clearTimeout(value.timer);
  retained = null;
  return true;
}
async function releaseRetained(): Promise<void> {
  const value = retained;
  if (!value || !takeRetained(value)) return;
  stopsInFlight++;
  try {
    await value.handoff;
    if (value.snapshot?.state === "READY" && native === value.port)
      await command({
        protocol_version: PROTOCOL_VERSION,
        request_id: crypto.randomUUID(),
        type: "CANCEL",
        payload: { job_id: value.snapshot.job_id },
      }).catch(() => {});
  } finally {
    stopsInFlight--;
    closeIdleConnection();
    installPendingUpdate();
  }
}
const stopHandoffs = new Set<{
  owner: ActiveSession | null;
  promise: Promise<void>;
}>();
// Allows Chrome's hidden-tab timer batching while bounding abandoned native work.
const PAGE_LEASE_MS = 90_000;
const retiredDocuments = new Map<
  number,
  { documentId: string; retiredAt: number }[]
>();
const currentDocuments = new Map<
  number,
  { tabId: number; documentId: string; generation: number }
>();
function retireDocument(
  owner: Pick<ActiveSession, "tabId" | "documentId"> | null,
): void {
  if (!owner?.documentId) return;
  const documents = retiredDocuments.get(owner.tabId) ?? [];
  retiredDocuments.set(owner.tabId, [
    ...documents
      .filter(
        (item) =>
          item.documentId !== owner.documentId &&
          Date.now() - item.retiredAt < PAGE_LEASE_MS,
      )
      .slice(-31),
    { documentId: owner.documentId, retiredAt: Date.now() },
  ]);
}
function isRetiredDocument(tabId: number, documentId?: string): boolean {
  const documents = (retiredDocuments.get(tabId) ?? []).filter(
    (item) => Date.now() - item.retiredAt < PAGE_LEASE_MS,
  );
  if (documents.length) retiredDocuments.set(tabId, documents);
  else retiredDocuments.delete(tabId);
  return documents.some((item) => item.documentId === documentId);
}
let leaseTimer: ReturnType<typeof setTimeout> | null = null;
async function probePageLease(owner: ActiveSession): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const message: ExtensionMessage = {
      type: "MM_PAGE_PROBE",
      generation: owner.generation,
    };
    const response: unknown = await Promise.race([
      owner.documentId
        ? chrome.tabs.sendMessage(owner.tabId, message, {
            documentId: owner.documentId,
          })
        : chrome.tabs.sendMessage(owner.tabId, message),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), 3000);
      }),
    ]);
    if (active !== owner) return;
    const sample =
      response && typeof response === "object" && "clock" in response
        ? response.clock
        : undefined;
    if (
      isMediaClock(sample) &&
      sample.generation === owner.generation &&
      sample.video_id === owner.videoId &&
      Date.now() - sample.sampled_at_ms >= 0 &&
      Date.now() - sample.sampled_at_ms <= 5000
    )
      owner.lastSeenAt = Date.now();
  } catch {
    // A discarded/closed document cannot renew its lease.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  if (active !== owner) return;
  if (Date.now() - owner.lastSeenAt >= PAGE_LEASE_MS)
    await fail("PLAYBACK_PAGE_LOST");
  else armPageLease(owner);
}
function armPageLease(owner: ActiveSession): void {
  if (leaseTimer) clearTimeout(leaseTimer);
  leaseTimer = setTimeout(
    () => {
      leaseTimer = null;
      if (active !== owner) return;
      if (Date.now() - owner.lastSeenAt >= PAGE_LEASE_MS)
        void probePageLease(owner);
      else armPageLease(owner);
    },
    Math.max(1000, PAGE_LEASE_MS - (Date.now() - owner.lastSeenAt)),
  );
}
let offscreenCreation: Promise<void> | null = null;
let offscreenLoading: {
  owner: ActiveSession;
  promise: Promise<void>;
} | null = null;
const startupRequestId = "00000000-0000-4000-8000-000000000000";
const startupErrorCodes = new Set([
  "LOCAL_COMPANION_BUSY",
  "LOCAL_COMPANION_LOCK_UNSAFE",
  "LOCAL_COMPANION_START_FAILED",
]);
const nativeRequestId =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** This failure was already reported by its owning port. */
class NativePortFailure extends Error {
  constructor(
    code: string,
    readonly error_context?: ErrorContext,
  ) {
    super(code);
  }
}
class NativeReplyFailure extends Error {
  constructor(
    code: string,
    readonly error_context?: ErrorContext,
  ) {
    super(code);
  }
}
const startupFailures = new WeakMap<chrome.runtime.Port, NativePortFailure>();
class IdleRetirementFailure extends NativePortFailure {
  constructor(readonly deadline: number) {
    super("LOCAL_COMPANION_BUSY");
  }
}
const pending = new Map<
  string,
  {
    type: NativeCommand["type"];
    resolve: (value: NativeReply) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const errorKey = "musicmute_local_errors";
let diagnosticQueue = Promise.resolve();
const safeEvents = new Set([
  "stage_completed",
  "job_started",
  "job_progress",
  "job_ready",
  "job_failed",
  "job_cancelled",
  "playback_started",
  "playback_stopped",
  "playback_suspended",
  "playback_drift",
  "playback_seek",
  "diagnostic_error",
  "harness_result",
]);

function sendToPage(
  message: ExtensionMessage,
  owner: ActiveSession | null = active,
): void {
  if (!owner) return;
  const delivery = owner.documentId
    ? chrome.tabs.sendMessage(owner.tabId, message, {
        documentId: owner.documentId,
      })
    : chrome.tabs.sendMessage(owner.tabId, message);
  void delivery.catch(() => {
    if (active === owner) void stop(true).catch(() => undefined);
  });
}
function safeDiagnostic(input: DiagnosticInput): DiagnosticInput | null {
  if (
    input.component !== "extension" ||
    !["info", "warning", "error"].includes(input.severity) ||
    !safeEvents.has(input.event)
  )
    return null;
  const output: DiagnosticInput = {
    component: "extension",
    severity: input.severity,
    event: input.event,
  };
  if (input.code && /^[A-Z0-9_]{1,80}$/.test(input.code))
    output.code = input.code;
  if (input.metrics) {
    const allowed = new Set([
      "duration_ms",
      "drift_ms",
      "elapsed_ms",
      "playing",
      "stage",
      "sequence",
      "generation",
      "passed",
    ]);
    output.metrics = Object.fromEntries(
      Object.entries(input.metrics).filter(
        ([key, value]) =>
          allowed.has(key) &&
          ((typeof value === "number" && Number.isFinite(value)) ||
            typeof value === "boolean" ||
            (key === "stage" &&
              typeof value === "string" &&
              /^[a-z_-]{1,40}$/.test(value))),
      ),
    );
  }
  return output;
}
function diagnostic(input: DiagnosticInput): void {
  const safe = safeDiagnostic(input);
  if (!safe) return;
  if (active?.jobId && safe.event === "stage_completed")
    safe.job_id = active.jobId;
  if (safe.severity !== "info") {
    diagnosticQueue = diagnosticQueue
      .then(async () => {
        const stored = await chrome.storage.local.get(errorKey);
        const values = safeLocalErrors(stored[errorKey]);
        await chrome.storage.local.set({
          [errorKey]: [
            ...values.slice(-49),
            { ...safe, recorded_at: new Date().toISOString() },
          ],
        });
      })
      .catch(() => undefined);
  }
  if (native) {
    try {
      native.postMessage({
        protocol_version: PROTOCOL_VERSION,
        request_id: crypto.randomUUID(),
        type: "EVENT",
        payload: safe,
      } satisfies NativeCommand);
    } catch {
      /* Native disconnect handles recovery. */
    }
  }
}
function fail(code: string, context?: ErrorContext): Promise<void> {
  lastError = code;
  lastErrorContext = context;
  diagnostic({
    component: "extension",
    severity: "error",
    event: "diagnostic_error",
    code,
  });
  // Capture and retire ownership before waiting, retaining its native job until
  // cancellation has acknowledged. Every failure releases the same resources.
  return stop(true, null, code, context).catch(() => undefined);
}
function rejectPending(error: NativePortFailure): void {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}
function connect(): chrome.runtime.Port {
  if (native) return native;
  native = chrome.runtime.connectNative(NATIVE_HOST);
  hello = null;
  negotiatedErrors = false;
  negotiatedPublication = false;
  const port = native;
  let handoffDeadline = idleRetirementDeadline;
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (native !== port) return;
    cancelStatusHandoff();
    native = null;
    hello = null;
    negotiatedErrors = false;
    negotiatedPublication = false;
    const startupFailure = startupFailures.get(port);
    rejectPending(
      startupFailure ?? new NativePortFailure("COMPANION_DISCONNECTED"),
    );
    if (!startupFailure) fail("COMPANION_DISCONNECTED");
  });
  port.onMessage.addListener((value: unknown) => {
    if (
      native !== port ||
      startupFailures.has(port) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      return;
    const reply = value as NativeReply;
    if (
      reply.protocol_version !== PROTOCOL_VERSION ||
      typeof reply.request_id !== "string" ||
      !nativeRequestId.test(reply.request_id) ||
      !["HELLO", "JOB", "ERROR", "REPORT", "CHECK"].includes(reply.type) ||
      (reply.payload === null && reply.type !== "JOB") ||
      (reply.payload !== null &&
        (typeof reply.payload !== "object" || Array.isArray(reply.payload)))
    )
      return;
    if (
      reply.type === "ERROR" &&
      (Object.keys(reply.payload).some(
        (key) => !["error_code", "error_context"].includes(key),
      ) ||
        typeof reply.payload.error_code !== "string" ||
        !isErrorCode(reply.payload.error_code) ||
        (reply.payload.error_context !== undefined &&
          (!negotiatedErrors || !isErrorContext(reply.payload.error_context))))
    )
      return;
    if (
      reply.type === "HELLO" &&
      (typeof reply.payload.ready !== "boolean" ||
        typeof reply.payload.version !== "string" ||
        typeof reply.payload.platform !== "string" ||
        typeof reply.payload.arch !== "string" ||
        !Number.isFinite(reply.payload.max_duration_seconds) ||
        (reply.payload.installation_check_supported !== undefined &&
          typeof reply.payload.installation_check_supported !== "boolean") ||
        (reply.payload.installation_id !== undefined &&
          (typeof reply.payload.installation_id !== "string" ||
            !/^[a-f0-9]{64}$/.test(reply.payload.installation_id))) ||
        (reply.payload.capabilities !== undefined &&
          (!Array.isArray(reply.payload.capabilities) ||
            reply.payload.capabilities.length > 4 ||
            reply.payload.capabilities.some(
              (capability) =>
                ![
                  "error_context_v1",
                  "cloud_handoff_v1",
                  "processing_selection_v1",
                  "background_publication_v1",
                ].includes(capability),
            ) ||
            new Set(reply.payload.capabilities).size !==
              reply.payload.capabilities.length)) ||
        (reply.payload.background_publication_supported !== undefined &&
          typeof reply.payload.background_publication_supported !==
            "boolean") ||
        (reply.payload.processing_provider !== undefined &&
          !["LOCAL_MACOS", "ONLINE_MUSICMUTE"].includes(
            reply.payload.processing_provider,
          )) ||
        (reply.payload.processing_scope !== undefined &&
          (typeof reply.payload.processing_scope !== "string" ||
            reply.payload.processing_scope.length !== 64 ||
            !/^[a-f0-9]{64}$/.test(reply.payload.processing_scope))))
    )
      return;
    if (
      reply.type === "JOB" &&
      reply.payload !== null &&
      !isJobSnapshot(reply.payload)
    )
      return;
    const entry = pending.get(reply.request_id);
    if (reply.type === "CHECK") {
      if (
        entry?.type !== "CHECK" ||
        !checkingInstallation ||
        !isInstallationCheck(reply.payload) ||
        reply.payload.installation_id !== hello?.installation_id
      )
        return;
      installationCheck = reply.payload;
      void chrome.runtime
        .sendMessage({
          type: "MM_CHECK_PROGRESS",
          payload: installationCheck,
        } satisfies ExtensionMessage)
        .catch(() => {});
      if (reply.payload.state === "running") return;
      void chrome.storage.local
        .set({ [installationCheckKey]: installationCheck })
        .catch(() => {});
    }
    if (
      !entry &&
      reply.request_id === startupRequestId &&
      reply.type === "ERROR" &&
      startupErrorCodes.has(reply.payload.error_code)
    ) {
      const recoveringIdleRetirement =
        reply.payload.error_code === "LOCAL_COMPANION_BUSY" &&
        handoffDeadline > Date.now() &&
        helloHandoffsInFlight > 0 &&
        pending.size > 0 &&
        [...pending.values()].every((command) => command.type === "HELLO");
      const error = recoveringIdleRetirement
        ? new IdleRetirementFailure(handoffDeadline)
        : new NativePortFailure(reply.payload.error_code);
      startupFailures.set(port, error);
      hello = null;
      rejectPending(error);
      if (recoveringIdleRetirement) {
        native = null;
        negotiatedErrors = false;
        negotiatedPublication = false;
        try {
          port.disconnect();
        } catch {
          /* The failed startup port is already retired. */
        }
      } else fail(error.message);
      return;
    }
    if (reply.request_id === startupRequestId) return;
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(reply.request_id);
      entry.resolve(reply);
    }
    if (reply.type === "HELLO" && entry) {
      hello = reply.payload;
      handoffDeadline = 0;
      idleRetirementDeadline = 0;
    }
    if (reply.type === "JOB" && reply.payload)
      void receiveJob(reply.payload, reply.request_id);
    if (
      reply.type === "ERROR" &&
      active &&
      !entry &&
      reply.request_id === active.requestId
    )
      fail(reply.payload.error_code, reply.payload.error_context);
  });
  return port;
}
function command(
  command: NativeCommand,
  timeoutMs = 10_000,
  disconnectOnTimeout = true,
): Promise<NativeReply> {
  cancelStatusHandoff();
  return new Promise((resolve, reject) => {
    let commandPort: chrome.runtime.Port | undefined;
    const timer = setTimeout(() => {
      pending.delete(command.request_id);
      reject(new NativePortFailure("COMPANION_TIMEOUT"));
      if (disconnectOnTimeout && commandPort && native === commandPort) {
        native = null;
        hello = null;
        rejectPending(new NativePortFailure("COMPANION_TIMEOUT"));
        try {
          commandPort.disconnect();
        } catch {
          /* Already disconnected. */
        }
        fail("COMPANION_TIMEOUT");
      }
    }, timeoutMs);
    pending.set(command.request_id, {
      type: command.type,
      resolve,
      reject,
      timer,
    });
    try {
      const port = connect();
      commandPort = port;
      const startupFailure = startupFailures.get(port);
      if (startupFailure) throw startupFailure;
      port.postMessage(command);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(command.request_id);
      reject(
        error instanceof NativePortFailure
          ? error
          : new Error("COMPANION_UNAVAILABLE"),
      );
    }
  });
}
async function handshake(
  commandValue: Extract<NativeCommand, { type: "HELLO" }>,
): Promise<NativeReply> {
  const owner = active ?? pendingStart;
  helloHandoffsInFlight++;
  try {
    for (;;) {
      if (owner && owner !== active && owner !== pendingStart)
        throw new Error("SESSION_STOPPED");
      try {
        return await command(commandValue, 65_000);
      } catch (error) {
        if (!(error instanceof IdleRetirementFailure)) throw error;
        const remaining = error.deadline - Date.now();
        if (remaining <= 0) {
          await fail(error.message);
          throw error;
        }
        // Retry only a handshake refused while our own idle host releases its
        // lock. No START, acquisition or other native command is replayed.
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(100, remaining)),
        );
      }
    }
  } finally {
    helloHandoffsInFlight--;
  }
}
async function ensureConnected(
  requireReady = true,
  refreshSelection = false,
): Promise<void> {
  if (
    hello &&
    native &&
    !refreshSelection &&
    (!requireReady || hello.ready) &&
    (!hello.capabilities?.includes("error_context_v1") || negotiatedErrors) &&
    (!hello.background_publication_supported || negotiatedPublication)
  )
    return;
  const reply = await handshake({
    protocol_version: PROTOCOL_VERSION,
    request_id: crypto.randomUUID(),
    type: "HELLO",
    payload:
      native && hello?.capabilities?.includes("processing_selection_v1")
        ? {
            capabilities: [
              ...(negotiatedErrors ? ["error_context_v1" as const] : []),
              "processing_selection_v1",
              ...(negotiatedPublication
                ? ["background_publication_v1" as const]
                : []),
            ],
          }
        : {},
  });
  if (reply.type !== "HELLO" || (requireReady && !reply.payload.ready))
    throw new Error(
      reply.type === "HELLO"
        ? (reply.payload.error_code ?? "COMPANION_NOT_READY")
        : "COMPANION_NOT_READY",
    );
  const selectionNeedsNegotiation =
    reply.payload.processing_provider !== undefined &&
    !reply.payload.capabilities?.includes("processing_selection_v1");
  if (
    selectionNeedsNegotiation ||
    (reply.payload.capabilities?.includes("error_context_v1") &&
      !negotiatedErrors) ||
    (reply.payload.background_publication_supported && !negotiatedPublication)
  ) {
    const capabilities: NativeCapability[] = [
      ...(reply.payload.capabilities?.includes("error_context_v1")
        ? ["error_context_v1" as const]
        : []),
      ...(reply.payload.processing_provider !== undefined
        ? ["processing_selection_v1" as const]
        : []),
      ...(reply.payload.background_publication_supported
        ? ["background_publication_v1" as const]
        : []),
    ];
    const configured = await handshake({
      protocol_version: PROTOCOL_VERSION,
      request_id: crypto.randomUUID(),
      type: "HELLO",
      payload: { capabilities },
    });
    if (
      configured.type !== "HELLO" ||
      (requireReady && !configured.payload.ready)
    )
      throw new Error("COMPANION_NOT_READY");
    if (
      selectionNeedsNegotiation &&
      (!configured.payload.capabilities?.includes("processing_selection_v1") ||
        configured.payload.processing_provider === undefined)
    )
      throw new Error("APP_UPDATE_REQUIRED");
    negotiatedErrors = capabilities.includes("error_context_v1");
    negotiatedPublication =
      capabilities.includes("background_publication_v1") &&
      configured.payload.capabilities?.includes("background_publication_v1") ===
        true;
  }
}
async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreation)
    offscreenCreation = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification:
          "Play prepared local vocals synchronized with a user-selected YouTube video.",
      })
      .finally(() => {
        offscreenCreation = null;
      });
  await offscreenCreation;
}
async function loadAudio(): Promise<void> {
  const owner = active;
  if (!owner?.media) return;
  if (offscreenLoading?.owner === owner) return offscreenLoading.promise;
  const previous = offscreenLoading?.promise;
  const loading = { owner, promise: Promise.resolve() };
  loading.promise = (async () => {
    if (previous) await previous.catch(() => undefined);
    if (active !== owner) return;
    const tabWasMuted = await tabAudio.set(
      owner.tabId,
      owner.requestId,
      !owner.clock?.ad_active,
    );
    if (tabWasMuted && owner.clock)
      owner.clock = { ...owner.clock, user_muted: true };
    if (active !== owner) return;
    try {
      await ensureOffscreen();
    } catch {
      throw new Error("OFFSCREEN_CREATION_FAILED");
    }
    if (active !== owner || !owner.media) return;
    let response: unknown;
    try {
      response = await chrome.runtime.sendMessage({
        type: "MM_AUDIO_LOAD",
        media: owner.media,
        generation: owner.generation,
        video_id: owner.videoId,
      } satisfies ExtensionMessage);
    } catch {
      throw new Error("OFFSCREEN_MESSAGE_FAILED");
    }
    if (active !== owner) return;
    if (
      !response ||
      typeof response !== "object" ||
      !("ok" in response) ||
      response.ok !== true
    )
      throw new Error("AUDIO_LOAD_FAILED");
    if (active === owner && owner.clock)
      await chrome.runtime.sendMessage({
        type: "MM_AUDIO_CLOCK",
        payload: owner.clock,
      } satisfies ExtensionMessage);
  })().finally(() => {
    if (offscreenLoading === loading) offscreenLoading = null;
  });
  offscreenLoading = loading;
  return loading.promise;
}
async function receiveJob(
  snapshot: import("../shared/protocol").JobSnapshot,
  requestId: string,
): Promise<void> {
  if (
    retained &&
    requestId === retained.owner.requestId &&
    snapshot.job_id === retained.snapshot?.job_id
  ) {
    retained.snapshot = pageJob(snapshot);
    if (
      snapshot.state !== "READY" ||
      !snapshot.media ||
      snapshot.media.url !== retained.owner.media?.url ||
      snapshot.media.duration_seconds !==
        retained.owner.media.duration_seconds ||
      snapshot.media.model_id !== retained.owner.media.model_id
    ) {
      void releaseRetained();
    }
    return;
  }
  if (
    !active ||
    requestId !== active.requestId ||
    snapshot.video_id !== active.videoId ||
    (active.jobId && active.jobId !== snapshot.job_id)
  )
    return;
  active.jobId = snapshot.job_id;
  const owner = active;
  job = pageJob(snapshot);
  if (snapshot.state === "CANCELLED") {
    // A cancelled grant must be silent before the page restores original audio.
    await stop(false);
    return;
  }
  sendToPage({ type: "MM_JOB", payload: job, generation: active.generation });
  if (snapshot.state === "FAILED") {
    lastError = snapshot.error_code;
    lastErrorContext = snapshot.error_context;
    diagnostic({
      component: "extension",
      severity: "error",
      event: "job_failed",
      ...(snapshot.error_code ? { code: snapshot.error_code } : {}),
      metrics: { stage: snapshot.error_context?.stage ?? "failed" },
    });
    await stop(false, null, null);
    return;
  }
  if (snapshot.state === "READY" && snapshot.media) {
    if (snapshot.provider === "LOCAL_MACOS" && owner.documentId)
      playbackSessions.save({
        version: 1,
        tabId: owner.tabId,
        documentId: owner.documentId,
        generation: owner.generation,
        videoId: owner.videoId,
        durationSeconds: owner.durationSeconds,
        requestId: owner.requestId,
        jobId: snapshot.job_id,
        savedAt: Date.now(),
      });
    // Save snapshots retain the same media grant and must not reset the player.
    const loadedMedia = active.media;
    if (
      loadedMedia?.url === snapshot.media.url &&
      loadedMedia.duration_seconds === snapshot.media.duration_seconds &&
      loadedMedia.model_id === snapshot.media.model_id
    )
      return;
    active.media = snapshot.media;
    await loadAudio().catch((error: unknown) => {
      if (active === owner)
        fail(error instanceof Error ? error.message : "AUDIO_LOAD_FAILED");
    });
  }
}
const MAX_PUBLICATION_ACK_ATTEMPTS = 6;
function canAcknowledgePlayback(owner: ActiveSession): boolean {
  return (
    active === owner &&
    negotiatedPublication &&
    native !== null &&
    owner.publicationPlaying === true &&
    owner.jobId !== undefined &&
    owner.media !== undefined &&
    job?.job_id === owner.jobId &&
    job.state === "READY" &&
    job.provider === "LOCAL_MACOS" &&
    !owner.publicationAcknowledged &&
    (owner.publicationAttempts ?? 0) < MAX_PUBLICATION_ACK_ATTEMPTS
  );
}
function cancelPublicationRetry(owner: ActiveSession): void {
  if (owner.publicationRetryTimer !== undefined)
    clearTimeout(owner.publicationRetryTimer);
  delete owner.publicationRetryTimer;
}
/** The extension-owned player, never a page diagnostic, releases publication. */
async function acknowledgePlayback(owner: ActiveSession): Promise<void> {
  if (
    !canAcknowledgePlayback(owner) ||
    !owner.jobId ||
    owner.publicationAcknowledging ||
    owner.publicationRetryTimer !== undefined
  )
    return;
  owner.publicationAcknowledging = true;
  owner.publicationAttempts = (owner.publicationAttempts ?? 0) + 1;
  try {
    const reply = await command(
      {
        protocol_version: PROTOCOL_VERSION,
        request_id: crypto.randomUUID(),
        type: "PLAYBACK_STARTED",
        payload: { job_id: owner.jobId, video_id: owner.videoId },
      },
      10_000,
      false,
    );
    if (reply.type !== "JOB") throw new Error("PUBLICATION_ACK_FAILED");
    owner.publicationAcknowledged = true;
  } catch {
    // Offscreen deduplicates continuing playback, so retry the command itself
    // while the last trusted state remains playing. This never reads status.
    if (canAcknowledgePlayback(owner)) {
      const delay = Math.min(
        5_000,
        1_000 * 2 ** (owner.publicationAttempts - 1),
      );
      owner.publicationRetryTimer = setTimeout(() => {
        delete owner.publicationRetryTimer;
        void acknowledgePlayback(owner);
      }, delay);
    }
  } finally {
    owner.publicationAcknowledging = false;
    closeIdleConnection();
    installPendingUpdate();
  }
}
async function stop(
  cancel: boolean,
  successor: ActiveSession | null = null,
  reason: string | null = "SESSION_STOPPED",
  context?: ErrorContext,
  retainForNavigation = false,
): Promise<void> {
  playbackSessions.save(null);
  const owner = active ?? pendingStart;
  if (owner && reason)
    diagnostic({
      component: "extension",
      severity: "info",
      event: "playback_stopped",
      code:
        successor && reason === "SESSION_STOPPED"
          ? "PLAYBACK_REPLACED"
          : reason,
      metrics: { stage: "background" },
    });
  if (owner) {
    owner.publicationPlaying = false;
    cancelPublicationRetry(owner);
  }
  if (leaseTimer) clearTimeout(leaseTimer);
  leaseTimer = null;
  let oldJob = job;
  pendingStart = successor;
  active = null;
  job = null;
  stopsInFlight++;
  let finishHandoff!: () => void;
  const handoff = {
    owner,
    promise: new Promise<void>((resolve) => {
      finishHandoff = resolve;
    }),
  };
  stopHandoffs.add(handoff);
  const previousRetention = retained;
  const releasing = previousRetention ? releaseRetained() : undefined;
  const keepPort =
    retainForNavigation &&
    owner &&
    native &&
    (oldJob?.provider === "LOCAL_MACOS" ||
      (!oldJob && hello?.processing_provider !== "ONLINE_MUSICMUTE"));
  let retention: RetainedSession | undefined;
  if (keepPort) {
    retention = {
      owner,
      snapshot: oldJob?.state === "READY" && owner.media ? oldJob : null,
      port: native!,
      expiresAt: Date.now() + RELOAD_GRACE_MS,
      handoff: handoff.promise,
      timer: setTimeout(() => {
        if (retained === retention) void releaseRetained();
      }, RELOAD_GRACE_MS),
    };
    retained = retention;
  }
  try {
    if (releasing) await releasing;
    await chrome.runtime
      .sendMessage({ type: "MM_AUDIO_STOP" })
      .catch(() => undefined);
    if (owner) await tabAudio.release(owner.tabId, owner.requestId);
    if (owner && reason)
      sendToPage(
        {
          type: "MM_ERROR",
          code: reason,
          generation: owner.generation,
          ...(context ? { error_context: context } : {}),
        },
        owner,
      );
    if (cancel && owner?.startReply && !oldJob) {
      const reply = await owner.startReply.catch(() => null);
      if (reply?.type === "JOB")
        oldJob = reply.payload ? pageJob(reply.payload) : null;
    }
    // A completed player still owns its native media grant until it is cancelled.
    if (
      oldJob &&
      !retention?.snapshot &&
      (oldJob.state === "READY" ||
        (cancel && !["CANCELLED", "FAILED"].includes(oldJob.state))) &&
      native
    )
      await command({
        protocol_version: PROTOCOL_VERSION,
        request_id: crypto.randomUUID(),
        type: "CANCEL",
        payload: { job_id: oldJob.job_id },
      }).catch(() => undefined);
  } finally {
    stopsInFlight--;
    stopHandoffs.delete(handoff);
    finishHandoff();
    closeIdleConnection();
    installPendingUpdate();
  }
}
function validPage(sender: chrome.runtime.MessageSender): boolean {
  if (
    sender.id !== chrome.runtime.id ||
    sender.tab?.id === undefined ||
    !sender.url ||
    (sender.frameId !== undefined && sender.frameId !== 0)
  )
    return false;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }
  return (
    (url.protocol === "https:" &&
      ["www.youtube.com", "youtube.com"].includes(url.hostname)) ||
    (url.protocol === "http:" && url.hostname === "127.0.0.1")
  );
}

function fromOffscreen(sender: chrome.runtime.MessageSender): boolean {
  return !sender.tab && sender.url === chrome.runtime.getURL("offscreen.html");
}
function senderVideoId(sender: chrome.runtime.MessageSender): string | null {
  if (!sender.url) return null;
  const id = parseYouTubeVideoId(sender.url);
  if (id) return id;
  // Localhost is reachable only in the separately built browser fixture.
  const url = new URL(sender.url);
  const candidate = url.searchParams.get("v");
  return url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.pathname === "/watch" &&
    isVideoId(candidate)
    ? candidate
    : null;
}
async function recoverPlayback(
  clock: MediaClock,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  if (recovery) {
    await recovery;
    if (active || pendingStart) return;
  }
  const recover = async () => {
    if (
      active ||
      pendingStart ||
      retained ||
      stopsInFlight ||
      !sender.documentId
    )
      return;
    const owner: ActiveSession = {
      tabId: sender.tab!.id!,
      documentId: sender.documentId,
      generation: clock.generation,
      videoId: clock.video_id,
      durationSeconds: clock.duration_seconds,
      requestId: crypto.randomUUID(),
      startedAt: performance.now(),
      automatic: false,
      lastSeenAt: Date.now(),
      clock,
    };
    pendingStart = owner;
    let matched = false;
    try {
      const saved = await playbackSessions.read();
      if (
        !saved ||
        pendingStart !== owner ||
        saved.tabId !== sender.tab?.id ||
        saved.documentId !== sender.documentId ||
        saved.generation !== clock.generation ||
        saved.videoId !== clock.video_id ||
        Math.abs(saved.durationSeconds - clock.duration_seconds) > 2 ||
        isRetiredDocument(saved.tabId, saved.documentId) ||
        (sender.documentLifecycle !== undefined &&
          sender.documentLifecycle !== "active")
      )
        return;
      matched = true;
      owner.requestId = saved.requestId;
      owner.jobId = saved.jobId;
      // Reserve before any tab/native awaits. Stop/navigation/new Start can retire
      // this reservation, and every continuation checks that same owner.
      const tab = await chrome.tabs.get(owner.tabId);
      if (
        pendingStart !== owner ||
        !tab.url ||
        senderVideoId({ ...sender, url: tab.url }) !== owner.videoId
      )
        return;
      await ensureConnected();
      if (pendingStart !== owner) return;
      const reply = await command({
        protocol_version: PROTOCOL_VERSION,
        request_id: crypto.randomUUID(),
        type: "STATUS",
        payload: {},
      });
      if (pendingStart !== owner) return;
      // STATUS rechecks the native account and saved provider. Never START,
      // reacquire or submit billable work during automatic recovery.
      if (
        reply.type !== "JOB" ||
        !reply.payload ||
        !isJobSnapshot(reply.payload) ||
        reply.payload.job_id !== saved.jobId ||
        reply.payload.video_id !== saved.videoId ||
        reply.payload.provider !== "LOCAL_MACOS" ||
        reply.payload.state !== "READY" ||
        !reply.payload.media ||
        Math.abs(reply.payload.media.duration_seconds - saved.durationSeconds) >
          2
      )
        return;
      active = owner;
      pendingStart = null;
      armPageLease(owner);
      await receiveJob(reply.payload, owner.requestId);
      if (active === owner)
        diagnostic({
          component: "extension",
          severity: "info",
          event: "stage_completed",
          metrics: { stage: "session_recovered" },
        });
    } catch {
      // No valid native grant remains. The page restores original audio and
      // reports the failed recovery instead of silently starting a new job.
    } finally {
      if (pendingStart === owner) {
        pendingStart = null;
        if (matched) {
          playbackSessions.save(null);
          await chrome.runtime
            .sendMessage({ type: "MM_AUDIO_STOP" })
            .catch(() => undefined);
          await tabAudio.release(owner.tabId, owner.requestId);
        }
      }
    }
  };
  recovery = recover().finally(() => {
    recovery = null;
  });
  return recovery;
}
async function handle(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  if (sender.id !== chrome.runtime.id) return { ok: false };
  if (message.type === "MM_CLOUD_ACTIVE") {
    if (sender.url !== chrome.runtime.getURL("popup.html") || sender.tab)
      return { ok: false };
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const id = tab?.url ? parseYouTubeVideoId(tab.url) : null;
    if (tab?.id === undefined || !id)
      return { ok: false, error: "UNSUPPORTED_VIDEO" };
    return handle(
      {
        type: "MM_CLOUD_HANDOFF",
        video_id: id,
        generation:
          active?.tabId === tab.id
            ? active.generation
            : pendingStart?.tabId === tab.id
              ? pendingStart.generation
              : 0,
      },
      { ...sender, tab, url: tab.url!, frameId: 0 },
    );
  }
  if (message.type === "MM_EVENT") {
    diagnostic(message.payload);
    return { ok: true };
  }
  if (message.type === "MM_STATUS") {
    if (!hello || message.refresh)
      await ensureConnected(
        true,
        message.refresh === true &&
          hello?.capabilities?.includes("processing_selection_v1") === true,
      ).catch(() => undefined);
    const stored = await chrome.storage.local.get([
      errorKey,
      installationCheckKey,
    ]);
    const previousCheck = installationCheck ?? stored[installationCheckKey];
    retainStatusConnection();
    return {
      hello,
      job,
      diagnostics: safeLocalErrors(stored[errorKey]),
      ...(isInstallationCheck(previousCheck) &&
      previousCheck.installation_id === hello?.installation_id
        ? { installation_check: previousCheck }
        : {}),
      ...(lastError ? { error: lastError } : {}),
      ...(lastErrorContext ? { error_context: lastErrorContext } : {}),
    } satisfies ExtensionStatus;
  }
  if (message.type === "MM_CHECK") {
    if (sender.tab || sender.url !== chrome.runtime.getURL("popup.html"))
      return { ok: false };
    if (checkingInstallation) return checkingInstallation;
    const run = async () => {
      await ensureConnected();
      if (!hello?.installation_check_supported)
        return { ok: false, error: "APP_UPDATE_REQUIRED" };
      const reply = await command(
        {
          protocol_version: PROTOCOL_VERSION,
          request_id: crypto.randomUUID(),
          type: "CHECK",
          payload: {},
        },
        365_000,
      );
      return reply.type === "CHECK"
        ? { ok: true, installation_check: reply.payload }
        : {
            ok: false,
            error:
              reply.type === "ERROR"
                ? reply.payload.error_code
                : "INSTALLATION_CHECK_FAILED",
          };
    };
    checkingInstallation = run();
    try {
      return await checkingInstallation;
    } catch (error) {
      const code =
        error instanceof NativePortFailure
          ? error.message
          : "INSTALLATION_CHECK_FAILED";
      if (installationCheck?.state === "running") {
        installationCheck = {
          ...installationCheck,
          state: "failed",
          completed_at: Date.now(),
          checks: installationCheck.checks.map((check) =>
            check.state === "running" || check.state === "pending"
              ? { ...check, state: "failed", error_code: code }
              : check,
          ),
        };
        await chrome.storage.local
          .set({ [installationCheckKey]: installationCheck })
          .catch(() => {});
        void chrome.runtime
          .sendMessage({
            type: "MM_CHECK_PROGRESS",
            payload: installationCheck,
          } satisfies ExtensionMessage)
          .catch(() => {});
      }
      return { ok: false, error: code };
    } finally {
      checkingInstallation = undefined;
      installPendingUpdate();
    }
  }
  if (
    message.type === "MM_DIAGNOSTICS" &&
    sender.url === chrome.runtime.getURL("popup.html")
  )
    return command({
      protocol_version: PROTOCOL_VERSION,
      request_id: crypto.randomUUID(),
      type: "DIAGNOSTICS",
      payload: {},
    });
  if (
    message.type === "MM_CLEAR_CACHE" &&
    sender.url === chrome.runtime.getURL("popup.html")
  ) {
    cacheClearsInFlight++;
    cancelStatusHandoff();
    try {
      await stop(true);
      return await command({
        protocol_version: PROTOCOL_VERSION,
        request_id: crypto.randomUUID(),
        type: "CLEAR_CACHE",
        payload: {},
      });
    } finally {
      cacheClearsInFlight--;
    }
  }
  if (message.type === "MM_AUDIO_READY" && fromOffscreen(sender)) {
    if (active?.generation === message.generation)
      sendToPage({
        type: "MM_READY",
        generation: message.generation,
        source_muted: !active.clock?.ad_active,
      });
    return { ok: true };
  }
  if (message.type === "MM_AUDIO_STATE" && fromOffscreen(sender)) {
    if (active?.generation === message.generation) {
      active.publicationPlaying = message.playing;
      if (message.playing && !active.firstPlaybackRecorded) {
        active.firstPlaybackRecorded = true;
        diagnostic({
          component: "extension",
          severity: "info",
          event: "stage_completed",
          ...(active.jobId ? { job_id: active.jobId } : {}),
          metrics: {
            stage: "start-to-playback",
            duration_ms: performance.now() - active.startedAt,
          },
        });
      }
      if (!message.playing) cancelPublicationRetry(active);
      sendToPage({
        type: "MM_PLAYBACK",
        playing: message.playing,
        generation: message.generation,
      });
      if (message.playing) void acknowledgePlayback(active);
    }
    return { ok: true };
  }
  if (message.type === "MM_AUDIO_ERROR" && fromOffscreen(sender)) {
    if (active?.generation === message.generation) fail(message.code);
    return { ok: true };
  }
  if (!validPage(sender)) return { ok: false };
  if (message.type === "MM_CLOCK" && !active)
    await recoverPlayback(message.payload, sender);
  if (message.type === "MM_CLOUD_HANDOFF") {
    const tab = await chrome.tabs.get(sender.tab!.id!);
    if (
      senderVideoId({ ...sender, url: tab.url ?? sender.url! }) !==
      message.video_id
    )
      return { ok: false, error: "UNSUPPORTED_VIDEO" };
    // Never submit billable work in Chrome: native Home reviews account and quota.
    // App launch works before Chrome registration and model setup. A known old
    // helper gets upgrade guidance; an absent helper is not a cloud prerequisite.
    if (hello && !hello.capabilities?.includes("cloud_handoff_v1"))
      return { ok: false, error: "APP_UPDATE_REQUIRED" };
    if (active || pendingStart) {
      const owner = active ?? pendingStart;
      if (
        owner?.tabId !== sender.tab!.id ||
        owner?.generation !== message.generation ||
        (owner.documentId !== undefined &&
          owner.documentId !== sender.documentId)
      )
        return { ok: false, error: "LOCAL_COMPANION_BUSY" };
      await stop(true, null, null);
      if (active || pendingStart)
        return { ok: false, error: "LOCAL_COMPANION_BUSY" };
      const latestTab = await chrome.tabs.get(sender.tab!.id!);
      if (
        senderVideoId({ ...sender, url: latestTab.url ?? sender.url! }) !==
        message.video_id
      )
        return { ok: false, error: "UNSUPPORTED_VIDEO" };
    }
    return {
      ok: true,
      handoff_url: cloudHandoffUrl(message.video_id, message.duration_seconds),
    };
  }
  if (message.type === "MM_START") {
    cancelStatusHandoff();
    if (
      !message.payload ||
      typeof message.payload !== "object" ||
      Array.isArray(message.payload) ||
      Object.keys(message.payload).some(
        (key) => !["video_id", "duration_seconds", "provider"].includes(key),
      ) ||
      !isVideoId(message.payload.video_id) ||
      message.payload.provider !== "LOCAL_MACOS" ||
      !Number.isFinite(message.payload.duration_seconds) ||
      message.payload.duration_seconds <= 0 ||
      message.payload.duration_seconds > MVP_MAX_DURATION_SECONDS ||
      !Number.isSafeInteger(message.generation) ||
      (message.intent !== undefined &&
        message.intent !== "manual" &&
        message.intent !== "automatic") ||
      (message.cloud_confirmed !== undefined &&
        typeof message.cloud_confirmed !== "boolean") ||
      (message.cloud_confirmation_scope !== undefined &&
        (typeof message.cloud_confirmation_scope !== "string" ||
          message.cloud_confirmation_scope.length !== 64 ||
          !/^[a-f0-9]{64}$/.test(message.cloud_confirmation_scope)))
    )
      return { ok: false, error: "UNSUPPORTED_VIDEO" };
    const automatic = message.intent === "automatic";
    const owner: ActiveSession = {
      startedAt: performance.now(),
      tabId: sender.tab!.id!,
      generation: message.generation,
      videoId: message.payload.video_id,
      durationSeconds: message.payload.duration_seconds,
      requestId: crypto.randomUUID(),
      automatic,
      lastSeenAt: Date.now(),
      ...(sender.documentId ? { documentId: sender.documentId } : {}),
    };
    const canRefresh = (previous: ActiveSession | null): boolean =>
      previous !== null &&
      previous.tabId === owner.tabId &&
      previous.documentId !== undefined &&
      owner.documentId !== undefined &&
      (previous.documentId !== owner.documentId ||
        (retained?.owner === previous &&
          owner.generation > previous.generation)) &&
      owner.generation >= previous.generation;
    const predecessor = active ?? pendingStart ?? retained?.owner ?? null;
    const retiring = [...stopHandoffs];
    const previousDocument = currentDocuments.get(owner.tabId);
    if (
      (sender.documentLifecycle !== undefined &&
        sender.documentLifecycle !== "active") ||
      isRetiredDocument(owner.tabId, owner.documentId) ||
      (previousDocument && owner.generation < previousDocument.generation)
    )
      return {
        ok: false,
        error: automatic ? "AUTO_START_BUSY" : "SESSION_STOPPED",
      };
    if (
      automatic &&
      ((predecessor && !canRefresh(predecessor)) ||
        retiring.some((handoff) => !canRefresh(handoff.owner)))
    )
      return { ok: false, error: "AUTO_START_BUSY" };
    if (owner.documentId) {
      // Retire a Chrome document only when another document replaces it. A Stop
      // followed by YouTube SPA navigation still belongs to the same document.
      // Keep one current identity per tab and short bounded tombstones, since
      // sender metadata may describe a message queued before a page refresh.
      if (previousDocument?.documentId !== owner.documentId)
        retireDocument(previousDocument ?? null);
      currentDocuments.set(owner.tabId, {
        tabId: owner.tabId,
        documentId: owner.documentId,
        generation: owner.generation,
      });
    }
    try {
      let currentTab: chrome.tabs.Tab;
      let candidate = retained;
      const preserve =
        !!active && canRefresh(active) && job?.provider === "LOCAL_MACOS";
      const replacement = candidate
        ? ((pendingStart = owner), candidate.handoff)
        : predecessor || !automatic
          ? stop(true, owner, "SESSION_STOPPED", undefined, preserve)
          : undefined;
      if (!predecessor) pendingStart = owner;
      candidate = retained;
      await Promise.all([
        ...(automatic ? retiring.map((handoff) => handoff.promise) : []),
        ...(replacement ? [replacement] : []),
      ]);
      if (pendingStart !== owner)
        return { ok: false, error: "SESSION_STOPPED" };
      if (automatic) {
        // Reserve before yielding, including when pagehide has already cleared
        // active ownership. Join its silence/native cancellation acknowledgement;
        // a refresh must not issue another acquisition while it is still retiring.
        let settings: Awaited<ReturnType<typeof loadSettings>>;
        try {
          settings = await loadSettings();
          if (pendingStart !== owner)
            return { ok: false, error: "SESSION_STOPPED" };
          currentTab = await chrome.tabs.get(owner.tabId);
        } catch {
          return {
            ok: false,
            error:
              pendingStart === owner
                ? "AUTO_START_UNAVAILABLE"
                : "SESSION_STOPPED",
          };
        }
        if (pendingStart !== owner)
          return { ok: false, error: "SESSION_STOPPED" };
        if (!currentTab || currentTab.id !== owner.tabId)
          return { ok: false, error: "AUTO_START_UNAVAILABLE" };
        if (
          !settings.autoStartEnabled ||
          message.payload.duration_seconds >= settings.maxDurationMinutes * 60
        )
          return { ok: false, error: "AUTO_START_INELIGIBLE" };
      } else {
        currentTab = await chrome.tabs.get(owner.tabId);
      }
      // Chrome sender.url can be the document's initial URL after SPA navigation.
      // tabs.get resolves the current route, without trusting a caller-supplied URL.
      if (
        senderVideoId({ ...sender, url: currentTab.url ?? sender.url! }) !==
        owner.videoId
      )
        return { ok: false, error: "UNSUPPORTED_VIDEO" };
      if (pendingStart !== owner)
        return { ok: false, error: "SESSION_STOPPED" };
      if (
        candidate &&
        retained === candidate &&
        native === candidate.port &&
        Date.now() < candidate.expiresAt &&
        canRefresh(candidate.owner) &&
        candidate.owner.videoId === owner.videoId &&
        Math.abs(candidate.owner.durationSeconds - owner.durationSeconds) <=
          2 &&
        candidate.snapshot?.state === "READY" &&
        candidate.owner.media &&
        hello?.processing_provider !== "ONLINE_MUSICMUTE" &&
        message.cloud_confirmed !== true
      ) {
        const current = await command({
          protocol_version: PROTOCOL_VERSION,
          request_id: crypto.randomUUID(),
          type: "STATUS",
          payload: {},
        });
        if (pendingStart !== owner)
          return { ok: false, error: "SESSION_STOPPED" };
        if (
          retained === candidate &&
          native === candidate.port &&
          Date.now() < candidate.expiresAt &&
          current.type === "JOB" &&
          current.payload?.state === "READY" &&
          current.payload.provider === "LOCAL_MACOS" &&
          current.payload.job_id === candidate.snapshot?.job_id &&
          current.payload.video_id === owner.videoId &&
          current.payload.media?.url === candidate.owner.media.url &&
          current.payload.media.duration_seconds ===
            candidate.owner.media.duration_seconds &&
          current.payload.media.model_id === candidate.owner.media.model_id
        ) {
          takeRetained(candidate);
          owner.requestId = candidate.owner.requestId;
          owner.jobId = current.payload.job_id;
          if (candidate.owner.publicationAcknowledged !== undefined)
            owner.publicationAcknowledged =
              candidate.owner.publicationAcknowledged;
          active = owner;
          pendingStart = null;
          lastError = undefined;
          lastErrorContext = undefined;
          armPageLease(owner);
          await receiveJob(current.payload, owner.requestId);
          return { ok: active === owner };
        }
        if (current.type === "ERROR") {
          await releaseRetained();
          throw new NativeReplyFailure(
            current.payload.error_code,
            current.payload.error_context,
          );
        }
      }
      await releaseRetained();
      if (pendingStart !== owner)
        return { ok: false, error: "SESSION_STOPPED" };
      active = owner;
      armPageLease(owner);
      pendingStart = null;
      lastError = undefined;
      lastErrorContext = undefined;
      try {
        await ensureConnected(
          false,
          hello?.capabilities?.includes("processing_selection_v1") === true,
        );
      } catch (error) {
        if (active !== owner && !(error instanceof NativePortFailure))
          return { ok: false, error: "SESSION_STOPPED" };
        throw error;
      }
      if (active !== owner) return { ok: false, error: "SESSION_STOPPED" };
      const selectedProvider =
        hello?.capabilities?.includes("processing_selection_v1") &&
        hello.processing_provider === "ONLINE_MUSICMUTE"
          ? "ONLINE_MUSICMUTE"
          : "LOCAL_MACOS";
      const choiceError =
        selectedProvider === "ONLINE_MUSICMUTE"
          ? automatic
            ? "AUTO_START_CLOUD_CONFIRMATION_REQUIRED"
            : !hello?.processing_scope
              ? "ACCOUNT_REQUIRED"
              : message.cloud_confirmed !== true
                ? "CLOUD_CONFIRMATION_REQUIRED"
                : message.cloud_confirmation_scope !== hello.processing_scope
                  ? "ACCOUNT_CHANGED"
                  : undefined
          : message.cloud_confirmed === true
            ? "PROCESSING_SELECTION_CHANGED"
            : undefined;
      if (choiceError) {
        active = null;
        if (leaseTimer) clearTimeout(leaseTimer);
        leaseTimer = null;
        return {
          ok: false,
          error: choiceError,
          processing_provider: selectedProvider,
          ...(choiceError === "CLOUD_CONFIRMATION_REQUIRED"
            ? { cloud_confirmation_scope: hello!.processing_scope }
            : {}),
        };
      }
      if (!hello?.ready)
        throw new Error(hello?.error_code ?? "COMPANION_NOT_READY");
      owner.startReply = command({
        protocol_version: PROTOCOL_VERSION,
        request_id: owner.requestId,
        type: "START",
        payload: {
          video_id: message.payload.video_id,
          duration_seconds: message.payload.duration_seconds,
          provider: selectedProvider,
        },
      });
      let reply: NativeReply;
      try {
        reply = await owner.startReply;
      } catch (error) {
        if (active !== owner && !(error instanceof NativePortFailure))
          return { ok: false, error: "SESSION_STOPPED" };
        throw error;
      }
      if (reply.type === "ERROR") {
        if (active !== owner) return { ok: false, error: "SESSION_STOPPED" };
        throw new NativeReplyFailure(
          reply.payload.error_code,
          reply.payload.error_context,
        );
      }
      return { ok: true };
    } finally {
      if (pendingStart === owner) pendingStart = null;
    }
  }
  const controlOwner =
    active ??
    pendingStart ??
    (message.type === "MM_CANCEL" ? retained?.owner : null);
  if (
    !controlOwner ||
    controlOwner.tabId !== sender.tab!.id ||
    (controlOwner.documentId !== undefined &&
      sender.documentId !== controlOwner.documentId) ||
    ("generation" in message && message.generation !== controlOwner.generation)
  )
    return { ok: false };
  if (message.type === "MM_CANCEL" || message.type === "MM_STOP") {
    const navigation = message.reason !== undefined;
    if (message.reason === "pagehide") retireDocument(controlOwner);
    await stop(
      message.type === "MM_CANCEL" || navigation,
      null,
      navigation ? null : "SESSION_STOPPED",
      undefined,
      navigation,
    );
    return { ok: true };
  }
  if (message.type === "MM_CLOCK" && active) {
    const owner = active;
    if (
      message.payload.generation !== active.generation ||
      message.payload.video_id !== active.videoId
    )
      return { ok: false };
    owner.lastSeenAt = Date.now();
    owner.clock = message.payload;
    if (owner.media) {
      try {
        if (!message.payload.ad_active) {
          const muted = await tabAudio.set(owner.tabId, owner.requestId, true);
          if (active !== owner) return { ok: false };
          if (muted) owner.clock = { ...owner.clock, user_muted: true };
        }
        if (offscreenLoading?.owner === owner) await offscreenLoading.promise;
        else {
          const hasDocument = await chrome.offscreen.hasDocument();
          if (active !== owner) return { ok: false };
          // A document can exist before its listener/media load is ready. Join
          // loads that began while the asynchronous document query was pending.
          if (offscreenLoading?.owner === owner) await offscreenLoading.promise;
          else {
            const latestClock = owner.clock;
            if (!hasDocument) {
              if (
                !latestClock.paused &&
                !latestClock.ended &&
                !latestClock.ad_active
              )
                await loadAudio();
            } else {
              try {
                await chrome.runtime.sendMessage({
                  type: "MM_AUDIO_CLOCK",
                  payload: latestClock,
                } satisfies ExtensionMessage);
              } catch {
                if (active !== owner) return { ok: false };
                diagnostic({
                  component: "extension",
                  severity: "warning",
                  event: "diagnostic_error",
                  code: "AUDIO_CONTEXT_LOST",
                  metrics: {
                    stage: "playback",
                    generation: owner.generation,
                    passed: false,
                  },
                });
                // The document may have disappeared after hasDocument(). Allow
                // one singleflight reload; a failed reload reaches the error
                // boundary below rather than recursively retrying this clock.
                await loadAudio();
                if (active === owner)
                  diagnostic({
                    component: "extension",
                    severity: "info",
                    event: "diagnostic_error",
                    code: "AUDIO_CONTEXT_LOST",
                    metrics: {
                      stage: "playback",
                      generation: owner.generation,
                      passed: true,
                    },
                  });
              }
            }
          }
        }
      } catch {
        if (active === owner) {
          fail("AUDIO_CONTEXT_LOST");
          return { ok: false, error: "AUDIO_CONTEXT_LOST" };
        }
        return { ok: false };
      }
    }
    if (active === owner && owner.media && owner.clock?.ad_active)
      await tabAudio.set(owner.tabId, owner.requestId, false);
    return {
      ok: active === owner,
      ...(owner.media ? { source_muted: !owner.clock?.ad_active } : {}),
    };
  }
  return { ok: false };
}

chrome.runtime.onMessage.addListener((value: unknown, sender, sendResponse) => {
  if (!isExtensionMessage(value)) {
    sendResponse({ ok: false, error: "INVALID_MESSAGE" });
    return true;
  }
  const message = value;
  if (
    message.type.startsWith("MM_AUDIO_") &&
    !["MM_AUDIO_READY", "MM_AUDIO_STATE", "MM_AUDIO_ERROR"].includes(
      message.type,
    )
  )
    return;
  void handle(message, sender)
    .then(sendResponse, async (error: unknown) => {
      const code =
        error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
          ? error.message
          : "EXTENSION_OPERATION_FAILED";
      if (error instanceof NativeReplyFailure) {
        await fail(code, error.error_context);
      } else if (error instanceof NativePortFailure) {
        // The owning port already recorded the failure and stopped playback.
      } else if (
        active &&
        sender.tab?.id === active.tabId &&
        (!("generation" in message) || message.generation === active.generation)
      )
        await fail(code);
      else {
        lastError = code;
        diagnostic({
          component: "extension",
          severity: "error",
          event: "diagnostic_error",
          code,
        });
      }
      sendResponse({
        ok: false,
        error: code,
        ...(error instanceof NativeReplyFailure && error.error_context
          ? { error_context: error.error_context }
          : {}),
      });
    })
    .finally(() => {
      closeIdleConnection();
      installPendingUpdate();
    });
  return true;
});
chrome.tabs.onUpdated?.addListener((tabId, change) => {
  if (
    change.status === "loading" &&
    active?.tabId !== tabId &&
    pendingStart?.tabId !== tabId
  )
    void (async () => {
      if (!(await tabAudio.has(tabId))) return;
      // After background loss, retire any orphan player before restoring its
      // source. A newly admitted session keeps ownership of its own mask.
      if (!active && !pendingStart)
        await chrome.runtime
          .sendMessage({ type: "MM_AUDIO_STOP" })
          .catch(() => undefined);
      if (active?.tabId !== tabId && pendingStart?.tabId !== tabId)
        await tabAudio.release(tabId);
    })().catch(() => undefined);
  if (
    active?.tabId === tabId &&
    active.media &&
    change.mutedInfo &&
    !(
      change.mutedInfo.reason === "extension" &&
      change.mutedInfo.extensionId === chrome.runtime.id
    )
  )
    void stop(false);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (active?.tabId === tabId || pendingStart?.tabId === tabId) void stop(true);
  if (retained?.owner.tabId === tabId) void releaseRetained();
  void tabAudio.release(tabId).catch(() => undefined);
  retiredDocuments.delete(tabId);
  currentDocuments.delete(tabId);
});
chrome.runtime.onUpdateAvailable?.addListener(() => {
  updatePending = true;
  installPendingUpdate();
});
globalThis.addEventListener("error", () =>
  diagnostic({
    component: "extension",
    severity: "error",
    event: "diagnostic_error",
    code: "BACKGROUND_UNCAUGHT_ERROR",
  }),
);
globalThis.addEventListener("unhandledrejection", () =>
  diagnostic({
    component: "extension",
    severity: "error",
    event: "diagnostic_error",
    code: "BACKGROUND_UNHANDLED_REJECTION",
  }),
);
