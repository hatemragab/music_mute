import type { AccountSessionScope } from "../account/account-controller.js";
import type { PlaybackAccountingPort } from "../player/controller.js";
import {
  parseHistoryCommand,
  type HistoryTrack,
  type HistoryView,
} from "../../shared/history-contracts.js";
import {
  encodeHistory,
  HISTORY_MAX_ENTRIES,
  HISTORY_MAX_CATALOG,
  HISTORY_MAX_RECEIPTS,
  historyScope,
  historyTrack,
  reconcileAliases,
  trackAliases,
  validSession,
  type HistoryRecord,
  type HistoryScope,
} from "./model.js";
import type { HistoryStore } from "./store.js";
interface Fence {
  epoch: number;
  scope: HistoryScope;
}
interface ActiveSession {
  fence: Fence;
  trackId: string;
  aliases: string[];
  position: number | null;
  time: number;
  rate: number | null;
}
export interface HistoryOptions {
  device: { sid: string; installationId: string };
  store: HistoryStore;
  now?: () => number;
}
/** Trusted Library ownership, distinct from a media grant's temporary account source. */
export type HistoryMetricTrack = HistoryTrack & { accountOwned?: boolean };
function metricTrack(track: HistoryMetricTrack): HistoryTrack {
  if (
    track.accountOwned !== undefined &&
    typeof track.accountOwned !== "boolean"
  )
    throw new Error("HISTORY_EVENT_INVALID");
  const { accountOwned: _ownership, ...raw } = track;
  return historyTrack(raw);
}
/** Device-private history; account generations fence events but never merge persisted owners. */
export class HistoryController implements PlaybackAccountingPort {
  private epoch = 0;
  private account: AccountSessionScope | null = null;
  private scope: HistoryScope;
  private record: HistoryRecord | null = null;
  private value: HistoryView = {
    state: "loading",
    errorCode: null,
    entries: [],
  };
  private load: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private readonly tracks = new Map<string, HistoryTrack>();
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly listeners = new Set<(view: HistoryView) => void>();
  private dirty = false;
  private disposed = false;
  private closing = false;
  private disposal: Promise<void> | undefined;
  private lastSaved = 0;
  private guestHistory: HistoryController | undefined;
  private readonly countListeners = new Set<() => void>();
  private lastCountSignature = "";
  private readonly now: () => number;
  constructor(
    private readonly options: HistoryOptions,
    private readonly guestOnly = false,
  ) {
    this.scope = historyScope(options.device, null);
    this.now = options.now ?? Date.now;
    void this.setScope(null);
  }
  view(): HistoryView {
    if (!this.account && this.guestHistory) return this.guestHistory.view();
    return structuredClone(this.value);
  }
  private guest(): HistoryController {
    if (this.disposed || this.closing) throw new Error("HISTORY_CLOSED");
    if (this.guestOnly) return this;
    if (!this.guestHistory) {
      const delegate = new HistoryController(this.options, true);
      this.guestHistory = delegate;
      delegate.subscribeCounts(() => this.emitCounts());
      delegate.subscribe(() => {
        if (!this.account) this.notify();
      });
    }
    return this.guestHistory;
  }
  subscribeCounts(listener: () => void): () => void {
    this.countListeners.add(listener);
    listener();
    return () => this.countListeners.delete(listener);
  }
  private countSignature(): string {
    return JSON.stringify([
      this.scope.ownerKey,
      this.value.state,
      this.record?.entries.map((row) => [row.aliases, row.count]) ?? [],
      this.guestHistory?.countSignature() ?? null,
    ]);
  }
  private emitCounts(): void {
    const signature = this.countSignature();
    if (signature === this.lastCountSignature) return;
    this.lastCountSignature = signature;
    for (const listener of this.countListeners) {
      try {
        listener();
      } catch {}
    }
  }
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {}
    }
  }
  subscribe(listener: (view: HistoryView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(): void {
    this.value = {
      ...this.value,
      entries: this.record ? structuredClone(this.record.entries) : [],
    };
    this.notify();
    this.emitCounts();
  }
  private fence(): Fence {
    if (this.disposed || this.closing) throw new Error("HISTORY_CLOSED");
    return { epoch: this.epoch, scope: { ...this.scope } };
  }
  private current(fence: Fence): void {
    if (
      this.disposed ||
      fence.epoch !== this.epoch ||
      fence.scope.ownerKey !== this.scope.ownerKey
    )
      throw new Error("HISTORY_OWNER_CHANGED");
  }
  private queue(run: () => Promise<void>): Promise<void> {
    const epoch = this.epoch;
    const next = this.writes
      .catch(() => {})
      .then(run)
      .catch((error) => {
        if (!this.disposed && this.epoch === epoch) {
          this.value.errorCode = this.safe(error);
          this.publish();
        }
        throw error;
      });
    this.writes = next;
    return next;
  }
  async setScope(account: AccountSessionScope | null): Promise<void> {
    if (this.guestOnly && account) throw new Error("HISTORY_SCOPE_INVALID");
    if (this.disposed || this.closing) throw new Error("HISTORY_CLOSED");
    if (
      account &&
      (typeof account.generation !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          account.generation,
        ))
    )
      throw new Error("HISTORY_SCOPE_INVALID");
    if (
      this.epoch > 0 &&
      this.account?.firebaseUid === account?.firebaseUid &&
      this.account?.generation === account?.generation
    )
      return this.load;
    const previous =
        this.record && this.dirty ? structuredClone(this.record) : null,
      previousScope = { ...this.scope };
    if (previous)
      void this.queue(async () => {
        // An in-flight count may commit during account switching. A detached
        // progress snapshot must never overwrite that newer durable revision.
        const latest = await this.options.store.read(previousScope);
        if (
          latest.state === "ready" &&
          latest.record &&
          latest.record.revision <= previous.revision
        ) {
          if (previous.revision === Number.MAX_SAFE_INTEGER)
            throw new Error("HISTORY_CAPACITY_REACHED");
          previous.revision++;
          await this.options.store.write(previousScope, previous);
        }
      }).catch(() => {});
    this.scope = historyScope(
      this.options.device,
      account?.firebaseUid ?? null,
    );
    this.account = account ? { ...account } : null;
    this.epoch++;
    this.record = null;
    this.dirty = false;
    this.sessions.clear();
    this.tracks.clear();
    this.value = { state: "loading", errorCode: null, entries: [] };
    this.publish();
    const fence = this.fence();
    this.load = (async () => {
      const result = await this.options.store.read(fence.scope);
      this.current(fence);
      this.record = result.record;
      this.value = {
        state: result.state,
        errorCode: result.errorCode,
        entries: [],
      };
      this.lastSaved = this.now();
      this.publish();
    })().catch((error) => {
      if (fence.epoch !== this.epoch || this.disposed) return;
      this.record = null;
      this.value = {
        state: "unavailable",
        errorCode: this.safe(error),
        entries: [],
      };
      this.publish();
    });
    return this.load;
  }
  restore(): Promise<void> {
    return !this.guestOnly && !this.account
      ? this.guest().restore()
      : this.load;
  }
  private safe(error: unknown): string {
    return error instanceof Error && /^HISTORY_[A-Z_]+$/.test(error.message)
      ? error.message
      : "HISTORY_STORAGE_UNAVAILABLE";
  }
  private async ready(fence: Fence): Promise<HistoryRecord> {
    await this.load;
    this.current(fence);
    if (this.value.state !== "ready" || !this.record)
      throw new Error(this.value.errorCode ?? "HISTORY_UNAVAILABLE");
    return structuredClone(this.record);
  }
  private async persist(fence: Fence, record: HistoryRecord): Promise<void> {
    this.current(fence);
    if (record.revision === Number.MAX_SAFE_INTEGER)
      throw new Error("HISTORY_CAPACITY_REACHED");
    record.revision++;
    encodeHistory(record);
    try {
      await this.options.store.write(fence.scope, record);
    } catch (error) {
      // Atomic rename may have committed before its post-write check failed. Read back
      // the same owner before allowing a retry to increment a session a second time.
      const result = await this.options.store
        .read(fence.scope)
        .catch(() => null);
      if (
        fence.epoch === this.epoch &&
        !this.disposed &&
        result?.state === "ready" &&
        result.record
      ) {
        this.record = result.record;
        this.dirty = false;
        this.value.errorCode = this.safe(error);
        this.publish();
      }
      throw error;
    }
    this.current(fence);
    this.record = record;
    this.dirty = false;
    this.lastSaved = this.now();
    this.value.errorCode = null;
    this.publish();
  }
  async reconcile(tracks: readonly HistoryMetricTrack[]): Promise<void> {
    this.fence();
    if (tracks.length > HISTORY_MAX_CATALOG)
      throw new Error("HISTORY_CAPACITY_REACHED");
    tracks.forEach(metricTrack);
    if (!this.guestOnly) {
      const guests = tracks.filter((track) => track.accountOwned === false),
        current = tracks.filter((track) => track.accountOwned !== false);
      if (!this.account) {
        if (current.some((track) => track.accountOwned === true))
          throw new Error("HISTORY_SCOPE_INVALID");
        return this.guest().reconcile(tracks.map(metricTrack));
      }
      const result = await Promise.allSettled([
        guests.length
          ? this.guest().reconcile(guests.map(metricTrack))
          : Promise.resolve(),
        this.reconcileOwned(current),
      ]);
      const failed = result.find(
        (entry): entry is PromiseRejectedResult => entry.status === "rejected",
      );
      if (failed) throw failed.reason;
      return;
    }
    return this.reconcileOwned(tracks);
  }
  private reconcileOwned(tracks: readonly HistoryMetricTrack[]): Promise<void> {
    if (tracks.length > HISTORY_MAX_CATALOG)
      throw new Error("HISTORY_CAPACITY_REACHED");
    const fence = this.fence(),
      parsed = tracks.map(metricTrack);
    if (
      new Set([...this.tracks.keys(), ...parsed.map((t) => t.id)]).size >
      HISTORY_MAX_CATALOG
    )
      throw new Error("HISTORY_CAPACITY_REACHED");
    for (const track of parsed) this.tracks.set(track.id, track);
    return this.queue(async () => {
      const record = await this.ready(fence),
        before = JSON.stringify(record.entries);
      for (const track of parsed) reconcileAliases(record, trackAliases(track));
      if (JSON.stringify(record.entries) !== before)
        await this.persist(fence, record);
    });
  }
  canCount(track: HistoryMetricTrack | string): boolean {
    if (
      typeof track !== "string" &&
      track.accountOwned === true &&
      !this.account
    )
      return false;
    if (
      !this.guestOnly &&
      typeof track !== "string" &&
      track.accountOwned === false
    )
      return this.guest().canCount(metricTrack(track));
    if (!this.account && this.guestHistory)
      return this.guestHistory.canCount(
        typeof track === "string" ? track : metricTrack(track),
      );
    return this.value.state === "ready" && !!this.record;
  }
  count(track: HistoryMetricTrack | string): number {
    if (
      typeof track !== "string" &&
      track.accountOwned === true &&
      !this.account
    )
      return 0;
    if (
      !this.guestOnly &&
      typeof track !== "string" &&
      track.accountOwned === false
    )
      return this.guest().count(metricTrack(track));
    if (!this.account && this.guestHistory)
      return this.guestHistory.count(
        typeof track === "string" ? track : metricTrack(track),
      );
    const aliases =
      typeof track === "string" ? [track] : trackAliases(metricTrack(track));
    return Math.max(
      0,
      ...(this.record?.entries
        .filter((r) => r.aliases.some((a) => aliases.includes(a)))
        .map((r) => r.count) ?? []),
    );
  }
  mostPlayed<T extends HistoryMetricTrack>(
    tracks: readonly T[],
    onlyPlayed = false,
  ): T[] {
    return tracks
      .filter((t) => !onlyPlayed || this.count(t) > 0)
      .slice()
      .sort(
        (a, b) =>
          this.count(b) - this.count(a) ||
          a.title.localeCompare(b.title, undefined, {
            numeric: true,
            sensitivity: "base",
          }) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
  }
  captureAccounting(): PlaybackAccountingPort {
    const fence = this.fence();
    return {
      begin: (trackId, id) => this.beginFor(fence, trackId, id),
      pulse: (trackId, id, position, rate) => {
        try {
          this.current(fence);
        } catch {
          return Promise.resolve();
        }
        return this.pulse(trackId, id, position, rate);
      },
      end: (trackId, id) => {
        try {
          this.current(fence);
        } catch {
          return Promise.resolve();
        }
        return this.end(trackId, id);
      },
    };
  }
  accountingFor(track: HistoryMetricTrack): PlaybackAccountingPort {
    const parsed = metricTrack(track);
    if (track.accountOwned === true && !this.account)
      throw new Error("HISTORY_SCOPE_INVALID");
    this.fence();
    const actor =
      track.accountOwned === false || !this.account ? this.guest() : this;
    if (
      !actor.tracks.has(parsed.id) &&
      actor.tracks.size >= HISTORY_MAX_CATALOG
    )
      throw new Error("HISTORY_CAPACITY_REACHED");
    actor.tracks.set(parsed.id, parsed);
    const port = actor.captureAccounting();
    const assertTrack = (id: string) => {
      if (id !== parsed.id) throw new Error("HISTORY_SESSION_CONFLICT");
    };
    return {
      begin: (id, session) => {
        assertTrack(id);
        return port.begin(id, session);
      },
      pulse: (id, session, position, rate) => {
        assertTrack(id);
        return port.pulse(id, session, position, rate);
      },
      end: (id, session) => {
        assertTrack(id);
        return port.end(id, session);
      },
    };
  }
  begin(trackId: string, sessionId: string): Promise<void> {
    return this.beginFor(this.fence(), trackId, sessionId);
  }
  private beginFor(
    fence: Fence,
    trackId: string,
    sessionId: string,
  ): Promise<void> {
    this.current(fence);
    if (!this.guestOnly && !this.account)
      return this.guest()
        .begin(trackId, sessionId)
        .then(() => this.current(fence));
    sessionId = validSession(sessionId);
    const track = historyTrack(
        this.tracks.get(trackId) ?? { id: trackId, title: "" },
      ),
      aliases = trackAliases(track),
      started = this.now();
    return this.queue(async () => {
      const record = await this.ready(fence),
        receipt = record.receipts.find((r) => r.sessionId === sessionId),
        existing = reconcileAliases(record, aliases);
      if (receipt) {
        if (!existing?.aliases.includes(receipt.trackId))
          throw new Error("HISTORY_SESSION_CONFLICT");
        return;
      }
      if (
        record.receipts.length >= HISTORY_MAX_RECEIPTS ||
        this.sessions.size >= 32 ||
        (!existing && record.entries.length >= HISTORY_MAX_ENTRIES)
      )
        throw new Error("HISTORY_CAPACITY_REACHED");
      const entry = existing ?? {
        aliases,
        count: 0,
        lastListenedAt: new Date(started).toISOString(),
        listenedSeconds: 0,
        lastPosition: 0,
      };
      entry.count = Math.min(Number.MAX_SAFE_INTEGER, entry.count + 1);
      entry.lastListenedAt = new Date(started).toISOString();
      if (!existing) record.entries.push(entry);
      record.receipts.push({ sessionId, trackId });
      await this.persist(fence, record);
      this.sessions.set(sessionId, {
        fence,
        trackId,
        aliases: entry.aliases,
        position: null,
        time: started,
        rate: null,
      });
    });
  }
  pulse(
    trackId: string,
    sessionId: string,
    position: number,
    rate: number,
  ): Promise<void> {
    if (!this.guestOnly && !this.account && this.guestHistory)
      return this.guestHistory.pulse(trackId, sessionId, position, rate);
    sessionId = validSession(sessionId);
    if (
      !Number.isFinite(position) ||
      position < 0 ||
      position > 7200 ||
      !Number.isFinite(rate) ||
      rate < 0.25 ||
      rate > 3
    )
      return Promise.reject(new Error("HISTORY_EVENT_INVALID"));
    const active = this.sessions.get(sessionId);
    if (!active) return Promise.resolve();
    if (active.trackId !== trackId)
      return Promise.reject(new Error("HISTORY_SESSION_CONFLICT"));
    const time = this.now();
    return this.queue(async () => {
      const record = await this.ready(active.fence),
        row = reconcileAliases(record, active.aliases);
      if (!row || !this.sessions.has(sessionId)) return;
      const elapsed = (time - active.time) / 1000,
        delta = active.position === null ? 0 : position - active.position;
      // A seek, loop jump, delayed buffer callback or changed rate establishes a new
      // baseline. It cannot manufacture listened time from a timeline discontinuity.
      if (
        elapsed > 0 &&
        elapsed <= 5 &&
        active.rate === rate &&
        delta > 0 &&
        delta <= elapsed * rate + 0.25
      ) {
        row.listenedSeconds = Math.min(
          Number.MAX_SAFE_INTEGER,
          row.listenedSeconds + delta,
        );
        row.lastListenedAt = new Date(time).toISOString();
      }
      row.lastPosition = position;
      active.position = position;
      active.time = time;
      active.rate = rate;
      this.current(active.fence);
      this.record = record;
      this.dirty = true;
      this.publish();
      if (time - this.lastSaved >= 5000)
        await this.persist(active.fence, record);
    });
  }
  end(trackId: string, sessionId: string): Promise<void> {
    if (!this.guestOnly && !this.account && this.guestHistory)
      return this.guestHistory.end(trackId, sessionId);
    sessionId = validSession(sessionId);
    const active = this.sessions.get(sessionId);
    if (!active) return Promise.resolve();
    if (active.trackId !== trackId)
      return Promise.reject(new Error("HISTORY_SESSION_CONFLICT"));
    return this.queue(async () => {
      this.current(active.fence);
      this.sessions.delete(sessionId);
      if (this.dirty && this.record)
        await this.persist(active.fence, structuredClone(this.record));
    });
  }
  flush(): Promise<void> {
    if (!this.guestOnly && !this.account && this.guestHistory)
      return this.guestHistory.flush();
    const fence = this.fence();
    return this.queue(async () => {
      await this.ready(fence);
      if (this.dirty && this.record)
        await this.persist(fence, structuredClone(this.record));
    });
  }
  execute(value: unknown): Promise<void> {
    if (!this.guestOnly && !this.account) return this.guest().execute(value);
    const command = parseHistoryCommand(value),
      fence = this.fence();
    if (command.type === "RESTORE") return this.load;
    return this.queue(async () => {
      this.current(fence);
      const result =
        command.type === "RECOVER"
          ? await this.options.store.recover(fence.scope)
          : await this.options.store.clear(fence.scope);
      this.current(fence);
      this.record = result.record;
      this.dirty = false;
      this.sessions.clear();
      this.value = {
        state: result.state,
        errorCode: result.errorCode,
        entries: [],
      };
      this.publish();
    });
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    const flush =
      this.value.state === "ready" ? this.flush() : Promise.resolve();
    this.closing = true;
    this.disposal = Promise.all([flush, this.guestHistory?.dispose()])
      .then(() => {})
      .finally(() => {
        this.disposed = true;
        this.epoch++;
        this.sessions.clear();
        this.listeners.clear();
        this.countListeners.clear();
      });
    return this.disposal;
  }
}
