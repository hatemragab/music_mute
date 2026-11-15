import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { DesktopApiError } from "../../../../chrome-extension/src/companion/account-api.js";
import { canonicalYouTubeUrl } from "../../../../chrome-extension/src/shared/protocol.js";
import type { AccountView } from "../../shared/account-contracts.js";
import {
  parseOutboxCommand,
  type OutboxView,
} from "../../shared/outbox-contracts.js";
import type { AccountSessionScope } from "../account/account-controller.js";
import type { CompletionReceipt } from "../../shared/reuse-contracts.js";
import { parseCompletionReceipt } from "../reuse/receipts.js";
import type { LocalLibraryEntry } from "../library/model.js";
import {
  createOutboxApi,
  outboxAccountScope,
  type OutboxAccountPort,
} from "./api.js";
import {
  artifactDeclaration,
  OUTBOX_PROFILE,
  parseOutboxRecord,
  outboxRoot,
  type OutboxRecord,
} from "./model.js";
import type { OutboxStore } from "./store.js";
import type { OutboxMediaPort, OutboxMediaContext } from "./media.js";
import type { OutboxCommunityPort } from "./community.js";
import {
  outboxGrant,
  parseOutboxSyncView,
  type OutboxSyncView,
} from "./sync-view.js";
export interface OutboxOptions {
  origin: string;
  installationId: string;
  account: OutboxAccountPort & {
    view(): AccountView;
    subscribe(listener: (view: AccountView) => void): () => void;
  };
  store: OutboxStore;
  media: OutboxMediaPort;
  community: OutboxCommunityPort;
  catalog: {
    attach(
      scope: AccountSessionScope,
      localId: string,
      jobId: string,
      outputSha256: string,
    ): Promise<void>;
  };
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  onAuthenticationRequired?(code: string): void;
  consumersAllowed?(): boolean;
}
const permanent = new Set([
  "LOCAL_SYNC_EXPIRED",
  "OUTBOX_ARTIFACT_INVALID",
  "OUTBOX_PROFILE_UNSUPPORTED",
  "IDEMPOTENCY_CONFLICT",
  "SOURCE_IDENTITY_MISMATCH",
  "TIMELINE_INCOMPATIBLE",
  "LOCAL_SYNC_REPLY_INVALID",
  "UPLOAD_ATTEMPT_LIMIT_REACHED",
  "ACCOUNT_DELETION_PENDING",
  "ACCOUNT_DELETED",
  "INVALID_INPUT",
  "MEDIA_TOO_LARGE",
  "MEDIA_TOO_LONG",
  "RETAINED_STORAGE_LIMIT_REACHED",
  "UPLOAD_BYTE_LIMIT_REACHED",
  "EMAIL_NOT_VERIFIED",
  "UPLOAD_GRANT_INVALID",
]);
export class OutboxController {
  private readonly captures = new Map<
    string,
    { abort: AbortController; promise: Promise<OutboxRecord> | undefined }
  >();
  private readonly stageJobs = new Map<string, Promise<OutboxRecord>>();
  private again = false;
  private scope: AccountSessionScope | null = null;
  private epoch = 0;
  private lifetime = new AbortController();
  private active: AbortController | null = null;
  private activeId: string | null = null;
  private drain: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly listeners = new Set<(view: OutboxView) => void>();
  private records: OutboxRecord[] = [];
  private readonly restoring = new Set<Promise<void>>();
  private value: OutboxView = {
    authenticated: false,
    busy: false,
    errorCode: null,
    items: [],
  };
  private readonly off: () => void;
  private readonly now: () => number;
  constructor(private readonly options: OutboxOptions) {
    this.now = options.now ?? Date.now;
    this.off = options.account.subscribe(() => {
      void this.setScope(options.account.sessionScope()).catch(() => {});
    });
  }
  view(): OutboxView {
    return structuredClone(this.value);
  }
  subscribe(listener: (view: OutboxView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(patch: Partial<OutboxView> = {}): void {
    this.value = {
      ...this.value,
      ...patch,
      busy:
        this.captures.size > 0 ||
        this.drain !== null ||
        this.restoring.size > 0 ||
        patch.busy === true,
      items: this.records.map((r) => ({
        requestId: r.requestId,
        localId: `local:${r.cacheKey}`,
        kind: r.kind,
        state: r.state === "committed" ? "saved" : r.state,
        title: r.title || "Voice track",
        errorCode: r.errorCode,
        jobId: r.jobId,
        nextAttemptAt: r.nextAttemptAt,
      })),
    };
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {}
    }
  }
  private current(
    scope: AccountSessionScope,
    epoch: number,
    signal?: AbortSignal,
  ): void {
    if (this.disposed || epoch !== this.epoch)
      throw new Error("ACCOUNT_CHANGED");
    signal?.throwIfAborted();
    this.options.account.assertScope(scope);
    if (
      scope.firebaseUid !== this.scope?.firebaseUid ||
      scope.generation !== this.scope?.generation
    )
      throw new Error("ACCOUNT_CHANGED");
  }
  private code(error: unknown): string {
    const code =
      error instanceof DesktopApiError
        ? error.code
        : error instanceof Error
          ? error.message
          : "OUTBOX_SAVE_FAILED";
    return /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : "OUTBOX_SAVE_FAILED";
  }
  async setScope(scope: AccountSessionScope | null): Promise<void> {
    if (this.disposed) return;
    if (
      scope?.firebaseUid === this.scope?.firebaseUid &&
      scope?.generation === this.scope?.generation &&
      this.epoch > 0
    ) {
      this.kick();
      return;
    }
    this.epoch++;
    this.lifetime.abort();
    this.active?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.lifetime = new AbortController();
    this.scope = scope ? { ...scope } : null;
    this.records = [];
    this.publish({ authenticated: !!scope, busy: false, errorCode: null });
    if (!scope) return;
    await this.restore();
    this.kick();
  }
  restore(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const scope = this.scope,
      epoch = this.epoch;
    const task = Promise.resolve()
      .then(() => this.restoreOne(scope, epoch))
      .finally(() => {
        this.restoring.delete(task);
        this.publish();
      });
    this.restoring.add(task);
    this.publish();
    return task;
  }
  private async restoreOne(
    scope: AccountSessionScope | null,
    epoch: number,
  ): Promise<void> {
    if (!scope) {
      if (this.disposed || epoch !== this.epoch) return;
      this.records = [];
      this.publish();
      return;
    }
    try {
      const records = await this.options.store.list(scope.firebaseUid);
      this.current(scope, epoch);
      this.records = records;
      this.publish({ errorCode: null });
    } catch (error) {
      if (epoch === this.epoch && !this.disposed)
        this.publish({ errorCode: this.code(error) });
      throw error;
    }
  }
  async stage(
    entry: LocalLibraryEntry,
    capturedScope: AccountSessionScope,
    kind: OutboxRecord["kind"] = "pair",
    originalCapture?: AccountSessionScope,
  ): Promise<OutboxRecord> {
    const key = JSON.stringify([
      capturedScope.firebaseUid,
      capturedScope.generation,
      entry.catalog.cache_key,
      kind,
    ]);
    this.current(capturedScope, this.epoch, this.lifetime.signal);
    const existing = this.stageJobs.get(key);
    if (existing) return existing;
    if (!this.intakeAllowed()) throw new Error("CONSUMERS_PAUSED");
    const requestId = randomUUID(),
      operation = {
        abort: new AbortController(),
        promise: undefined as Promise<OutboxRecord> | undefined,
      };
    this.captures.set(requestId, operation);
    this.publish();
    const promise = this.stageOne(
      structuredClone(entry),
      { ...capturedScope },
      kind,
      requestId,
      operation,
      originalCapture,
    ).finally(() => {
      if (this.stageJobs.get(key) === promise) this.stageJobs.delete(key);
      for (const [id, active] of this.captures)
        if (active === operation) this.captures.delete(id);
      this.kick();
      this.publish();
    });
    operation.promise = promise;
    this.stageJobs.set(key, promise);
    return promise;
  }
  /** Trusted recovery explicitly authorizes the current session of the originally captured UID. */
  async stageCaptured(
    entry: LocalLibraryEntry,
    completion: CompletionReceipt,
    authorizedScope: AccountSessionScope,
  ): Promise<OutboxRecord> {
    const receipt = parseCompletionReceipt(completion, {
      installationId: this.options.installationId,
      jobId: entry.personalJobId,
      originalSha256: entry.original.sha256,
      vocalsSha256: entry.vocals.sha256,
    });
    if (
      !receipt.capturedAccountScope ||
      receipt.capturedAccountScope.firebaseUid !== authorizedScope.firebaseUid
    )
      throw new Error("OUTBOX_OWNER_INVALID");
    return this.stage(
      entry,
      authorizedScope,
      "pair",
      receipt.capturedAccountScope,
    );
  }
  private async stageOne(
    entry: LocalLibraryEntry,
    capturedScope: AccountSessionScope,
    kind: OutboxRecord["kind"],
    requestId: string,
    operation: {
      abort: AbortController;
      promise: Promise<OutboxRecord> | undefined;
    },
    originalCapture?: AccountSessionScope,
  ): Promise<OutboxRecord> {
    const epoch = this.epoch,
      signal = AbortSignal.any([this.lifetime.signal, operation.abort.signal]);
    this.current(capturedScope, epoch, signal);
    const context = {
        signal,
        assertCurrent: () => this.current(capturedScope, epoch, signal),
      },
      description = await this.options.media.describe(
        entry,
        capturedScope,
        this.options.installationId,
        requestId,
        kind,
        this.now(),
        context,
      );
    this.current(capturedScope, epoch, signal);
    if (originalCapture) {
      if (originalCapture.firebaseUid !== capturedScope.firebaseUid)
        throw new Error("OUTBOX_OWNER_INVALID");
      description.ownerGeneration = originalCapture.generation;
    }
    let record = await this.options.store.create(
      parseOutboxRecord(description, this.options.installationId),
    );
    this.captures.set(record.requestId, operation);
    this.current(capturedScope, epoch, signal);
    if (record.state === "capturing") {
      try {
        await this.options.media.retain(record, context);
        this.current(capturedScope, epoch, signal);
        record = await this.options.store.update(record, {
          state: "pending",
          captured: true,
          updatedAt: this.now(),
          errorCode: null,
        });
      } catch (error) {
        await this.options.store
          .update(record, {
            state: "retry",
            errorCode: this.code(error),
            updatedAt: this.now(),
            nextAttemptAt: this.now() + 5000,
          })
          .catch(() => {});
        throw error;
      }
    }
    await this.restore();
    this.kick();
    return record;
  }
  /** Reconnect/receipt events wake commands; no periodic HTTP reads or status polling. */
  onConnected(): void {
    this.kick();
  }
  private intakeAllowed(): boolean {
    return this.options.consumersAllowed?.() ?? true;
  }
  /** Explicit lifecycle settlement wakes durable work without status polling. */
  resume(): Promise<void> {
    if (this.disposed || !this.intakeAllowed()) return Promise.resolve();
    return this.savePending();
  }
  private eligible(): boolean {
    return (
      !!this.scope &&
      this.options.account.view().online &&
      this.options.account.view().access.allowed
    );
  }
  private kick(): void {
    if (this.disposed || !this.eligible()) return;
    if (!this.intakeAllowed()) {
      this.again = true;
      return;
    }
    if (this.drain) {
      this.again = true;
      return;
    }
    void this.savePending().catch(() => {});
  }
  async savePending(): Promise<void> {
    if (this.drain) return this.drain;
    const scope = this.scope,
      epoch = this.epoch;
    if (!scope || !this.eligible()) return;
    if (!this.intakeAllowed()) {
      this.again = true;
      return;
    }
    const run = this.process(scope, epoch);
    this.drain = run;
    try {
      await run;
    } finally {
      if (this.drain === run) this.drain = null;
      this.publish();
      if (epoch === this.epoch && !this.disposed) this.schedule();
      else if (!this.disposed) this.kick();
      if (this.again && !this.disposed && this.intakeAllowed()) {
        this.again = false;
        this.kick();
      }
    }
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.eligible()) return;
    if (!this.intakeAllowed()) {
      this.again = true;
      return;
    }
    const next = this.records
      .filter(
        (r) =>
          ["retry", "committed"].includes(r.state) && r.nextAttemptAt !== null,
      )
      .map((r) => r.nextAttemptAt!);
    if (!next.length) return;
    const delay = Math.max(
      50,
      Math.min(86400000, Math.min(...next) - this.now()),
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.kick();
    }, delay);
    this.timer.unref?.();
  }
  private async process(
    scope: AccountSessionScope,
    epoch: number,
  ): Promise<void> {
    this.publish({ busy: true });
    try {
      const records = await this.options.store.list(scope.firebaseUid);
      this.current(scope, epoch);
      for (const record of records) {
        this.current(scope, epoch);
        if (!this.intakeAllowed()) {
          this.again = true;
          break;
        }
        if (this.captures.has(record.requestId)) continue;
        if (
          record.state === "discarded" ||
          record.state === "blocked" ||
          (record.nextAttemptAt !== null && record.nextAttemptAt > this.now())
        )
          continue;
        if (
          record.state === "committed" &&
          record.linked &&
          record.copiesReleased
        )
          continue;
        await this.saveOne(record, scope, epoch);
      }
      await this.restore();
    } finally {
      if (epoch === this.epoch && !this.disposed) this.publish({ busy: false });
    }
  }
  private async saveOne(
    initial: OutboxRecord,
    scope: AccountSessionScope,
    epoch: number,
  ): Promise<void> {
    let record = initial;
    const abort = new AbortController();
    this.active = abort;
    this.activeId = record.requestId;
    const signal = AbortSignal.any([
        this.lifetime.signal,
        abort.signal,
        AbortSignal.timeout(6 * 60000),
      ]),
      context: OutboxMediaContext = {
        signal,
        assertCurrent: () => this.current(scope, epoch, signal),
      };
    const advance = async (patch: Partial<OutboxRecord>) => {
      record = await this.options.store.update(record, {
        ...patch,
        updatedAt: this.now(),
      });
    };
    try {
      context.assertCurrent();
      if (record.state === "committed") {
        await advance({ attempts: record.attempts + 1, nextAttemptAt: null });
        await this.finish(record, scope, context, advance);
        return;
      }
      await advance({
        state: "saving",
        attemptId: randomUUID(),
        attemptGeneration: scope.generation,
        attempts: record.attempts + 1,
        nextAttemptAt: null,
        errorCode: null,
      });
      await this.options.media.retain(record, context);
      await this.options.media.verify(record, context);
      if (!record.captured) await advance({ captured: true });
      context.assertCurrent();
      if (record.kind === "community-link") {
        const jobId = await this.options.community.link(record, scope, signal);
        context.assertCurrent();
        if (!jobId) throw new Error("COMMUNITY_OWNER_LINK_DEFERRED");
        await advance({ state: "committed", jobId });
        await this.finish(record, scope, context, advance);
        return;
      }
      const api = createOutboxApi(
          this.options.origin,
          this.options.installationId,
          this.options.account,
          scope,
          signal,
          this.options.fetch,
        ),
        candidate = outboxAccountScope(scope);
      let view = parseOutboxSyncView(
        await api.request(
          candidate,
          "/local-media-syncs",
          "POST",
          {
            request_id: record.requestId,
            profile_id: OUTBOX_PROFILE,
            original: artifactDeclaration(record.original!),
            vocals: artifactDeclaration(record.vocals),
            source_kind: record.videoId ? "url" : "file",
            ...(record.title ? { source_title: record.title } : {}),
            ...(record.videoId
              ? { source_url: canonicalYouTubeUrl(record.videoId) }
              : {}),
          },
          signal,
        ),
        record.requestId,
      );
      context.assertCurrent();
      await advance({ syncId: view.syncId, jobId: view.jobId });
      if (view.status === "expired") throw new Error("LOCAL_SYNC_EXPIRED");
      if (view.status !== "ready") {
        const grants = () => {
          if (!view.uploadGrants) throw new Error("LOCAL_SYNC_REPLY_INVALID");
          return {
            original: outboxGrant(view.uploadGrants.original, record.original!),
            vocals: outboxGrant(view.uploadGrants.vocals, record.vocals),
          };
        };
        let pair: ReturnType<typeof grants> | undefined;
        try {
          pair = grants();
        } catch (error) {
          if (
            !(error instanceof DesktopApiError) ||
            error.code !== "UPLOAD_GRANT_EXPIRED"
          )
            throw error;
          if (!record.grantRequestId)
            await advance({ grantRequestId: randomUUID() });
          view = await this.refresh(api, candidate, view, record, signal);
          context.assertCurrent();
          try {
            if (view.status !== "ready") pair = grants();
          } catch (next) {
            if (
              !(next instanceof DesktopApiError) ||
              next.code !== "UPLOAD_GRANT_EXPIRED"
            )
              throw next;
            await advance({ grantRequestId: randomUUID() });
            view = await this.refresh(api, candidate, view, record, signal);
            if (view.status !== "ready") pair = grants();
          }
        }
        if (view.status !== "ready") {
          if (!pair) throw new Error("LOCAL_SYNC_REPLY_INVALID");
          let uploadError: unknown;
          try {
            await this.options.media.upload(
              record,
              record.original!,
              pair.original,
              context,
            );
            await this.options.media.upload(
              record,
              record.vocals,
              pair.vocals,
              context,
            );
          } catch (error) {
            uploadError = error;
          }
          context.assertCurrent();
          try {
            view = parseOutboxSyncView(
              await api.request(
                candidate,
                `/local-media-syncs/${view.syncId}/completions`,
                "POST",
                {},
                signal,
              ),
              record.requestId,
            );
          } catch (error) {
            if (
              uploadError &&
              error instanceof DesktopApiError &&
              error.code === "UPLOAD_NOT_READY"
            )
              throw uploadError;
            throw error;
          }
        }
      }
      context.assertCurrent();
      if (view.status !== "ready" || !view.committed)
        throw new Error("LOCAL_SYNC_NOT_COMMITTED");
      await advance({
        state: "committed",
        jobId: view.jobId,
        syncId: view.syncId,
      });
      await this.finish(record, scope, context, advance);
    } catch (error) {
      const code = this.code(error);
      if (
        epoch === this.epoch &&
        ((error instanceof DesktopApiError && error.status === 401) ||
          code === "UNAUTHENTICATED")
      ) {
        try {
          this.options.onAuthenticationRequired?.(code);
        } catch {
          /* The owner journal still records the failure. */
        }
      }
      if (record.state !== "committed") {
        const blocked = permanent.has(code) || record.attempts >= 8;
        const retryAfter =
            error instanceof DesktopApiError ? error.retry_after_seconds : null,
          delay =
            Math.max(
              Math.min(
                300000,
                Math.max(5000, 5000 * 2 ** Math.min(6, record.attempts - 1)),
              ),
              (retryAfter ?? 0) * 1000,
            ) *
            (1 + 0.1 * (this.options.random ?? Math.random)());
        await this.options.store
          .update(record, {
            state: blocked ? "blocked" : "retry",
            errorCode: code,
            updatedAt: this.now(),
            nextAttemptAt: blocked ? null : this.now() + Math.ceil(delay),
            attemptId: null,
            attemptGeneration: null,
          })
          .catch(() => {});
      } else
        await this.options.store
          .update(record, {
            errorCode: code,
            updatedAt: this.now(),
            nextAttemptAt: record.attempts < 8 ? this.now() + 5000 : null,
          })
          .catch(() => {});
    } finally {
      if (this.active === abort) {
        this.active = null;
        this.activeId = null;
      }
    }
  }
  private async refresh(
    api: ReturnType<typeof createOutboxApi>,
    scope: ReturnType<typeof outboxAccountScope>,
    view: OutboxSyncView,
    record: OutboxRecord,
    signal: AbortSignal,
  ): Promise<OutboxSyncView> {
    return parseOutboxSyncView(
      await api.request(
        scope,
        `/local-media-syncs/${view.syncId}/upload-grants`,
        "POST",
        { request_id: record.grantRequestId },
        signal,
      ),
      record.requestId,
    );
  }
  private async finish(
    record: OutboxRecord,
    scope: AccountSessionScope,
    context: OutboxMediaContext,
    advance: (patch: Partial<OutboxRecord>) => Promise<void>,
  ): Promise<void> {
    context.assertCurrent();
    if (!record.jobId) throw new Error("LOCAL_SYNC_NOT_COMMITTED");
    if (!record.linked) {
      await this.options.catalog.attach(
        scope,
        `local:${record.cacheKey}`,
        record.jobId,
        record.vocals.sha256,
      );
      context.assertCurrent();
      await advance({ linked: true, errorCode: null });
    }
    if (!record.copiesReleased) {
      await this.options.media.release(record);
      await advance({ copiesReleased: true, errorCode: null });
    }
  }
  async execute(value: unknown): Promise<OutboxView> {
    const command = parseOutboxCommand(value);
    if (command.type === "RESTORE") await this.restore();
    else if (command.type === "SAVE_PENDING") await this.savePending();
    else {
      const scope = this.scope,
        epoch = this.epoch;
      if (!scope) throw new Error("SIGN_IN_REQUIRED");
      this.current(scope, epoch);
      const capture = this.captures.get(command.requestId);
      if (command.type === "DISCARD" && capture) {
        capture.abort.abort();
        await capture.promise?.catch(() => {});
      }
      if (command.type === "DISCARD" && this.activeId === command.requestId) {
        this.active?.abort();
        await this.drain;
      }
      let record = (await this.options.store.list(scope.firebaseUid)).find(
        (r) => r.requestId === command.requestId,
      );
      this.current(scope, epoch);
      if (!record) throw new Error("OUTBOX_NOT_FOUND");
      if (record.state === "discarded" && command.type === "RETRY")
        throw new Error("OUTBOX_DISCARDED");
      if (
        record.state === "committed" &&
        (command.type === "DISCARD" || (record.linked && record.copiesReleased))
      )
        throw new Error("OUTBOX_ALREADY_SAVED");
      if (command.type === "RETRY") {
        if (!this.intakeAllowed()) throw new Error("CONSUMERS_PAUSED");
        record = await this.options.store.update(record, {
          state: record.state === "committed" ? "committed" : "retry",
          attempts: 0,
          nextAttemptAt: null,
          errorCode: null,
          attemptId: null,
          attemptGeneration: null,
          updatedAt: this.now(),
        });
      } else {
        record = await this.options.store.update(record, {
          state: "discarded",
          nextAttemptAt: null,
          errorCode: record.syncId ? "OUTBOX_REMOTE_RESERVATION_EXPIRES" : null,
          attemptId: null,
          attemptGeneration: null,
          updatedAt: this.now(),
        });
        await this.options.media.release(record);
        await this.options.store.update(record, { copiesReleased: true });
      }
      await this.restore();
      if (command.type === "RETRY") this.kick();
    }
    return this.view();
  }
  async retainedDirectories(): Promise<Set<string>> {
    return new Set(
      (await this.options.store.list())
        .filter((r) => !r.copiesReleased)
        .flatMap((r) => [
          outboxRoot(r),
          ...(!r.captured ? [win32.dirname(r.vocals.sourceRelativePath)] : []),
        ]),
    );
  }
  async retentionUsage(): Promise<{
    originalBytes: number;
    vocalsBytes: number;
  }> {
    return (await this.options.store.list())
      .filter((record) => !record.copiesReleased)
      .reduce(
        (total, record) => ({
          originalBytes: total.originalBytes + (record.original?.bytes ?? 0),
          vocalsBytes: total.vocalsBytes + record.vocals.bytes,
        }),
        { originalBytes: 0, vocalsBytes: 0 },
      );
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.off();
    this.lifetime.abort();
    this.active?.abort();
    if (this.timer) clearTimeout(this.timer);
    await this.drain?.catch(() => {});
    await Promise.allSettled(this.stageJobs.values());
    await Promise.allSettled(this.restoring);
    this.listeners.clear();
  }
}
