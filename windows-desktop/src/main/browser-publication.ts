import type { BrowserPublicationPort } from "./browser/account-contracts.js";
import type { PersonalPlaybackOwnerProof } from "./session/personal-owner-proof.js";
import { parsePersonalOwnerProof } from "./session/personal-owner-proof.js";
import type { VerifiedPersonalPair } from "./reuse/pair.js";
import type {
  WindowsCommunityPublisher,
  PublicationStatus,
} from "./reuse/publication.js";

type PublicationInput = Parameters<
  BrowserPublicationPort["playbackStarted"]
>[0];
type PublicationUpdate = Parameters<
  Parameters<BrowserPublicationPort["subscribe"]>[0]
>[0];
function state(
  snapshot: PublicationStatus | null,
): "pending" | "saving" | "saved" | null {
  if (!snapshot || snapshot.state === "discarded") return null;
  if (snapshot.state === "committed") return "saved";
  return snapshot.ready && snapshot.declared && !snapshot.errorCode
    ? "saving"
    : "pending";
}
export function assertPublicationPair(
  pair: VerifiedPersonalPair,
  proof: PersonalPlaybackOwnerProof,
): void {
  if (
    !pair.completion ||
    pair.completion.ownerId !== proof.owner_id ||
    pair.entry.personalJobId !== proof.job_id ||
    pair.reuse?.source.kind !== "youtube" ||
    pair.reuse.source.videoId !== proof.video_id ||
    pair.entry.catalog.trim_enabled ||
    pair.entry.vocals.id !== proof.vocals.artifact_id ||
    pair.entry.vocals.sha256 !== proof.vocals.sha256 ||
    pair.entry.vocals.bytes !== proof.vocals.bytes ||
    pair.entry.vocals.contentType !== proof.vocals.content_type ||
    Math.abs(
      pair.entry.vocals.durationSeconds - proof.vocals.duration_seconds,
    ) > 0.001
  )
    throw new Error("PEER_DENIED");
}
/** A contribution is released only by an exact live owner proof after voice playback.
 * Cache hits do not enter this fresh producer path. */
export class WindowsBrowserPublication implements BrowserPublicationPort {
  private readonly listeners = new Set<(update: PublicationUpdate) => void>();
  private readonly authorized = new Map<
    string,
    { ownerId: string; jobId: string; videoId: string }
  >();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly abort = new AbortController();
  private readonly stop: () => void;
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(
    private readonly options: {
      publisher: Pick<
        WindowsCommunityPublisher,
        "stage" | "releasePlayback" | "drain" | "snapshot" | "subscribe"
      >;
      pair(jobId: string, signal: AbortSignal): Promise<VerifiedPersonalPair>;
    },
  ) {
    this.stop = options.publisher.subscribe((jobId) => {
      if ([...this.authorized.values()].some((row) => row.jobId === jobId))
        void this.track(() => this.changed(jobId)).catch(() => {});
    });
  }
  subscribe(listener: (update: PublicationUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CANCELLED"));
    const promise = Promise.resolve().then(work);
    this.pending.add(promise);
    const done = () => {
      this.pending.delete(promise);
    };
    void promise.then(done, done);
    return promise;
  }
  private async changed(jobId: string): Promise<void> {
    const next = state(await this.options.publisher.snapshot(jobId));
    if (!next || this.closed) return;
    for (const row of this.authorized.values()) {
      if (row.jobId !== jobId) continue;
      for (const listener of this.listeners) {
        try {
          listener({ ...row, state: next });
        } catch {}
      }
    }
  }
  playbackStarted(
    input: PublicationInput,
  ): ReturnType<BrowserPublicationPort["playbackStarted"]> {
    return this.track(async () => {
      const proof = parsePersonalOwnerProof(input.proof, {
          ...input,
          ownerKind: "chrome",
        }),
        pair = await this.options.pair(input.jobId, this.abort.signal);
      this.abort.signal.throwIfAborted();
      if (pair.reuse?.source.kind === "community-youtube") return null;
      assertPublicationPair(pair, proof);
      if (this.authorized.size >= 64 && !this.authorized.has(input.ownerId))
        throw new Error("ACCOUNT_SESSION_UNAVAILABLE");
      this.authorized.set(input.ownerId, {
        ownerId: input.ownerId,
        jobId: input.jobId,
        videoId: input.videoId,
      });
      const record = await this.options.publisher.stage(input.jobId, true);
      if (
        record.jobId !== input.jobId ||
        record.videoId !== input.videoId ||
        record.vocalsSha256 !== proof.vocals.sha256 ||
        record.vocalsBytes !== proof.vocals.bytes ||
        record.originalSha256 !== pair.entry.original.sha256 ||
        record.originalBytes !== pair.entry.original.bytes
      )
        throw new Error("PEER_DENIED");
      const current = await this.options.pair(input.jobId, this.abort.signal);
      assertPublicationPair(current, proof);
      this.abort.signal.throwIfAborted();
      await this.options.publisher.releasePlayback(
        input.jobId,
        proof.vocals.sha256,
      );
      void this.options.publisher.drain().catch(() => {});
      return state(await this.options.publisher.snapshot(input.jobId));
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort.abort();
    this.stop();
    return (this.closing = (async () => {
      while (this.pending.size) await Promise.allSettled(this.pending);
      this.authorized.clear();
      this.listeners.clear();
    })());
  }
}
