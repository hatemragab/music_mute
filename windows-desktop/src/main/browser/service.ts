import { randomUUID } from "node:crypto";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { validateCommand } from "../../../../chrome-extension/src/companion/native-protocol.js";
import {
  VERSION,
  type JobSnapshot,
  type NativeReply,
} from "../../../../chrome-extension/src/shared/protocol.js";
import type { ConsumerProcessIdentity } from "../../../../worker/src/platform/windows/consumer-native.js";
import type { PersonalJobView } from "../../shared/personal-contracts.js";
import type { PersonalReply } from "../personal/session-port.js";
import type { SessionClient } from "../session/control.js";
import type { BrowserAccountClient } from "./account-bridge.js";
import type { BrowserAccountState } from "./account-contracts.js";
import { parseChromeDiagnosticExport } from "../diagnostics/browser-report.js";
import { projectBrowserEvent } from "./toolkit.js";

export interface BrowserMediaPort {
  issue(
    job: PersonalJobView,
  ): Promise<{ url: string; release(): Promise<void> }>;
  close(): Promise<void>;
}
type Source = {
  videoId: string;
  requestId: string;
  duration: number;
  provider: "LOCAL_WINDOWS" | "ONLINE_MUSICMUTE";
};
type PersonalSession = Pick<SessionClient, "personal">;
/** One Chrome-owned local/cloud gateway; all account authorization stays native. */
export class WindowsBrowserService {
  readonly ownerId: string;
  private readonly source = new Map<string, Source>();
  private readonly views = new Map<string, PersonalJobView>();
  private readonly grants = new Map<
    string,
    { sha256: string; url: string; release(): Promise<void> }
  >();
  private readonly remote = new Map<string, JobSnapshot>();
  private session: PersonalSession | undefined;
  private opening: Promise<PersonalSession> | undefined;
  private accountState: BrowserAccountState | undefined;
  private checkRequest: { publicId: string; privateId: string } | undefined;
  private closing = false;
  private closed = false;
  private watcher: Promise<void> | undefined;
  private accountWatcher: Promise<void> | undefined;
  private storeClosing: Promise<void> | undefined;
  constructor(
    private readonly options: {
      session?: PersonalSession;
      getSession?(): Promise<PersonalSession>;
      account?: Pick<
        BrowserAccountClient,
        "ownerId" | "command" | "start" | "wait" | "playbackStarted" | "close"
      > &
        Partial<Pick<BrowserAccountClient, "diagnostics">>;
      personalPeer?(): Promise<ConsumerProcessIdentity | undefined>;
      media: BrowserMediaPort;
      write(reply: NativeReply): Promise<void>;
      onDisconnected(): void;
      distribution?: "microsoft-store";
    },
  ) {
    this.ownerId = options.account?.ownerId ?? randomUUID();
    this.session = options.session;
  }
  private async local(): Promise<PersonalSession> {
    if (this.session) return this.session;
    if (!this.options.getSession) throw new Error("LOCAL_INSTALL_REQUIRED");
    try {
      return (this.session = await (this.opening ??=
        this.options.getSession()));
    } finally {
      this.opening = undefined;
    }
  }
  current(jobId: string, sha256: string): boolean {
    const job = this.views.get(jobId);
    return (
      !this.closing && job?.state === "ready" && job.vocals?.sha256 === sha256
    );
  }
  async authorizeMedia(jobId: string, sha256: string): Promise<boolean> {
    if (this.closing || !this.session) return false;
    const reply = await this.session.personal(
      {
        version: 1,
        requestId: randomUUID(),
        action: "jobs",
        ownerId: this.ownerId,
      },
      "chrome",
    );
    if (!reply.ok || !Array.isArray(reply.jobs)) return false;
    this.replace(reply.jobs);
    return this.current(jobId, sha256);
  }
  private async refreshAccount(): Promise<BrowserAccountState | undefined> {
    if (!this.options.account) return undefined;
    return (this.accountState = await this.options.account.command({
      action: "selection",
    }));
  }
  async command(value: unknown): Promise<void> {
    const command = validateCommand(value);
    if (
      Object.keys(command).sort().join() !==
      "payload,protocol_version,request_id,type"
    )
      throw new Error("INVALID_COMMAND");
    const base = {
      protocol_version: 1 as const,
      request_id: command.request_id,
    };
    try {
      if (this.closing) throw new Error("LOCAL_HOST_UNAVAILABLE");
      if (command.type === "CHECK") {
        if (!this.options.account) throw new Error("INSTALLATION_CHECK_FAILED");
        const state = await this.options.account.command({ action: "check" });
        if (!state.installation_check)
          throw new Error("INSTALLATION_CHECK_FAILED");
        this.accountState = state;
        this.checkRequest = {
          publicId: command.request_id,
          privateId: state.installation_check.request_id,
        };
        await this.options.write({
          ...base,
          type: "CHECK",
          payload: state.installation_check.status,
        });
        this.watchAccount();
        return;
      }
      if (command.type === "CLEAR_CACHE") {
        if (!this.options.account) throw new Error("CACHE_CLEAR_UNAVAILABLE");
        this.accountState = await this.options.account.command({
          action: "clear_cache",
        });
        await this.options.write({ ...base, type: "JOB", payload: null });
        return;
      }
      if (command.type === "DIAGNOSTICS") {
        if (!this.options.account?.diagnostics)
          throw new Error("DIAGNOSTICS_UNAVAILABLE");
        const exported = parseChromeDiagnosticExport(
          await this.options.account.diagnostics(command.request_id),
        );
        if (this.closing) throw new Error("LOCAL_HOST_UNAVAILABLE");
        await this.options.write({
          ...base,
          type: "REPORT",
          payload: { report: exported.report },
        });
        return;
      }
      if (command.type === "HELLO") {
        const account = await this.refreshAccount();
        const cloud =
          account?.selection.processing_provider === "ONLINE_MUSICMUTE";
        let localReady = false,
          localError: string | undefined;
        if (!cloud) {
          try {
            const reply = await (
              await this.local()
            ).personal(
              {
                version: 1,
                requestId: randomUUID(),
                action: "jobs",
                ownerId: this.ownerId,
              },
              "chrome",
            );
            if (!reply.ok || !Array.isArray(reply.jobs))
              throw new Error(reply.error ?? "LOCAL_HOST_UNAVAILABLE");
            this.replace(reply.jobs);
            this.watch();
            localReady = true;
          } catch (error) {
            localError = this.failure(error);
          }
        }
        this.watchAccount();
        const ready = cloud
          ? account!.selection.cloud_ready
          : localReady || !!account?.selection.cache_reuse_supported;
        await this.options.write({
          ...base,
          type: "HELLO",
          payload: {
            ready,
            version: VERSION,
            platform: "win32",
            arch: "x64",
            max_duration_seconds: 1200,
            capabilities: account
              ? [
                  "cloud_handoff_v1",
                  "processing_selection_v1",
                  ...(account.selection.publication_supported
                    ? ["background_publication_v1" as const]
                    : []),
                ]
              : [],
            ...(account
              ? {
                  processing_provider: account.selection.processing_provider,
                  ...(account.selection.processing_scope
                    ? { processing_scope: account.selection.processing_scope }
                    : {}),
                  cache_recovery_supported:
                    account.selection.cache_reuse_supported,
                }
              : {}),
            background_publication_supported:
              !!account?.selection.publication_supported,
            ...(!ready
              ? {
                  error_code: cloud
                    ? (account!.selection.error_code ?? "ACCOUNT_REQUIRED")
                    : (localError ?? "LOCAL_INSTALL_REQUIRED"),
                }
              : {}),
          },
        });
        return;
      }
      if (command.type === "START") {
        const input = command.payload;
        if (input.provider === "ONLINE_MUSICMUTE") {
          if (
            !this.options.account ||
            !this.accountState?.selection.processing_scope
          )
            throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
          const state = await this.options.account.start(
            input.video_id,
            input.duration_seconds,
            this.accountState.selection.processing_scope,
            command.request_id,
          );
          this.accountState = state;
          if (
            !state.job ||
            state.job.provider !== "ONLINE_MUSICMUTE" ||
            state.job.video_id !== input.video_id
          )
            throw new Error("CLOUD_REPLY_INVALID");
          this.source.set(state.job.job_id, {
            videoId: input.video_id,
            requestId: command.request_id,
            duration: input.duration_seconds,
            provider: "ONLINE_MUSICMUTE",
          });
          await this.sendRemote(state.job, command.request_id);
          this.watchAccount();
          return;
        }
        if (input.provider !== "LOCAL_WINDOWS")
          throw new Error("PROVIDER_UNAVAILABLE");
        if (this.options.account) {
          const state = await this.options.account.command({
            action: "local_lookup",
            video_id: input.video_id,
            duration_seconds: input.duration_seconds,
            cache_only: false,
          });
          this.accountState = state;
          if (state.job) {
            this.source.set(state.job.job_id, {
              videoId: input.video_id,
              requestId: command.request_id,
              duration: input.duration_seconds,
              provider: "LOCAL_WINDOWS",
            });
            await this.sendRemote(state.job, command.request_id);
            this.watchAccount();
            return;
          }
        }
        const reply = await (
          await this.local()
        ).personal(
          {
            version: 1,
            requestId: command.request_id,
            action: "submit",
            submission: {
              ownerId: this.ownerId,
              requestId: command.request_id,
              input: { kind: "youtube", videoId: input.video_id },
              rightsConfirmed: true,
              recipeId: "kim-vocals-v2",
            },
          },
          "chrome",
        );
        if (!reply.ok || !reply.job)
          throw new Error(reply.error ?? "PROCESSING_FAILED");
        this.source.set(reply.job.id, {
          videoId: input.video_id,
          requestId: command.request_id,
          duration: input.duration_seconds,
          provider: "LOCAL_WINDOWS",
        });
        this.views.set(reply.job.id, reply.job);
        this.watch();
        await this.sendJob(reply.job, command.request_id);
        return;
      }
      if (command.type === "CANCEL") {
        const id = command.payload.job_id;
        if (!this.source.has(id)) throw new Error("OWNER_DETACHED");
        if (this.remote.has(id)) {
          await this.options.account!.command({ action: "cancel", job_id: id });
          this.remote.delete(id);
        } else {
          const reply = await (
            await this.local()
          ).personal(
            {
              version: 1,
              requestId: command.request_id,
              action: "cancel",
              ownerId: this.ownerId,
              jobId: id,
            },
            "chrome",
          );
          if (!reply.ok) throw new Error(reply.error ?? "PROCESSING_FAILED");
          for (const job of reply.jobs ?? []) this.views.set(job.id, job);
        }
        await this.options.write({ ...base, type: "JOB", payload: null });
        return;
      }
      if (command.type === "STATUS") {
        if (Object.keys(command.payload).length) {
          if (
            !this.options.account ||
            !this.accountState?.selection.cache_reuse_supported
          )
            throw new Error("OWNER_DETACHED");
          const saved = command.payload as {
            video_id: string;
            duration_seconds: number;
            job_id: string;
          };
          const state = await this.options.account.command({
            action: "local_lookup",
            video_id: saved.video_id,
            duration_seconds: saved.duration_seconds,
            cache_only: true,
            restore_job_id: saved.job_id,
          });
          this.accountState = state;
          if (state.job) {
            this.source.set(state.job.job_id, {
              videoId: saved.video_id,
              requestId: command.request_id,
              duration: saved.duration_seconds,
              provider: "LOCAL_WINDOWS",
            });
            await this.sendRemote(state.job, command.request_id);
            return;
          }
          await this.options.write({ ...base, type: "JOB", payload: null });
          return;
        }
        if (this.options.account) {
          const state = await this.options.account.command({
            action: "status",
          });
          this.accountState = state;
          if (state.job && this.source.has(state.job.job_id)) {
            await this.sendRemote(state.job, command.request_id);
            return;
          }
        }
        if (this.session) {
          const reply = await this.session.personal(
            {
              version: 1,
              requestId: command.request_id,
              action: "jobs",
              ownerId: this.ownerId,
            },
            "chrome",
          );
          if (!reply.ok || !Array.isArray(reply.jobs))
            throw new Error(reply.error ?? "LOCAL_HOST_UNAVAILABLE");
          this.replace(reply.jobs);
          const job = [...this.views.values()].at(-1);
          if (job && this.source.has(job.id)) {
            await this.sendJob(job, command.request_id);
            return;
          }
        }
        await this.options.write({ ...base, type: "JOB", payload: null });
        return;
      }
      if (command.type === "PLAYBACK_STARTED") {
        const source = this.source.get(command.payload.job_id);
        if (
          !source ||
          source.videoId !== command.payload.video_id ||
          (!this.views.has(command.payload.job_id) &&
            !this.remote.has(command.payload.job_id))
        )
          throw new Error("OWNER_DETACHED");
        if (this.options.account && source.provider === "LOCAL_WINDOWS") {
          const state = await this.options.account.playbackStarted(
            command.payload.job_id,
            source.videoId,
            this.views.has(command.payload.job_id)
              ? await this.options.personalPeer?.()
              : undefined,
          );
          this.accountState = state;
          const personal = this.views.get(command.payload.job_id);
          if (personal) {
            await this.sendJob(personal, command.request_id);
            return;
          }
          if (state.job && state.job.job_id === command.payload.job_id) {
            await this.sendRemote(state.job, command.request_id);
            return;
          }
        }
        await this.options.write({ ...base, type: "JOB", payload: null });
        return;
      }
      if (command.type === "EVENT") {
        if (!this.options.account) throw new Error("DIAGNOSTICS_UNAVAILABLE");
        await this.options.account.command({
          action: "event",
          event: projectBrowserEvent(command.payload),
        });
        await this.options.write({ ...base, type: "JOB", payload: null });
        return;
      }
      throw new Error("OPEN_APP_REQUIRED");
    } catch (error) {
      const code = this.failure(error);
      await this.options.write(
        command.type === "HELLO"
          ? {
              ...base,
              type: "HELLO",
              payload: {
                ready: false,
                version: VERSION,
                platform: "win32",
                arch: "x64",
                max_duration_seconds: 1200,
                error_code: code,
                capabilities: [],
              },
            }
          : { ...base, type: "ERROR", payload: { error_code: code } },
      );
    }
  }
  private failure(error: unknown): string {
    const message =
      error instanceof Error &&
      /^[A-Za-z][A-Za-z0-9_]{1,63}$/u.test(error.message)
        ? error.message
        : "LOCAL_HOST_UNAVAILABLE";
    return [
      "PREPARE_REQUIRED",
      "SESSION_UNAVAILABLE",
      "SESSION_INTEGRITY_INVALID",
    ].includes(message)
      ? "LOCAL_INSTALL_REQUIRED"
      : message;
  }
  private replace(jobs: PersonalJobView[]): void {
    this.views.clear();
    for (const job of jobs) this.views.set(job.id, job);
    for (const [id] of this.source)
      if (!this.views.has(id) && !this.remote.has(id)) this.source.delete(id);
    for (const [id, grant] of this.grants)
      if (!this.current(id, grant.sha256)) {
        this.grants.delete(id);
        void grant.release().catch(() => {});
      }
  }
  private watchAccount(): void {
    if (
      !this.options.account ||
      !this.accountState ||
      this.accountWatcher ||
      this.closing
    )
      return;
    this.accountWatcher = (async () => {
      while (!this.closing) {
        const current = this.accountState!,
          state = await this.options.account!.wait(
            current.revision,
            current.instance_id,
          );
        if (this.closing) return;
        this.accountState = state;
        if (
          !state.unchanged &&
          state.installation_check &&
          this.checkRequest?.privateId === state.installation_check.request_id
        )
          await this.options.write({
            protocol_version: 1,
            request_id: this.checkRequest.publicId,
            type: "CHECK",
            payload: state.installation_check.status,
          });
        if (
          !state.unchanged &&
          current.job?.provider === "ONLINE_MUSICMUTE" &&
          !state.job
        ) {
          const source = this.source.get(current.job.job_id);
          if (source)
            await this.options.write({
              protocol_version: 1,
              request_id: source.requestId,
              type: "ERROR",
              payload: {
                error_code:
                  state.selection.processing_provider === "ONLINE_MUSICMUTE"
                    ? "ACCOUNT_CHANGED"
                    : "PROCESSING_SELECTION_CHANGED",
              },
            });
        }
        const publication = state.publication;
        if (!state.unchanged && publication) {
          const view = this.views.get(publication.job_id),
            source = this.source.get(publication.job_id);
          if (view && source?.videoId === publication.video_id)
            await this.sendJob(view, source.requestId);
        }
        if (!state.job) this.remote.clear();
        if (!state.unchanged && state.job) {
          const source = this.source.get(state.job.job_id);
          if (source) await this.sendRemote(state.job, source.requestId);
        }
      }
    })();
    void this.accountWatcher.catch(() => this.disconnect());
  }
  private disconnect(): void {
    if (!this.closing) {
      this.closing = true;
      this.options.onDisconnected();
      if (this.options.distribution === "microsoft-store")
        void this.close().catch(() => {});
      else void this.options.media.close().catch(() => {});
    }
  }
  private watch(): void {
    if (this.watcher || !this.session || this.closing) return;
    this.watcher = (async () => {
      let version = 0,
        instance: string | undefined;
      while (!this.closing) {
        const reply: PersonalReply = await this.session!.personal(
          {
            version: 1,
            requestId: randomUUID(),
            action: "wait_changes",
            ownerId: this.ownerId,
            afterVersion: version,
            ...(instance ? { instanceId: instance } : {}),
          },
          "chrome",
        );
        if (this.closing) return;
        if (
          !reply.ok ||
          !Number.isSafeInteger(reply.changeVersion) ||
          typeof reply.instanceId !== "string" ||
          !Array.isArray(reply.jobs)
        )
          throw new Error("LOCAL_HOST_UNAVAILABLE");
        if (reply.unchanged) continue;
        version = reply.changeVersion!;
        instance = reply.instanceId;
        this.replace(reply.jobs);
        for (const job of reply.jobs) {
          const source = this.source.get(job.id);
          if (source) await this.sendJob(job, source.requestId);
        }
      }
    })();
    void this.watcher.catch(() => this.disconnect());
  }
  private async sendRemote(
    snapshot: JobSnapshot,
    requestId: string,
  ): Promise<void> {
    const source = this.source.get(snapshot.job_id);
    if (
      !source ||
      snapshot.video_id !== source.videoId ||
      snapshot.provider !== source.provider ||
      (snapshot.media &&
        (snapshot.media.trim_enabled !== false ||
          Math.abs(snapshot.media.duration_seconds - source.duration) > 2))
    )
      throw new Error("TIMELINE_MISMATCH");
    for (const id of this.remote.keys())
      if (id !== snapshot.job_id) {
        this.remote.delete(id);
        this.source.delete(id);
      }
    this.remote.set(snapshot.job_id, structuredClone(snapshot));
    await this.options.write({
      protocol_version: 1,
      request_id: requestId,
      type: "JOB",
      payload: snapshot,
    });
  }
  private async sendJob(
    job: PersonalJobView,
    requestId: string,
  ): Promise<void> {
    const source = this.source.get(job.id);
    if (!source) return;
    const waitReason =
      job.state === "preparing" &&
      job.stage === "preparation" &&
      (job.waitReason === "waiting-for-worker" ||
        job.waitReason === "gpu-busy" ||
        job.waitReason === "recovering")
        ? job.waitReason
        : null;
    const state: JobSnapshot["state"] =
      job.state === "ready"
        ? "READY"
        : job.state === "failed"
          ? "FAILED"
          : job.state === "cancelled"
            ? "CANCELLED"
            : ["downloading", "metadata"].includes(job.stage)
              ? "DOWNLOADING"
              : job.stage === "output-validation"
                ? "VALIDATING"
                : "PROCESSING";
    const snapshot: JobSnapshot = {
      job_id: job.id,
      video_id: source.videoId,
      provider: "LOCAL_WINDOWS",
      state,
      stage: waitReason ?? job.stage,
      ...(!waitReason && job.progress !== null
        ? { completed: Math.round(job.progress * 100), total: 100 }
        : {}),
      ...(job.error ? { error_code: job.error } : {}),
      ...(this.accountState?.publication?.job_id === job.id
        ? { save_state: this.accountState.publication.state }
        : {}),
    };
    if (job.state === "ready" && job.vocals) {
      if (Math.abs(job.vocals.durationSeconds - source.duration) > 2)
        throw new Error("TIMELINE_MISMATCH");
      let grant = this.grants.get(job.id);
      if (!grant) {
        const issued = await this.options.media.issue(job);
        grant = { ...issued, sha256: job.vocals.sha256 };
        this.grants.set(job.id, grant);
      }
      snapshot.media = {
        url: grant.url,
        duration_seconds: job.vocals.durationSeconds,
        trim_enabled: false,
        model_id: MODEL.sha256,
      };
    }
    await this.options.write({
      protocol_version: 1,
      request_id: requestId,
      type: "JOB",
      payload: snapshot,
    });
  }
  close(): Promise<void> {
    if (this.options.distribution === "microsoft-store")
      return (this.storeClosing ??= this.closeStore());
    return this.closeLegacy();
  }
  private async closeStore(): Promise<void> {
    this.closed = true;
    this.closing = true;
    const failures: unknown[] = [];
    // A factory already in progress remains the original owner. Do not let it
    // publish a session after this service has stopped accepting commands.
    if (this.opening) {
      try {
        this.session = await this.opening;
      } catch (error) {
        failures.push(error);
      }
    }
    const intake = await Promise.allSettled([
      Promise.resolve().then(async () => {
        if (!this.session) return;
        const reply = await this.session.personal(
          {
            version: 1,
            requestId: randomUUID(),
            action: "detach",
            ownerId: this.ownerId,
          },
          "chrome",
        );
        if (!reply.ok) throw new Error("BROWSER_OWNER_RETIREMENT_UNCONFIRMED");
      }),
      Promise.resolve().then(() => this.options.account?.close()),
    ]);
    for (const result of intake)
      if (result.status === "rejected") failures.push(result.reason);
    const grants = [...this.grants.entries()];
    const resources = await Promise.allSettled([
      Promise.resolve().then(() => this.options.media.close()),
      ...grants.map(([, grant]) =>
        Promise.resolve().then(() => grant.release()),
      ),
    ]);
    for (const [index, result] of resources.entries()) {
      if (result.status === "rejected") failures.push(result.reason);
      else if (index > 0) this.grants.delete(grants[index - 1]![0]);
    }
    if (failures.length)
      throw new AggregateError(failures, "BROWSER_CLEANUP_UNCONFIRMED");
    this.remote.clear();
  }
  private async closeLegacy(): Promise<void> {
    if (this.closed) {
      await this.options.media.close();
      return;
    }
    this.closed = true;
    this.closing = true;
    try {
      await Promise.allSettled([
        this.session?.personal(
          {
            version: 1,
            requestId: randomUUID(),
            action: "detach",
            ownerId: this.ownerId,
          },
          "chrome",
        ),
        this.options.account?.close(),
      ]);
    } finally {
      await this.options.media.close();
      await Promise.allSettled(
        [...this.grants.values()].map((grant) => grant.release()),
      );
      this.grants.clear();
      this.remote.clear();
    }
  }
}
