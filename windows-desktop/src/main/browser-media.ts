import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { fullTimeline } from "../../../chrome-extension/src/companion/cloud-provider.js";
import { MODEL } from "../../../chrome-extension/src/shared/local-model.js";
import { canonicalYouTubeUrl } from "../../../chrome-extension/src/shared/protocol.js";
import type { ConsumerProcessIdentity } from "../../../worker/src/platform/windows/consumer-native.js";
import type {
  BrowserCloudMediaPort,
  BrowserLocalReusePort,
} from "./browser/account-contracts.js";
import type { HostContext } from "./host-context.js";
import type { LibraryArtifactCache } from "./library/artifacts.js";
import type { LibraryPins } from "./library/pins.js";
import type { LibraryPlaybackPort } from "./library/playback.js";
import type { WindowsReuseController } from "./reuse/controller.js";
import { LibraryPlaybackSources } from "./player/library-sources.js";
import type { PlaybackSource } from "./player/controller.js";
import { ScopedMediaServer } from "./player/media-server.js";

type SourceOptions = ConstructorParameters<typeof LibraryPlaybackSources>[0];
/** Chrome media uses the same verified descriptor/pin path as desktop playback.
 * Cloud bytes need account grants and hashes, never the local processing runtime. */
export class WindowsBrowserMedia
  implements BrowserCloudMediaPort, BrowserLocalReusePort
{
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly grants = new Map<string, () => Promise<void>>();
  private readonly retained = new Set<() => Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private closing: Promise<void> | undefined;
  private closed = false;
  private readonly server: ScopedMediaServer;
  constructor(
    private readonly options: {
      host: HostContext;
      origin: string;
      cache: Pick<LibraryArtifactCache, "lookup" | "download">;
      pins: Pick<LibraryPins, "pin">;
      playback: LibraryPlaybackPort;
      reuse(): Pick<WindowsReuseController, "find" | "findCached"> | undefined;
      verifyPeer(peer: ConsumerProcessIdentity): Promise<boolean>;
      sourceFiles?: Pick<SourceOptions, "openFile" | "fingerprint">;
      server?: ScopedMediaServer;
    },
  ) {
    this.server = options.server ?? new ScopedMediaServer(options.origin);
  }
  start(): Promise<void> {
    return this.server.start();
  }
  activity(): {
    pending: number;
    grants: number;
    retained: number;
    idle: boolean;
  } {
    const server = this.server.activity();
    return {
      pending: this.pending.size + server.pending,
      grants: Math.max(this.grants.size, server.grants),
      retained: this.retained.size,
      idle:
        this.pending.size === 0 &&
        this.grants.size === 0 &&
        this.retained.size === 0 &&
        server.idle,
    };
  }
  subscribeActivity(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CANCELLED"));
    const pending = Promise.resolve().then(work);
    this.pending.add(pending);
    this.changed();
    const done = () => {
      this.pending.delete(pending);
      this.changed();
    };
    void pending.then(done, done);
    return pending;
  }
  private async check(
    peer: ConsumerProcessIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (this.closed || !(await this.options.verifyPeer(peer)))
      throw new Error("PEER_DENIED");
    signal.throwIfAborted();
  }
  private sources(
    ownerId: string,
    library: LibraryPlaybackPort,
  ): LibraryPlaybackSources {
    return new LibraryPlaybackSources({
      host: this.options.host,
      library,
      scope: () => null,
      server: { issue: (_owner, file) => this.server.issue(ownerId, file) },
      ...this.options.sourceFiles,
      onReleasePending: (retry) => {
        this.retained.add(retry);
        this.changed();
      },
    });
  }
  private issued(source: PlaybackSource, releaseOther?: () => Promise<void>) {
    if (
      source.trimmed ||
      !Number.isFinite(source.sourceDuration) ||
      source.sourceDuration <= 0 ||
      source.sourceDuration > 1200
    )
      throw new Error("TIMELINE_INCOMPATIBLE");
    const id = randomUUID();
    let closing: Promise<void> | undefined;
    let sourceReleased = false,
      otherReleased = !releaseOther;
    const release = () =>
      (closing ??= (async () => {
        if (!sourceReleased) {
          await source.release();
          sourceReleased = true;
        }
        if (!otherReleased) {
          await releaseOther!();
          otherReleased = true;
        }
        this.grants.delete(id);
        this.changed();
      })().finally(() => {
        closing = undefined;
      }));
    this.grants.set(id, release);
    this.changed();
    return {
      media: {
        url: source.url,
        duration_seconds: source.sourceDuration,
        trim_enabled: false as const,
        model_id: MODEL.sha256,
      },
      release,
    };
  }
  publish(
    input: Parameters<BrowserCloudMediaPort["publish"]>[0],
  ): ReturnType<BrowserCloudMediaPort["publish"]> {
    return this.track(async () => {
      const signal = AbortSignal.any([input.signal, this.abort.signal]),
        { job } = input;
      const current = async () => {
        input.assertCurrent();
        await this.check(input.peer, signal);
        input.assertCurrent();
      };
      await current();
      if (
        !fullTimeline(job) ||
        job.source_kind !== "url" ||
        job.source_url !== canonicalYouTubeUrl(input.videoId) ||
        !job.output ||
        job.output.content_type !== "audio/mpeg" ||
        (job.output.duration_seconds !== null &&
          Math.abs(job.output.duration_seconds - job.input.duration_seconds) >
            0.25) ||
        Math.abs(job.input.duration_seconds - input.durationSeconds) > 2
      )
        throw new Error("SOURCE_IDENTITY_MISMATCH");
      const cached =
        (await this.options.cache.lookup(job, input.scope, signal)) ??
        (await this.options.cache.download(
          job,
          input.grant,
          input.scope,
          signal,
        ));
      await current();
      if (
        cached.ownerUid !== input.scope.firebaseUid ||
        cached.jobId !== job.id ||
        cached.variant !== "voice" ||
        cached.bytes !== job.output.bytes ||
        cached.sha256 !==
          Buffer.from(job.output.sha256, "base64").toString("hex") ||
        cached.contentType !== "audio/mpeg" ||
        Math.abs(cached.durationSeconds - job.input.duration_seconds) > 0.25
      )
        throw new Error("SOURCE_IDENTITY_MISMATCH");
      const artifact = {
        artifactId: cached.artifactId,
        relativePath: cached.relativePath,
        bytes: cached.bytes,
        sha256: cached.sha256,
        mime: "audio/mpeg" as const,
        durationSeconds: cached.durationSeconds,
      };
      const sources = this.sources(input.ownerId, {
        pin: async () => this.options.pins.pin(artifact, "playback"),
        resolvePlayback: async () => ({
          ...artifact,
          path: win32.join(this.options.host.personalRoot, cached.relativePath),
          originalDuration: job.input.duration_seconds,
          voiceDuration: cached.durationSeconds,
          sourceDuration: cached.durationSeconds,
          trimEnabled: false,
          accountOwned: true,
          title: "",
          thumbnailUrl: null,
          current,
        }),
      });
      const source = await sources.open(job.id, "voice", signal);
      try {
        await current();
        return this.issued(source);
      } catch (error) {
        await source.release();
        throw error;
      }
    });
  }
  find(
    input: Parameters<BrowserLocalReusePort["find"]>[0],
  ): ReturnType<BrowserLocalReusePort["find"]> {
    return this.track(async () => {
      const signal = AbortSignal.any([input.signal, this.abort.signal]);
      await this.check(input.peer, signal);
      const reuse = this.options.reuse();
      if (!reuse) return null;
      const request = {
          requestId: input.requestId,
          ownerId: input.ownerId,
          videoId: input.videoId,
          durationSeconds: input.durationSeconds,
          scope: null,
        },
        hit = await (input.cacheOnly
          ? reuse.findCached(request, signal)
          : reuse.find(request, signal));
      if (!hit) return null;
      let source: PlaybackSource | undefined;
      try {
        await this.check(input.peer, signal);
        source = await this.sources(input.ownerId, {
          pin: (id, variant) => this.options.playback.pin(id, variant, null),
          resolvePlayback: async (id, variant, _scope, sourceSignal) => {
            const artifact = await this.options.playback.resolvePlayback(
              id,
              variant,
              null,
              sourceSignal,
            );
            if (artifact.accountOwned) throw new Error("PEER_DENIED");
            return {
              ...artifact,
              current: async () => {
                await this.check(input.peer, signal);
                await artifact.current();
              },
            };
          },
        }).open(hit.trackId, "voice", signal);
        await this.check(input.peer, signal);
        if (Math.abs(source.sourceDuration - input.durationSeconds) > 0.25)
          throw new Error("TIMELINE_MISMATCH");
        return this.issued(source, hit.release);
      } catch (error) {
        try {
          await source?.release();
        } finally {
          await hit.release();
        }
        throw error;
      }
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort.abort();
    this.changed();
    return (this.closing = (async () => {
      await Promise.allSettled(this.pending);
      const releases = await Promise.allSettled(
        [...this.grants.values()].map((release) => release()),
      );
      const unissued = await Promise.allSettled(
        [...this.retained].map(async (retry) => {
          await retry();
          this.retained.delete(retry);
          this.changed();
        }),
      );
      await this.server.close();
      if (
        [...releases, ...unissued].some(
          (result) => result.status === "rejected",
        )
      )
        throw new Error("MEDIA_RELEASE_PENDING");
      if (!this.activity().idle) throw new Error("MEDIA_RELEASE_PENDING");
      this.changed();
      this.listeners.clear();
    })().finally(() => {
      this.closing = undefined;
    }));
  }
}
