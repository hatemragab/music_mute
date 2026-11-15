import type { SessionAccountScope } from "../../shared/session-contracts.js";
import {
  DEFAULT_LIBRARY_QUERY,
  parseLibraryAction,
  type LibraryAction,
  type LibraryView,
  type LibraryTrackView,
} from "../../shared/library-contracts.js";
import type { RealtimeUpdate } from "../realtime/user-realtime.js";
import {
  accountLibraryJob,
  localTrackId,
  mergeLibrary,
  visibleLibrary,
  type AccountLibraryJob,
} from "./model.js";
import type { LibraryStore } from "./store.js";
import type { LibraryArtifactCache } from "./artifacts.js";
import { parseDownloadGrant } from "../../../../chrome-extension/src/companion/cloud-provider.js";
import type { HistoryMetricTrack } from "../history/controller.js";
export interface LibraryControllerOptions {
  store: LibraryStore;
  cache: Pick<LibraryArtifactCache, "lookup" | "download" | "adopt" | "local">;
  scope(): SessionAccountScope | null;
  realtime: {
    watch(
      resource: "jobs",
      params: Record<string, string>,
      listener: (update: RealtimeUpdate) => void,
    ): () => void;
  };
  request(
    scope: SessionAccountScope,
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  removeCache(
    track: LibraryTrackView,
    scope: SessionAccountScope,
    signal: AbortSignal,
  ): Promise<void>;
  deleteLocal(
    trackId: string,
    scope: SessionAccountScope | null,
    signal: AbortSignal,
  ): Promise<void>;
  /** Retire only the acknowledged item's current playback, under its captured owner. */
  accountDeleted?(trackId: string, scope: SessionAccountScope): Promise<void>;
  history?: {
    count(track: HistoryMetricTrack): number;
    reconcile(tracks: HistoryMetricTrack[]): Promise<void>;
    canCount?(track: HistoryMetricTrack): boolean;
    subscribeCounts?(listener: () => void): () => void;
  };
  trustedResultMetadata?(
    capability: string,
    scope: SessionAccountScope,
  ): unknown;
  thumbnail?(url: string | null, signal: AbortSignal): Promise<string | null>;
}
const same = (a: SessionAccountScope | null, b: SessionAccountScope | null) =>
  a?.firebaseUid === b?.firebaseUid && a?.generation === b?.generation;
/** Full socket snapshots replace the account page atomically; commands never trigger HTTP status polling. */
export class LibraryController {
  private value: LibraryView = {
    revision: 0,
    state: "loading",
    accountState: "signed-out",
    errorCode: null,
    query: { ...DEFAULT_LIBRARY_QUERY },
    tracks: [],
    visibleIds: [],
    total: 0,
    nextCursor: null,
  };
  private all: LibraryTrackView[] = [];
  private scope: SessionAccountScope | null = null;
  private epoch = 0;
  private abort = new AbortController();
  private readonly watches = new Map<
    string,
    { version: number; off: () => void }
  >();
  private readonly pages = new Map<
    string,
    { jobs: AccountLibraryJob[]; revision: number }
  >();
  private pageRevision = 0;
  private cursor: string | null = null;
  private disposed = false;
  private hydrationVersion = 0;
  private watchVersion = 0;
  private readonly pixels = new Map<string, Promise<string | null>>();
  private serial: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(view: LibraryView) => void>();
  private readonly stopCounts: (() => void) | undefined;
  private historyAvailable = true;
  constructor(private readonly options: LibraryControllerOptions) {
    this.stopCounts = options.history?.subscribeCounts?.(() => {
      if (this.disposed || !same(this.scope, options.scope())) return;
      const tracks = this.historyCounts(this.all);
      if (
        !tracks.some(
          (track, index) => track.playCount !== this.all[index]?.playCount,
        )
      )
        return;
      this.all = tracks;
      this.render(false);
    });
  }
  private historyIdentity(track: LibraryTrackView): HistoryMetricTrack {
    return {
      id: track.id,
      ...(track.jobId ? { jobId: track.jobId } : {}),
      title: track.title,
      accountOwned: track.accountOwned,
    };
  }
  private historyCounts(tracks: LibraryTrackView[]): LibraryTrackView[] {
    const history = this.options.history;
    if (!history) return tracks;
    return tracks.map((track) => {
      const identity = this.historyIdentity(track);
      let count = 0;
      try {
        if (history.canCount?.(identity) ?? this.historyAvailable)
          count = history.count(identity);
      } catch {
        /* History recovery cannot disable media. */
      }
      return { ...track, playCount: count };
    });
  }
  view() {
    return structuredClone(this.value);
  }
  subscribe(listener: (view: LibraryView) => void) {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    this.value.revision++;
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {
        /* Isolate presentation subscribers. */
      }
    }
  }
  private current(scope: SessionAccountScope | null, epoch = this.epoch) {
    if (
      this.disposed ||
      epoch !== this.epoch ||
      !same(scope, this.scope) ||
      !same(scope, this.options.scope())
    )
      throw new Error("ACCOUNT_CHANGED");
  }
  async setScope(scope: SessionAccountScope | null): Promise<void> {
    this.epoch++;
    this.abort.abort();
    this.abort = new AbortController();
    for (const watch of this.watches.values()) watch.off();
    this.watches.clear();
    this.pages.clear();
    this.scope = scope ? { ...scope } : null;
    this.pixels.clear();
    this.cursor = null;
    this.all = [];
    this.value = {
      ...this.value,
      state: "loading",
      accountState: scope ? "connecting" : "signed-out",
      errorCode: null,
      tracks: [],
      visibleIds: [],
      total: 0,
      nextCursor: null,
    };
    this.emit();
    const epoch = this.epoch;
    try {
      await this.refreshLocal(epoch);
      this.current(scope, epoch);
      if (scope) this.bind(epoch);
    } catch (error) {
      if (
        !this.disposed &&
        epoch === this.epoch &&
        same(scope, this.scope) &&
        same(scope, this.options.scope())
      ) {
        this.value.state = "error";
        this.value.errorCode = "LIBRARY_UNAVAILABLE";
        this.emit();
      }
      throw error;
    }
  }
  private bind(epoch: number) {
    const page = this.cursor ?? "";
    if (this.watches.has(page)) return;
    if (this.watches.size >= 82) throw new Error("LIBRARY_CAPACITY_REACHED");
    const watchVersion = ++this.watchVersion;
    const slot = { version: watchVersion, off: () => {} };
    this.watches.set(page, slot);
    try {
      slot.off = this.options.realtime.watch(
        "jobs",
        {
          status: "ready",
          limit: "50",
          ...(this.cursor ? { cursor: this.cursor } : {}),
        },
        (update) => {
          const scope = this.scope;
          if (
            !scope ||
            epoch !== this.epoch ||
            this.watches.get(page)?.version !== watchVersion
          )
            return;
          this.serial = this.serial
            .catch(() => {})
            .then(async () => {
              this.current(scope, epoch);
              if (this.watches.get(page)?.version !== watchVersion) return;
              this.value.accountState = update.errorCode
                ? "error"
                : update.live
                  ? "live"
                  : "disconnected";
              this.value.errorCode = update.errorCode;
              if (update.data !== null) {
                const row = update.data as {
                  items?: unknown;
                  next_cursor?: unknown;
                };
                if (
                  !row ||
                  !Array.isArray(row.items) ||
                  row.items.length > 50 ||
                  (row.next_cursor !== null &&
                    (typeof row.next_cursor !== "string" ||
                      row.next_cursor.length < 1 ||
                      row.next_cursor.length > 1024 ||
                      /[\p{Cc}\p{Cf}]/u.test(row.next_cursor)))
                )
                  throw new Error("LIBRARY_SNAPSHOT_INVALID");
                const jobs: AccountLibraryJob[] =
                  row.items.map(accountLibraryJob);
                this.current(scope, epoch);
                const updated = new Map(this.pages);
                updated.set(page, { jobs, revision: ++this.pageRevision });
                const merged = new Map<string, AccountLibraryJob>();
                for (const loaded of [...updated.values()].sort(
                  (a, b) => a.revision - b.revision,
                ))
                  for (const job of loaded.jobs)
                    merged.set(job.metadata.id, job);
                if (merged.size > 4096)
                  throw new Error("LIBRARY_CAPACITY_REACHED");
                await this.options.store.saveAccountJobs(scope, [
                  ...merged.values(),
                ]);
                this.current(scope, epoch);
                this.pages.clear();
                for (const [key, value] of updated) this.pages.set(key, value);
                if (page === (this.cursor ?? ""))
                  this.value.nextCursor = row.next_cursor as string | null;
              }
              await this.refreshLocal(epoch);
            })
            .catch((error) => {
              if (epoch !== this.epoch) return;
              this.value.state = "error";
              this.value.errorCode =
                error instanceof Error && /^[A-Z_]{2,64}$/.test(error.message)
                  ? error.message
                  : "LIBRARY_UNAVAILABLE";
              this.emit();
            });
        },
      );
    } catch (error) {
      this.watches.delete(page);
      throw error;
    }
  }
  async nextPage() {
    if (!this.scope || !this.value.nextCursor) return;
    if (this.watches.has(this.value.nextCursor))
      throw new Error("LIBRARY_SNAPSHOT_INVALID");
    this.cursor = this.value.nextCursor;
    this.value.accountState = "connecting";
    this.emit();
    this.bind(this.epoch);
  }
  async refreshLocal(epoch = this.epoch): Promise<void> {
    const scope = this.scope,
      snapshot = await this.options.store.snapshot(scope);
    this.current(scope, epoch);
    const offline = new Set<string>();
    for (const job of snapshot.account.jobs) {
      this.current(scope, epoch);
      if (
        scope &&
        job.metadata.can_download_output &&
        (await this.options.cache.lookup(
          job.metadata,
          scope,
          this.abort.signal,
        ))
      )
        offline.add(job.metadata.id);
    }
    this.current(scope, epoch);
    const preferences = scope
      ? snapshot.account.preferences
      : snapshot.guest.preferences;
    let tracks = mergeLibrary(
      snapshot.guest.entries,
      snapshot.account.jobs,
      snapshot.account.links,
      preferences,
      offline,
    );
    for (const local of snapshot.guest.entries) {
      this.current(scope, epoch);
      const available = async (variant: "voice" | "original") => {
        try {
          await this.options.cache.local(
            local.personalJobId,
            variant === "voice" ? local.vocals : local.original,
            variant,
          );
          return true;
        } catch {
          return false;
        }
      };
      const voice = await available("voice"),
        original = await available("original");
      this.current(scope, epoch);
      const id = localTrackId(local),
        track = tracks.find((track) => track.id === id),
        linked =
          scope && track?.jobId
            ? snapshot.account.jobs.find(
                (job) => job.metadata.id === track.jobId,
              )
            : undefined;
      const voiceRestored = !!(
        linked?.metadata.output &&
        Buffer.from(linked.metadata.output.sha256, "base64").toString("hex") ===
          local.vocals.sha256 &&
        offline.has(linked.metadata.id)
      );
      const originalRemote = !!(
        linked?.metadata.can_download_input &&
        Buffer.from(linked.metadata.input.sha256, "base64").toString("hex") ===
          local.original.sha256
      );
      tracks = tracks.map((track) =>
        track.id === id
          ? {
              ...track,
              offline: voice || voiceRestored,
              canExport: voice || voiceRestored,
              originalAvailable: original || originalRemote,
            }
          : track,
      );
    }
    if (this.options.history) {
      const identities = tracks.map((track) => this.historyIdentity(track));
      this.historyAvailable = true;
      try {
        await this.options.history.reconcile(identities);
      } catch {
        this.historyAvailable = false; /* History owns its separate recovery state. Media remains usable. */
      }
      this.current(scope, epoch);
      tracks = this.historyCounts(tracks);
    }
    this.all = tracks;
    this.value.state = "ready";
    this.render();
  }
  private render(hydrate = true) {
    this.value.tracks = this.all;
    this.value.visibleIds = visibleLibrary(this.all, this.value.query).map(
      (track) => track.id,
    );
    this.value.total = this.all.length;
    this.emit();
    if (hydrate) {
      const version = ++this.hydrationVersion;
      if (this.options.thumbnail)
        void this.hydrateThumbnails(this.epoch, version).catch(() => {});
    }
  }
  private pixel(url: string | null): Promise<string | null> {
    if (!url || !this.options.thumbnail) return Promise.resolve(null);
    let pending = this.pixels.get(url);
    if (!pending) {
      if (this.pixels.size >= 128)
        this.pixels.delete(this.pixels.keys().next().value!);
      pending = this.options
        .thumbnail(url, this.abort.signal)
        .then((value) =>
          value &&
          value.length <= 180000 &&
          /^data:image\/(?:jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value)
            ? value
            : null,
        )
        .catch(() => null);
      this.pixels.set(url, pending);
    }
    return pending;
  }
  private async hydrateThumbnails(
    epoch: number,
    version: number,
  ): Promise<void> {
    const scope = this.scope,
      visible = this.value.visibleIds
        .slice(0, 50)
        .map((id) => this.all.find((track) => track.id === id))
        .filter((track): track is LibraryTrackView => !!track),
      resolved = new Map<string, string | null>();
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, visible.length) }, async () => {
        while (index < visible.length) {
          const track = visible[index++]!;
          const pixels = await this.pixel(track.thumbnailUrl);
          this.current(scope, epoch);
          if (version !== this.hydrationVersion) return;
          resolved.set(track.id, pixels);
        }
      }),
    );
    this.current(scope, epoch);
    if (version !== this.hydrationVersion) return;
    let budget = 4 * 1024 ** 2,
      changed = false;
    this.all = this.all.map((track) => {
      if (!resolved.has(track.id)) {
        if (track.thumbnailDataUrl) {
          changed = true;
          return { ...track, thumbnailDataUrl: null };
        }
        return track;
      }
      let data = resolved.get(track.id) ?? null;
      if (data && data.length > budget) data = null;
      if (data) budget -= data.length;
      if (track.thumbnailDataUrl === data) return track;
      changed = true;
      return { ...track, thumbnailDataUrl: data };
    });
    if (changed) {
      this.value.tracks = this.all;
      this.emit();
    }
  }
  async act(input: unknown): Promise<void> {
    const action: LibraryAction = parseLibraryAction(input);
    if (action.type === "QUERY") {
      this.value.query = { ...action.query };
      this.render();
      return;
    }
    const scope = this.scope,
      epoch = this.epoch;
    this.current(scope, epoch);
    const track = this.all.find((row) => row.id === action.trackId);
    if (!track) throw new Error("LIBRARY_NOT_FOUND");
    if (
      action.type === "STAR" ||
      action.type === "HIDE" ||
      action.type === "RESTORE"
    )
      await this.options.store.preferences(scope, (p) => {
        const ids = [track.id, ...(track.jobId ? [track.jobId] : [])];
        if (action.type === "STAR") {
          p.starred = p.starred.filter((id) => !ids.includes(id));
          if (!track.starred) p.starred.push(track.id);
        } else {
          p.hidden = p.hidden.filter((id) => !ids.includes(id));
          if (action.type === "HIDE") p.hidden.push(track.id);
        }
      });
    else if (action.type === "DELETE_LOCAL")
      await this.options.deleteLocal(track.id, scope, this.abort.signal);
    else if (action.type === "REMOVE_CACHE") {
      if (!scope || !track.accountOwned)
        throw new Error("LIBRARY_ACTION_UNAVAILABLE");
      await this.options.removeCache(track, scope, this.abort.signal);
    } else {
      if (!scope || !track.jobId) throw new Error("LIBRARY_ACTION_UNAVAILABLE");
      if (action.type === "RENAME")
        await this.options.request(
          scope,
          `/jobs/${track.jobId}`,
          "PATCH",
          { display_name: action.title.trim() },
          this.abort.signal,
        );
      else
        await this.options.request(
          scope,
          `/jobs/${track.jobId}`,
          "DELETE",
          undefined,
          this.abort.signal,
        );
    }
    this.current(scope, epoch);
    if (action.type === "DELETE_ACCOUNT") {
      await this.options.accountDeleted?.(track.id, scope!);
      this.current(scope, epoch);
    }
    await this.refreshLocal(epoch);
  }
  async download(
    trackId: string,
    variant: "voice" | "original" = "voice",
    request?: { scope: SessionAccountScope | null; signal: AbortSignal },
  ): Promise<void> {
    const scope = this.scope,
      epoch = this.epoch,
      signal = request
        ? AbortSignal.any([this.abort.signal, request.signal])
        : this.abort.signal,
      current = () => {
        signal.throwIfAborted();
        this.current(scope, epoch);
        if (request && !same(request.scope, scope))
          throw new Error("ACCOUNT_CHANGED");
      };
    current();
    const snapshot = await this.options.store.snapshot(scope),
      local = snapshot.guest.entries.find(
        (entry) => localTrackId(entry) === trackId,
      );
    current();
    if (local) {
      try {
        await this.options.cache.local(
          local.personalJobId,
          variant === "voice" ? local.vocals : local.original,
          variant,
        );
        current();
        return;
      } catch (error) {
        current();
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!scope) throw new Error("AUTHENTICATION_REQUIRED");
    const link = local
      ? snapshot.account.links.find(
          (link) =>
            link.localId === trackId &&
            link.outputSha256 === local.vocals.sha256,
        )
      : undefined;
    const job = snapshot.account.jobs.find(
      (row) => row.metadata.id === (local ? link?.jobId : trackId),
    );
    if (!job) throw new Error("LIBRARY_NOT_FOUND");
    if (local) {
      const selected =
          variant === "voice" ? job.metadata.output : job.metadata.input,
        expected = variant === "voice" ? local.vocals : local.original;
      if (
        !selected ||
        selected.bytes !== expected.bytes ||
        Buffer.from(selected.sha256, "base64").toString("hex") !==
          expected.sha256
      )
        throw new Error("LIBRARY_RESULT_INVALID");
    }
    const grant = parseDownloadGrant(
      await this.options.request(
        scope,
        `/jobs/${job.metadata.id}/download-grants`,
        "POST",
        { variant: variant === "voice" ? "output" : "input" },
        signal,
      ),
    );
    current();
    await this.options.cache.download(
      job.metadata,
      grant,
      scope,
      signal,
      variant,
    );
    current();
    await this.refreshLocal(epoch);
    current();
  }
  async adoptCloudResult(
    capability: string,
    jobId: string,
    scope: SessionAccountScope,
    trustedMetadata?: unknown,
  ) {
    this.current(scope);
    const epoch = this.epoch,
      snapshot = await this.options.store.snapshot(scope);
    let job = snapshot.account.jobs.find((row) => row.metadata.id === jobId);
    const metadata =
      trustedMetadata ??
      this.options.trustedResultMetadata?.(capability, scope);
    if (!job && metadata !== undefined) {
      job = accountLibraryJob(metadata);
      if (job.metadata.id !== jobId || job.metadata.status !== "ready")
        throw new Error("LIBRARY_RESULT_INVALID");
    }
    if (!job) throw new Error("LIBRARY_RESULT_UNAVAILABLE");
    await this.options.cache.adopt(
      capability,
      job.metadata,
      scope,
      this.abort.signal,
    );
    this.current(scope, epoch);
    if (!snapshot.account.jobs.some((row) => row.metadata.id === jobId))
      await this.options.store.saveAccountJobs(
        scope,
        [job, ...snapshot.account.jobs].slice(0, 4096),
      );
    this.current(scope, epoch);
    await this.refreshLocal(epoch);
  }
  async thumbnail(trackId: string): Promise<string | null> {
    const scope = this.scope,
      epoch = this.epoch,
      track = this.all.find((track) => track.id === trackId);
    if (!track || !this.options.thumbnail) return null;
    this.current(scope, epoch);
    const result = await this.pixel(track.thumbnailUrl);
    this.current(scope, epoch);
    return result;
  }
  async flush() {
    await this.serial;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.stopCounts?.();
    this.epoch++;
    this.abort.abort();
    for (const watch of this.watches.values()) watch.off();
    this.watches.clear();
    this.pages.clear();
    this.listeners.clear();
  }
}
