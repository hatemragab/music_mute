import { canonicalYouTubeUrl } from "../../../../chrome-extension/src/shared/protocol.js";
import {
  fullTimeline,
  type JobMetadata,
} from "../../../../chrome-extension/src/companion/cloud-provider.js";
import { DesktopApiError } from "../../../../chrome-extension/src/companion/account-api.js";
import type {
  CommunityDelivery,
  YouTubeCommunityClient,
} from "../../../../chrome-extension/src/companion/youtube-community-client.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import { PERSONAL_UUID } from "../../shared/personal-contracts.js";
import type {
  ReuseView,
  ReuseSourceIdentity,
} from "../../shared/reuse-contracts.js";
import type { LibraryStore } from "../library/store.js";
import { localTrackId, type LocalLibraryEntry } from "../library/model.js";
import type {
  LibraryArtifactCache,
  TrustedLibraryArtifact,
} from "../library/artifacts.js";
import type { LibraryPins } from "../library/pins.js";
import type { VerifiedPersonalPair } from "./pair.js";
export interface ReuseRequest {
  requestId: string;
  ownerId: string;
  videoId: string;
  durationSeconds?: number;
  sourceIdentity?: ReuseSourceIdentity;
  scope: SessionAccountScope | null;
  cacheOnly?: boolean;
}
export interface VerifiedReuse {
  origin: "local" | "account" | "community";
  trackId: string;
  provenance: "trusted" | "community_contributed" | null;
  release(): Promise<void>;
}
export interface ReuseOptions {
  store: Pick<LibraryStore, "snapshot">;
  cache: Pick<LibraryArtifactCache, "local" | "lookup" | "verify">;
  pins: Pick<LibraryPins, "pin">;
  current(scope: SessionAccountScope | null): boolean;
  pair(
    entry: LocalLibraryEntry,
    signal: AbortSignal,
  ): Promise<VerifiedPersonalPair>;
  account: {
    restore(
      job: JobMetadata,
      scope: SessionAccountScope,
      signal: AbortSignal,
    ): Promise<TrustedLibraryArtifact>;
  };
  community?: Pick<YouTubeCommunityClient, "lookup">;
  adopt(
    delivery: CommunityDelivery,
    signal: AbortSignal,
    assertCurrent: () => void,
  ): Promise<VerifiedPersonalPair>;
  onCommunityReady?(
    entry: LocalLibraryEntry,
    scope: SessionAccountScope | null,
  ): Promise<void>;
}
function unavailable(error: unknown): boolean {
  return (
    (error instanceof Error &&
      [
        "GUEST_CREDENTIALS_UNAVAILABLE",
        "ACCOUNT_NOT_CONFIGURED",
        "COMMUNITY_SESSION_UNAVAILABLE",
      ].includes(error.message)) ||
    (error instanceof DesktopApiError &&
      ([401, 403, 404, 408, 429].includes(error.status) ||
        error.status >= 500 ||
        [
          "COMMUNITY_UNAVAILABLE",
          "COMMUNITY_SESSION_UNAVAILABLE",
          "API_UNAVAILABLE",
          "REALTIME_UNAVAILABLE",
        ].includes(error.code)))
  );
}
interface SharedReuseLookup {
  promise: Promise<VerifiedReuse | null>;
  abort: AbortController;
  waiters: number;
  settled: boolean;
  anchor: VerifiedReuse | null;
}
export class WindowsReuseController {
  private generation = 0;
  private lifetime = new AbortController();
  private readonly guestLifetime = new AbortController();
  private readonly active = new Map<string, SharedReuseLookup>();
  private readonly accountRequests = new Set<string>();
  private readonly retainers = new WeakMap<
    VerifiedReuse,
    () => VerifiedReuse
  >();
  private readonly leased = new Map<() => Promise<void>, boolean>();
  private readonly pending = new Set<Promise<unknown>>();
  private disposed = false;
  private closing: Promise<void> | undefined;
  private value: ReuseView = {
    state: "idle",
    origin: null,
    reason: null,
    requestId: null,
    trackId: null,
    provenance: null,
  };
  private listeners = new Set<(view: ReuseView) => void>();
  constructor(private readonly options: ReuseOptions) {}
  view(): ReuseView {
    return structuredClone(this.value);
  }
  subscribe(listener: (view: ReuseView) => void) {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(patch: Partial<ReuseView>) {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {}
    }
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  invalidateOwner() {
    this.generation++;
    this.lifetime.abort();
    this.lifetime = new AbortController();
    for (const key of this.accountRequests) this.active.delete(key);
    this.accountRequests.clear();
    for (const [release, accountOwned] of this.leased)
      if (accountOwned) this.track(release());
    this.publish({
      state: "idle",
      origin: null,
      reason: null,
      requestId: null,
      trackId: null,
      provenance: null,
    });
  }
  find(
    input: ReuseRequest,
    signal: AbortSignal,
  ): Promise<VerifiedReuse | null> {
    if (this.disposed) return Promise.reject(new Error("REUSE_OWNER_CHANGED"));
    if (signal.aborted) return Promise.reject(signal.reason);
    if (
      !PERSONAL_UUID.test(input.requestId) ||
      !PERSONAL_UUID.test(input.ownerId) ||
      !/^[A-Za-z0-9_-]{11}$/.test(input.videoId) ||
      (input.cacheOnly !== undefined && typeof input.cacheOnly !== "boolean") ||
      (input.durationSeconds !== undefined &&
        (!Number.isFinite(input.durationSeconds) ||
          input.durationSeconds <= 0 ||
          input.durationSeconds > 1200))
    )
      return Promise.reject(new Error("REUSE_REQUEST_INVALID"));
    const generation = this.generation,
      request = structuredClone(input),
      key = JSON.stringify([
        request.ownerId,
        request.videoId,
        request.durationSeconds,
        request.sourceIdentity,
        request.scope,
        request.cacheOnly === true,
      ]),
      existing = this.active.get(key);
    if (existing?.abort.signal.aborted)
      return Promise.reject(new Error("REUSE_SHUTDOWN_PENDING"));
    if (existing) return this.join(existing, request, generation, signal);
    const abort = new AbortController();
    const combined = AbortSignal.any([
      abort.signal,
      request.scope === null ? this.guestLifetime.signal : this.lifetime.signal,
      AbortSignal.timeout(5 * 60000),
    ]);
    const check = () => {
      combined.throwIfAborted();
      if (
        this.disposed ||
        (request.scope !== null && generation !== this.generation) ||
        !this.options.current(request.scope)
      )
        throw new Error("ACCOUNT_CHANGED");
    };
    const lookup: SharedReuseLookup = {
      promise: Promise.resolve(null),
      abort,
      waiters: 0,
      settled: false,
      anchor: null,
    };
    lookup.promise = this.track(
      this.run(request, combined, check)
        .then(async (result) => {
          lookup.settled = true;
          // A shared anchor protects the verified pair while individual waiting
          // callers retain or cancel. One cancellation cannot release a peer's
          // not-yet-delivered reference.
          lookup.anchor = result ? this.retainers.get(result)!() : null;
          if (!lookup.waiters) await this.releaseAnchor(lookup);
          return result;
        })
        .finally(() => {
          if (this.active.get(key) === lookup) {
            this.active.delete(key);
            this.accountRequests.delete(key);
          }
        }),
    );
    this.active.set(key, lookup);
    if (request.scope !== null) this.accountRequests.add(key);
    return this.join(lookup, request, generation, signal);
  }
  private async releaseAnchor(lookup: SharedReuseLookup): Promise<void> {
    const anchor = lookup.anchor;
    lookup.anchor = null;
    await anchor?.release();
  }
  private join(
    lookup: SharedReuseLookup,
    request: ReuseRequest,
    generation: number,
    signal: AbortSignal,
  ): Promise<VerifiedReuse | null> {
    lookup.waiters++;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    return this.track(
      (async () => {
        try {
          const result = await Promise.race([lookup.promise, cancelled]);
          signal.throwIfAborted();
          if (
            this.disposed ||
            (request.scope !== null && generation !== this.generation) ||
            !this.options.current(request.scope)
          )
            throw new Error("REUSE_OWNER_CHANGED");
          return result ? this.retainers.get(result)!() : null;
        } finally {
          signal.removeEventListener("abort", cancel);
          if (--lookup.waiters === 0) {
            if (!lookup.settled) {
              lookup.abort.abort();
              // Keep the outer command/browser authority busy until its last
              // admitted lookup has actually stopped. The active key remains
              // fenced rather than admitting a replacement decoder on abort.
              await lookup.promise.catch(() => {});
            }
            await this.releaseAnchor(lookup);
          }
        }
      })(),
    );
  }
  private async run(
    request: ReuseRequest,
    signal: AbortSignal,
    check: () => void,
  ): Promise<VerifiedReuse | null> {
    check();
    this.publish({
      state: "looking-up",
      origin: null,
      reason: null,
      requestId: request.requestId,
      trackId: null,
      provenance: null,
    });
    const pins: Awaited<ReturnType<LibraryPins["pin"]>>[] = [];
    const pin = async (artifact: TrustedLibraryArtifact) => {
      const receipt = await this.options.pins.pin(artifact, "playback");
      pins.push(receipt);
      if (
        receipt.artifactId !== artifact.artifactId ||
        receipt.relativePath !== artifact.relativePath ||
        receipt.sha256 !== artifact.sha256
      )
        throw new Error("REUSE_PIN_INVALID");
      await this.options.cache.verify(artifact, signal);
      check();
    };
    const hit = (
      origin: VerifiedReuse["origin"],
      trackId: string,
      provenance: VerifiedReuse["provenance"],
    ): VerifiedReuse => {
      this.publish({ state: "hit", origin, trackId, provenance, reason: null });
      let released = false,
        references = 0;
      const release = async () => {
        if (released) return;
        released = true;
        this.leased.delete(release);
        await Promise.allSettled(pins.map((p) => p.release()));
      };
      this.leased.set(release, request.scope !== null);
      const result = {
        origin,
        trackId,
        provenance,
        release,
      };
      this.retainers.set(result, () => {
        if (released) throw new Error("REUSE_OWNER_CHANGED");
        references++;
        let closed = false;
        return {
          ...result,
          release: async () => {
            if (closed) return;
            closed = true;
            if (--references === 0) await release();
          },
        };
      });
      return result;
    };
    try {
      const snapshot = await this.options.store.snapshot(request.scope);
      check();
      for (const entry of snapshot.guest.entries) {
        if (
          entry.catalog.video_id !== request.videoId ||
          entry.catalog.trim_enabled ||
          (request.durationSeconds !== undefined &&
            Math.abs(entry.original.durationSeconds - request.durationSeconds) >
              0.25)
        )
          continue;
        const pair = await this.options.pair(entry, signal);
        check();
        const proof = pair.reuse;
        if (
          !proof ||
          proof.source.kind === "file" ||
          proof.source.videoId !== request.videoId ||
          proof.vocalsSha256 !== entry.vocals.sha256 ||
          proof.originalSha256 !== entry.original.sha256
        )
          continue;
        if (
          request.sourceIdentity &&
          JSON.stringify(proof.source) !==
            JSON.stringify(request.sourceIdentity)
        )
          continue;
        await pin(
          await this.options.cache.local(
            entry.personalJobId,
            entry.vocals,
            "voice",
          ),
        );
        await pin(
          await this.options.cache.local(
            entry.personalJobId,
            entry.original,
            "original",
          ),
        );
        return hit(
          "local",
          localTrackId(entry),
          proof.source.kind === "community-youtube"
            ? proof.source.provenance
            : "trusted",
        );
      }
      if (request.scope) {
        for (const { metadata: job } of snapshot.account.jobs) {
          if (
            job.status !== "ready" ||
            !job.can_download_output ||
            !job.output ||
            job.output.duration_seconds === null ||
            job.source_url !== canonicalYouTubeUrl(request.videoId) ||
            job.source_kind !== "url" ||
            !fullTimeline(job) ||
            (request.durationSeconds !== undefined &&
              Math.abs(job.input.duration_seconds - request.durationSeconds) >
                0.25)
          )
            continue;
          try {
            let artifact: TrustedLibraryArtifact;
            if (request.cacheOnly) {
              const cached = await this.options.cache.lookup(
                job,
                request.scope,
                signal,
              );
              if (!cached) continue;
              artifact = {
                artifactId: cached.artifactId,
                relativePath: cached.relativePath,
                bytes: cached.bytes,
                sha256: cached.sha256,
                mime: cached.contentType,
                durationSeconds: cached.durationSeconds,
              };
            } else
              artifact = await this.options.account.restore(
                job,
                request.scope,
                signal,
              );
            check();
            if (
              artifact.bytes !== job.output.bytes ||
              artifact.sha256 !==
                Buffer.from(job.output.sha256, "base64").toString("hex")
            )
              throw new Error("SOURCE_IDENTITY_MISMATCH");
            await pin(artifact);
            return hit("account", job.id, "trusted");
          } catch (error) {
            check();
            if (!unavailable(error)) throw error;
          }
        }
      }
      if (request.cacheOnly) {
        this.publish({ state: "miss", reason: "CACHE_MISS" });
        return null;
      }
      if (!this.options.community) {
        this.publish({ state: "miss", reason: "OPTIONAL_SERVICE_UNAVAILABLE" });
        return null;
      }
      let delivery: CommunityDelivery | null;
      try {
        delivery = await this.options.community.lookup(
          request.videoId,
          request.durationSeconds,
          signal,
        );
        check();
      } catch (error) {
        check();
        if (!unavailable(error)) throw error;
        this.publish({ state: "miss", reason: "OPTIONAL_SERVICE_UNAVAILABLE" });
        return null;
      }
      if (!delivery) {
        this.publish({ state: "miss", reason: "CACHE_MISS" });
        return null;
      }
      const pair = await this.options.adopt(delivery, signal, check);
      check();
      if (
        pair.reuse?.source.kind !== "community-youtube" ||
        pair.reuse.source.videoId !== request.videoId ||
        pair.reuse.source.provenance !== delivery.provenance ||
        pair.reuse.source.sourceIdentityVerified !==
          delivery.source_identity_verified
      )
        throw new Error("SOURCE_IDENTITY_MISMATCH");
      await pin(
        await this.options.cache.local(
          pair.entry.personalJobId,
          pair.entry.vocals,
          "voice",
        ),
      );
      await pin(
        await this.options.cache.local(
          pair.entry.personalJobId,
          pair.entry.original,
          "original",
        ),
      );
      await this.options
        .onCommunityReady?.(pair.entry, request.scope)
        .catch(() => {});
      check();
      return hit("community", localTrackId(pair.entry), delivery.provenance);
    } catch (error) {
      await Promise.allSettled(pins.map((p) => p.release()));
      try {
        check();
        this.publish({
          state: "failed",
          reason:
            error instanceof Error && /^[A-Z_]{3,64}$/.test(error.message)
              ? error.message
              : "REUSE_FAILED",
        });
      } catch {}
      throw error;
    }
  }
  findCached(
    input: ReuseRequest,
    signal: AbortSignal,
  ): Promise<VerifiedReuse | null> {
    return this.find({ ...input, cacheOnly: true }, signal);
  }
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.invalidateOwner();
    this.lifetime.abort();
    this.guestLifetime.abort();
    for (const release of this.leased.keys()) this.track(release());
    this.listeners.clear();
    this.closing = (async () => {
      while (this.pending.size) await Promise.allSettled(this.pending);
    })();
    return this.closing;
  }
}
