import { randomUUID } from "node:crypto";
import type {
  ListeningCommand,
  ListeningView,
  PlaybackBookmark,
} from "../../shared/listening-contracts.js";
import {
  validateSilenceRanges,
  type SilenceRange,
} from "./silence-analysis.js";
export interface ListeningContext {
  trackId: string;
  generation: string;
  ownerKey: string;
  ownerFence?: string;
  duration: number;
  position: number;
  variant: "voice" | "original";
  playing: boolean;
  /** Explicit artifact/output identity for standalone voice markers. */
  bookmarkTrackId?: string;
}
export interface BookmarkStore {
  read(owner: string, trackId: string): Promise<unknown>;
  write(owner: string, trackId: string, record: unknown): Promise<void>;
  /** Retains the exact damaged record before a user's next explicit edit repairs it. */
  quarantine(owner: string, trackId: string): Promise<void>;
}
interface ListeningPort {
  pause(): void;
  seek(seconds: number): void;
  repeatAt(seconds: number): Promise<void>;
  analyze(signal: AbortSignal): Promise<SilenceRange[]>;
}
export interface ListeningClock {
  wall(): number;
  monotonic(): number;
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}
const clock: ListeningClock = {
  wall: Date.now,
  monotonic: () => performance.now(),
  set: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
function parseBookmarks(
  raw: unknown,
  owner: string,
  trackId: string,
  duration: number,
): { bookmarks: PlaybackBookmark[]; skip: boolean } {
  if (raw === null) return { bookmarks: [], skip: false };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("PREFERENCES_UNAVAILABLE");
  const row = raw as Record<string, unknown>;
  if (
    Object.keys(row).sort().join() !==
      (row.skipSilencePreferred === undefined
        ? "bookmarks,owner,trackId,version"
        : "bookmarks,owner,skipSilencePreferred,trackId,version") ||
    (row.skipSilencePreferred !== undefined &&
      typeof row.skipSilencePreferred !== "boolean") ||
    row.version !== 1 ||
    row.owner !== owner ||
    row.trackId !== trackId ||
    !Array.isArray(row.bookmarks) ||
    row.bookmarks.length > 100
  )
    throw new Error("PREFERENCES_UNAVAILABLE");
  const ids = new Set<string>();
  let previous = -1;
  const bookmarks = row.bookmarks.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).sort().join() !== "id,seconds,title"
    )
      throw new Error("PREFERENCES_UNAVAILABLE");
    const bookmark = item as PlaybackBookmark;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        bookmark.id,
      ) ||
      ids.has(bookmark.id) ||
      !Number.isFinite(bookmark.seconds) ||
      bookmark.seconds < 0 ||
      bookmark.seconds > duration ||
      bookmark.seconds < previous ||
      typeof bookmark.title !== "string" ||
      bookmark.title.length < 1 ||
      bookmark.title.length > 80 ||
      /[\p{Cc}\p{Cf}]/u.test(bookmark.title)
    )
      throw new Error("PREFERENCES_UNAVAILABLE");
    ids.add(bookmark.id);
    previous = bookmark.seconds;
    return { ...bookmark };
  });
  return { bookmarks, skip: row.skipSilencePreferred === true };
}
/** Sleep first, AB second, voice-only skip third; all coordinates are verified original time. */
export class AdvancedListening {
  private value: ListeningView = {
    loopStart: null,
    loopEnd: null,
    bookmarks: [],
    sleepRemainingSeconds: null,
    skipSilence: false,
    analyzingSilence: false,
    error: null,
  };
  private context: ListeningContext | null = null;
  private selectedTrackId: string | null = null;
  private selectedGeneration: string | undefined;
  private epoch = 0;
  private ownerEpoch = 0;
  private binding: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private corrupt = false;
  private skipPreferred = false;
  private analysis: AbortController | undefined;
  private analysisRequest = 0;
  private ranges: SilenceRange[] = [];
  private sleep:
    | {
        wallDeadline: number;
        monotonicStart: number;
        duration: number;
        remaining: number;
        trackId: string | null;
      }
    | undefined;
  private timer: unknown;
  private repeating = false;
  private awaitingLoopSeek = false;
  private disposed = false;
  private listeners = new Set<(view: ListeningView) => void>();
  constructor(
    private readonly port: ListeningPort,
    private readonly store: BookmarkStore,
    private readonly time: ListeningClock = clock,
  ) {}
  view(): ListeningView {
    return structuredClone(this.value);
  }
  subscribe(listener: (view: ListeningView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => this.listeners.delete(listener);
  }
  private publish(patch: Partial<ListeningView>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {}
    }
  }
  bind(context: ListeningContext | null): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const prior = this.context;
    if (context) this.selectTrack(context.trackId, context.generation);
    this.context = context ? { ...context } : null;
    const same =
      !!prior &&
      !!context &&
      prior.trackId === context.trackId &&
      prior.ownerKey === context.ownerKey &&
      prior.ownerFence === context.ownerFence;
    const samePreferences =
      same &&
      (prior!.bookmarkTrackId ?? prior!.trackId) ===
        (context!.bookmarkTrackId ?? context!.trackId);
    if (samePreferences && prior!.generation === context!.generation)
      return this.binding;
    this.epoch++;
    this.analysisRequest++;
    this.awaitingLoopSeek = false;
    if (!samePreferences) this.ownerEpoch++;
    this.analysis?.abort();
    this.analysis = undefined;
    this.ranges = [];
    this.publish({
      skipSilence: false,
      analyzingSilence: false,
      ...(!samePreferences
        ? { loopStart: null, loopEnd: null, bookmarks: [], error: null }
        : {}),
    });
    if (samePreferences) {
      const epoch = this.epoch;
      void this.binding.then(() => {
        if (
          epoch === this.epoch &&
          this.skipPreferred &&
          context?.variant === "voice"
        )
          void this.prepareSilence(context, epoch);
      });
      return this.binding;
    }
    this.skipPreferred = false;
    if (!context) return (this.binding = Promise.resolve());
    const epoch = this.ownerEpoch,
      captured = { ...context };
    this.corrupt = false;
    this.binding = (async () => {
      try {
        const raw = await this.store.read(
          captured.ownerKey,
          captured.bookmarkTrackId ?? captured.trackId,
        );
        const record = parseBookmarks(
          raw,
          captured.ownerKey,
          captured.bookmarkTrackId ?? captured.trackId,
          captured.duration,
        );
        if (epoch === this.ownerEpoch && !this.disposed) {
          this.skipPreferred = record.skip;
          this.publish({ bookmarks: record.bookmarks });
        }
      } catch {
        if (epoch === this.ownerEpoch && !this.disposed) {
          this.corrupt = true;
          this.publish({ error: "PREFERENCES_UNAVAILABLE" });
        }
      }
    })();
    const mediaEpoch = this.epoch;
    void this.binding.then(() => {
      if (
        mediaEpoch === this.epoch &&
        this.skipPreferred &&
        captured.variant === "voice"
      )
        void this.prepareSilence(captured, mediaEpoch);
    });
    return this.binding;
  }
  async execute(command: ListeningCommand): Promise<void> {
    if (this.disposed) throw new Error("MEDIA_UNAVAILABLE");
    if (command.type === "SLEEP") {
      this.setSleep(command.seconds);
      return;
    }
    const context = this.context ? { ...this.context } : null;
    const epoch = this.epoch,
      ownerEpochAtIntake = this.ownerEpoch;
    await this.binding;
    if (
      this.disposed ||
      epoch !== this.epoch ||
      ownerEpochAtIntake !== this.ownerEpoch
    )
      return;
    if (!context || context.generation !== this.selectedGeneration) return;
    if (command.type === "LOOP_START")
      this.publish({
        loopStart: context.position,
        loopEnd:
          this.value.loopEnd !== null &&
          this.value.loopEnd > context.position + 0.1
            ? this.value.loopEnd
            : null,
      });
    else if (command.type === "LOOP_END") {
      if (
        this.value.loopStart !== null &&
        context.position > this.value.loopStart + 0.1
      )
        this.publish({ loopEnd: context.position });
    } else if (command.type === "LOOP_CLEAR") {
      this.awaitingLoopSeek = false;
      this.publish({ loopStart: null, loopEnd: null });
    } else if (command.type === "SKIP_SILENCE") {
      const analysisRequest = ++this.analysisRequest;
      this.analysis?.abort();
      this.ranges = [];
      this.publish({ skipSilence: false, analyzingSilence: false });
      if (command.enabled && context.variant !== "voice") {
        this.publish({ error: "SILENCE_UNAVAILABLE" });
        return;
      }
      const ownerEpoch = this.ownerEpoch;
      const write = this.writes
        .catch(() => {})
        .then(async () => {
          if (ownerEpoch !== this.ownerEpoch || this.disposed) return;
          if (this.corrupt)
            await this.store.quarantine(
              context.ownerKey,
              context.bookmarkTrackId ?? context.trackId,
            );
          await this.store.write(
            context.ownerKey,
            context.bookmarkTrackId ?? context.trackId,
            {
              version: 1,
              owner: context.ownerKey,
              trackId: context.bookmarkTrackId ?? context.trackId,
              bookmarks: this.value.bookmarks,
              skipSilencePreferred: command.enabled,
            },
          );
          if (ownerEpoch === this.ownerEpoch) {
            this.skipPreferred = command.enabled;
            this.corrupt = false;
          }
        });
      this.writes = write;
      try {
        await write;
      } catch {
        if (ownerEpoch === this.ownerEpoch)
          this.publish({ error: "PREFERENCES_UNAVAILABLE" });
        return;
      }
      if (
        epoch === this.epoch &&
        analysisRequest === this.analysisRequest &&
        !this.disposed
      ) {
        this.publish({ error: null });
        if (command.enabled)
          await this.prepareSilence(context, epoch, analysisRequest);
      }
    } else if (command.type === "BOOKMARK_SEEK") {
      const bookmark = this.value.bookmarks.find(
        (value) => value.id === command.id,
      );
      if (bookmark) this.port.seek(bookmark.seconds);
    } else {
      const ownerEpoch = this.ownerEpoch;
      const write = this.writes
        .catch(() => {})
        .then(async () => {
          if (ownerEpoch !== this.ownerEpoch || this.disposed) return;
          const next = this.value.bookmarks.map((value) => ({ ...value }));
          if (command.type === "BOOKMARK_ADD") {
            if (
              next.length >= 100 ||
              next.some(
                (value) => Math.abs(value.seconds - context.position) < 0.5,
              )
            )
              return;
            next.push({
              id: randomUUID(),
              seconds: context.position,
              title: `Bookmark ${next.length + 1}`,
            });
            next.sort((a, b) => a.seconds - b.seconds);
          } else if (command.type === "BOOKMARK_REMOVE") {
            const index = next.findIndex((value) => value.id === command.id);
            if (index < 0) return;
            next.splice(index, 1);
          } else if (command.type === "BOOKMARK_RENAME") {
            const bookmark = next.find((value) => value.id === command.id);
            if (!bookmark) return;
            bookmark.title = command.title.trim();
          }
          if (this.corrupt)
            await this.store.quarantine(
              context.ownerKey,
              context.bookmarkTrackId ?? context.trackId,
            );
          await this.store.write(
            context.ownerKey,
            context.bookmarkTrackId ?? context.trackId,
            {
              version: 1,
              owner: context.ownerKey,
              trackId: context.bookmarkTrackId ?? context.trackId,
              bookmarks: next,
              skipSilencePreferred: this.skipPreferred,
            },
          );
          if (ownerEpoch === this.ownerEpoch && !this.disposed) {
            this.corrupt = false;
            this.publish({ bookmarks: next, error: null });
          }
        });
      this.writes = write;
      try {
        await write;
      } catch {
        if (ownerEpoch === this.ownerEpoch)
          this.publish({ error: "PREFERENCES_UNAVAILABLE" });
      }
    }
  }
  private async prepareSilence(
    context: ListeningContext,
    epoch: number,
    analysisRequest = this.analysisRequest,
  ): Promise<void> {
    if (
      this.disposed ||
      epoch !== this.epoch ||
      analysisRequest !== this.analysisRequest
    )
      return;
    this.analysis?.abort();
    const abort = new AbortController();
    this.analysis = abort;
    this.publish({ analyzingSilence: true, error: null });
    try {
      const ranges = validateSilenceRanges(
        await this.port.analyze(abort.signal),
        context.duration,
      );
      if (
        epoch === this.epoch &&
        analysisRequest === this.analysisRequest &&
        !abort.signal.aborted
      ) {
        this.ranges = ranges;
        this.publish({ skipSilence: true });
      }
    } catch {
      if (epoch === this.epoch && !abort.signal.aborted)
        this.publish({ error: "SILENCE_UNAVAILABLE" });
    } finally {
      if (this.analysis === abort) {
        this.analysis = undefined;
        this.publish({ analyzingSilence: false });
      }
    }
  }
  private setSleep(seconds: number): void {
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.timer = undefined;
    this.sleep = undefined;
    if (seconds > 0)
      this.sleep = {
        wallDeadline: this.time.wall() + seconds * 1000,
        monotonicStart: this.time.monotonic(),
        duration: seconds,
        remaining: seconds,
        trackId: this.selectedTrackId,
      };
    this.publish({ sleepRemainingSeconds: seconds > 0 ? seconds : null });
    if (this.sleep) this.tick();
  }
  private tick(): boolean {
    if (!this.sleep) return false;
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.timer = undefined;
    const remaining = Math.max(
      0,
      Math.min(
        this.sleep.remaining,
        (this.sleep.wallDeadline - this.time.wall()) / 1000,
        this.sleep.duration -
          Math.max(0, this.time.monotonic() - this.sleep.monotonicStart) / 1000,
      ),
    );
    this.sleep.remaining = remaining;
    if (remaining <= 0) {
      this.sleep = undefined;
      this.publish({ sleepRemainingSeconds: null });
      this.port.pause();
      return true;
    }
    this.publish({ sleepRemainingSeconds: Math.ceil(remaining) });
    this.timer = this.time.set(
      () => {
        this.timer = undefined;
        this.tick();
      },
      Math.min(1000, remaining * 1000),
    );
    return false;
  }
  /** Call on real media-time events and system resume. No HTTP/status polling. */
  async position(position: number, playing: boolean): Promise<void> {
    if (this.disposed) return;
    if (this.context) this.context.position = position;
    if (this.tick() || !playing || !this.context || this.repeating) return;
    if (
      this.awaitingLoopSeek &&
      (this.value.loopEnd === null || position < this.value.loopEnd - 0.04)
    )
      this.awaitingLoopSeek = false;
    if (
      this.value.loopStart !== null &&
      this.value.loopEnd !== null &&
      position >= this.value.loopEnd
    ) {
      if (this.awaitingLoopSeek) return;
      this.repeating = true;
      this.awaitingLoopSeek = true;
      try {
        await this.port.repeatAt(this.value.loopStart);
      } catch (error) {
        this.awaitingLoopSeek = false;
        throw error;
      } finally {
        this.repeating = false;
      }
      return;
    }
    if (this.value.skipSilence && this.context.variant === "voice") {
      const range = this.ranges.find(
        (value) => position >= value.start && position < value.end - 0.04,
      );
      if (range)
        this.port.seek(Math.min(range.end, this.value.loopEnd ?? range.end));
    }
  }
  resume(): void {
    if (!this.disposed) this.tick();
  }
  clearSleep(): void {
    this.setSleep(0);
  }
  /** Requested media identity exists during preparation, before its coordinate context. */
  selectTrack(trackId: string | null, generation?: string): void {
    if (this.disposed) return;
    if (this.sleep && this.sleep.trackId !== trackId) this.setSleep(0);
    this.selectedTrackId = trackId;
    if (generation !== undefined && this.selectedGeneration !== generation) {
      this.selectedGeneration = generation;
      this.epoch++;
      this.analysisRequest++;
      this.awaitingLoopSeek = false;
      this.analysis?.abort();
      this.analysis = undefined;
      this.ranges = [];
      this.publish({
        skipSilence: false,
        analyzingSilence: false,
        ...(this.value.error === "SILENCE_UNAVAILABLE" ? { error: null } : {}),
      });
    }
  }
  manualSeek(): void {
    this.awaitingLoopSeek = false;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.epoch++;
    this.analysis?.abort();
    if (this.timer !== undefined) this.time.clear(this.timer);
    this.timer = undefined;
    this.sleep = undefined;
    this.context = null;
    this.awaitingLoopSeek = false;
    await this.writes.catch(() => {});
    this.listeners.clear();
  }
}
