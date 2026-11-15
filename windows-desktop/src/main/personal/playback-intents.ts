import type { PersonalJobView } from "../../shared/personal-contracts.js";
import type { PersonalPlaybackPreparation } from "../../shared/personal-playback-contracts.js";
import {
  PERSONAL_UUID,
  parsePersonalScope,
} from "../../shared/personal-contracts.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import type { VerifiedPersonalPair } from "../reuse/pair.js";
import { parseCompletionReceipt } from "../reuse/receipts.js";
import { localTrackId } from "../library/model.js";

export interface PersonalPlaybackIntent {
  requestId: string;
  ownerId: string;
  scope: SessionAccountScope | null;
}
export interface PersonalPlaybackContext {
  windowCurrent: boolean;
  scope: SessionAccountScope | null;
  playbackEpoch: number;
}
export interface PersonalPlaybackSelection {
  trackId: string;
  jobId: string;
  ownerId: string;
  requestId: string;
  vocalsSha256: string;
}
interface Intent extends PersonalPlaybackIntent {
  epoch: number;
  jobId?: string;
}
const sameScope = (
  a: SessionAccountScope | null,
  b: SessionAccountScope | null,
) => a?.firebaseUid === b?.firebaseUid && a?.generation === b?.generation;
const SHA = /^[a-f0-9]{64}$/u;

/** Transient desktop intent, never restored from result folders or account history. */
export class PersonalPlaybackIntents {
  private readonly pending = new Map<string, Intent>();
  private readonly retired = new Set<string>();
  private readonly listeners = new Set<
    (value: PersonalPlaybackPreparation | null) => void
  >();
  constructor(
    private readonly options: {
      installationId: string;
      context(): PersonalPlaybackContext;
      job(jobId: string): PersonalJobView | undefined;
    },
  ) {
    if (!PERSONAL_UUID.test(options.installationId))
      throw new Error("PERSONAL_PLAYBACK_INTENT_INVALID");
  }
  private context(): PersonalPlaybackContext {
    const value = this.options.context();
    if (
      !value ||
      typeof value.windowCurrent !== "boolean" ||
      !Number.isSafeInteger(value.playbackEpoch) ||
      value.playbackEpoch < 0
    )
      throw new Error("PERSONAL_PLAYBACK_INTENT_INVALID");
    return { ...value, scope: parsePersonalScope(value.scope) };
  }
  view(): PersonalPlaybackPreparation | null {
    const intent = [...this.pending.values()]
      .reverse()
      .find((value) => this.current(value));
    return intent
      ? { requestId: intent.requestId, jobId: intent.jobId ?? null }
      : null;
  }
  subscribe(
    listener: (value: PersonalPlaybackPreparation | null) => void,
  ): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    const value = this.view();
    for (const listener of this.listeners) {
      try {
        listener(value ? { ...value } : null);
      } catch {}
    }
  }
  created(value: PersonalPlaybackIntent): void {
    if (
      !value ||
      !PERSONAL_UUID.test(value.requestId) ||
      !PERSONAL_UUID.test(value.ownerId) ||
      this.pending.has(value.requestId) ||
      this.retired.has(value.requestId)
    )
      throw new Error("PERSONAL_PLAYBACK_INTENT_INVALID");
    const scope = parsePersonalScope(value.scope),
      current = this.context();
    for (const [id, intent] of this.pending) {
      if (
        intent.epoch !== current.playbackEpoch ||
        !sameScope(intent.scope, current.scope)
      )
        this.retire(id);
    }
    if (!current.windowCurrent || !sameScope(scope, current.scope)) {
      this.rememberRetired(value.requestId);
      return;
    }
    if (this.pending.size >= 16)
      throw new Error("PERSONAL_PLAYBACK_INTENT_LIMIT");
    this.pending.set(value.requestId, {
      requestId: value.requestId,
      ownerId: value.ownerId,
      scope,
      epoch: current.playbackEpoch,
    });
    this.changed();
  }
  accepted(requestId: string, job: PersonalJobView): void {
    const intent = this.pending.get(requestId);
    if (!intent) return;
    if (
      !job ||
      !PERSONAL_UUID.test(job.id) ||
      job.ownerId !== intent.ownerId ||
      (intent.jobId && intent.jobId !== job.id)
    )
      throw new Error("PERSONAL_PLAYBACK_INTENT_INVALID");
    if (job.state === "failed" || job.state === "cancelled") {
      this.retire(requestId);
      return;
    }
    intent.jobId = job.id;
    this.changed();
  }
  private rememberRetired(requestId: string): void {
    this.retired.add(requestId);
    if (this.retired.size > 32)
      this.retired.delete(this.retired.values().next().value!);
  }
  retire(requestId: string): void {
    if (!PERSONAL_UUID.test(requestId))
      throw new Error("PERSONAL_PLAYBACK_INTENT_INVALID");
    this.pending.delete(requestId);
    this.rememberRetired(requestId);
    this.changed();
  }
  cancelJob(jobId: string): void {
    if (!PERSONAL_UUID.test(jobId))
      throw new Error("PERSONAL_PLAYBACK_INTENT_INVALID");
    for (const [id, intent] of this.pending)
      if (intent.jobId === jobId) this.retire(id);
  }
  retireOwner(ownerId: string): void {
    if (!PERSONAL_UUID.test(ownerId))
      throw new Error("PERSONAL_PLAYBACK_INTENT_INVALID");
    for (const [id, intent] of this.pending)
      if (intent.ownerId === ownerId) this.retire(id);
  }
  invalidate(): void {
    for (const id of this.pending.keys()) this.retire(id);
  }
  private current(intent: Intent): boolean {
    const context = this.context();
    return (
      context.windowCurrent &&
      context.playbackEpoch === intent.epoch &&
      sameScope(context.scope, intent.scope)
    );
  }
  /** Intentional pre-acquisition reuse consumes the same command intent as fresh processing. */
  consumeReuse(requestId: string): boolean {
    const intent = this.pending.get(requestId);
    if (!intent || intent.jobId) return false;
    if (!this.current(intent)) {
      this.retire(requestId);
      return false;
    }
    this.retire(requestId);
    return true;
  }
  /** Caller supplies only the existing pinned, full-hashed onVerifiedPair result. */
  consume(pair: VerifiedPersonalPair): PersonalPlaybackSelection | null {
    const receipt = pair.completion;
    if (!receipt) return null;
    const intent = this.pending.get(receipt.requestId);
    if (!intent || !intent.jobId) return null;
    if (!this.current(intent)) {
      this.retire(intent.requestId);
      return null;
    }
    let completion;
    try {
      completion = parseCompletionReceipt(receipt, {
        installationId: this.options.installationId,
        jobId: pair.entry.personalJobId,
        originalSha256: pair.entry.original.sha256,
        vocalsSha256: pair.entry.vocals.sha256,
      });
    } catch {
      return null;
    }
    const job = this.options.job(intent.jobId);
    if (
      completion.ownerId !== intent.ownerId ||
      completion.jobId !== intent.jobId ||
      pair.view.id !== intent.jobId ||
      pair.view.ownerId !== intent.ownerId ||
      !sameScope(completion.capturedAccountScope, intent.scope) ||
      !job ||
      job.ownerId !== intent.ownerId ||
      job.id !== intent.jobId ||
      job.state !== "ready" ||
      !job.original ||
      !job.vocals ||
      !SHA.test(job.original.sha256) ||
      !SHA.test(job.vocals.sha256) ||
      job.original.sha256 !== completion.originalSha256 ||
      job.vocals.sha256 !== completion.vocalsSha256 ||
      pair.view.original?.sha256 !== completion.originalSha256 ||
      pair.view.vocals?.sha256 !== completion.vocalsSha256
    )
      return null;
    this.retire(intent.requestId);
    return {
      trackId: localTrackId(pair.entry),
      jobId: intent.jobId,
      ownerId: intent.ownerId,
      requestId: intent.requestId,
      vocalsSha256: completion.vocalsSha256,
    };
  }
}
