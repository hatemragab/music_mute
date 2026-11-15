import type { DesktopSnapshot } from "../../shared/contracts.js";
import type {
  PersonalJobView,
  PersonalStage,
} from "../../shared/personal-contracts.js";
import type {
  DiagnosticSubsystem,
  WindowsDiagnosticEvent,
} from "../../shared/diagnostics-contracts.js";
import { diagnosticCode } from "./projection.js";

type Snapshot = Partial<DesktopSnapshot>;
type Event = WindowsDiagnosticEvent["event"];
export interface DiagnosticOwner {
  /** Private references are used only to fence observations, never serialized. */
  personal: object | null;
  personalOwnerId: string | null;
  accountGeneration: string | null;
  window: string;
}
interface Observation {
  state: PersonalJobView["state"];
  stage: PersonalStage;
  error: PersonalJobView["error"];
  at: number | null;
}
const phases: Record<PersonalStage, string> = {
  queued: "starting",
  metadata: "validation",
  downloading: "download",
  "input-validation": "validation",
  preparation: "preparing",
  "model-load": "preparing",
  separation: "separation",
  encoding: "encode",
  "output-validation": "validation",
};
function sameOwner(a: DiagnosticOwner, b: DiagnosticOwner): boolean {
  return (
    a.personal === b.personal &&
    a.personalOwnerId === b.personalOwnerId &&
    a.accountGeneration === b.accountGeneration &&
    a.window === b.window
  );
}
function safeReason(
  value: string | null | undefined,
  fallback: string,
): string {
  const code = diagnosticCode(value);
  return code === "UNKNOWN_ERROR" ? fallback : code;
}
/** Receives the same trusted snapshots Main publishes. No subscriptions, timers,
 * transport, user identifiers or model reads are created by this recorder. */
export class DesktopDiagnosticRecorder {
  private owner: DiagnosticOwner | null = null;
  private readonly jobs = new Map<string, Observation>();
  constructor(
    private readonly options: {
      owner(): DiagnosticOwner;
      record(input: unknown): Promise<unknown>;
      memory(): { rss: number; heapUsed: number };
      now?: () => number;
    },
  ) {}
  async receive(previous: Snapshot, patch: Snapshot): Promise<void> {
    const owner = this.options.owner();
    if (!this.owner || !sameOwner(this.owner, owner)) {
      this.jobs.clear();
      this.owner = owner;
    }
    const pending: Promise<unknown>[] = [];
    const record = (
      subsystem: DiagnosticSubsystem,
      code: string,
      event: Event,
      phase: string | null,
      metrics: Record<string, number | boolean> = {},
      job?: string,
    ) => {
      if (!sameOwner(owner, this.options.owner())) return;
      const memory = this.options.memory();
      try {
        pending.push(
          Promise.resolve(
            this.options.record({
              subsystem,
              code,
              event,
              phase,
              severity: event === "failed" ? "error" : "info",
              metrics: {
                ...metrics,
                rss_bytes: memory.rss,
                heap_used_bytes: memory.heapUsed,
              },
              ...(job ? { job } : {}),
            }),
          ),
        );
      } catch {
        /* A diagnostic sink cannot change consumer authority. */
      }
    };
    if (
      patch.backgroundSaveError &&
      patch.backgroundSaveError !== previous.backgroundSaveError
    )
      record(
        "lifecycle",
        safeReason(patch.backgroundSaveError, "OUTBOX_SAVE_FAILED"),
        "failed",
        "recovery",
      );
    if (
      patch.preparation &&
      (patch.preparation.state !== previous.preparation?.state ||
        patch.preparation.stage !== previous.preparation?.stage ||
        patch.preparation.errorCode !== previous.preparation?.errorCode)
    ) {
      const v = patch.preparation;
      record(
        "setup",
        v.errorCode || v.state === "error"
          ? safeReason(v.errorCode, "PREPARATION_FAILED")
          : "PREPARATION_STATE",
        v.state === "error"
          ? "failed"
          : v.state === "ready"
            ? "completed"
            : v.state === "cancelled"
              ? "cancelled"
              : "progress",
        v.state === "ready" ? "complete" : "preparing",
      );
    }
    if (
      patch.consumerUpdate &&
      (patch.consumerUpdate.phase !== previous.consumerUpdate?.phase ||
        patch.consumerUpdate.problem !== previous.consumerUpdate?.problem)
    ) {
      const v = patch.consumerUpdate;
      record(
        "update",
        v.problem
          ? safeReason(v.problem, "UPDATE_UNAVAILABLE")
          : "UPDATE_STATE",
        v.problem
          ? "failed"
          : v.phase === "complete"
            ? "completed"
            : "progress",
        v.phase === "rolled-back"
          ? "rollback"
          : v.phase === "complete"
            ? "complete"
            : "preparing",
      );
    }
    if (
      patch.accountDetails &&
      (patch.accountDetails.state !== previous.accountDetails?.state ||
        patch.accountDetails.online !== previous.accountDetails?.online ||
        patch.accountDetails.errorCode !== previous.accountDetails?.errorCode)
    ) {
      const v = patch.accountDetails;
      record(
        "account",
        v.errorCode
          ? safeReason(v.errorCode, "ACCOUNT_UNAVAILABLE")
          : "ACCOUNT_STATE",
        v.errorCode
          ? "failed"
          : v.state === "signed-in"
            ? "completed"
            : "progress",
        v.state === "restoring" ? "starting" : "validation",
        { online: v.online },
      );
    }
    if (
      patch.usage &&
      (patch.usage.connection !== previous.usage?.connection ||
        patch.usage.authenticated !== previous.usage?.authenticated ||
        patch.usage.errorCode !== previous.usage?.errorCode)
    ) {
      const v = patch.usage,
        disconnected = v.connection === "reconnecting" || !!v.errorCode;
      record(
        "account",
        disconnected
          ? safeReason(v.errorCode, "REALTIME_DISCONNECTED")
          : "REALTIME_STATE",
        disconnected
          ? "failed"
          : v.connection === "live"
            ? "completed"
            : "progress",
        v.connection === "reconnecting" ? "reconnect" : "refresh",
        { online: v.connection === "live" },
      );
    }
    if (
      patch.library &&
      (patch.library.state !== previous.library?.state ||
        patch.library.accountState !== previous.library?.accountState ||
        patch.library.errorCode !== previous.library?.errorCode)
    ) {
      const v = patch.library,
        failed =
          v.state === "error" ||
          v.accountState === "error" ||
          v.accountState === "disconnected" ||
          !!v.errorCode;
      record(
        "library",
        failed
          ? safeReason(v.errorCode, "LIBRARY_UNAVAILABLE")
          : "LIBRARY_STATE",
        failed ? "failed" : v.state === "ready" ? "completed" : "progress",
        "refresh",
        { online: v.accountState === "live" },
      );
    }
    if (
      patch.outbox &&
      (patch.outbox.busy !== previous.outbox?.busy ||
        patch.outbox.errorCode !== previous.outbox?.errorCode ||
        patch.outbox.items.filter((v) => v.state === "saved").length !==
          previous.outbox?.items.filter((v) => v.state === "saved").length ||
        patch.outbox.items.filter((v) => !!v.errorCode).length !==
          previous.outbox?.items.filter((v) => !!v.errorCode).length)
    ) {
      const v = patch.outbox,
        failed = !!v.errorCode || v.items.some((item) => !!item.errorCode);
      record(
        "library",
        failed ? safeReason(v.errorCode, "OUTBOX_SAVE_FAILED") : "OUTBOX_STATE",
        failed ? "failed" : v.busy ? "progress" : "completed",
        "publication",
        {
          completed: v.items.filter((item) => item.state === "saved").length,
          total: v.items.length,
        },
      );
    }
    if (
      patch.fleet &&
      (patch.fleet.state !== previous.fleet?.state ||
        patch.fleet.eligibility !== previous.fleet?.eligibility ||
        patch.fleet.errorCode !== previous.fleet?.errorCode)
    ) {
      const v = patch.fleet;
      record(
        "worker",
        v.errorCode || v.state === "unavailable"
          ? safeReason(v.errorCode, "FLEET_UNAVAILABLE")
          : v.state === "revoked"
            ? "FLEET_REVOKED"
            : "FLEET_STATE",
        v.errorCode || v.state === "unavailable" || v.state === "revoked"
          ? "failed"
          : "progress",
        "validation",
      );
    }
    if (patch.worker && patch.worker.state !== previous.worker?.state)
      record(
        "worker",
        patch.worker.state === "error" ? "FLEET_UNAVAILABLE" : "WORKER_STATE",
        patch.worker.state === "error" ? "failed" : "progress",
        patch.worker.state === "draining" ? "draining" : "validation",
      );
    if (
      patch.fleetAdvanced &&
      (patch.fleetAdvanced.phase !== previous.fleetAdvanced?.phase ||
        patch.fleetAdvanced.problem !== previous.fleetAdvanced?.problem)
    ) {
      const v = patch.fleetAdvanced;
      record(
        "worker",
        v.problem || v.phase === "error"
          ? safeReason(v.problem, "ADVANCED_OPERATION_FAILED")
          : "ADVANCED_STATE",
        v.problem || v.phase === "error"
          ? "failed"
          : v.phase === "complete"
            ? "completed"
            : "progress",
        v.phase === "recovery" ? "recovery" : "validation",
      );
    }
    if (patch.personal) {
      const visible = new Set(
        patch.personal.jobs.slice(-16).map((job) => job.id),
      );
      for (const id of this.jobs.keys())
        if (!visible.has(id)) this.jobs.delete(id);
      for (const job of patch.personal.jobs.slice(-16)) {
        if (
          !owner.personal ||
          job.ownerId !== owner.personalOwnerId ||
          !sameOwner(owner, this.options.owner())
        )
          continue;
        const before = this.jobs.get(job.id);
        if (
          before?.state === job.state &&
          before.stage === job.stage &&
          before.error === job.error
        )
          continue;
        const now = (this.options.now ?? (() => performance.now()))(),
          at = Number.isFinite(now) && now >= 0 ? now : null;
        if (
          before?.state === "preparing" &&
          before.at !== null &&
          at !== null
        ) {
          const duration = at - before.at;
          // A clock reset or an unobserved day-long interval is not a measured stage.
          if (duration >= 0 && duration <= 24 * 60 * 60 * 1000)
            record(
              "personal",
              "PERSONAL_STATE",
              "resource_sample",
              phases[before.stage],
              { duration_ms: Math.round(duration) },
              job.id,
            );
        }
        this.jobs.set(job.id, {
          state: job.state,
          stage: job.stage,
          error: job.error,
          at,
        });
        record(
          "personal",
          job.state === "cancelled"
            ? "CANCELLED"
            : job.error || job.state === "failed"
              ? safeReason(job.error, "PERSONAL_PROCESSING_FAILED")
              : "PERSONAL_STATE",
          job.state === "cancelled"
            ? "cancelled"
            : job.state === "failed"
              ? "failed"
              : job.state === "ready"
                ? "completed"
                : before
                  ? "progress"
                  : job.stage === "queued"
                    ? "started"
                    : "progress",
          job.state === "ready" ? "complete" : phases[job.stage],
          {
            active_jobs: patch.personal.jobs.filter(
              (v) => v.state === "preparing",
            ).length,
            ...(job.vocals
              ? {
                  output_bytes: job.vocals.bytes,
                  audio_duration_seconds: job.vocals.durationSeconds,
                }
              : {}),
          },
          job.id,
        );
      }
    }
    if (
      patch.playback?.error &&
      patch.playback.error !== previous.playback?.error
    )
      record(
        "player",
        safeReason(patch.playback.error, "PLAYBACK_FAILED"),
        "failed",
        "playback",
      );
    await Promise.allSettled(pending);
  }
}
