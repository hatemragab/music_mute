import { createHash, randomUUID } from "node:crypto";
import {
  CloudProcessingProvider,
  fullTimeline,
  type CloudProgress,
} from "../../../../chrome-extension/src/companion/cloud-provider.js";
import { DesktopApiError } from "../../../../chrome-extension/src/companion/account-api.js";
import {
  canonicalYouTubeUrl,
  type JobSnapshot,
} from "../../../../chrome-extension/src/shared/protocol.js";
import {
  sameConsumerProcess,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import { createCloudApi } from "../cloud/api.js";
import type { AccountSessionScope } from "../account/account-controller.js";
import { parsePersonalOwnerProof } from "../session/personal-owner-proof.js";
import { parseChromeDiagnosticExport } from "../diagnostics/browser-report.js";
import type { InstallationCheck } from "../../../../chrome-extension/src/shared/installation-check.js";
import {
  parseBrowserAccountCommand,
  type BrowserAccountAuthorityOptions,
  type BrowserAccountCommand,
  type BrowserAccountReply,
  type BrowserDiagnosticReply,
  type BrowserAccountSelection,
  type BrowserAccountState,
} from "./account-contracts.js";

interface Operation {
  scope: AccountSessionScope;
  source: { videoId: string; duration: number; requestId: string };
  abort: AbortController;
  provider: CloudProcessingProvider;
  snapshot: JobSnapshot;
  release?: () => Promise<void>;
  promise: Promise<void>;
  cancel?: Promise<void>;
}
interface Owner {
  peer: ConsumerProcessIdentity;
  helloScope: string | null;
  revision: number;
  expires: number;
  operation?: Operation;
  requests: Map<string, string>;
  listeners: Set<() => void>;
  waiting: boolean;
  starting: boolean;
  check?: {
    requestId: string;
    status: InstallationCheck;
    cancel(): void;
    done: Promise<InstallationCheck>;
  };
  local?: { snapshot: JobSnapshot; release(): Promise<void> };
  publication?: {
    job_id: string;
    video_id: string;
    state: "pending" | "saving" | "saved";
  };
}
export interface BrowserAccountIdleReservation {
  /** Recheck after the caller has stopped its private transport and media intake. */
  assertIdle(): void;
  release(): void;
  /** Commit only after transport shutdown; the same authority cannot reopen. */
  commit(): Promise<void>;
}
const publicErrors = new Set([
  "INVALID_COMMAND",
  "PEER_DENIED",
  "OWNER_DETACHED",
  "REQUEST_ID_REUSED",
  "ACCOUNT_REQUIRED",
  "SIGN_IN_REQUIRED",
  "ACCOUNT_CHANGED",
  "SESSION_CHANGED",
  "ACCOUNT_OFFLINE",
  "ACCOUNT_SESSION_UNAVAILABLE",
  "PROCESSING_SELECTION_CHANGED",
  "PROCESSING_SELECTION_UNAVAILABLE",
  "CLOUD_BUSY",
  "CLOUD_POLICY_UNAVAILABLE",
  "CLOUD_POLICY_DENIED",
  "PROCESSING_PAUSED",
  "PROCESSING_ALLOWANCE_EXHAUSTED",
  "EMAIL_VERIFICATION_REQUIRED",
  "APP_UPDATE_REQUIRED",
  "CLOUD_PROCESSING_TIMEOUT",
  "CLOUD_REPLY_INVALID",
  "CLOUD_RESULT_UNAVAILABLE",
  "SOURCE_IDENTITY_MISMATCH",
  "TIMELINE_INCOMPATIBLE",
  "TIMELINE_MISMATCH",
  "DOWNLOAD_GRANT_INVALID",
  "CLOUD_IMPORT_CANCELLATION_UNAVAILABLE",
  "CANCELLED",
  "WINDOWS_SESSION_ALREADY_ACTIVE",
  "CONFIGURATION_REQUIRED",
  "PROCESSING_MAINTENANCE",
  "DIAGNOSTICS_UNAVAILABLE",
  "DIAGNOSTICS_BUSY",
  "DIAGNOSTICS_CLOSED",
  "DIAGNOSTICS_REPORT_INVALID",
  "DIAGNOSTICS_REPORT_TOO_LARGE",
  "DIAGNOSTICS_REPORT_STATE_INVALID",
  "DIAGNOSTICS_REPORT_CHANGED",
  "DIAGNOSTICS_REPORT_MISSING",
  "INSTALLATION_CHECK_BUSY",
  "INSTALLATION_CHECK_FAILED",
  "CACHE_CLEAR_UNAVAILABLE",
  "LOCAL_HOST_UNAVAILABLE",
  "STORAGE_WRITE_LIMIT",
  "STORAGE_RECOVERY_PENDING",
  "STORAGE_NOT_READY",
  "STORAGE_WRITE_CHANGED",
  "monthly_limit_reached",
  "storage_limit_reached",
  "waiting_job_limit",
  "paused",
]);
export function browserAccountFailure(error: unknown): string {
  const code =
    error instanceof DesktopApiError
      ? error.code
      : error instanceof Error
        ? error.message
        : "";
  if (error instanceof DesktopApiError && error.status === 401)
    return "SIGN_IN_REQUIRED";
  if (error instanceof DesktopApiError && error.status === 503)
    return "CLOUD_POLICY_UNAVAILABLE";
  return publicErrors.has(code) ? code : "ACCOUNT_SESSION_UNAVAILABLE";
}
/** Sole native AccountController is injected; neither tokens nor raw account snapshots leave this authority. */
export class BrowserAccountAuthority {
  readonly instanceId = randomUUID();
  private readonly owners = new Map<string, Owner>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly activityListeners = new Set<() => void>();
  private replies = 0;
  private readonly stops: (() => void)[];
  private disposed = false;
  private accepting = true;
  private idleReservation: object | undefined;
  private closing: Promise<void> | undefined;
  private readonly reapTimer: ReturnType<typeof setInterval>;
  private reaping = false;
  private selectedMode: "local" | "cloud";
  constructor(private readonly options: BrowserAccountAuthorityOptions) {
    this.selectedMode = options.selectedMode();
    if (options.publication && !options.provePersonalOwner)
      throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
    this.stops = [
      options.account.subscribe(() => this.accountChanged()),
      options.usage.subscribe(() => this.changedAll()),
    ];
    if (options.publication)
      this.stops.push(
        options.publication.subscribe((update) => {
          const owner = this.owners.get(update.ownerId);
          if (
            !owner ||
            owner.publication?.job_id !== update.jobId ||
            owner.publication.video_id !== update.videoId ||
            !["pending", "saving", "saved"].includes(update.state)
          )
            return;
          owner.publication.state = update.state;
          this.changed(owner);
        }),
      );
    // IPC heartbeat renews a browser lease. A crashed host must not retain media
    // grants/account authority forever; the signed PID/birth proof is rechecked.
    this.reapTimer = setInterval(() => {
      void this.reapExpired();
    }, 15000);
    this.reapTimer.unref();
  }
  async reapExpired(): Promise<void> {
    if (this.reaping || !this.accepting) return;
    this.reaping = true;
    try {
      for (const [id, owner] of this.owners) {
        if (owner.expires > this.now || owner.waiting || owner.starting)
          continue;
        if (await this.options.verifyPeer(owner.peer).catch(() => false)) {
          owner.expires = this.now + 60000;
          continue;
        }
        await this.detach(id, owner).catch(() => {});
      }
    } finally {
      this.reaping = false;
      this.activityChanged();
    }
  }
  private get now() {
    return (this.options.now ?? Date.now)();
  }
  activity(): {
    consumers: number;
    activeJobs: number;
    mediaGrants: number;
    idle: boolean;
  } {
    let consumers = 0,
      activeJobs = 0,
      mediaGrants = 0;
    for (const owner of this.owners.values()) {
      if (
        owner.expires > this.now ||
        owner.operation?.snapshot.state === "PROCESSING" ||
        owner.operation?.snapshot.state === "DOWNLOADING" ||
        owner.operation?.snapshot.state === "VALIDATING"
      )
        consumers++;
      if (
        owner.operation &&
        !["READY", "FAILED", "CANCELLED"].includes(
          owner.operation.snapshot.state,
        )
      )
        activeJobs++;
      if (owner.operation?.release) mediaGrants++;
      if (owner.local) mediaGrants++;
    }
    return {
      consumers,
      activeJobs,
      mediaGrants,
      idle:
        consumers === 0 &&
        activeJobs === 0 &&
        mediaGrants === 0 &&
        this.pending.size === 0 &&
        this.replies === 0 &&
        !this.reaping,
    };
  }
  subscribeActivity(listener: () => void): () => void {
    this.activityListeners.add(listener);
    listener();
    return () => {
      this.activityListeners.delete(listener);
    };
  }
  /** Synchronous fence: no owner may enter between idle observation and quit/update. */
  beginIdleClose(): BrowserAccountIdleReservation | null {
    if (!this.accepting || this.disposed || this.closing) return null;
    this.accepting = false;
    if (!this.activity().idle) {
      this.accepting = true;
      return null;
    }
    const token = {};
    this.idleReservation = token;
    let finished = false;
    const assertIdle = () => {
      if (
        finished ||
        this.idleReservation !== token ||
        this.disposed ||
        !this.activity().idle
      )
        throw new Error("ACCOUNT_AUTHORITY_BUSY");
    };
    return {
      assertIdle,
      release: () => {
        if (finished || this.idleReservation !== token) return;
        finished = true;
        this.idleReservation = undefined;
        if (!this.disposed && !this.closing) this.accepting = true;
        this.activityChanged();
      },
      commit: () => {
        assertIdle();
        finished = true;
        this.idleReservation = undefined;
        return this.dispose();
      },
    };
  }
  /** The private transport holds this through the actual reply acknowledgement. */
  holdReply(): () => void {
    this.replies++;
    this.activityChanged();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.replies--;
      this.activityChanged();
    };
  }
  private activityChanged() {
    for (const listener of this.activityListeners) {
      try {
        listener();
      } catch {
        /* Observation cannot authorize intake. */
      }
    }
  }
  private changed(owner: Owner) {
    owner.revision++;
    for (const listener of owner.listeners) listener();
    this.activityChanged();
  }
  private changedAll() {
    for (const owner of this.owners.values()) this.changed(owner);
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    this.activityChanged();
    const done = () => {
      this.pending.delete(promise);
      this.activityChanged();
    };
    void promise.then(done, done);
    return promise;
  }
  private same(scope: AccountSessionScope) {
    const current = this.options.account.sessionScope();
    return (
      current?.firebaseUid === scope.firebaseUid &&
      current.generation === scope.generation
    );
  }
  private current(scope: AccountSessionScope) {
    if (this.disposed) throw new Error("CANCELLED");
    if (this.options.origin === null) throw new Error("CONFIGURATION_REQUIRED");
    this.options.account.assertScope(scope);
    if (this.options.selectedMode() !== "cloud")
      throw new Error("PROCESSING_SELECTION_CHANGED");
  }
  /** Main calls this from its existing saved-mode subscription, without polling. */
  selectionChanged(): void {
    const mode = this.options.selectedMode();
    if (mode === this.selectedMode) return;
    this.selectedMode = mode;
    for (const owner of this.owners.values()) {
      owner.helloScope = null;
      if (owner.operation && this.options.selectedMode() !== "cloud") {
        const operation = owner.operation;
        operation.abort.abort();
        operation.provider.close();
        delete owner.operation;
        if (operation.release) this.track(operation.release().catch(() => {}));
      }
      this.changed(owner);
    }
  }
  private accountChanged() {
    for (const owner of this.owners.values()) {
      owner.helloScope = null;
      const operation = owner.operation;
      if (operation && !this.same(operation.scope)) {
        operation.abort.abort();
        operation.provider.close();
        delete owner.operation;
        if (operation.release) this.track(operation.release().catch(() => {}));
      }
      this.changed(owner);
    }
  }
  private scopeKey(scope: AccountSessionScope): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          "windows-browser-cloud-v1",
          this.instanceId,
          this.options.installationId,
          scope.firebaseUid,
          scope.generation,
        ]),
      )
      .digest("hex");
  }
  private consumersAllowed(): boolean {
    return this.options.consumersAllowed?.() !== false;
  }
  private assertConsumersAllowed(): void {
    if (!this.consumersAllowed()) throw new Error("PROCESSING_MAINTENANCE");
  }
  private async selection(): Promise<BrowserAccountSelection> {
    const mode = await this.options.modeStore.read();
    if (this.disposed || mode !== this.options.selectedMode())
      throw new Error("PROCESSING_SELECTION_CHANGED");
    const scope = this.options.account.sessionScope();
    let ready = false,
      error: string | null = null;
    if (mode === "cloud") {
      try {
        this.assertConsumersAllowed();
        if (this.options.origin === null)
          throw new Error("CONFIGURATION_REQUIRED");
        if (!scope) throw new Error("SIGN_IN_REQUIRED");
        this.current(scope);
        this.options.usage.assertCloudSubmission(this.options.account.view());
        ready = true;
      } catch (failure) {
        error = browserAccountFailure(failure);
      }
    }
    return {
      processing_provider:
        mode === "cloud" ? "ONLINE_MUSICMUTE" : "LOCAL_WINDOWS",
      processing_scope: mode === "cloud" && scope ? this.scopeKey(scope) : null,
      cloud_ready: ready,
      error_code: error,
      cache_reuse_supported:
        this.consumersAllowed() && !!this.options.localReuse,
      publication_supported:
        this.consumersAllowed() && !!this.options.publication,
    };
  }
  private async state(
    owner: Owner,
    unchanged = false,
  ): Promise<BrowserAccountState> {
    const selection = await this.selection();
    const operation = owner.operation;
    if (operation && !this.same(operation.scope))
      throw new Error("ACCOUNT_CHANGED");
    return {
      version: 1,
      instance_id: this.instanceId,
      revision: owner.revision,
      selection,
      job: operation
        ? structuredClone(operation.snapshot)
        : owner.local
          ? structuredClone(owner.local.snapshot)
          : null,
      unchanged,
      ...(owner.check
        ? {
            installation_check: {
              request_id: owner.check.requestId,
              status: structuredClone(owner.check.status),
            },
          }
        : {}),
      ...(owner.publication
        ? { publication: structuredClone(owner.publication) }
        : {}),
    };
  }
  private async owner(
    command: BrowserAccountCommand,
    peer: ConsumerProcessIdentity,
  ): Promise<Owner> {
    if (
      !this.accepting ||
      this.disposed ||
      !(await this.options.verifyPeer(peer))
    )
      throw new Error("PEER_DENIED");
    if (!this.accepting || this.disposed) throw new Error("PEER_DENIED");
    let owner = this.owners.get(command.owner_id);
    if (owner && !sameConsumerProcess(owner.peer, peer))
      throw new Error("PEER_DENIED");
    if (!owner) {
      if (
        !["selection", "diagnostics"].includes(command.action) ||
        this.owners.size >= 32
      )
        throw new Error("OWNER_DETACHED");
      owner = {
        peer: structuredClone(peer),
        helloScope: null,
        revision: 1,
        expires: this.now + 60000,
        requests: new Map(),
        listeners: new Set(),
        waiting: false,
        starting: false,
      };
      this.owners.set(command.owner_id, owner);
    }
    owner.expires = this.now + 60000;
    this.activityChanged();
    return owner;
  }
  /** Personal-only diagnostics lane, separate from account/cloud state projection. */
  async diagnostics(
    value: unknown,
    peer: ConsumerProcessIdentity,
    signal: AbortSignal,
  ): Promise<BrowserDiagnosticReply> {
    const command = parseBrowserAccountCommand(value);
    try {
      if (command.action !== "diagnostics") throw new Error("INVALID_COMMAND");
      this.assertConsumersAllowed();
      const owner = await this.owner(command, peer);
      if (!this.options.diagnostics) throw new Error("DIAGNOSTICS_UNAVAILABLE");
      signal.throwIfAborted();
      this.assertConsumersAllowed();
      const report = await this.track(
        this.options.diagnostics.exportReport(command.request_id, signal),
      );
      signal.throwIfAborted();
      if (
        this.disposed ||
        !this.accepting ||
        this.owners.get(command.owner_id) !== owner ||
        !(await this.options.verifyPeer(peer))
      )
        throw new Error("PEER_DENIED");
      return {
        version: 1,
        request_id: command.request_id,
        ok: true,
        diagnostics: parseChromeDiagnosticExport(report),
      };
    } catch (error) {
      return {
        version: 1,
        request_id: command.request_id,
        ok: false,
        error_code: signal.aborted ? "CANCELLED" : browserAccountFailure(error),
      };
    }
  }
  async execute(
    value: unknown,
    peer: ConsumerProcessIdentity,
    publicationPeer?: ConsumerProcessIdentity,
    signal: AbortSignal = AbortSignal.timeout(200000),
  ): Promise<BrowserAccountReply> {
    const command = parseBrowserAccountCommand(value);
    try {
      if (
        [
          "start",
          "local_lookup",
          "playback_started",
          "diagnostics",
          "check",
          "clear_cache",
        ].includes(command.action)
      )
        this.assertConsumersAllowed();
      if (command.action === "diagnostics") throw new Error("INVALID_COMMAND");
      const owner = await this.owner(command, peer);
      if (command.action === "check") {
        if (!this.options.toolkit) throw new Error("INSTALLATION_CHECK_FAILED");
        if (owner.check?.status.state === "running")
          throw new Error("INSTALLATION_CHECK_BUSY");
        // Reserve synchronously. Published snapshots belong only to this exact
        // signed native peer/owner; watchers never start a check themselves.
        let pendingStatus: InstallationCheck | undefined;
        const handle = this.options.toolkit.startCheck(signal, (status) => {
          pendingStatus = status;
          if (owner.check?.requestId === command.request_id) {
            owner.check.status = status;
            this.changed(owner);
          }
        });
        owner.check = {
          requestId: command.request_id,
          status: pendingStatus ?? handle.initial,
          cancel: handle.cancel,
          done: handle.done,
        };
        this.changed(owner);
        void this.track(handle.done).catch(() => {});
      }
      if (command.action === "clear_cache") {
        if (!this.options.toolkit) throw new Error("CACHE_CLEAR_UNAVAILABLE");
        await this.track(this.options.toolkit.clearCache(signal));
      }
      if (command.action === "event") {
        if (!this.options.toolkit) throw new Error("DIAGNOSTICS_UNAVAILABLE");
        await this.track(this.options.toolkit.recordEvent(command.event));
      }
      if (command.action === "selection") {
        const result = await this.state(owner);
        owner.helloScope = result.selection.processing_scope;
        return {
          version: 1,
          request_id: command.request_id,
          ok: true,
          state: result,
        };
      }
      if (command.action === "start") await this.start(command, owner);
      if (command.action === "local_lookup")
        await this.localLookup(command, owner);
      if (command.action === "playback_started") {
        if (
          publicationPeer &&
          !(await this.options.verifyPeer(publicationPeer))
        )
          throw new Error("PEER_DENIED");
        const snapshot = owner.local?.snapshot;
        // Fresh personal jobs are verified by the native composition callback;
        // a cached job is already bound here to this exact peer/video.
        if (
          snapshot &&
          (snapshot.job_id !== command.job_id ||
            snapshot.video_id !== command.video_id)
        )
          throw new Error("OWNER_DETACHED");
        if (snapshot)
          return {
            version: 1,
            request_id: command.request_id,
            ok: true,
            state: await this.state(owner),
          };
        if (
          !publicationPeer ||
          !this.options.publication ||
          !this.options.provePersonalOwner
        )
          throw new Error("PEER_DENIED");
        const requested = {
          ownerId: command.owner_id,
          peer: publicationPeer,
          jobId: command.job_id,
          videoId: command.video_id,
        };
        const proof = parsePersonalOwnerProof(
          await this.options.provePersonalOwner(requested),
          requested,
        );
        this.assertConsumersAllowed();
        const state = await this.options.publication.playbackStarted({
          ownerId: command.owner_id,
          peer: publicationPeer ?? owner.peer,
          jobId: command.job_id,
          videoId: command.video_id,
          proof,
        });
        if (state) {
          owner.publication = {
            job_id: command.job_id,
            video_id: command.video_id,
            state,
          };
          this.changed(owner);
        }
      }
      if (command.action === "cancel") {
        if (owner.local?.snapshot.job_id === command.job_id) {
          await owner.local.release();
          delete owner.local;
          this.changed(owner);
        } else if (owner.operation?.snapshot.job_id !== command.job_id)
          throw new Error("OWNER_DETACHED");
        else await this.cancel(owner.operation, owner);
      }
      if (command.action === "detach") {
        await this.detach(command.owner_id, owner);
        return {
          version: 1,
          request_id: command.request_id,
          ok: true,
          state: {
            version: 1,
            instance_id: this.instanceId,
            revision: owner.revision,
            selection: await this.selection(),
            job: null,
            unchanged: false,
          },
        };
      }
      const unchanged =
        command.action === "wait" ? await this.wait(command, owner) : false;
      return {
        version: 1,
        request_id: command.request_id,
        ok: true,
        state: await this.state(owner, unchanged),
      };
    } catch (error) {
      return {
        version: 1,
        request_id: command.request_id,
        ok: false,
        error_code: browserAccountFailure(error),
      };
    }
  }
  private async localLookup(
    command: Extract<BrowserAccountCommand, { action: "local_lookup" }>,
    owner: Owner,
  ): Promise<void> {
    if (owner.starting) throw new Error("CLOUD_BUSY");
    owner.starting = true;
    try {
      if (
        this.options.selectedMode() !== "local" ||
        (await this.options.modeStore.read()) !== "local"
      )
        throw new Error("PROCESSING_SELECTION_CHANGED");
      if (
        owner.operation &&
        !["READY", "FAILED", "CANCELLED"].includes(
          owner.operation.snapshot.state,
        )
      )
        throw new Error("CLOUD_BUSY");
      if (owner.operation?.release) await owner.operation.release();
      delete owner.operation;
      if (owner.local) {
        await owner.local.release();
        delete owner.local;
      }
      delete owner.publication;
      const result = await this.options.localReuse?.find({
        ownerId: command.owner_id,
        peer: owner.peer,
        requestId: command.request_id,
        videoId: command.video_id,
        durationSeconds: command.duration_seconds,
        cacheOnly: command.cache_only,
        signal: AbortSignal.timeout(30000),
      });
      if (result) {
        try {
          this.assertConsumersAllowed();
          if (
            !this.accepting ||
            this.options.selectedMode() !== "local" ||
            result.media.trim_enabled !== false ||
            Math.abs(result.media.duration_seconds - command.duration_seconds) >
              2
          )
            throw new Error("TIMELINE_MISMATCH");
          owner.local = {
            snapshot: {
              job_id: command.restore_job_id ?? randomUUID(),
              video_id: command.video_id,
              provider: "LOCAL_WINDOWS",
              state: "READY",
              stage: "cache-ready",
              cache_hit: true,
              media: structuredClone(result.media),
            },
            release: result.release,
          };
        } catch (error) {
          await result.release();
          throw error;
        }
      }
      this.changed(owner);
    } finally {
      owner.starting = false;
    }
  }
  private async start(
    command: Extract<BrowserAccountCommand, { action: "start" }>,
    owner: Owner,
  ): Promise<void> {
    this.assertConsumersAllowed();
    if (this.options.origin === null) throw new Error("CONFIGURATION_REQUIRED");
    if (owner.starting) throw new Error("CLOUD_BUSY");
    owner.starting = true;
    try {
      await this.startExclusive(command, owner);
    } finally {
      owner.starting = false;
    }
  }
  private async startExclusive(
    command: Extract<BrowserAccountCommand, { action: "start" }>,
    owner: Owner,
  ): Promise<void> {
    const origin = this.options.origin;
    if (origin === null) throw new Error("CONFIGURATION_REQUIRED");
    const identity = JSON.stringify([
      command.video_id,
      command.duration_seconds,
      command.processing_scope,
    ]);
    const previous = owner.requests.get(command.request_id);
    if (previous !== undefined) {
      if (previous !== identity) throw new Error("REQUEST_ID_REUSED");
      if (owner.operation?.source.requestId !== command.request_id)
        throw new Error("OWNER_DETACHED");
      return;
    }
    if (
      owner.operation &&
      !["READY", "FAILED", "CANCELLED"].includes(owner.operation.snapshot.state)
    )
      throw new Error("CLOUD_BUSY");
    if (owner.requests.size >= 64) throw new Error("CLOUD_BUSY");
    const selection = await this.selection(),
      scope = this.options.account.sessionScope();
    if (selection.processing_provider !== "ONLINE_MUSICMUTE")
      throw new Error("PROCESSING_SELECTION_CHANGED");
    if (!scope || !selection.cloud_ready)
      throw new Error(selection.error_code ?? "ACCOUNT_REQUIRED");
    if (
      owner.helloScope !== command.processing_scope ||
      selection.processing_scope !== command.processing_scope
    )
      throw new Error("ACCOUNT_CHANGED");
    this.current(scope);
    delete owner.publication;
    if (owner.local) {
      await owner.local.release();
      delete owner.local;
    }
    this.options.usage.assertCloudSubmission(this.options.account.view());
    if (owner.operation?.release) {
      await owner.operation.release();
      delete owner.operation.release;
    }
    this.current(scope);
    const abort = new AbortController();
    let operation!: Operation;
    const api = createCloudApi({
      origin,
      installationId: this.options.installationId,
      account: this.options.account,
      scope,
      beforeIntake: () => {
        this.current(scope);
        if (this.options.selectedMode() !== "cloud")
          throw new Error("PROCESSING_SELECTION_CHANGED");
        this.options.usage.assertCloudSubmission(this.options.account.view());
      },
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
    const provider = new CloudProcessingProvider({
      api,
      scope: {
        firebase_uid: scope.firebaseUid,
        session_generation: scope.generation,
      },
      signal: abort.signal,
      realtime: this.options.realtime.cloudLease(scope),
      onProgress: (progress) => {
        if (owner.operation !== operation || !this.same(scope)) return;
        this.progress(operation, progress);
        this.changed(owner);
      },
      resolveDownload: async (job, grant, signal) => {
        this.assertConsumersAllowed();
        this.current(scope);
        if (
          !fullTimeline(job) ||
          job.source_kind !== "url" ||
          job.source_url !== canonicalYouTubeUrl(command.video_id)
        )
          throw new Error("SOURCE_IDENTITY_MISMATCH");
        if (Math.abs(job.input.duration_seconds - command.duration_seconds) > 2)
          throw new Error("TIMELINE_MISMATCH");
        const issued = await this.options.media.publish({
          ownerId: command.owner_id,
          peer: owner.peer,
          scope,
          requestId: command.request_id,
          videoId: command.video_id,
          durationSeconds: command.duration_seconds,
          job,
          grant,
          signal,
          assertCurrent: () => {
            this.assertConsumersAllowed();
            this.current(scope);
          },
        });
        try {
          this.assertConsumersAllowed();
          this.current(scope);
          signal.throwIfAborted();
          if (
            owner.operation !== operation ||
            issued.media.trim_enabled !== false ||
            Math.abs(
              issued.media.duration_seconds - job.input.duration_seconds,
            ) > 0.25
          )
            throw new Error("TIMELINE_MISMATCH");
          operation.release = issued.release;
          operation.snapshot.media = structuredClone(issued.media);
        } catch (error) {
          await issued.release();
          throw error;
        }
      },
    });
    operation = {
      scope: { ...scope },
      source: {
        videoId: command.video_id,
        duration: command.duration_seconds,
        requestId: command.request_id,
      },
      abort,
      provider,
      snapshot: {
        job_id: randomUUID(),
        video_id: command.video_id,
        provider: "ONLINE_MUSICMUTE",
        state: "PROCESSING",
        stage: "cloud-importing",
      },
      promise: Promise.resolve(),
    };
    owner.requests.set(command.request_id, identity);
    owner.operation = operation;
    this.changed(owner);
    operation.promise = this.track(
      Promise.resolve().then(async () => {
        try {
          await provider.startYouTube({
            url: canonicalYouTubeUrl(command.video_id),
            request_id: command.request_id,
          });
          this.current(scope);
          if (owner.operation === operation) {
            if (!operation.snapshot.media)
              throw new Error("CLOUD_RESULT_UNAVAILABLE");
            operation.snapshot.state = "READY";
            operation.snapshot.stage = "cloud-ready";
            this.changed(owner);
          }
        } catch (error) {
          if (owner.operation === operation && this.same(scope)) {
            operation.snapshot.state = abort.signal.aborted
              ? "CANCELLED"
              : "FAILED";
            operation.snapshot.stage = "cloud-finished";
            operation.snapshot.error_code = browserAccountFailure(error);
            this.changed(owner);
          }
        } finally {
          provider.close();
        }
      }),
    );
  }
  private progress(operation: Operation, value: CloudProgress) {
    operation.snapshot.state =
      value.phase === "downloading" ? "DOWNLOADING" : "PROCESSING";
    operation.snapshot.stage = `cloud-${value.phase}`;
  }
  private async cancel(operation: Operation, owner: Owner) {
    operation.cancel ??= this.track(
      (async () => {
        try {
          this.current(operation.scope);
          await operation.provider.cancel(AbortSignal.timeout(15000));
        } finally {
          operation.abort.abort();
          await operation.promise;
          if (operation.release) {
            await operation.release();
            delete operation.release;
          }
          if (owner.operation === operation) {
            operation.snapshot.state = "CANCELLED";
            delete operation.snapshot.media;
            this.changed(owner);
          }
        }
      })(),
    );
    await operation.cancel;
  }
  private async wait(
    command: Extract<BrowserAccountCommand, { action: "wait" }>,
    owner: Owner,
  ): Promise<boolean> {
    if (
      command.instance_id !== this.instanceId ||
      command.after_revision < owner.revision
    )
      return false;
    if (command.after_revision > owner.revision || owner.waiting)
      throw new Error("INVALID_COMMAND");
    owner.waiting = true;
    try {
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const done = (unchanged: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          owner.listeners.delete(change);
          resolve(unchanged);
        };
        const change = () => done(false);
        const timer = setTimeout(() => done(true), 20000);
        owner.listeners.add(change);
        if (this.disposed) done(false);
      });
    } finally {
      owner.waiting = false;
    }
  }
  private async detach(id: string, owner: Owner) {
    if (owner.check) {
      owner.check.cancel();
      await owner.check.done.catch(() => {});
    }
    try {
      if (owner.operation) await this.cancel(owner.operation, owner);
    } finally {
      try {
        if (owner.local) await owner.local.release();
      } finally {
        delete owner.local;
        this.owners.delete(id);
        owner.expires = 0;
        this.changed(owner);
      }
    }
  }
  dispose(): Promise<void> {
    this.accepting = false;
    clearInterval(this.reapTimer);
    return (this.closing ??= (async () => {
      for (const stop of this.stops) stop();
      await Promise.allSettled(
        [...this.owners].map(([id, owner]) => this.detach(id, owner)),
      );
      this.disposed = true;
      this.changedAll();
      await Promise.allSettled(this.pending);
      this.owners.clear();
      this.activityChanged();
      this.activityListeners.clear();
    })());
  }
}
export function createBrowserAccountAuthority(
  options: BrowserAccountAuthorityOptions,
): BrowserAccountAuthority {
  return new BrowserAccountAuthority(options);
}
