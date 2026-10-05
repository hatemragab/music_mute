import { createHash, randomUUID } from "node:crypto";
import { verifyPrivateAudio } from "./audio-integrity.js";
import {
  copyFile,
  readFile,
  rm,
  statfs,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { projectErrorContext } from "../shared/error-context.js";
import {
  FILESYSTEM_ERRNOS,
  type Diagnostics,
  type LocalJobPhase,
} from "./diagnostics.js";
import type { MediaServer } from "./media-server.js";
import {
  assertCacheDirectory,
  cacheFileBytes,
  makeOfflineSpace,
} from "./cache-budget.js";
import { LocalProcessingError, MODEL_SHA256 } from "./local-provider.js";
import { readResidentAccountYouTube } from "./account-cache.js";
import {
  markJobWorkspace,
  recoverJobWorkspaces,
  releaseJobWorkspace,
} from "./job-workspace.js";
import {
  preserveLocalPairRecovery,
  retainLocalPairRecoverySource,
  type LocalLibraryOwner,
  type LocalSyncStage,
} from "./sync-outbox.js";
import {
  MVP_MAX_DURATION_SECONDS,
  isLocalAudioDeclaration,
  sanitizeSourceTitle,
  type LocalAudioDeclaration,
  type DiagnosticInput,
  type JobSnapshot,
  type PreparedAudio,
  type ProcessingProvider,
  type StartPayload,
} from "../shared/protocol.js";

/** Locally retained evidence, written only from the native validated pipeline hook. */
export interface RetainedAudio extends PreparedAudio {
  verified_model_sha256?: string;
  owner_uid?: string;
}
type CancellationReason =
  "CANCELLED" | "ACCOUNT_CHANGED" | "ACCOUNT_STATE_UNSAFE";
export interface LocalPreparedResult {
  owner: LocalLibraryOwner;
  request: StartPayload;
  request_id: string;
  cache_key: string;
  audio: PreparedAudio;
}
export interface LocalReadyResult extends Omit<LocalPreparedResult, "owner"> {
  owner?: LocalLibraryOwner;
  cache_hit: boolean;
}
export interface JobManagerOptions {
  offline_bytes_limit?: number;
  max_duration_seconds?: number;
  pinnedCacheKeys?: () => Promise<ReadonlySet<string>>;
  /** Capture native account state before start; never derive it from browser messages. */
  beforePrepare?: (owner: LocalLibraryOwner) => Promise<void>;
  onPrepared?: (result: LocalPreparedResult) => Promise<void>;
  onReady?: (result: LocalReadyResult) => Promise<void>;
  withCacheMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Authoritative native account fence for resident account-owned playback. */
  isCurrentOwner?: (
    owner: LocalLibraryOwner,
  ) => boolean | void | Promise<boolean | void>;
  /** Restore saved owner audio on an ordinary local miss, without holding the cache lease. */
  resolveCached?:
    | ((input: {
        owner: LocalLibraryOwner;
        request: StartPayload;
        job_id: string;
        signal: AbortSignal;
      }) => Promise<string | undefined>)
    | undefined;
}
export function localCacheKey(
  request: StartPayload,
  sourceDigest?: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        video_id: request.video_id,
        provider: request.provider,
        model: MODEL_SHA256,
        revision: 8,
        trim: false,
        source: sourceDigest ?? "default",
      }),
    )
    .digest("hex");
}

export class JobManager {
  private snapshot: JobSnapshot | null = null;
  private abort: AbortController | null = null;
  private task: Promise<void> | null = null;
  private admitting = false;
  private cancellation: {
    jobId: string;
    reason: CancellationReason;
    promise: Promise<void>;
  } | null = null;
  constructor(
    private readonly cacheRoot: string,
    private readonly provider: ProcessingProvider,
    private readonly diagnostics: Diagnostics,
    private readonly media: MediaServer,
    private readonly publish: (snapshot: JobSnapshot) => void,
    private readonly options: JobManagerOptions = {},
  ) {}
  current(): JobSnapshot | null {
    return this.snapshot;
  }
  /** Publication progress cannot revive a retired player or replace its media grant. */
  setSaveState(
    jobId: string,
    videoId: string,
    state: "pending" | "saving" | "saved",
  ): boolean {
    const snapshot = this.snapshot;
    if (
      !snapshot ||
      snapshot.job_id !== jobId ||
      snapshot.video_id !== videoId ||
      snapshot.provider !== "LOCAL_MACOS" ||
      snapshot.state !== "READY"
    )
      return false;
    if (snapshot.save_state !== state)
      this.update({ ...snapshot, save_state: state });
    return true;
  }
  busy(): boolean {
    return this.admitting || this.task !== null || this.cancellation !== null;
  }
  /** A verified native lookup: no inference, publication or access-recency change. */
  async peekCache(
    request: StartPayload,
    sourceDigest?: string,
  ): Promise<RetainedAudio | null> {
    request = { ...request };
    if (this.busy()) throw new Error("LOCAL_COMPANION_BUSY");
    this.validateRequest(request, sourceDigest);
    this.admitting = true;
    try {
      if (!(await this.cacheDirectory(this.cacheRoot))) return null;
      const operation = () =>
        this.readCache(
          join(this.cacheRoot, "vocals", localCacheKey(request, sourceDigest)),
          request,
          { lookup: 0, validation: 0 },
        );
      const cached = await (this.options.withCacheMutation?.(operation) ??
        operation());
      if (!cached) return null;
      const { verified_model_sha256: verification, ...audio } = cached;
      return verification === MODEL_SHA256
        ? { ...audio, verified_model_sha256: verification }
        : audio;
    } finally {
      this.admitting = false;
    }
  }
  private validateRequest(request: StartPayload, sourceDigest?: string): void {
    if (request.provider !== this.provider.id)
      throw new Error("PROVIDER_NOT_AVAILABLE");
    const maximum =
      this.options.max_duration_seconds ?? MVP_MAX_DURATION_SECONDS;
    if (
      !Number.isSafeInteger(maximum) ||
      maximum <= 0 ||
      maximum > 1800 ||
      (maximum > MVP_MAX_DURATION_SECONDS &&
        this.provider.id !== "ONLINE_MUSICMUTE")
    )
      throw new Error("PROVIDER_LIMIT_INVALID");
    if (sourceDigest !== undefined && !/^[a-f0-9]{64}$/.test(sourceDigest))
      throw new Error("SOURCE_IDENTITY_INVALID");
    if (!(request.duration_seconds > 0 && request.duration_seconds <= maximum))
      throw new Error("UNSUPPORTED_VIDEO");
  }
  async start(
    request: StartPayload,
    owner?: LocalLibraryOwner,
    sourceDigest?: string,
    admissionSignal?: AbortSignal,
  ): Promise<JobSnapshot> {
    return this.beginStart(
      request,
      owner,
      sourceDigest,
      undefined,
      admissionSignal,
    );
  }
  /** Account-key playback only. A miss never starts inference or replaces account bytes. */
  async startCached(
    request: StartPayload,
    owner: LocalLibraryOwner,
    validatedCacheKey: string,
    admissionSignal?: AbortSignal,
  ): Promise<JobSnapshot> {
    if (
      !/^[a-f0-9]{64}$/.test(validatedCacheKey) ||
      !this.options.isCurrentOwner
    )
      throw new Error("CACHE_UNSAFE");
    return this.beginStart(
      request,
      owner,
      undefined,
      validatedCacheKey,
      admissionSignal,
    );
  }
  private async beginStart(
    request: StartPayload,
    owner?: LocalLibraryOwner,
    sourceDigest?: string,
    cachedKey?: string,
    admissionSignal?: AbortSignal,
  ): Promise<JobSnapshot> {
    request = { ...request };
    const acceptedOwner = owner && { ...owner };
    if (this.busy()) throw new Error("LOCAL_COMPANION_BUSY");
    this.validateRequest(request, sourceDigest);
    this.admitting = true;
    try {
      if (admissionSignal?.aborted) throw new Error("CANCELLED");
      if (cachedKey) await this.assertCurrentOwner(acceptedOwner!);
      else {
        await this.cacheDirectory(this.cacheRoot, true);
        if (!this.canResolveCached(request, acceptedOwner, sourceDigest)) {
          const disk = await statfs(this.cacheRoot);
          if (
            Number(disk.bavail) * Number(disk.bsize) < 3 * 1024 ** 3 &&
            !(await this.readCache(
              join(
                this.cacheRoot,
                "vocals",
                localCacheKey(request, sourceDigest),
              ),
              request,
              { lookup: 0, validation: 0 },
            ))
          )
            throw new Error("DISK_SPACE_LOW");
        }
      }
      if (admissionSignal?.aborted) throw new Error("CANCELLED");
      await this.media.revoke();
      if (admissionSignal?.aborted) throw new Error("CANCELLED");
    } catch (error) {
      this.admitting = false;
      throw error;
    }
    this.abort = new AbortController();
    const snapshot: JobSnapshot = {
      job_id: randomUUID(),
      video_id: request.video_id,
      provider: request.provider,
      state: "DOWNLOADING",
      stage: "cache-check",
    };
    this.snapshot = snapshot;
    this.publish(snapshot);
    this.diagnostics.record({
      component: "companion",
      severity: "info",
      event: "job_started",
      job_id: snapshot.job_id,
      metrics: {
        audio_duration_seconds: request.duration_seconds,
        active_jobs: 1,
      },
    });
    this.task = this.run(
      request,
      snapshot,
      this.abort,
      acceptedOwner,
      sourceDigest,
      cachedKey,
    ).finally(() => {
      this.task = null;
      this.abort = null;
      this.admitting = false;
    });
    return snapshot;
  }
  async cancel(
    jobId: string,
    reason: CancellationReason = "CANCELLED",
  ): Promise<void> {
    if (this.snapshot?.job_id !== jobId) throw new Error("STALE_JOB");
    if (this.cancellation) {
      if (this.cancellation.jobId !== jobId) throw new Error("STALE_JOB");
      return await this.cancellation.promise;
    }
    const controller = this.abort;
    const task = this.task;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const cancellation = { jobId, reason, promise };
    // Fence START synchronously, including any reentrant abort observer.
    this.cancellation = cancellation;
    controller?.abort();
    const releaseAdmission = () => {
      if (this.cancellation === cancellation) this.cancellation = null;
    };
    void this.cancelCaptured(jobId, task, reason).then(
      () => {
        releaseAdmission();
        resolve();
      },
      (error: unknown) => {
        releaseAdmission();
        reject(error);
      },
    );
    await promise;
  }
  private async cancelCaptured(
    jobId: string,
    task: Promise<void> | null,
    reason: CancellationReason,
  ): Promise<void> {
    await this.media.revoke();
    try {
      await task;
    } finally {
      // A finalizer that was already in flight must not leave a new grant.
      await this.media.revoke();
    }
    if (this.snapshot?.job_id === jobId && this.snapshot.state === "READY") {
      const { media: _media, ...snapshot } = this.snapshot;
      this.update({ ...snapshot, state: "CANCELLED", stage: "cancelled" });
      this.diagnostics.record({
        component: "companion",
        severity: "info",
        event: "job_cancelled",
        job_id: jobId,
        code: reason,
        metrics: { active_jobs: 0 },
      });
    }
  }
  async close(): Promise<void> {
    this.abort?.abort();
    await this.task;
    await this.cancellation?.promise;
    await this.media.revoke();
  }
  async clearCache(): Promise<void> {
    if (this.busy()) throw new Error("LOCAL_COMPANION_BUSY");
    this.admitting = true;
    try {
      await this.media.revoke();
      const operation = async () => {
        await this.pruneCache(undefined, true);
        this.snapshot = null;
      };
      await (this.options.withCacheMutation?.(operation) ?? operation());
    } finally {
      this.admitting = false;
    }
  }
  private update(snapshot: JobSnapshot): void {
    this.snapshot = snapshot;
    this.publish(snapshot);
  }
  private async cacheDirectory(path: string, create = false): Promise<boolean> {
    return assertCacheDirectory(this.cacheRoot, path, create);
  }
  private async cacheFile(path: string): Promise<number | null> {
    return cacheFileBytes(this.cacheRoot, path);
  }
  private async assertReplacementUnpinned(key: string): Promise<void> {
    if ((await this.options.pinnedCacheKeys?.())?.has(key))
      throw new Error("CACHE_UNSAFE");
  }
  private async assertCurrentOwner(
    owner: LocalLibraryOwner,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new Error("CANCELLED");
    const current = this.options.isCurrentOwner;
    if (!current) throw new Error("CACHE_UNSAFE");
    if ((await current({ ...owner })) === false)
      throw new Error("ACCOUNT_CHANGED");
    if (signal?.aborted) throw new Error("CANCELLED");
  }
  private canResolveCached(
    request: StartPayload,
    owner?: LocalLibraryOwner,
    sourceDigest?: string,
  ): boolean {
    return (
      !!this.options.resolveCached &&
      !!owner &&
      request.provider === "LOCAL_MACOS" &&
      sourceDigest === undefined
    );
  }
  private async run(
    request: StartPayload,
    snapshot: JobSnapshot,
    controller: AbortController,
    owner?: LocalLibraryOwner,
    sourceDigest?: string,
    cachedKey?: string,
  ): Promise<void> {
    const started = performance.now();
    let phase: LocalJobPhase = "cache_lock";
    try {
      if (!cachedKey && this.canResolveCached(request, owner, sourceDigest)) {
        await this.assertCurrentOwner(owner!, controller.signal);
        const lookup = async () => {
          phase = "cache_lookup";
          const audio = await this.readCache(
            join(
              this.cacheRoot,
              "vocals",
              localCacheKey(request, sourceDigest),
            ),
            request,
            { lookup: 0, validation: 0 },
          );
          phase = "cache_lock";
          return audio;
        };
        const local = await (this.options.withCacheMutation?.(lookup) ??
          lookup());
        await this.assertCurrentOwner(owner!, controller.signal);
        if (!local) {
          phase = "account_restore";
          this.update({ ...snapshot, stage: "account-restore" });
          const resolved = await this.options.resolveCached!({
            owner: { ...owner! },
            request: { ...request },
            job_id: snapshot.job_id,
            signal: controller.signal,
          });
          await this.assertCurrentOwner(owner!, controller.signal);
          if (resolved !== undefined) {
            if (!/^[a-f0-9]{64}$/.test(resolved))
              throw new Error("CACHE_UNSAFE");
            cachedKey = resolved;
          }
        }
      }
      phase = "cache_lock";
      const operation = () =>
        this.runWithCacheOwnership(
          request,
          snapshot,
          controller,
          owner,
          sourceDigest,
          cachedKey,
          started,
        );
      await (this.options.withCacheMutation?.(operation) ?? operation());
    } catch (error) {
      this.failJob(error, snapshot, controller, started, phase);
    }
  }
  private async runWithCacheOwnership(
    request: StartPayload,
    snapshot: JobSnapshot,
    controller: AbortController,
    owner?: LocalLibraryOwner,
    sourceDigest?: string,
    cachedKey?: string,
    started = performance.now(),
  ): Promise<void> {
    let phase: LocalJobPhase = "workspace";
    const key = cachedKey ?? localCacheKey(request, sourceDigest);
    const resultRoot = join(this.cacheRoot, "vocals", key);
    const workRoot = join(this.cacheRoot, "jobs", snapshot.job_id);
    let workCreated = false;
    let workMarked = false;
    let recovery: LocalSyncStage | undefined;
    try {
      if (!cachedKey) {
        await this.cacheDirectory(this.cacheRoot);
        await recoverJobWorkspaces(this.cacheRoot);
        await this.cacheDirectory(join(this.cacheRoot, "jobs"), true);
        await this.cacheDirectory(workRoot, true);
        workCreated = true;
      }
      const cacheTimings = { lookup: 0, validation: 0 };
      const lookupStarted = performance.now();
      phase = "cache_lookup";
      const cached: RetainedAudio | null = cachedKey
        ? await readResidentAccountYouTube(
            this.cacheRoot,
            owner!,
            request,
            key,
            {
              signal: controller.signal,
              isCurrent: (account) =>
                this.assertCurrentOwner(account, controller.signal),
            },
          )
        : await this.readCache(resultRoot, request, cacheTimings);
      if (cachedKey) {
        cacheTimings.validation = performance.now() - lookupStarted;
        if (!cached) throw new Error("CACHE_MISS");
      }
      if (!cached) {
        // Invalid metadata must not authorize replacing bytes still referenced
        // by an account save or a player. Pins protect replacement as well as eviction.
        phase = "cache_pin";
        await this.assertReplacementUnpinned(key);
        phase = "workspace";
        const disk = await statfs(this.cacheRoot);
        if (Number(disk.bavail) * Number(disk.bsize) < 3 * 1024 ** 3)
          throw new Error("DISK_SPACE_LOW");
        await markJobWorkspace(this.cacheRoot, snapshot.job_id);
        workMarked = true;
      }
      if (!cached && owner) {
        phase = "outbox_admission";
        await this.options.beforePrepare?.(owner);
      }
      let verifiedModelSha256 =
        cached?.verified_model_sha256 === MODEL_SHA256
          ? MODEL_SHA256
          : undefined;
      phase = "provider";
      const result =
        cached ??
        (await this.provider.prepare(request, workRoot, {
          signal: controller.signal,
          onProgress: (stage, completed, total) => {
            if (controller.signal.aborted) return;
            const state = /validat|encod|output/.test(stage)
              ? "VALIDATING"
              : /download|acquisit|metadata/.test(stage)
                ? "DOWNLOADING"
                : "PROCESSING";
            this.update({
              ...snapshot,
              state,
              stage,
              ...(completed === undefined ? {} : { completed }),
              ...(total === undefined ? {} : { total }),
            });
            this.diagnostics.record({
              component: "companion",
              severity: "info",
              event: "job_progress",
              job_id: snapshot.job_id,
              metrics: {
                stage,
                elapsed_ms: performance.now() - started,
                ...(completed === undefined
                  ? {}
                  : { progress_completed: completed }),
                ...(total === undefined ? {} : { progress_total: total }),
              },
            });
          },
          onDiagnostic: (event, verifiedModel) => {
            const diagnostic = { ...event, job_id: snapshot.job_id };
            if (
              event.event === "local_pipeline_completed" &&
              event.component === "companion" &&
              event.severity === "info" &&
              verifiedModel === MODEL_SHA256
            ) {
              verifiedModelSha256 = verifiedModel;
              this.diagnostics.recordVerified(diagnostic, verifiedModel);
            } else this.diagnostics.record(diagnostic);
          },
        }));
      phase = "validation";
      if (controller.signal.aborted) throw new Error("CANCELLED");
      if (
        result.trim_enabled !== false ||
        Math.abs(result.source_duration_seconds - result.duration_seconds) >
          0.25 ||
        Math.abs(request.duration_seconds - result.source_duration_seconds) > 2
      )
        throw new Error("TIMELINE_MISMATCH");
      // Never accept a reserved provenance field from a generic provider result.
      const {
        verified_model_sha256: _untrustedVerification,
        owner_uid: _untrustedOwner,
        original_declaration: providerDeclaration,
        publication_pending: _publicationPending,
        source_title: untrustedTitle,
        original,
        ...prepared
      } = result as RetainedAudio;
      const sourceTitle = sanitizeSourceTitle(untrustedTitle);
      let originalDeclaration: LocalAudioDeclaration | undefined =
        cached?.original_declaration;
      if (
        !cached &&
        !original &&
        result.shared_youtube_profile === "kim-vocal-2-full-timeline-v1" &&
        providerDeclaration !== undefined
      ) {
        if (
          result.source?.kind !== "youtube" ||
          result.source.video_id !== request.video_id ||
          !isLocalAudioDeclaration(
            providerDeclaration,
            result.source_duration_seconds,
          )
        )
          throw new Error("ORIGINAL_DECLARATION_INVALID");
        originalDeclaration = { ...providerDeclaration };
      }
      if (!cached && original) {
        const declaration = {
          extension: original.extension,
          content_type: original.content_type,
          bytes: original.bytes,
          duration_seconds: original.duration_seconds,
          sha256: original.sha256,
        };
        if (
          !isLocalAudioDeclaration(declaration, result.source_duration_seconds)
        )
          throw new Error("ORIGINAL_DECLARATION_INVALID");
        originalDeclaration = declaration;
      }
      let retained: RetainedAudio = {
        ...prepared,
        ...(sourceTitle ? { source_title: sourceTitle } : {}),
        ...(originalDeclaration
          ? { original_declaration: originalDeclaration }
          : {}),
        ...(cached?.owner_uid
          ? { owner_uid: cached.owner_uid }
          : !cached && owner
            ? { owner_uid: owner.uid }
            : {}),
        ...(verifiedModelSha256 !== undefined &&
        verifiedModelSha256 === result.model_id
          ? { verified_model_sha256: verifiedModelSha256 }
          : {}),
      };
      phase = "publication";
      if (!cached) {
        await this.cacheDirectory(join(this.cacheRoot, "vocals"), true);
        await this.cacheDirectory(resultRoot, true);
        const output = join(resultRoot, "vocals.mp3");
        retained = { ...retained, output_path: output };
        // Admission must count the exact published path and UTF-8 metadata bytes.
        const manifest = JSON.stringify(retained);
        phase = "cache_budget";
        await this.pruneCache(
          resultRoot,
          false,
          result.bytes + Buffer.byteLength(manifest),
        );
        phase = "publication";
        if (controller.signal.aborted) throw new Error("CANCELLED");
        for (const path of [output, join(resultRoot, "result.json")]) {
          await this.cacheFile(path);
        }
        if (controller.signal.aborted) throw new Error("CANCELLED");
        // Another native process can publish a pin while preparation is running.
        phase = "cache_pin";
        await this.assertReplacementUnpinned(key);
        phase = "publication";
        await copyFile(result.output_path, output);
        if (controller.signal.aborted) throw new Error("CANCELLED");
        await writeFile(join(resultRoot, "result.json"), manifest, {
          mode: 0o600,
        });
        if (controller.signal.aborted) throw new Error("CANCELLED");
      }
      // Updating access time never rewrites inference/provenance metadata.
      const accessed = new Date();
      await utimes(resultRoot, accessed, accessed);
      if (!cached && owner && original && this.options.onPrepared) {
        recovery = {
          owner,
          request_id: snapshot.job_id,
          cache_key: key,
          original,
          vocals: {
            path: retained.output_path,
            extension: "mp3",
            content_type: "audio/mpeg",
            duration_seconds: retained.duration_seconds,
            bytes: retained.bytes,
            sha256: retained.sha256,
          },
          ...(retained.source ? { source: retained.source } : {}),
          ...(retained.source_title ? { title: retained.source_title } : {}),
        };
        try {
          if (result.shared_youtube_profile !== "kim-vocal-2-full-timeline-v1")
            await preserveLocalPairRecovery(this.cacheRoot, recovery);
          await this.options.onPrepared({
            owner,
            request,
            request_id: snapshot.job_id,
            cache_key: key,
            audio: { ...retained, original },
          });
          recovery = undefined;
        } catch {
          // Local playback and saved vocals survive account-sync staging failures.
          this.diagnostics.record({
            component: "companion",
            severity: "warning",
            event: "diagnostic_error",
            job_id: snapshot.job_id,
            code: "LOCAL_SYNC_STAGING_FAILED",
          });
        }
      }
      phase = "cache_budget";
      await this.pruneCache(resultRoot);
      phase = "publication";
      if (controller.signal.aborted) throw new Error("CANCELLED");
      try {
        await this.options.onReady?.({
          ...(owner ? { owner } : {}),
          request,
          request_id: snapshot.job_id,
          cache_key: key,
          audio: retained,
          cache_hit: cached !== null,
        });
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : error instanceof Error
              ? error.message
              : "";
        if (["ACCOUNT_CHANGED", "CANCELLED"].includes(code)) throw error;
        this.diagnostics.record({
          component: "companion",
          severity: "warning",
          event: "diagnostic_error",
          job_id: snapshot.job_id,
          code: "CATALOG_SAVE_FAILED",
        });
      }
      if (controller.signal.aborted) throw new Error("CANCELLED");
      if (cachedKey) await this.assertCurrentOwner(owner!, controller.signal);
      phase = "playback";
      const grantStarted = performance.now();
      const url = await this.media.issue(snapshot.job_id, retained.output_path);
      if (controller.signal.aborted) throw new Error("CANCELLED");
      if (owner && this.options.isCurrentOwner)
        await this.assertCurrentOwner(owner, controller.signal);
      const grantMilliseconds = performance.now() - grantStarted;
      this.update({
        ...snapshot,
        state: "READY",
        stage: "ready",
        cache_hit: cached !== null,
        ...(!cached &&
        result.shared_youtube_profile === "kim-vocal-2-full-timeline-v1" &&
        result.publication_pending === true
          ? { save_state: "pending" as const }
          : {}),
        media: {
          url,
          duration_seconds: retained.duration_seconds,
          trim_enabled: false,
          model_id: retained.model_id,
        },
      });
      const readyDiagnostic: DiagnosticInput = {
        component: "companion",
        severity: "info",
        event: "job_ready",
        job_id: snapshot.job_id,
        metrics: {
          elapsed_ms: performance.now() - started,
          cache_origin: cached
            ? "local"
            : retained.source?.format_id === "shared-cache"
              ? "shared"
              : retained.source?.format_id === "pending-local"
                ? "pending"
                : request.provider === "ONLINE_MUSICMUTE"
                  ? "cloud"
                  : "processed",
          cache_hit: cached !== null,
          output_duration_seconds: retained.duration_seconds,
          output_bytes: retained.bytes,
        },
      };
      if (
        verifiedModelSha256 !== undefined &&
        verifiedModelSha256 === retained.model_id
      )
        this.diagnostics.recordVerified(readyDiagnostic, verifiedModelSha256);
      else this.diagnostics.record(readyDiagnostic);
      if (cached) {
        const cacheDiagnostic: DiagnosticInput = {
          component: "companion",
          severity: "info",
          event: "cache_hit",
          job_id: snapshot.job_id,
          metrics: {
            cache_hit: true,
            duration_ms: cacheTimings.lookup + cacheTimings.validation,
          },
        };
        if (
          verifiedModelSha256 !== undefined &&
          verifiedModelSha256 === retained.model_id
        )
          this.diagnostics.recordVerified(cacheDiagnostic, verifiedModelSha256);
        else this.diagnostics.record(cacheDiagnostic);
      }
      // Retained inference timings describe the original preparation. A replay
      // reports only work measured for this job, without rewriting cache metadata.
      const currentTimings = cached
        ? {
            "cache-lookup": cacheTimings.lookup,
            "cache-validation": cacheTimings.validation,
            "media-grant": grantMilliseconds,
          }
        : retained.timings_ms;
      for (const [stage, duration] of Object.entries(currentTimings))
        this.diagnostics.record({
          component: cached ? "companion" : "engine",
          severity: "info",
          event: "stage_completed",
          job_id: snapshot.job_id,
          metrics: {
            stage,
            duration_ms: duration,
            ...(cached ? { cache_hit: true } : {}),
          },
        });
    } catch (error) {
      this.failJob(error, snapshot, controller, started, phase);
    } finally {
      if (
        workCreated &&
        (await this.cacheDirectory(join(this.cacheRoot, "jobs")))
      ) {
        if (await this.cacheDirectory(workRoot))
          if (recovery) {
            try {
              await retainLocalPairRecoverySource(this.cacheRoot, recovery);
            } catch {
              // A filesystem failure must never delete the sole retained source.
              this.diagnostics.record({
                component: "companion",
                severity: "warning",
                event: "diagnostic_error",
                job_id: snapshot.job_id,
                code: "LOCAL_SYNC_RECOVERY_FAILED",
              });
            }
          } else {
            await rm(workRoot, { recursive: true, force: true });
            if (workMarked) {
              try {
                await releaseJobWorkspace(this.cacheRoot, snapshot.job_id);
              } catch {
                this.diagnostics.record({
                  component: "companion",
                  severity: "warning",
                  event: "diagnostic_error",
                  job_id: snapshot.job_id,
                  code: "CACHE_UNSAFE",
                });
              }
            }
          }
      }
    }
  }
  private failJob(
    error: unknown,
    snapshot: JobSnapshot,
    controller: AbortController,
    started: number,
    phase: LocalJobPhase,
  ): void {
    void this.media.revoke();
    const candidate =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : "PROCESSING_FAILED";
    const cancelled = controller.signal.aborted || candidate === "CANCELLED";
    const code = cancelled
      ? this.cancellation?.jobId === snapshot.job_id
        ? this.cancellation.reason
        : "CANCELLED"
      : /^[A-Z][A-Z_0-9]{2,64}$/.test(candidate)
        ? candidate
        : "PROCESSING_FAILED";
    const acquisition =
      !cancelled && error instanceof LocalProcessingError
        ? error.acquisition_failure
        : undefined;
    // Observe only exact Node errno codes at native preparation boundaries.
    // Provider exceptions retain their acquisition/source semantics.
    const errno =
      !cancelled &&
      phase !== "provider" &&
      !(error instanceof LocalProcessingError) &&
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      FILESYSTEM_ERRNOS.some((value) => value === error.code)
        ? error.code
        : undefined;
    const errorContext = !cancelled
      ? projectErrorContext({
          stage: acquisition?.stage ?? phase,
          retry_at: acquisition?.retry_at,
          block_reason: acquisition?.block_reason,
          http_status: acquisition?.http_status,
        })
      : undefined;
    this.update({
      ...snapshot,
      state: cancelled ? "CANCELLED" : "FAILED",
      stage: cancelled ? "cancelled" : "failed",
      error_code: code,
      ...(errorContext ? { error_context: errorContext } : {}),
    });
    this.diagnostics.record({
      component: "companion",
      severity: cancelled ? "info" : "error",
      event: cancelled ? "job_cancelled" : "job_failed",
      job_id: snapshot.job_id,
      code,
      metrics: {
        elapsed_ms: performance.now() - started,
        active_jobs: 0,
        ...(!cancelled ? { local_job_phase: phase } : {}),
        ...(errno ? { filesystem_errno: errno } : {}),
        ...(acquisition
          ? {
              error_origin: "download",
              ...(acquisition.stage
                ? { acquisition_stage: acquisition.stage }
                : {}),
              ...(acquisition.exit_code === undefined
                ? {}
                : { exit_code: acquisition.exit_code }),
              ...(acquisition.http_status === undefined
                ? {}
                : { http_status: acquisition.http_status }),
              ...(acquisition.refusal_code
                ? { refusal_code: acquisition.refusal_code }
                : {}),
              ...(acquisition.block_reason
                ? { acquisition_block_reason: acquisition.block_reason }
                : {}),
              ...(acquisition.stderr_kind
                ? { acquisition_stderr_kind: acquisition.stderr_kind }
                : {}),
              ...(acquisition.stderr_bytes === undefined
                ? {}
                : { acquisition_stderr_bytes: acquisition.stderr_bytes }),
            }
          : {}),
      },
    });
  }
  private async readCache(
    root: string,
    request: StartPayload,
    timings: { lookup: number; validation: number },
  ): Promise<RetainedAudio | null> {
    const started = performance.now();
    let validationStarted: number | undefined;
    try {
      if (
        !(await this.cacheDirectory(join(this.cacheRoot, "vocals"))) ||
        !(await this.cacheDirectory(root))
      )
        return null;
      try {
        const path = join(root, "vocals.mp3");
        const size = await this.cacheFile(path);
        const metadataSize = await this.cacheFile(join(root, "result.json"));
        if (
          size === null ||
          size >
            ((this.options.max_duration_seconds ?? MVP_MAX_DURATION_SECONDS) >
            MVP_MAX_DURATION_SECONDS
              ? 60
              : 30) *
              1024 ** 2 ||
          metadataSize === null ||
          metadataSize > 16 * 1024
        )
          return null;
        const result = JSON.parse(
          await readFile(join(root, "result.json"), "utf8"),
        ) as RetainedAudio;
        validationStarted = performance.now();
        if (
          result.output_path !== path ||
          result.model_id !== MODEL_SHA256 ||
          result.trim_enabled !== false ||
          result.bytes !== size ||
          (result.owner_uid !== undefined &&
            (typeof result.owner_uid !== "string" ||
              result.owner_uid.length === 0 ||
              result.owner_uid.length > 128 ||
              /\p{Cc}/u.test(result.owner_uid))) ||
          !/^[a-f0-9]{64}$/.test(result.sha256) ||
          !Number.isFinite(result.source_duration_seconds) ||
          !Number.isFinite(result.duration_seconds) ||
          Math.abs(result.source_duration_seconds - request.duration_seconds) >
            2 ||
          (result.original_declaration !== undefined &&
            !isLocalAudioDeclaration(
              result.original_declaration,
              result.source_duration_seconds,
            )) ||
          Math.abs(result.duration_seconds - result.source_duration_seconds) >
            0.25
        )
          return null;
        if (!(await verifyPrivateAudio(path, result.bytes, result.sha256)))
          return null;
        const { source_title: rawTitle, ...audio } = result;
        const sourceTitle = sanitizeSourceTitle(rawTitle);
        return {
          ...audio,
          ...(sourceTitle ? { source_title: sourceTitle } : {}),
        };
      } catch (error) {
        if (error instanceof Error && error.message === "CACHE_UNSAFE")
          throw error;
        return null;
      }
    } finally {
      const completed = performance.now();
      timings.lookup = Math.max(0, (validationStarted ?? completed) - started);
      timings.validation =
        validationStarted === undefined
          ? 0
          : Math.max(0, completed - validationStarted);
    }
  }
  private async pruneCache(
    keepRoot?: string,
    clear = false,
    incomingBytes = 0,
  ): Promise<void> {
    await makeOfflineSpace(
      this.cacheRoot,
      incomingBytes,
      keepRoot,
      (await this.options.pinnedCacheKeys?.()) ?? new Set(),
      {
        ...(this.options.offline_bytes_limit === undefined
          ? {}
          : { limit_bytes: this.options.offline_bytes_limit }),
        clear,
        onEvicted: (bytes) =>
          this.diagnostics.record({
            component: "companion",
            severity: "info",
            event: "cache_evicted",
            metrics: { cache_bytes: bytes },
          }),
      },
    );
  }
}
