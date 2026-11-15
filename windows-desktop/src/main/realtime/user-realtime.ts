import {
  AccountRealtimeClient,
  validateAccountRealtimeParams,
  type AccountResource,
  type AccountSocket,
  type AccountTransport,
} from "../../../../chrome-extension/src/companion/account-realtime.js";
import {
  DesktopApiError,
  accountApiOrigin,
  type AccountScope,
} from "../../../../chrome-extension/src/companion/account-api.js";
import { accountRequest, type AccountFetch } from "../account/transport.js";
import { accountFailure } from "../account/errors.js";
import type { AccountSessionScope } from "../account/account-controller.js";
import type { RealtimeStatusView } from "../../shared/usage-contracts.js";
import { hideStaleQueueRanks } from "../usage/queue-rank.js";

export type { AccountResource };
export interface RealtimeAccountPort {
  sessionScope(): AccountSessionScope | null;
  assertScope(scope: AccountSessionScope): void;
  authorization(forceRefresh?: boolean): Promise<string>;
}
export interface RealtimeUpdate {
  live: boolean;
  data: unknown | null;
  errorCode: string | null;
}
export interface UserRealtimeOptions {
  origin: string;
  installationId: string;
  account: RealtimeAccountPort;
  fetch?: AccountFetch;
  socket?: (url: string, protocols: string[]) => AccountSocket;
  onAuthenticationRequired?: (code: string, scope: AccountSessionScope) => void;
}
interface WatchEntry {
  resource: AccountResource;
  params: Record<string, string>;
  listeners: Set<(value: RealtimeUpdate) => void>;
  last: unknown | null;
  live: boolean;
  error: string | null;
  unsubscribe?: () => void;
}
const sameScope = (
  a: AccountSessionScope | null,
  b: AccountSessionScope | null,
) => a?.firebaseUid === b?.firebaseUid && a?.generation === b?.generation;
const authCodes = new Set([
  "UNAUTHENTICATED",
  "ACCOUNT_DISABLED",
  "ACCOUNT_DELETION_PENDING",
  "ACCOUNT_DELETED",
]);
const publicCode = (code: string): string =>
  /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "REALTIME_UNAVAILABLE";

/** One shared native raw socket for this account generation; no REST live-read fallback. */
export class UserRealtimeController {
  readonly origin: string;
  private scope: AccountSessionScope | null = null;
  private epoch = 0;
  private authRejectedEpoch = -1;
  private client: AccountRealtimeClient | null = null;
  private readonly entries = new Map<string, WatchEntry>();
  private readonly statusListeners = new Set<
    (value: RealtimeStatusView) => void
  >();
  private readonly scopeListeners = new Set<
    (scope: AccountSessionScope | null) => void
  >();
  private state: RealtimeStatusView["state"] = "stopped";
  private errorCode: string | null = null;
  private disposed = false;
  private checkoutAbort: AbortController | null = null;
  private appCheckoutAbort: AbortController | null = null;
  private readonly fetcher: AccountFetch;
  constructor(private readonly options: UserRealtimeOptions) {
    this.origin = accountApiOrigin(options.origin);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        options.installationId,
      )
    )
      throw new DesktopApiError("INVALID_INSTALLATION_ID");
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  }
  status(): RealtimeStatusView {
    return {
      state: this.state,
      authenticated: this.scope !== null,
      libraryReady: [...this.entries.values()].some(
        (entry) => entry.resource === "jobs" && entry.live && !entry.error,
      ),
      errorCode: this.errorCode,
    };
  }
  /** A leased facade shares this generation's socket; its stop releases only its watches. */
  cloudLease(
    scope: AccountSessionScope,
  ): Pick<
    AccountRealtimeClient,
    "start" | "stop" | "watch" | "read" | "onState"
  > {
    const epoch = this.epoch,
      client = this.client;
    this.current(scope, epoch);
    if (!client) throw new DesktopApiError("REALTIME_UNAVAILABLE");
    const cleanups = new Set<() => void>();
    let closed = false;
    const current = () => {
      if (closed) throw new DesktopApiError("CANCELLED");
      this.current(scope, epoch);
    };
    return {
      start: () => {
        current();
        client.start();
      },
      stop: () => {
        if (closed) return;
        closed = true;
        for (const off of cleanups) off();
        cleanups.clear();
      },
      watch: (resource, params, listener) => {
        current();
        const off = client.watch(resource, params, (snapshot) => {
          try {
            current();
            listener(snapshot);
          } catch (error) {
            listener({
              error:
                error instanceof DesktopApiError
                  ? error
                  : new DesktopApiError("ACCOUNT_CHANGED"),
            });
          }
        });
        cleanups.add(off);
        return () => {
          off();
          cleanups.delete(off);
        };
      },
      read: async (resource, params, signal) => {
        current();
        const result = await client.read(resource, params, signal);
        current();
        return result;
      },
      onState: (listener) => {
        current();
        const off = client.onState((state) => {
          try {
            current();
            listener(state);
          } catch {
            /* Old generation notifications cannot reach a consumer. */
          }
        });
        cleanups.add(off);
        return () => {
          off();
          cleanups.delete(off);
        };
      },
    };
  }
  currentScope(): AccountSessionScope | null {
    return this.scope ? { ...this.scope } : null;
  }
  subscribeStatus(listener: (value: RealtimeStatusView) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status());
    return () => {
      this.statusListeners.delete(listener);
    };
  }
  onScope(listener: (scope: AccountSessionScope | null) => void): () => void {
    this.scopeListeners.add(listener);
    listener(this.currentScope());
    return () => {
      this.scopeListeners.delete(listener);
    };
  }
  private emitStatus(): void {
    for (const listener of this.statusListeners) {
      try {
        listener(this.status());
      } catch {
        /* Safe presentation isolation. */
      }
    }
  }
  private authenticationRejected(code: string, epoch: number): void {
    if (
      epoch !== this.epoch ||
      this.disposed ||
      this.authRejectedEpoch === epoch
    )
      return;
    this.authRejectedEpoch = epoch;
    const rejectedScope = this.scope;
    this.setScope(null);
    this.errorCode = publicCode(code);
    this.emitStatus();
    if (rejectedScope)
      this.options.onAuthenticationRequired?.(this.errorCode, {
        ...rejectedScope,
      });
  }
  private current(scope: AccountSessionScope, epoch: number): void {
    if (this.disposed || epoch !== this.epoch || !sameScope(scope, this.scope))
      throw new DesktopApiError("ACCOUNT_CHANGED");
    try {
      this.options.account.assertScope(scope);
    } catch {
      throw new DesktopApiError("ACCOUNT_CHANGED");
    }
  }
  setScope(scope: AccountSessionScope | null): void {
    if (this.disposed || sameScope(scope, this.scope)) return;
    this.epoch++;
    this.checkoutAbort?.abort();
    this.checkoutAbort = null;
    this.appCheckoutAbort?.abort();
    this.appCheckoutAbort = null;
    this.client?.close();
    this.client = null;
    this.scope = scope ? { ...scope } : null;
    this.state = "stopped";
    this.errorCode = null;
    for (const listener of this.scopeListeners) {
      try {
        listener(this.currentScope());
      } catch {
        /* Subscriber isolation. */
      }
    }
    for (const entry of this.entries.values()) {
      entry.last = null;
      entry.live = false;
      entry.error = null;
      delete entry.unsubscribe;
      this.notify(entry);
    }
    this.emitStatus();
    if (!scope) return;
    const epoch = this.epoch;
    this.current(scope, epoch);
    const api: AccountTransport = {
      origin: this.origin,
      assertCurrent: (candidate: AccountScope) => {
        if (
          candidate.firebase_uid !== scope.firebaseUid ||
          candidate.session_generation !== scope.generation
        )
          throw new DesktopApiError("ACCOUNT_CHANGED");
        this.current(scope, epoch);
      },
      request: async (_scope, path, method, body, signal) => {
        if (
          path !== "/realtime-tickets" ||
          method !== "POST" ||
          !body ||
          typeof body !== "object" ||
          Object.keys(body).length
        )
          throw new DesktopApiError("INVALID_API_PATH");
        this.current(scope, epoch);
        try {
          const token = await this.options.account.authorization();
          this.current(scope, epoch);
          const result = await accountRequest(
            this.fetcher,
            `${this.origin}/realtime-tickets`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
                "X-Installation-Id": this.options.installationId,
              },
              body: "{}",
            },
            { ...(signal ? { signal } : {}), limit: 16384, deadlineMs: 10000 },
          );
          this.current(scope, epoch);
          return result;
        } catch (error) {
          const failure = accountFailure(error);
          if (authCodes.has(failure.code))
            this.authenticationRejected(failure.code, epoch);
          throw new DesktopApiError(
            failure.code === "SESSION_CHANGED"
              ? "ACCOUNT_CHANGED"
              : failure.code,
            authCodes.has(failure.code)
              ? 401
              : failure.code === "RATE_LIMITED"
                ? 429
                : 503,
            failure.retryAfterSeconds,
          );
        }
      },
    };
    const client = new AccountRealtimeClient({
      api,
      scope: {
        firebase_uid: scope.firebaseUid,
        session_generation: scope.generation,
      },
      ...(this.options.socket ? { socket: this.options.socket } : {}),
    });
    this.client = client;
    client.onState((state) => {
      if (epoch !== this.epoch || this.disposed) return;
      this.state = state;
      for (const entry of this.entries.values()) {
        entry.live = state === "live" && entry.last !== null && !entry.error;
        this.notify(entry);
      }
      this.emitStatus();
    });
    for (const entry of this.entries.values())
      this.bind(entry, client, scope, epoch);
    client.start();
  }
  watch(
    resource: AccountResource,
    params: Record<string, string>,
    listener: (value: RealtimeUpdate) => void,
  ): () => void {
    if (this.disposed) throw new DesktopApiError("CANCELLED");
    validateAccountRealtimeParams(resource, params);
    const key = JSON.stringify([resource, Object.entries(params).sort()]);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 128)
        throw new DesktopApiError("REALTIME_SUBSCRIPTION_LIMIT");
      entry = {
        resource,
        params: { ...params },
        listeners: new Set(),
        last: null,
        live: false,
        error: null,
      };
      this.entries.set(key, entry);
      if (this.client && this.scope)
        this.bind(entry, this.client, this.scope, this.epoch);
    }
    entry.listeners.add(listener);
    this.notifyOne(listener, entry);
    return () => {
      entry!.listeners.delete(listener);
      if (!entry!.listeners.size) {
        entry!.unsubscribe?.();
        this.entries.delete(key);
        this.emitStatus();
      }
    };
  }
  private bind(
    entry: WatchEntry,
    client: AccountRealtimeClient,
    scope: AccountSessionScope,
    epoch: number,
  ): void {
    entry.unsubscribe = client.watch(
      entry.resource,
      entry.params,
      (snapshot) => {
        if (this.disposed || epoch !== this.epoch) return;
        if (snapshot.error) {
          entry.last = null;
          entry.live = false;
          entry.error = publicCode(snapshot.error.code);
          this.errorCode = entry.error;
          if (authCodes.has(snapshot.error.code)) {
            this.authenticationRejected(snapshot.error.code, epoch);
            return;
          }
        } else {
          try {
            this.current(scope, epoch);
          } catch {
            return;
          }
          entry.last = snapshot.data;
          entry.live = true;
          entry.error = null;
          this.errorCode = null;
        }
        this.notify(entry);
        this.emitStatus();
      },
    );
  }
  private notifyOne(
    listener: (value: RealtimeUpdate) => void,
    entry: WatchEntry,
  ): void {
    try {
      listener({
        live: entry.live,
        data:
          entry.last === null
            ? null
            : entry.live
              ? structuredClone(entry.last)
              : hideStaleQueueRanks(entry.last),
        errorCode: entry.error,
      });
    } catch {
      /* No private data in diagnostics. */
    }
  }
  private notify(entry: WatchEntry): void {
    for (const listener of entry.listeners) this.notifyOne(listener, entry);
  }
  /** Called once at app open. Authenticated live updates continue through the socket. */
  async checkoutPolicy(): Promise<unknown> {
    if (this.disposed) throw new DesktopApiError("CANCELLED");
    const epoch = this.epoch;
    const scope = this.currentScope();
    this.checkoutAbort?.abort();
    const abort = new AbortController();
    this.checkoutAbort = abort;
    try {
      const token = scope ? await this.options.account.authorization() : null;
      if (epoch !== this.epoch) throw new DesktopApiError("ACCOUNT_CHANGED");
      if (scope) this.current(scope, epoch);
      const value = await accountRequest(
        this.fetcher,
        `${this.origin}/processing-policy?schema_version=2`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Installation-Id": this.options.installationId,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        { signal: abort.signal, limit: 65536 },
      );
      if (epoch !== this.epoch || this.checkoutAbort !== abort)
        throw new DesktopApiError("ACCOUNT_CHANGED");
      if (scope) this.current(scope, epoch);
      return value;
    } finally {
      if (this.checkoutAbort === abort) this.checkoutAbort = null;
    }
  }
  async checkoutAppPolicy(): Promise<unknown> {
    if (this.disposed) throw new DesktopApiError("CANCELLED");
    const epoch = this.epoch;
    this.appCheckoutAbort?.abort();
    const abort = new AbortController();
    this.appCheckoutAbort = abort;
    try {
      const value = await accountRequest(
        this.fetcher,
        `${this.origin}/app-policy`,
        { method: "GET", headers: { Accept: "application/json" } },
        { signal: abort.signal, limit: 65536 },
      );
      if (
        this.disposed ||
        epoch !== this.epoch ||
        this.appCheckoutAbort !== abort
      )
        throw new DesktopApiError("ACCOUNT_CHANGED");
      return value;
    } finally {
      if (this.appCheckoutAbort === abort) this.appCheckoutAbort = null;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.setScope(null);
    this.disposed = true;
    this.client?.close();
    this.client = null;
    this.checkoutAbort?.abort();
    this.appCheckoutAbort?.abort();
    this.entries.clear();
    this.statusListeners.clear();
    this.scopeListeners.clear();
  }
}
