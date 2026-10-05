import { desktopRecord } from "../shared/desktop-protocol.js";
import {
  DesktopApiError,
  accountApiOrigin,
  type AccountApiClient,
  type AccountScope,
} from "./account-api.js";

export type AccountTransport = Pick<
  AccountApiClient,
  "origin" | "request" | "assertCurrent"
>;
export type AccountResource = "jobs" | "job" | "import" | "usage" | "policy";
export type AccountConnectionState =
  "connecting" | "live" | "reconnecting" | "stopped";
export type AccountSnapshot =
  { data: unknown; error?: never } | { error: DesktopApiError; data?: never };
type Timer = ReturnType<typeof setTimeout>;
interface Subscription {
  id: string;
  resource: AccountResource;
  params: Record<string, string>;
  sequence: number;
  pendingSnapshot: boolean;
  listeners: Set<(snapshot: AccountSnapshot) => void>;
  last: AccountSnapshot | undefined;
  timeout: Timer | undefined;
}
export type AccountSocket = Pick<
  WebSocket,
  "readyState" | "send" | "close" | "onmessage" | "onclose" | "onerror"
>;
export interface AccountRealtimeOptions {
  api: AccountTransport;
  scope: AccountScope;
  signal?: AbortSignal;
  socket?: (url: string, protocols: string[]) => AccountSocket;
}

/** Native raw WebSocket transport. Each connection gets a fresh single-use ticket. */
export class AccountRealtimeClient {
  private readonly scope: AccountScope;
  private socket: AccountSocket | undefined;
  private ticketAbort: AbortController | undefined;
  private generation = 0;
  private stopped = true;
  private stream = "";
  private nextId = 0;
  private attempts = 0;
  private retry: Timer | undefined;
  private watchdog: Timer | undefined;
  private entries = new Map<string, Subscription>();
  private state: AccountConnectionState = "stopped";
  private stateListeners = new Set<(state: AccountConnectionState) => void>();
  constructor(private readonly options: AccountRealtimeOptions) {
    this.scope = {
      firebase_uid: options.scope.firebase_uid,
      session_generation: options.scope.session_generation,
    };
    accountApiOrigin(options.api.origin);
    options.signal?.addEventListener("abort", this.abort, { once: true });
  }
  getState(): AccountConnectionState {
    return this.state;
  }
  onState(listener: (state: AccountConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  start(): void {
    if (!this.stopped) return;
    this.current();
    this.stopped = false;
    void this.connect();
  }
  stop(): void {
    this.stopped = true;
    this.disconnect();
    this.setState("stopped");
  }
  close(): void {
    this.fail(new DesktopApiError("CANCELLED"));
    this.options.signal?.removeEventListener("abort", this.abort);
    this.entries.clear();
    this.stateListeners.clear();
  }
  reconnect(): void {
    if (this.stopped) return;
    this.current();
    this.disconnect();
    this.attempts = 0;
    void this.connect();
  }
  watch(
    resource: AccountResource,
    params: Record<string, string>,
    listener: (snapshot: AccountSnapshot) => void,
  ): () => void {
    this.current();
    validateParams(resource, params);
    const key = JSON.stringify([resource, Object.entries(params).sort()]);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 128)
        throw new DesktopApiError("REALTIME_LIMIT_REACHED");
      entry = {
        id: `s${++this.nextId}`,
        resource,
        params: { ...params },
        sequence: 0,
        pendingSnapshot: true,
        listeners: new Set(),
        last: undefined,
        timeout: undefined,
      };
      this.entries.set(key, entry);
      if (this.stream) this.subscribe(entry);
    }
    entry.listeners.add(listener);
    if (entry.last) this.notify(listener, entry.last);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) {
        clearTimeout(entry.timeout);
        this.send({ type: "unsubscribe", subscription_id: entry.id });
        this.entries.delete(key);
      }
    };
  }
  read(
    resource: AccountResource,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let off = () => {};
      let settled = false;
      const done = (error?: DesktopApiError, data?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        off();
        if (error) reject(error);
        else resolve(data);
      };
      const abort = () => done(new DesktopApiError("CANCELLED"));
      const timeout = setTimeout(
        () => done(new DesktopApiError("REALTIME_SNAPSHOT_TIMEOUT")),
        15_000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        off = this.watch(resource, params, (snapshot) =>
          done(snapshot.error, snapshot.data),
        );
        if (settled) off();
        this.start();
      } catch (error) {
        done(safeError(error));
      }
    });
  }
  private abort = (): void => {
    this.fail(new DesktopApiError("CANCELLED"));
  };
  private current(): void {
    this.options.api.assertCurrent(this.scope);
    if (this.options.signal?.aborted) throw new DesktopApiError("CANCELLED");
  }
  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const abort = new AbortController();
    this.ticketAbort = abort;
    this.setState(this.attempts ? "reconnecting" : "connecting");
    const deadline = setTimeout(() => abort.abort(), 10_000);
    try {
      this.current();
      const grant = await this.options.api.request(
        this.scope,
        "/realtime-tickets",
        "POST",
        {},
        abort.signal,
      );
      if (generation !== this.generation || this.stopped) return;
      this.current();
      if (
        !desktopRecord(grant) ||
        grant.path !== "/realtime/socket" ||
        grant.protocol !== "musicmute.realtime.v1" ||
        typeof grant.ticket !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(grant.ticket) ||
        typeof grant.expires_at !== "string" ||
        !Number.isFinite(Date.parse(grant.expires_at)) ||
        Date.parse(grant.expires_at) <= Date.now()
      )
        throw new DesktopApiError("REALTIME_TICKET_INVALID");
      const url = new URL(grant.path, this.options.api.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = (
        this.options.socket ??
        ((address, protocols) => new WebSocket(address, protocols))
      )(url.href, [grant.protocol, `ticket.${grant.ticket}`]);
      this.socket = socket;
      this.armWatchdog(10_000);
      socket.onmessage = (event) => {
        if (generation === this.generation && !this.stopped)
          this.message(event.data);
      };
      socket.onerror = () => {
        socket.close();
      };
      socket.onclose = () => {
        if (generation !== this.generation || this.stopped) return;
        this.disconnect();
        this.schedule();
      };
    } catch (error) {
      if (generation !== this.generation || this.stopped) return;
      const failure = safeError(error);
      if (
        failure.code === "ACCOUNT_CHANGED" ||
        failure.code === "CANCELLED" ||
        [401, 403].includes(failure.status)
      )
        this.fail(failure);
      else this.schedule(failure.retry_after_seconds);
    } finally {
      clearTimeout(deadline);
      if (this.ticketAbort === abort) this.ticketAbort = undefined;
    }
  }
  private message(raw: unknown): void {
    try {
      this.current();
      if (typeof raw !== "string" || Buffer.byteLength(raw) > 256 * 1024)
        throw new DesktopApiError("REALTIME_FRAME_INVALID");
      const frame: unknown = JSON.parse(raw);
      if (!desktopRecord(frame))
        throw new DesktopApiError("REALTIME_FRAME_INVALID");
      if (frame.type === "ping") {
        if (!this.stream) throw new DesktopApiError("REALTIME_FRAME_INVALID");
        this.send({ type: "pong" });
        this.armWatchdog(65_000);
        return;
      }
      if (frame.type === "ready") {
        if (
          this.stream ||
          frame.protocol_version !== 1 ||
          typeof frame.stream_id !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(frame.stream_id)
        )
          throw new DesktopApiError("REALTIME_FRAME_INVALID");
        this.stream = frame.stream_id;
        this.attempts = 0;
        this.armWatchdog(65_000);
        for (const entry of this.entries.values()) this.subscribe(entry);
        if (!this.entries.size) this.setState("live");
        return;
      }
      if (!this.stream || frame.stream_id !== this.stream) return;
      const entry = [...this.entries.values()].find(
        (candidate) => candidate.id === frame.subscription_id,
      );
      if (!entry) return;
      if (frame.type === "snapshot") {
        if (
          frame.protocol_version !== 1 ||
          !Number.isSafeInteger(frame.sequence) ||
          Number(frame.sequence) < 1 ||
          !Object.hasOwn(frame, "data")
        )
          throw new DesktopApiError("REALTIME_FRAME_INVALID");
        const sequence = Number(frame.sequence);
        if (sequence <= entry.sequence) return;
        if (
          !entry.pendingSnapshot &&
          entry.sequence &&
          sequence !== entry.sequence + 1
        ) {
          entry.sequence = sequence;
          entry.pendingSnapshot = true;
          entry.last = undefined;
          this.setState("reconnecting");
          this.armSubscriptionTimeout(entry);
          this.send({ type: "resync", subscription_id: entry.id });
          return;
        }
        entry.sequence = sequence;
        entry.pendingSnapshot = false;
        clearTimeout(entry.timeout);
        entry.last = { data: frame.data };
        for (const listener of entry.listeners)
          this.notify(listener, entry.last);
        this.current();
        if (
          [...this.entries.values()].every(
            (candidate) => !candidate.pendingSnapshot,
          )
        )
          this.setState("live");
      } else if (frame.type === "subscription_error") {
        if (
          typeof frame.code !== "string" ||
          !/^[A-Z][A-Z0-9_]{1,63}$/.test(frame.code) ||
          !Number.isInteger(frame.status) ||
          Number(frame.status) < 400 ||
          Number(frame.status) > 599
        )
          throw new DesktopApiError("REALTIME_FRAME_INVALID");
        const error = new DesktopApiError(frame.code, Number(frame.status));
        if ([401, 403].includes(error.status)) {
          this.fail(error);
          return;
        }
        if (error.status >= 500 || error.status === 429) {
          this.disconnect();
          this.schedule();
          return;
        }
        clearTimeout(entry.timeout);
        entry.last = { error };
        for (const listener of entry.listeners)
          this.notify(listener, entry.last);
      } else throw new DesktopApiError("REALTIME_FRAME_INVALID");
    } catch (error) {
      const failure = safeError(error);
      if (failure.code === "ACCOUNT_CHANGED" || failure.code === "CANCELLED")
        this.fail(failure);
      else {
        this.disconnect();
        this.schedule();
      }
    }
  }
  private subscribe(entry: Subscription): void {
    entry.sequence = 0;
    entry.pendingSnapshot = true;
    entry.last = undefined;
    this.armSubscriptionTimeout(entry);
    this.send({
      type: "subscribe",
      subscription_id: entry.id,
      resource: entry.resource,
      params: entry.params,
    });
  }
  private armSubscriptionTimeout(entry: Subscription): void {
    clearTimeout(entry.timeout);
    entry.timeout = setTimeout(() => {
      this.disconnect();
      this.schedule();
    }, 15_000);
  }
  private send(value: unknown): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(value));
  }
  private armWatchdog(milliseconds: number): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.disconnect();
      this.schedule();
    }, milliseconds);
  }
  private notify(
    listener: (snapshot: AccountSnapshot) => void,
    value: AccountSnapshot,
  ): void {
    if (!value.error) this.current();
    try {
      listener(value);
    } catch {
      /* View failures cannot restart transport or reveal data in logs. */
    }
  }
  private schedule(retryAfter = 0): void {
    if (this.stopped) return;
    try {
      this.current();
    } catch (error) {
      this.fail(safeError(error));
      return;
    }
    clearTimeout(this.retry);
    this.setState("reconnecting");
    const milliseconds = Math.max(
      Math.min(86_400, retryAfter) * 1000,
      Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)) *
        (0.8 + Math.random() * 0.4),
    );
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.connect();
    }, milliseconds);
  }
  private disconnect(): void {
    this.generation++;
    this.ticketAbort?.abort();
    this.ticketAbort = undefined;
    clearTimeout(this.retry);
    this.retry = undefined;
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
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
      entry.timeout = undefined;
      entry.last = undefined;
      entry.sequence = 0;
      entry.pendingSnapshot = true;
    }
  }
  private fail(error: DesktopApiError): void {
    this.stop();
    for (const entry of this.entries.values())
      for (const listener of entry.listeners) this.notify(listener, { error });
  }
  private setState(state: AccountConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.stateListeners)
      try {
        listener(state);
      } catch {
        /* Local view isolation. */
      }
  }
}
function safeError(error: unknown): DesktopApiError {
  return error instanceof DesktopApiError
    ? error
    : new DesktopApiError("REALTIME_UNAVAILABLE");
}
function validateParams(
  resource: AccountResource,
  params: Record<string, string>,
): void {
  if (
    !["jobs", "job", "import", "usage", "policy"].includes(resource) ||
    !desktopRecord(params) ||
    Object.values(params).some(
      (value) => typeof value !== "string" || value.length > 512,
    ) ||
    Buffer.byteLength(JSON.stringify(params)) > 8192
  )
    throw new DesktopApiError("REALTIME_PARAMS_INVALID");
  const allowed =
    resource === "jobs"
      ? ["limit", "cursor", "status"]
      : resource === "job" || resource === "import"
        ? ["id"]
        : resource === "policy"
          ? ["schema_version"]
          : [];
  if (
    Object.keys(params).some((key) => !allowed.includes(key)) ||
    ((resource === "job" || resource === "import") &&
      !/^[a-f0-9]{24}$/.test(params.id ?? ""))
  )
    throw new DesktopApiError("REALTIME_PARAMS_INVALID");
}
