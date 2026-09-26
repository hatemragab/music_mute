import { ApiError } from "../api/client";
import { fromWire, toWire } from "../api/wire";

export type ConnectionState =
  "connecting" | "live" | "reconnecting" | "offline" | "paused" | "signedOut";
interface Ticket {
  ticket: string;
  path: string;
  protocol: string;
  expiresAt: string;
}
type Result =
  { data: unknown; error?: never } | { error: ApiError; data?: never };
interface Entry {
  id: string;
  resource: string;
  params: Record<string, string>;
  sequence: number;
  listeners: Set<(result: Result) => void>;
  last?: Result;
  timeout?: ReturnType<typeof setTimeout>;
}

/** Shared, session-owned raw socket. Subscriptions survive reconnect; credentials do not. */
export class RealtimeClient {
  private socket?: WebSocket;
  private ticketAbort?: AbortController;
  private generation = 0;
  private stopped = true;
  private stream = "";
  private nextId = 0;
  private attempts = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private entries = new Map<string, Entry>();
  private stateListeners = new Set<() => void>();
  private state: ConnectionState = "connecting";

  constructor(
    private readonly options: {
      origin: string;
      ticket: (signal: AbortSignal, refresh: boolean) => Promise<Ticket>;
      socket?: (url: string, protocols: string[]) => WebSocket;
      onSessionExpired?: () => void;
    },
  ) {}

  getState = (): ConnectionState => this.state;
  onState = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    window.addEventListener("online", this.resume);
    window.addEventListener("offline", this.resume);
    document.addEventListener("visibilitychange", this.resume);
    this.resume();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("online", this.resume);
    window.removeEventListener("offline", this.resume);
    document.removeEventListener("visibilitychange", this.resume);
    this.disconnect();
  }

  reconnect = (): void => {
    if (this.stopped) return;
    this.disconnect();
    this.attempts = 0;
    this.resume();
  };

  watch(
    resource: string,
    params: Record<string, string>,
    listener: (result: Result) => void,
  ): () => void {
    const key = JSON.stringify([resource, Object.entries(params).sort()]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        id: `s${++this.nextId}`,
        resource,
        params,
        sequence: 0,
        listeners: new Set(),
      };
      this.entries.set(key, entry);
      if (this.stream) this.subscribe(entry);
    }
    entry.listeners.add(listener);
    if (entry.last) listener(entry.last);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) {
        clearTimeout(entry.timeout);
        this.send({ type: "unsubscribe", subscription_id: entry.id });
        this.entries.delete(key);
      }
    };
  }

  read<T>(
    resource: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let off = () => {};
      let settled = false;
      const done = (error?: unknown, data?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        off();
        if (error) reject(error);
        else resolve(data as T);
      };
      const abort = () => done(new DOMException("Aborted", "AbortError"));
      const timeout = setTimeout(
        () => done(new ApiError(503, "SERVICE_UNAVAILABLE")),
        15_000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      off = this.watch(resource, params, (result) =>
        done(result.error, result.data),
      );
      if (settled) off();
    });
  }

  private resume = (): void => {
    if (this.stopped) return;
    if (!navigator.onLine || document.visibilityState === "hidden") {
      this.disconnect();
      this.setState(navigator.onLine ? "paused" : "offline");
      return;
    }
    if (!this.socket && !this.ticketAbort && !this.retry) void this.connect();
  };

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const abort = new AbortController();
    this.ticketAbort = abort;
    this.setState(this.attempts ? "reconnecting" : "connecting");
    const deadline = setTimeout(() => abort.abort(), 10_000);
    try {
      let grant: Ticket;
      try {
        grant = await this.options.ticket(abort.signal, false);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
        grant = await this.options.ticket(abort.signal, true);
      }
      if (generation !== this.generation || this.stopped) return;
      if (
        grant.path !== "/realtime/socket" ||
        grant.protocol !== "musicmute.realtime.v1" ||
        !/^[A-Za-z0-9_-]{43}$/.test(grant.ticket)
      )
        throw new Error("Invalid realtime ticket");
      const url = new URL(grant.path, this.options.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = (
        this.options.socket ??
        ((url, protocols) => new WebSocket(url, protocols))
      )(url.href, [grant.protocol, `ticket.${grant.ticket}`]);
      this.socket = socket;
      this.armWatchdog(10_000);
      socket.onmessage = (event) => {
        if (generation === this.generation) this.message(String(event.data));
      };
      socket.onerror = () => socket.close();
      socket.onclose = (event) => {
        if (generation !== this.generation) return;
        this.disconnect();
        if (event.code === 4001) this.options.onSessionExpired?.();
        this.schedule();
      };
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        this.setState("signedOut");
      } else
        this.schedule(error instanceof ApiError ? error.retryAfter : undefined);
    } finally {
      clearTimeout(deadline);
      if (this.ticketAbort === abort) this.ticketAbort = undefined;
    }
  }

  private message(raw: string): void {
    try {
      if (raw.length > 256 * 1024) throw new Error();
      const frame = JSON.parse(raw) as Record<string, unknown>;
      if (frame.type === "ping") {
        this.send({ type: "pong" });
        this.armWatchdog(65_000);
        return;
      }
      if (frame.type === "ready") {
        if (frame.protocol_version !== 1 || typeof frame.stream_id !== "string")
          throw new Error();
        this.stream = frame.stream_id;
        this.attempts = 0;
        this.armWatchdog(65_000);
        for (const entry of this.entries.values()) this.subscribe(entry);
        if (!this.entries.size) this.setState("live");
        return;
      }
      if (frame.stream_id !== this.stream) return;
      const entry = [...this.entries.values()].find(
        (item) => item.id === frame.subscription_id,
      );
      if (!entry) return;
      if (frame.type === "snapshot") {
        if (
          !Number.isSafeInteger(frame.sequence) ||
          Number(frame.sequence) < 1 ||
          frame.protocol_version !== 1
        )
          throw new Error();
        const sequence = Number(frame.sequence);
        if (sequence <= entry.sequence) return;
        if (entry.sequence && sequence !== entry.sequence + 1) {
          entry.sequence = 0;
          this.send({ type: "resync", subscription_id: entry.id });
          return;
        }
        entry.sequence = sequence;
        clearTimeout(entry.timeout);
        entry.last = { data: fromWire(frame.data) };
        for (const listener of entry.listeners) listener(entry.last);
        if ([...this.entries.values()].every((item) => item.sequence > 0))
          this.setState("live");
      } else if (frame.type === "subscription_error") {
        if (typeof frame.code !== "string" || typeof frame.status !== "number")
          throw new Error();
        clearTimeout(entry.timeout);
        entry.last = { error: new ApiError(frame.status, frame.code) };
        for (const listener of entry.listeners) listener(entry.last);
        if (frame.status >= 500) {
          this.disconnect();
          this.schedule();
        }
      }
    } catch {
      this.disconnect();
      this.schedule();
    }
  }

  private subscribe(entry: Entry): void {
    entry.sequence = 0;
    entry.last = undefined;
    clearTimeout(entry.timeout);
    entry.timeout = setTimeout(() => {
      this.disconnect();
      this.schedule();
    }, 10_000);
    this.send({
      type: "subscribe",
      subscription_id: entry.id,
      resource: entry.resource,
      params: toWire(entry.params),
    });
  }

  private send(value: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(value));
  }

  private armWatchdog(ms: number): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.disconnect();
      this.schedule();
    }, ms);
  }

  private schedule(retryAfter?: number): void {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.setState(navigator.onLine ? "reconnecting" : "offline");
    const ms = Math.max(
      (retryAfter ?? 0) * 1000,
      Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)) *
        (0.8 + Math.random() * 0.4),
    );
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.resume();
    }, ms);
  }

  private disconnect(): void {
    this.generation++;
    this.ticketAbort?.abort();
    this.ticketAbort = undefined;
    clearTimeout(this.retry);
    this.retry = undefined;
    clearTimeout(this.watchdog);
    const socket = this.socket;
    this.socket = undefined;
    this.stream = "";
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
    }
    for (const entry of this.entries.values()) {
      clearTimeout(entry.timeout);
      entry.last = undefined;
      entry.sequence = 0;
    }
  }

  private setState(state: ConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    for (const listener of this.stateListeners) listener();
  }
}
