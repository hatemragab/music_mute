import { createHash, randomUUID } from "node:crypto";
import {
  parsePlaybackCommand,
  type PlaybackCommand,
  type PlaybackVariant,
  type PlaybackView,
} from "../../shared/playback-contracts.js";
import {
  PlaybackTimeline,
  resolvePlaybackTimeline,
  type ComparisonRange,
} from "./timeline.js";
import { parseListeningCommand } from "../../shared/listening-contracts.js";
import {
  AdvancedListening,
  type BookmarkStore,
  type ListeningClock,
} from "./listening.js";
import {
  validateSilenceRanges,
  type SilenceRange,
} from "./silence-analysis.js";
export interface PlaybackSource {
  url: string;
  originalDuration: number;
  voiceDuration?: number | null;
  timelineIdentity?: string;
  sourceDuration: number;
  trimmed: boolean;
  accountOwned?: boolean;
  /** Captured by the trusted source resolver for this track's metric owner. */
  accounting?: PlaybackAccountingPort;
  comparisonRanges?: ComparisonRange[];
  /** Trusted pinned source acknowledgement; never a renderer-supplied path/hash. */
  playbackStarted?(): Promise<void>;
  /** Bounded offline analysis of this exact pinned verified voice; ranges are output time. */
  analyzeSilence?(signal: AbortSignal): Promise<SilenceRange[]>;
  /** Releases the exact verified artifact pin/grant, never the source file. */
  release(): Promise<void>;
}
export interface PlaybackSourcePort {
  /** Trusted current Library scope admission, distinct from codec availability. */
  canQueue?(trackId: string): boolean;
  available?(trackId: string, variant: PlaybackVariant): boolean;
  open(
    trackId: string,
    variant: PlaybackVariant,
    signal: AbortSignal,
  ): Promise<PlaybackSource>;
}
export interface PlaybackAccountingPort {
  begin(trackId: string, sessionId: string): Promise<void>;
  pulse(
    trackId: string,
    sessionId: string,
    position: number,
    rate: number,
  ): Promise<void>;
  end(trackId: string, sessionId: string): Promise<void>;
}
function validMediaUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      Number(url.port) > 0 &&
      !url.username &&
      !url.password &&
      !url.hash &&
      /^\/media\/[a-f0-9-]{36}$/u.test(url.pathname) &&
      [...url.searchParams.keys()].join() === "capability" &&
      /^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get("capability") ?? "")
    );
  } catch {
    return false;
  }
}
export class PlaybackController {
  private value: PlaybackView = {
    generation: randomUUID(),
    trackId: null,
    phase: "idle",
    variant: "voice",
    position: 0,
    sourcePosition: 0,
    duration: 0,
    url: null,
    requestedPlaying: false,
    seekRevision: 0,
    rate: 1,
    volume: 1,
    muted: false,
    repeat: "off",
    shuffle: false,
    queue: [],
    queueRevision: 0,
    error: null,
    timeCoordinate: "original",
    comparisonAvailable: true,
  };
  private readonly listeners = new Set<(view: PlaybackView) => void>();
  private source: PlaybackSource | undefined;
  private timeline: PlaybackTimeline | undefined;
  private request: AbortController | undefined;
  private lastAudible = 0.8;
  private sessionId: string | null = null;
  private trackAccounting: PlaybackAccountingPort | undefined;
  private repeatSeek:
    | { generation: string; revision: number; sourcePosition: number }
    | undefined;
  private history: string[] = [];
  private disposed = false;
  private readonly listening: AdvancedListening | undefined;
  constructor(
    private readonly sources: PlaybackSourcePort,
    private readonly accounting?: PlaybackAccountingPort,
    private readonly random: () => number = Math.random,
    private readonly listeningOptions?: {
      store: BookmarkStore;
      owner(): { key: string; fence: string };
      guestOwner?(): { key: string; fence: string };
      clock?: ListeningClock;
    },
  ) {
    if (listeningOptions) {
      this.listening = new AdvancedListening(
        {
          pause: () =>
            this.publish({
              requestedPlaying: false,
              phase: this.source ? "paused" : "idle",
            }),
          seek: (seconds) => this.seek(seconds),
          repeatAt: async (seconds) => {
            this.seek(seconds);
            this.repeatSeek = {
              generation: this.value.generation,
              revision: this.value.seekRevision,
              sourcePosition: this.value.sourcePosition,
            };
          },
          analyze: async (signal) => {
            const source = this.source,
              timeline = this.timeline;
            if (
              !source?.analyzeSilence ||
              !timeline ||
              this.value.variant !== "voice"
            )
              throw new Error("SILENCE_UNAVAILABLE");
            const output = validateSilenceRanges(
              await source.analyzeSilence(signal),
              source.sourceDuration,
            );
            signal.throwIfAborted();
            if (this.source !== source || this.timeline !== timeline)
              throw new Error("SILENCE_UNAVAILABLE");
            return output
              .map((range) => ({
                start: timeline.toOriginal(range.start),
                end: Math.min(
                  timeline.originalDuration,
                  timeline.toOriginal(
                    Math.max(range.start, range.end - 1 / 44100),
                  ) +
                    1 / 44100,
                ),
              }))
              .filter((range) => range.end > range.start);
          },
        },
        listeningOptions.store,
        listeningOptions.clock,
      );
      this.listening.subscribe((view) => this.publish({ listening: view }));
    }
  }
  view(): PlaybackView {
    return structuredClone(this.value);
  }
  subscribe(listener: (view: PlaybackView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => this.listeners.delete(listener);
  }
  private publish(patch: Partial<PlaybackView>): void {
    if (patch.queue) {
      const revision = (this.value.queueRevision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("INVALID_REQUEST");
      patch = { ...patch, queueRevision: revision };
    }
    this.value = { ...this.value, ...patch };
    if (
      this.listening &&
      Object.keys(patch).some((key) => key !== "listening")
    ) {
      this.listening.selectTrack(this.value.trackId, this.value.generation);
      const owner =
        this.source?.accountOwned === false && this.listeningOptions!.guestOwner
          ? this.listeningOptions!.guestOwner!()
          : this.listeningOptions!.owner();
      if (this.source || !this.value.trackId)
        void this.listening.bind(
          this.value.trackId &&
            this.source &&
            (this.value.timeCoordinate !== "voice-output" ||
              (typeof this.source.timelineIdentity === "string" &&
                /^[a-f0-9]{64}$/u.test(this.source.timelineIdentity)))
            ? {
                trackId: this.value.trackId,
                generation: this.value.generation,
                ownerKey: owner.key,
                ownerFence: owner.fence,
                duration: this.value.duration,
                position: this.value.position,
                variant: this.value.variant,
                playing: this.value.phase === "playing",
                ...(this.value.timeCoordinate === "voice-output"
                  ? {
                      bookmarkTrackId: `voice:${createHash("sha256")
                        .update(
                          JSON.stringify([
                            this.value.trackId,
                            this.source.timelineIdentity,
                          ]),
                        )
                        .digest("hex")}`,
                    }
                  : {}),
              }
            : null,
        );
    }
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {}
    }
  }
  async execute(input: PlaybackCommand): Promise<PlaybackView> {
    const command = parsePlaybackCommand(input);
    if (this.disposed) throw new Error("MEDIA_UNAVAILABLE");
    const listening = parseListeningCommand(command);
    if (listening) {
      await this.listening?.execute(listening);
      return this.view();
    }
    switch (command.type) {
      case "LOAD":
        await this.load(command.trackId, "voice", false);
        break;
      case "SOURCE":
        if (
          this.value.trackId &&
          command.variant !== this.value.variant &&
          this.value.comparisonAvailable === false
        ) {
          this.publish({ error: "COMPARISON_TIMELINE_UNAVAILABLE" });
          break;
        }
        if (this.value.trackId && command.variant !== this.value.variant)
          await this.load(this.value.trackId, command.variant, true);
        break;
      case "PLAY":
        if (this.source) {
          if (this.value.position >= this.value.duration - 0.02) {
            await this.endAccounting();
            this.seek(0);
          }
          this.publish({ requestedPlaying: true });
        }
        break;
      case "PAUSE":
        this.repeatSeek = undefined;
        this.publish({
          requestedPlaying: false,
          phase: this.source ? "paused" : "idle",
        });
        break;
      case "STOP":
        await this.stop();
        break;
      case "SEEK":
        this.listening?.manualSeek();
        this.seek(command.seconds);
        break;
      case "RESTART":
        this.listening?.manualSeek();
        this.seek(0);
        break;
      case "RATE":
        this.publish({ rate: command.rate });
        break;
      case "VOLUME":
        if (command.level > 0) this.lastAudible = command.level;
        this.publish({ volume: command.level, muted: command.level === 0 });
        break;
      case "MUTE":
        this.publish(
          this.value.muted
            ? {
                muted: false,
                volume:
                  this.value.volume > 0 ? this.value.volume : this.lastAudible,
              }
            : { muted: true },
        );
        break;
      case "REPEAT":
        this.publish({ repeat: command.mode });
        break;
      case "SHUFFLE":
        this.publish({ shuffle: command.enabled });
        break;
      case "QUEUE":
        this.publish({
          queue: [...command.ids],
        });
        break;
      case "NEXT":
        await this.next(false);
        break;
      case "QUEUE_PLAY": {
        if (
          command.generation !== this.value.generation ||
          command.queueRevision !== this.value.queueRevision ||
          this.sources.canQueue?.(command.trackId) === false ||
          this.value.queue[command.index] !== command.trackId
        )
          throw new Error("INVALID_REQUEST");
        const queue = [...this.value.queue];
        queue.splice(command.index, 1);
        this.publish({ queue });
        await this.load(command.trackId, "voice", false);
        break;
      }
      case "QUEUE_EDIT": {
        if (
          command.generation !== this.value.generation ||
          command.queueRevision !== this.value.queueRevision
        )
          throw new Error("INVALID_REQUEST");
        const queue = [...this.value.queue];
        if (command.action === "clear") queue.length = 0;
        else if (
          command.action === "append" ||
          command.action === "insert-next"
        ) {
          if (this.sources.canQueue?.(command.trackId) === false)
            throw new Error("MEDIA_UNAVAILABLE");
          if (queue.length === 1000) throw new Error("INVALID_REQUEST");
          queue.splice(
            command.action === "append" ? queue.length : 0,
            0,
            command.trackId,
          );
        } else {
          if (queue[command.index] !== command.trackId)
            throw new Error("INVALID_REQUEST");
          if (command.action === "remove") queue.splice(command.index, 1);
          else {
            if (command.to >= queue.length) throw new Error("INVALID_REQUEST");
            queue.splice(command.index, 1);
            queue.splice(command.to, 0, command.trackId);
          }
        }
        this.publish({ queue });
        break;
      }
      case "PREVIOUS":
        if (this.value.position > 3) this.seek(0);
        else {
          const id = this.history.pop();
          if (id) await this.load(id, this.value.variant, false);
        }
        break;
      case "MEDIA_EVENT":
        await this.event(command);
        break;
    }
    return this.view();
  }
  private async load(
    trackId: string,
    variant: PlaybackVariant,
    same: boolean,
  ): Promise<void> {
    this.request?.abort();
    const abort = new AbortController(),
      generation = randomUUID();
    this.request = abort;
    this.repeatSeek = undefined;
    const position = same ? this.value.position : 0,
      playing = same ? this.value.requestedPlaying : true;
    const previousId = this.value.trackId;
    if (!same && previousId !== trackId) this.listening?.clearSleep();
    const accounting = same ? Promise.resolve() : this.endAccounting();
    const previous = this.source;
    if (!same) void this.listening?.bind(null);
    this.source = undefined;
    this.timeline = undefined;
    this.publish({
      generation,
      trackId,
      variant,
      phase: "preparing",
      url: null,
      error: null,
      position,
      sourcePosition: 0,
      requestedPlaying: playing,
    });
    try {
      await previous?.release();
      await accounting;
      if (
        abort.signal.aborted ||
        this.value.generation !== generation ||
        this.disposed
      )
        return;
      const source = await this.sources.open(trackId, variant, abort.signal);
      if (
        abort.signal.aborted ||
        this.value.generation !== generation ||
        this.disposed
      ) {
        await source.release();
        return;
      }
      try {
        if (
          !validMediaUrl(source.url) ||
          !Number.isFinite(source.sourceDuration) ||
          source.sourceDuration <= 0 ||
          source.sourceDuration > 7200
        )
          throw new Error("MEDIA_UNAVAILABLE");
        const resolved = resolvePlaybackTimeline(source, variant),
          timeline = resolved.timeline;
        this.source = source;
        this.timeline = timeline;
        if (!same) this.trackAccounting = source.accounting ?? this.accounting;
        if (!same && previousId && previousId !== trackId)
          this.history = [...this.history.slice(-99), previousId];
        const logical = Math.min(position, timeline.originalDuration);
        this.publish({
          phase: "buffering",
          url: source.url,
          duration: timeline.originalDuration,
          position: logical,
          sourcePosition:
            variant === "original" ? logical : timeline.toOutput(logical),
          seekRevision: this.value.seekRevision + 1,
          timeCoordinate: resolved.coordinate,
          comparisonAvailable:
            resolved.comparisonAvailable &&
            this.sources.available?.(
              trackId,
              variant === "voice" ? "original" : "voice",
            ) !== false,
        });
      } catch (error) {
        await source.release();
        throw error;
      }
    } catch (error) {
      if (abort.signal.aborted || this.value.generation !== generation) return;
      this.publish({
        phase: "error",
        requestedPlaying: false,
        url: null,
        error:
          error instanceof Error &&
          error.message === "COMPARISON_TIMELINE_UNAVAILABLE"
            ? "COMPARISON_TIMELINE_UNAVAILABLE"
            : "MEDIA_UNAVAILABLE",
      });
    }
  }
  seek(seconds: number): void {
    this.repeatSeek = undefined;
    if (!this.timeline || !this.source) return;
    const position = Math.min(this.value.duration, Math.max(0, seconds));
    this.publish({
      position,
      sourcePosition:
        this.value.variant === "original"
          ? position
          : this.timeline.toOutput(position),
      seekRevision: this.value.seekRevision + 1,
    });
  }
  private async event(
    command: Extract<PlaybackCommand, { type: "MEDIA_EVENT" }>,
  ): Promise<void> {
    if (
      command.generation !== this.value.generation ||
      !this.source ||
      !this.timeline
    )
      return;
    const source = this.source,
      timeline = this.timeline,
      seekRevision = this.value.seekRevision,
      seekFenced = ["time", "seeked", "ended"].includes(command.event),
      current = () =>
        !this.disposed &&
        this.source === source &&
        this.timeline === timeline &&
        this.value.generation === command.generation &&
        (!seekFenced || this.value.seekRevision === seekRevision);
    if (
      command.event === "seeked" &&
      command.seekRevision !== undefined &&
      command.seekRevision !== seekRevision
    )
      return;
    if (command.position > source.sourceDuration + 0.5) return;
    const position =
      this.value.variant === "original"
        ? Math.min(command.position, this.value.duration)
        : timeline.toOriginal(command.position);
    if (command.event === "seeked") {
      const repeat = this.repeatSeek;
      if (
        repeat &&
        repeat.generation === command.generation &&
        repeat.revision === command.seekRevision &&
        Math.abs(command.position - repeat.sourcePosition) <= 0.25
      ) {
        this.repeatSeek = undefined;
        if (this.value.requestedPlaying) {
          await this.endAccounting();
          if (!current()) return;
          if (this.value.phase === "playing") await this.startAccounting();
          if (!current()) return;
        }
      }
      await this.listening?.position(position, this.value.phase === "playing");
    } else if (command.event === "time") {
      this.publish({ position, sourcePosition: command.position });
      if (this.value.phase === "playing") await this.startAccounting();
      if (!current()) return;
      if (
        this.value.phase === "playing" &&
        this.sessionId &&
        this.value.trackId
      )
        await this.trackAccounting?.pulse(
          this.value.trackId,
          this.sessionId,
          position,
          this.value.rate,
        );
      if (!current()) return;
      await this.listening?.position(position, this.value.phase === "playing");
    } else if (command.event === "loaded")
      this.publish({
        phase: this.value.requestedPlaying ? "buffering" : "paused",
      });
    else if (command.event === "playing") {
      if (!this.value.requestedPlaying) return;
      this.publish({ phase: "playing" });
      await source?.playbackStarted?.().catch(() => {});
      if (!current()) return;
      await this.startAccounting();
    } else if (command.event === "paused") this.publish({ phase: "paused" });
    else if (command.event === "buffering")
      this.publish({ phase: "buffering" });
    else if (command.event === "error")
      this.publish({
        phase: "error",
        requestedPlaying: false,
        error: "MEDIA_UNAVAILABLE",
      });
    else if (
      command.event === "ended" &&
      this.value.requestedPlaying &&
      this.value.phase === "playing"
    ) {
      await this.listening?.position(position, true);
      if (!current()) return;
      if (
        this.value.requestedPlaying &&
        this.value.phase === "playing" &&
        !this.repeatSeek
      )
        await this.next(true);
    }
  }
  private async next(_ended: boolean): Promise<void> {
    if (this.value.phase === "preparing") return;
    if (this.value.repeat === "track" && this.value.trackId) {
      await this.endAccounting();
      this.seek(0);
      this.publish({ requestedPlaying: true, phase: "buffering" });
      return;
    }
    const queue = [...this.value.queue];
    if (!queue.length) {
      if (this.value.repeat === "queue" && this.value.trackId) {
        await this.endAccounting();
        this.seek(0);
        this.publish({ requestedPlaying: true, phase: "buffering" });
      } else
        this.publish({
          requestedPlaying: false,
          phase: this.source ? "paused" : "idle",
        });
      return;
    }
    const random = this.random();
    const index = this.value.shuffle
      ? Math.min(
          queue.length - 1,
          Math.floor(
            Math.max(
              0,
              Math.min(0.999999, Number.isFinite(random) ? random : 0),
            ) * queue.length,
          ),
        )
      : 0;
    const id = queue.splice(index, 1)[0]!;
    if (this.value.repeat === "queue" && this.value.trackId)
      queue.push(this.value.trackId);
    this.publish({ queue });
    const variant =
      this.value.variant === "original" &&
      this.sources.available?.(id, "original") === false
        ? "voice"
        : this.value.variant;
    await this.load(id, variant, false);
  }
  private async endAccounting(): Promise<void> {
    const id = this.sessionId,
      track = this.value.trackId;
    this.sessionId = null;
    if (id && track) await this.trackAccounting?.end(track, id);
  }
  private async startAccounting(): Promise<void> {
    if (!this.sessionId && this.value.trackId) {
      this.sessionId = randomUUID();
      await this.trackAccounting?.begin(this.value.trackId, this.sessionId);
    }
  }
  /** Recheck the sleep deadline after Windows resume and reload owner-scoped preferences. */
  refreshListeningOwner(): void {
    this.listening?.resume();
    this.publish({ position: this.value.position });
  }
  /** Freeze the current visible Library order when the user starts a track. */
  async playFromLibrary(
    trackId: string,
    visibleIds: readonly string[],
    variant: PlaybackVariant = "voice",
  ): Promise<void> {
    parsePlaybackCommand({ type: "LOAD", trackId });
    parsePlaybackCommand({ type: "QUEUE", ids: [...visibleIds] });
    const at = visibleIds.indexOf(trackId);
    if (at < 0) throw new Error("MEDIA_UNAVAILABLE");
    const loading = this.load(trackId, variant, false);
    this.publish({ queue: visibleIds.slice(at + 1) });
    await loading;
  }
  async stop(): Promise<void> {
    this.listening?.clearSleep();
    this.request?.abort();
    this.repeatSeek = undefined;
    const source = this.source;
    this.source = undefined;
    this.timeline = undefined;
    const accounting = this.endAccounting();
    this.trackAccounting = undefined;
    this.publish({
      generation: randomUUID(),
      trackId: null,
      phase: "idle",
      url: null,
      position: 0,
      sourcePosition: 0,
      duration: 0,
      requestedPlaying: false,
      error: null,
    });
    try {
      await accounting;
    } finally {
      await source?.release();
    }
  }
  /** Account changes revoke grants through the trusted source port; stop cannot terminate fleet work. */
  async invalidateOwner(
    accountTrack: (id: string) => boolean = () => true,
  ): Promise<void> {
    const stopping = this.source?.accountOwned ? this.stop() : undefined;
    this.history = this.history.filter((id) => !accountTrack(id));
    this.publish({ queue: this.value.queue.filter((id) => !accountTrack(id)) });
    await stopping;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.listening?.dispose();
    await this.stop();
    this.listeners.clear();
  }
}
