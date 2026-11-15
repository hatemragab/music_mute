import { randomUUID } from "node:crypto";
import {
  CloudProcessingProvider,
  type CloudResult,
  type CloudProgress,
  type CloudFileRequest,
  type InputDeclaration,
  type JobMetadata,
  type DownloadGrant,
  type RealtimeAccess,
} from "../../../../chrome-extension/src/companion/cloud-provider.js";
import type { validateUploadGrant } from "../../../../chrome-extension/src/companion/local-sync-client.js";
type UploadGrant = ReturnType<typeof validateUploadGrant>;
import {
  canonicalYouTubeUrl,
  MVP_MAX_DURATION_SECONDS,
} from "../../../../chrome-extension/src/shared/protocol.js";
import { DesktopApiError } from "../../../../chrome-extension/src/companion/account-api.js";
import type { AccountView } from "../../shared/account-contracts.js";
import type { AccountSessionScope } from "../account/account-controller.js";
import type {
  AccountUsageView,
  ProcessingMode,
} from "../../shared/usage-contracts.js";
import { processingAdmissionPreview } from "../usage/presentation.js";
import {
  parseCloudCommand,
  type CloudCommand,
  type CloudView,
  type CloudBrowserSettings,
  type CloudConfirmationView,
} from "../../shared/cloud-contracts.js";
import type { CloudModeStore } from "./mode-store.js";
import { createCloudApi } from "./api.js";
import type { AccountFetch } from "../account/transport.js";
export interface CloudAccountPort {
  view(): AccountView;
  sessionScope(): AccountSessionScope | null;
  assertScope(scope: AccountSessionScope): void;
  authorization(force?: boolean): Promise<string>;
  subscribe(listener: (view: AccountView) => void): () => void;
}
export interface CloudMediaInput {
  input: InputDeclaration;
  source: "audio_file" | "video_file";
  title: string;
  upload(grant: UploadGrant, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
export interface CloudMediaPort {
  prepareFile(
    source: { capability: string; name: string; bytes: number },
    context: {
      requestId: string;
      scope: AccountSessionScope;
      signal: AbortSignal;
      assertCurrent(): void;
    },
  ): Promise<CloudMediaInput>;
  download(
    job: JobMetadata,
    grant: DownloadGrant,
    context: {
      requestId: string;
      scope: AccountSessionScope;
      signal: AbortSignal;
      assertCurrent(): void;
    },
  ): Promise<string>;
}
export interface CloudControllerOptions {
  origin: string;
  installationId: string;
  account: CloudAccountPort;
  usage: {
    view(): AccountUsageView;
    assertCloudSubmission(account: AccountView): void;
    subscribe(listener: (view: AccountUsageView) => void): () => void;
  };
  realtime: { cloudLease(scope: AccountSessionScope): RealtimeAccess };
  modeStore: CloudModeStore;
  media: CloudMediaPort;
  localReady(): boolean;
  fetch?: AccountFetch;
  now?: () => number;
}
interface Confirmation {
  view: CloudConfirmationView;
  scope: AccountSessionScope;
  source:
    | { kind: "youtube"; videoId: string; duration?: number; title?: string }
    | { kind: "file"; capability: string; name: string; bytes: number };
  used: boolean;
  media?: CloudMediaInput;
}
interface Operation {
  scope: AccountSessionScope;
  abort: AbortController;
  provider: CloudProcessingProvider;
  confirmation: Confirmation;
  promise: Promise<CloudView>;
  cancelRequested: boolean;
  cancelJobKnown: boolean;
}
const safeCodes = new Set([
  "SIGN_IN_REQUIRED",
  "ACCOUNT_OFFLINE",
  "ACCOUNT_CHANGED",
  "SESSION_CHANGED",
  "CLOUD_POLICY_UNAVAILABLE",
  "PROCESSING_PAUSED",
  "PROCESSING_ALLOWANCE_EXHAUSTED",
  "monthly_limit_reached",
  "storage_limit_reached",
  "waiting_job_limit",
  "paused",
  "APP_UPDATE_REQUIRED",
  "EMAIL_VERIFICATION_REQUIRED",
  "CANCELLED",
  "CLOUD_BUSY",
  "CLOUD_CONFIRMATION_INVALID",
  "CLOUD_CONFIRMATION_EXPIRED",
  "PROCESSING_SELECTION_UNAVAILABLE",
  "CLOUD_PROCESSING_TIMEOUT",
  "CLOUD_RESULT_UNAVAILABLE",
  "DOWNLOAD_GRANT_INVALID",
  "UPLOAD_GRANT_INVALID",
  "UPLOAD_GRANT_EXPIRED",
  "SOURCE_IDENTITY_MISMATCH",
  "TIMELINE_INCOMPATIBLE",
  "CLOUD_REPLY_INVALID",
  "CLOUD_REQUEST_ACTIVE",
  "CLOUD_POLICY_DENIED",
  "API_UNAVAILABLE",
  "API_REQUEST_FAILED",
  "UPLOAD_UNAVAILABLE",
  "UPLOAD_AMBIGUOUS",
  "UPLOAD_REJECTED",
  "MEDIA_TOOLS_REQUIRED",
  "CLOUD_INPUT_INVALID",
  "MODE_CHANGED",
  "CLOUD_IMPORT_CANCELLATION_UNAVAILABLE",
]);
function failure(error: unknown): string {
  if (error instanceof DesktopApiError) {
    if (error.status === 503) return "CLOUD_POLICY_UNAVAILABLE";
    if (error.status === 401) return "SIGN_IN_REQUIRED";
    if (error.status === 403) return "CLOUD_POLICY_DENIED";
    return safeCodes.has(error.code) ? error.code : "CLOUD_REQUEST_FAILED";
  }
  const code = error instanceof Error ? error.message : "";
  return safeCodes.has(code) ? code : "CLOUD_REQUEST_FAILED";
}
export class CloudController {
  private mode: ProcessingMode = "local";
  private restored = false;
  private confirmation: Confirmation | null = null;
  private operation: Operation | null = null;
  private presentedScope: AccountSessionScope | null = null;
  private readonly completed = new Map<
    string,
    { scope: AccountSessionScope; job: JobMetadata; expiresAt: number }
  >();
  private disposed = false;
  private closing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<CloudView>>();
  private modeQueue: Promise<void> = Promise.resolve();
  private value: CloudView = {
    mode: "local",
    ready: false,
    reason: "PREPARE_REQUIRED",
    signInRequired: false,
    linkImportVisible: false,
    connection: "stopped",
    busy: false,
    phase: "idle",
    confirmation: null,
    job: null,
    errorCode: null,
    resultCapability: null,
  };
  private readonly listeners = new Set<(view: CloudView) => void>();
  private readonly stops: (() => void)[] = [];
  constructor(private readonly options: CloudControllerOptions) {
    this.stops.push(
      options.account.subscribe(() => this.accountChanged()),
      options.usage.subscribe(() => this.recompute()),
    );
  }
  private get now() {
    return (this.options.now ?? Date.now)();
  }
  view(): CloudView {
    return structuredClone(this.value);
  }
  /** Local Prepare events change admission without polling or changing the user's chosen mode. */
  refreshReadiness(): void {
    this.recompute();
  }
  subscribe(listener: (view: CloudView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(patch: Partial<CloudView>): void {
    if (this.disposed) return;
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {
        /* Presentation cannot authorize charges. */
      }
    }
  }
  private recompute(): void {
    const account = this.options.account.view(),
      usage = this.options.usage.view(),
      decision = processingAdmissionPreview(
        this.mode,
        this.options.localReady(),
        account,
        usage,
      );
    this.publish({
      mode: this.mode,
      ready: decision.allowed,
      reason: decision.reason,
      signInRequired: decision.signInRequired,
      linkImportVisible: usage.policy?.linkImportVisible === true,
      connection: usage.connection,
    });
  }
  private accountChanged(): void {
    const scope = this.options.account.sessionScope();
    for (const [capability, result] of this.completed)
      if (!this.same(scope, result.scope)) this.completed.delete(capability);
    if (this.presentedScope && !this.same(scope, this.presentedScope)) {
      this.presentedScope = null;
      this.publish({ phase: "idle", job: null, resultCapability: null });
    }
    if (this.confirmation && !this.same(scope, this.confirmation.scope)) {
      const media = this.confirmation.media;
      this.confirmation = null;
      void media?.close().catch(() => {});
      this.publish({ confirmation: null, job: null, resultCapability: null });
    }
    if (this.operation && !this.same(scope, this.operation.scope)) {
      this.operation.abort.abort();
      this.operation.provider.close();
      this.operation = null;
      this.publish({
        busy: false,
        phase: "idle",
        confirmation: null,
        job: null,
        resultCapability: null,
        errorCode: null,
      });
    }
    this.recompute();
  }
  private same(a: AccountSessionScope | null, b: AccountSessionScope) {
    return a?.firebaseUid === b.firebaseUid && a.generation === b.generation;
  }
  private current(scope: AccountSessionScope) {
    if (this.disposed) throw new Error("CANCELLED");
    this.options.account.assertScope(scope);
  }
  async restore(): Promise<CloudView> {
    try {
      this.mode = await this.options.modeStore.read();
      this.restored = true;
      this.recompute();
    } catch (error) {
      this.restored = false;
      this.publish({
        ready: false,
        errorCode: failure(error),
        reason: "PROCESSING_SELECTION_UNAVAILABLE",
      });
    }
    return this.view();
  }
  setMode(mode: ProcessingMode): Promise<CloudView> {
    const action = this.modeQueue.then(async () => {
      if (this.disposed) throw new Error("CANCELLED");
      await this.options.modeStore.write(mode);
      this.mode = mode;
      this.restored = true;
      this.recompute();
      return this.view();
    });
    this.modeQueue = action.then(
      () => {},
      () => {},
    );
    return action;
  }
  async execute(value: unknown): Promise<CloudView> {
    const command = parseCloudCommand(value);
    if (command.type === "RESTORE") return this.restore();
    if (command.type === "SET_MODE") return this.setMode(command.mode);
    if (command.type === "CANCEL") return this.cancel();
    if (command.type === "CLEAR_CONFIRMATION") {
      await this.clearConfirmation();
      return this.view();
    }
    if (command.type === "PREPARE_YOUTUBE") {
      this.prepareYouTubeConfirmation(command);
      return this.view();
    }
    if (command.type === "PREPARE_FILE") {
      this.prepareFileConfirmation(command);
      return this.view();
    }
    if (command.type === "CONFIRM")
      return this.confirm(command.capability, command.rightsConfirmed);
    throw new Error("CLOUD_COMMAND_INVALID");
  }
  private scope(): AccountSessionScope {
    if (!this.restored) throw new Error("PROCESSING_SELECTION_UNAVAILABLE");
    if (this.mode !== "cloud") throw new Error("CLOUD_CONFIRMATION_INVALID");
    const scope = this.options.account.sessionScope();
    if (!scope) throw new Error("SIGN_IN_REQUIRED");
    this.options.usage.assertCloudSubmission(this.options.account.view());
    return { ...scope };
  }
  prepareYouTubeConfirmation(input: {
    videoId: string;
    durationSeconds?: number;
    title?: string;
  }): CloudConfirmationView {
    const checked = parseCloudCommand({
      type: "PREPARE_YOUTUBE",
      ...input,
    }) as Extract<CloudCommand, { type: "PREPARE_YOUTUBE" }>;
    return this.prepare(
      {
        kind: "youtube",
        videoId: checked.videoId,
        ...(checked.durationSeconds === undefined
          ? {}
          : { duration: checked.durationSeconds }),
        ...(checked.title === undefined ? {} : { title: checked.title }),
      },
      checked.title ?? canonicalYouTubeUrl(checked.videoId),
      checked.durationSeconds ?? null,
    );
  }
  prepareFileConfirmation(input: {
    fileCapability: string;
    name: string;
    bytes: number;
  }): CloudConfirmationView {
    parseCloudCommand({ type: "PREPARE_FILE", ...input });
    return this.prepare(
      {
        kind: "file",
        capability: input.fileCapability,
        name: input.name,
        bytes: input.bytes,
      },
      input.name,
      null,
    );
  }
  private prepare(
    source: Confirmation["source"],
    title: string,
    duration: number | null,
  ): CloudConfirmationView {
    if (this.operation) throw new Error("CLOUD_BUSY");
    const scope = this.scope();
    const view: CloudConfirmationView = {
      capability: randomUUID(),
      requestId: randomUUID(),
      kind: source.kind,
      title,
      estimatedDurationSeconds: duration,
      expiresAt: new Date(this.now + 5 * 60000).toISOString(),
    };
    const previous = this.confirmation;
    this.confirmation = { view, scope, source, used: false };
    void previous?.media?.close().catch(() => {});
    this.publish({
      phase: "confirming",
      confirmation: view,
      errorCode: null,
      job: null,
      resultCapability: null,
    });
    return structuredClone(view);
  }
  /** Browser handoff freezes no account or capability and never starts a request. */
  acceptBrowserHandoff(
    videoId: string,
    durationSeconds?: number,
  ): { videoId: string; durationSeconds?: number } {
    parseCloudCommand({
      type: "PREPARE_YOUTUBE",
      videoId,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
    });
    return {
      videoId,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
    };
  }
  browserSettings(): CloudBrowserSettings {
    return {
      processing_mode: this.mode,
      processing_provider:
        this.mode === "local" ? "LOCAL_WINDOWS" : "ONLINE_MUSICMUTE",
      automatic_processing_allowed:
        this.restored && this.mode === "local" && this.options.localReady(),
      max_duration_seconds: MVP_MAX_DURATION_SECONDS,
      link_import_visible:
        this.options.usage.view().policy?.linkImportVisible === true,
    };
  }
  assertBrowserAutomatic(durationSeconds: number): void {
    if (
      !this.restored ||
      this.mode !== "local" ||
      !this.options.localReady() ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0 ||
      durationSeconds > MVP_MAX_DURATION_SECONDS
    )
      throw new Error("AUTOMATIC_PROCESSING_UNAVAILABLE");
  }
  confirm(capability: string, rightsConfirmed: boolean): Promise<CloudView> {
    if (this.operation) return Promise.reject(new Error("CLOUD_BUSY"));
    const c = this.confirmation;
    if (
      !c ||
      c.view.capability !== capability ||
      rightsConfirmed !== true ||
      c.used
    )
      return Promise.reject(new Error("CLOUD_CONFIRMATION_INVALID"));
    if (Date.parse(c.view.expiresAt) <= this.now)
      return Promise.reject(new Error("CLOUD_CONFIRMATION_EXPIRED"));
    try {
      this.current(c.scope);
      this.scope();
    } catch (error) {
      return Promise.reject(error);
    }
    c.used = true;
    const abort = new AbortController(),
      api = createCloudApi({
        origin: this.options.origin,
        installationId: this.options.installationId,
        account: this.options.account,
        scope: c.scope,
        beforeIntake: () => {
          try {
            this.current(c.scope);
            if (this.mode !== "cloud") throw new Error("MODE_CHANGED");
            this.options.usage.assertCloudSubmission(
              this.options.account.view(),
            );
          } catch (error) {
            throw new DesktopApiError(failure(error));
          }
        },
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      });
    const provider = new CloudProcessingProvider({
      api,
      scope: {
        firebase_uid: c.scope.firebaseUid,
        session_generation: c.scope.generation,
      },
      signal: abort.signal,
      realtime: this.options.realtime.cloudLease(c.scope),
      onProgress: (p) => this.progress(c, p),
      resolveDownload: async (job, grant, signal) => {
        this.current(c.scope);
        // Ready follows upload confirmation; prepared input bytes are no longer
        // needed. Close their owned workspace before admitting the result at
        // the same request path, and retain it if cleanup cannot be confirmed.
        if (c.media) {
          const prepared = c.media;
          await prepared.close();
          this.current(c.scope);
          if (signal.aborted) throw new DesktopApiError("CANCELLED");
          if (c.media === prepared) delete c.media;
        }
        const result = await this.options.media.download(job, grant, {
          requestId: c.view.requestId,
          scope: c.scope,
          signal,
          assertCurrent: () => this.current(c.scope),
        });
        this.current(c.scope);
        if (this.completed.size >= 32)
          this.completed.delete(this.completed.keys().next().value!);
        this.completed.set(result, {
          scope: { ...c.scope },
          job: structuredClone(job),
          expiresAt: this.now + 15 * 60000,
        });
        this.presentedScope = { ...c.scope };
        this.publish({ resultCapability: result });
      },
    });
    const promise = Promise.resolve().then(async () => {
      this.publish({
        busy: true,
        phase: c.source.kind === "file" ? "preparing" : "importing",
        errorCode: null,
      });
      try {
        let result: CloudResult;
        if (c.source.kind === "youtube") {
          result = await provider.startYouTube({
            url: canonicalYouTubeUrl(c.source.videoId),
            request_id: c.view.requestId,
            ...(c.source.title ? { source_title: c.source.title } : {}),
          });
        } else {
          c.media ??= await this.options.media.prepareFile(
            {
              capability: c.source.capability,
              name: c.source.name,
              bytes: c.source.bytes,
            },
            {
              requestId: c.view.requestId,
              scope: c.scope,
              signal: abort.signal,
              assertCurrent: () => this.current(c.scope),
            },
          );
          this.current(c.scope);
          this.options.usage.assertCloudSubmission(this.options.account.view());
          const policy = this.options.usage.view().policy;
          if (
            !policy ||
            c.media.input.bytes > policy.maxPreparedAudioBytes ||
            c.media.input.duration_seconds >
              Math.min(policy.maxDurationSeconds, 1200)
          )
            throw new Error("CLOUD_INPUT_INVALID");
          const request: CloudFileRequest = {
            request_id: c.view.requestId,
            input: c.media.input,
            source: c.media.source,
            source_title: c.media.title,
          };
          result = await provider.startFile(request, (grant, _job, signal) =>
            c.media!.upload(grant, signal),
          );
        }
        this.current(c.scope);
        this.publish({
          phase: "ready",
          job: this.jobView(result.job),
          confirmation: null,
        });
        this.confirmation = null;
      } catch (error) {
        if (
          this.same(this.options.account.sessionScope(), c.scope) &&
          !this.disposed
        ) {
          const code = failure(error);
          const cancelled =
            this.operation?.confirmation === c &&
            this.operation.cancelRequested;
          this.publish({
            phase:
              code === "CANCELLED"
                ? cancelled && this.operation?.cancelJobKnown
                  ? "cancellation-requested"
                  : "cancelled"
                : "failed",
            errorCode:
              code === "CANCELLED" && cancelled
                ? this.operation?.cancelJobKnown
                  ? null
                  : "CLOUD_IMPORT_CANCELLATION_UNAVAILABLE"
                : code,
          });
        }
      } finally {
        provider.close();
        if (this.operation?.confirmation === c) this.operation = null;
        if (this.same(this.options.account.sessionScope(), c.scope)) {
          this.publish({ busy: false });
        }
        await c.media?.close().catch(() => {});
        delete c.media;
      }
      return this.view();
    });
    this.operation = {
      scope: c.scope,
      abort,
      provider,
      confirmation: c,
      promise,
      cancelRequested: false,
      cancelJobKnown: false,
    };
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  /** Starts an explicitly confirmed submission without blocking UI cancellation/progress IPC. */
  submitConfirmed(capability: string, rightsConfirmed: boolean): CloudView {
    const scope = this.options.account.sessionScope();
    void this.confirm(capability, rightsConfirmed).catch((error) => {
      const current = this.options.account.sessionScope();
      if (
        !this.disposed &&
        current?.firebaseUid === scope?.firebaseUid &&
        current?.generation === scope?.generation
      )
        this.publish({ errorCode: failure(error) });
    });
    return this.view();
  }
  private progress(c: Confirmation, p: CloudProgress): void {
    if (
      !this.same(this.options.account.sessionScope(), c.scope) ||
      this.disposed
    )
      return;
    this.publish({
      phase:
        p.phase === "connecting" || p.phase === "reconnecting"
          ? this.value.phase
          : p.phase,
      ...(p.job_id
        ? {
            job: {
              id: p.job_id,
              status: p.status ?? "processing",
              title: c.view.title,
              durationSeconds: c.view.estimatedDurationSeconds,
              resultAvailable: false,
            },
          }
        : {}),
    });
  }
  private jobView(job: JobMetadata) {
    return {
      id: job.id,
      status: job.status,
      title: job.display_name ?? job.source_title,
      durationSeconds:
        job.output?.duration_seconds ?? job.input.duration_seconds,
      resultAvailable: job.can_download_output,
    };
  }
  /** Trusted Library composition only; ready metadata stays bound to its exact account generation. */
  completedResult(capability: string, scope: AccountSessionScope): JobMetadata {
    this.current(scope);
    const result = this.completed.get(capability);
    if (
      !result ||
      !this.same(scope, result.scope) ||
      result.expiresAt <= this.now
    )
      throw new Error("CLOUD_RESULT_UNAVAILABLE");
    return structuredClone(result.job);
  }
  async cancel(): Promise<CloudView> {
    const operation = this.operation;
    if (!operation) {
      await this.clearConfirmation();
      return this.view();
    }
    try {
      this.current(operation.scope);
      operation.cancelRequested = true;
      operation.cancelJobKnown = operation.provider.currentJobId() !== null;
      await operation.provider.cancel(AbortSignal.timeout(15000));
      this.publish({
        phase: operation.cancelJobKnown
          ? "cancellation-requested"
          : "cancelled",
        errorCode: operation.cancelJobKnown
          ? null
          : "CLOUD_IMPORT_CANCELLATION_UNAVAILABLE",
      });
    } catch (error) {
      this.publish({ errorCode: failure(error) });
    }
    return this.view();
  }
  async clearConfirmation(): Promise<void> {
    if (this.operation) throw new Error("CLOUD_BUSY");
    const c = this.confirmation;
    this.confirmation = null;
    await c?.media?.close();
    this.publish({ confirmation: null, phase: "idle", errorCode: null });
  }
  dispose(): void {
    if (this.disposed) return;
    const operation = this.operation,
      media = this.confirmation?.media;
    this.disposed = true;
    this.operation?.abort.abort();
    this.operation?.provider.close();
    this.closing = Promise.allSettled([
      ...this.pending,
      operation?.promise,
      media?.close(),
      this.modeQueue,
    ]).then(() => {});
    for (const stop of this.stops) stop();
    this.listeners.clear();
  }
  /** Main keeps its private-file/native authority alive until local media cleanup has settled. */
  async shutdown(): Promise<void> {
    this.dispose();
    await this.closing;
  }
}
