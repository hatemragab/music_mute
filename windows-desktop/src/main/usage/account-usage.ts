import { createHash } from "node:crypto";
import type { AccountView } from "../../shared/account-contracts.js";
import type {
  AccountUsageView,
  ProcessingMode,
} from "../../shared/usage-contracts.js";
import type { AccountSessionScope } from "../account/account-controller.js";
import type {
  UserRealtimeController,
  RealtimeUpdate,
} from "../realtime/user-realtime.js";
import {
  parseUsage,
  parseProcessingPolicy,
  policyToWire,
  processingAdmissionPreview,
} from "./presentation.js";

export interface UsageCachePort {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
}
export interface AccountUsageOptions {
  realtime: UserRealtimeController;
  cache?: UsageCachePort;
  now?: () => number;
  applyAppPolicy?: (value: unknown) => void;
}
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cacheKey = (scope: AccountSessionScope | null) =>
  scope
    ? createHash("sha256")
        .update(`musicmute-policy-v1:${scope.firebaseUid}`)
        .digest("hex")
    : "policy_guest";

export class AccountUsageController {
  private value: AccountUsageView = {
    connection: "stopped",
    authenticated: false,
    libraryReady: false,
    usageState: "unavailable",
    usage: null,
    policyState: "unavailable",
    policy: null,
    errorCode: null,
  };
  private ownerEpoch = 0;
  private policyEpoch = 0;
  private appPolicyEpoch = 0;
  private ownerKey = "policy_guest";
  private savedAt = 0;
  private readonly now: () => number;
  private readonly listeners = new Set<(value: AccountUsageView) => void>();
  private readonly stops: (() => void)[] = [];
  private disposed = false;
  constructor(private readonly options: AccountUsageOptions) {
    this.now = options.now ?? Date.now;
    this.stops.push(
      options.realtime.onScope((scope) => this.changeOwner(scope)),
    );
    this.stops.push(
      options.realtime.subscribeStatus((status) => {
        this.value.connection = status.state;
        this.value.authenticated = status.authenticated;
        this.value.libraryReady = status.libraryReady;
        if (status.errorCode) this.value.errorCode = status.errorCode;
        this.emit();
      }),
    );
    this.stops.push(
      options.realtime.watch("usage", {}, (update) => this.usage(update)),
    );
    this.stops.push(
      options.realtime.watch("policy", { schema_version: "2" }, (update) =>
        this.policy(update),
      ),
    );
  }
  view(): AccountUsageView {
    const value = structuredClone(this.value);
    if (value.usage)
      value.usage.resetOverdue = Date.parse(value.usage.resetAt) <= this.now();
    if (
      value.policyState === "cached" &&
      this.now() - this.savedAt > CACHE_TTL_MS
    ) {
      value.policy = null;
      value.policyState = "unavailable";
    }
    return value;
  }
  subscribe(listener: (value: AccountUsageView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {
        /* UI observers cannot change authority. */
      }
    }
  }
  private changeOwner(scope: AccountSessionScope | null): void {
    const epoch = ++this.ownerEpoch;
    this.policyEpoch++;
    this.appPolicyEpoch++;
    this.ownerKey = cacheKey(scope);
    this.savedAt = 0;
    this.value = {
      connection: "stopped",
      authenticated: scope !== null,
      libraryReady: false,
      usageState: scope ? "loading" : "unavailable",
      usage: null,
      policyState: "loading",
      policy: null,
      errorCode: null,
    };
    this.emit();
    if (!this.options.cache) {
      this.value.policyState = "unavailable";
      return;
    }
    const key = this.ownerKey,
      policyEpoch = this.policyEpoch;
    void this.options.cache
      .read(key)
      .then((cached) => {
        if (
          this.disposed ||
          epoch !== this.ownerEpoch ||
          policyEpoch !== this.policyEpoch ||
          !cached ||
          typeof cached !== "object" ||
          Array.isArray(cached)
        )
          return;
        const record = cached as Record<string, unknown>;
        if (
          Buffer.byteLength(JSON.stringify(record), "utf8") > 65536 ||
          record.version !== 1 ||
          record.ownerKey !== key ||
          typeof record.savedAt !== "number" ||
          !Number.isSafeInteger(record.savedAt) ||
          record.savedAt > this.now() ||
          this.now() - record.savedAt > CACHE_TTL_MS
        )
          return;
        try {
          this.value.policy = parseProcessingPolicy(record.policy);
          this.value.policyState = "cached";
          this.savedAt = record.savedAt;
          this.emit();
        } catch {
          /* Corrupt cached policy defaults to hidden/unavailable. */
        }
      })
      .catch(() => undefined);
  }
  private usage(update: RealtimeUpdate): void {
    if (this.disposed) return;
    if (update.data === null) {
      this.value.usage = null;
      this.value.usageState = update.errorCode
        ? "unavailable"
        : this.value.authenticated
          ? "loading"
          : "unavailable";
    } else {
      try {
        this.value.usage = parseUsage(update.data, this.now());
        this.value.usageState = update.live ? "current" : "stale";
        if (this.value.errorCode === "USAGE_UNAVAILABLE")
          this.value.errorCode = null;
      } catch {
        this.value.usage = null;
        this.value.usageState = "unavailable";
        this.value.errorCode = "USAGE_UNAVAILABLE";
      }
    }
    if (update.errorCode) this.value.errorCode = update.errorCode;
    this.emit();
  }
  private policy(update: RealtimeUpdate): void {
    if (this.disposed) return;
    if (update.data === null) {
      if (update.errorCode) this.value.errorCode = update.errorCode;
      if (this.value.policy) this.value.policyState = "cached";
      else this.value.policyState = "unavailable";
      this.emit();
      return;
    }
    try {
      const next = parseProcessingPolicy(update.data);
      // AppPolicy has its own global revision; a changed gate must not be dropped
      // just because the processing-policy payload remains identical.
      if (update.live && Object.hasOwn(update.data as object, "app_policy")) {
        this.options.applyAppPolicy?.(
          (update.data as Record<string, unknown>).app_policy,
        );
        this.appPolicyEpoch++;
      }
      if (
        update.live &&
        this.value.policyState === "current" &&
        JSON.stringify(next) === JSON.stringify(this.value.policy)
      )
        return;
      if (
        this.value.policy &&
        (next.revision < this.value.policy.revision ||
          next.linkRevision < this.value.policy.linkRevision)
      )
        return;
      this.policyEpoch++;
      this.value.policy = next;
      if (this.value.errorCode === "POLICY_UNAVAILABLE")
        this.value.errorCode = null;
      this.value.policyState = update.live ? "current" : "cached";
      if (update.live) {
        this.savedAt = this.now();
        const key = this.ownerKey,
          epoch = this.ownerEpoch;
        const cached = {
          version: 1,
          ownerKey: key,
          savedAt: this.savedAt,
          policy: policyToWire(next),
        };
        if (this.options.cache)
          void Promise.resolve()
            .then(async () => {
              if (epoch === this.ownerEpoch && !this.disposed)
                await this.options.cache!.write(key, cached);
            })
            .catch(() => undefined);
      }
      this.emit();
    } catch {
      this.value.policyState = this.value.policy ? "cached" : "unavailable";
      this.value.errorCode = "POLICY_UNAVAILABLE";
      this.emit();
    }
  }
  /** Explicit startup read only; never used as a periodic realtime fallback. */
  async onAppOpen(): Promise<void> {
    const epoch = this.ownerEpoch,
      policyEpoch = this.policyEpoch,
      appPolicyEpoch = this.appPolicyEpoch;
    await Promise.all([
      (async () => {
        try {
          const value = await this.options.realtime.checkoutPolicy();
          if (
            this.disposed ||
            epoch !== this.ownerEpoch ||
            policyEpoch !== this.policyEpoch
          )
            return;
          this.policy({ live: true, data: value, errorCode: null });
        } catch {
          if (this.disposed || epoch !== this.ownerEpoch) return;
          this.value.policyState = this.value.policy ? "cached" : "unavailable";
          this.emit();
        }
      })(),
      (async () => {
        try {
          const value = await this.options.realtime.checkoutAppPolicy();
          if (
            !this.disposed &&
            epoch === this.ownerEpoch &&
            appPolicyEpoch === this.appPolicyEpoch
          )
            this.options.applyAppPolicy?.(value);
        } catch {
          /* Backend commands retain their authoritative build gate. */
        }
      })(),
    ]);
  }
  assertCloudSubmission(
    account: Pick<AccountView, "state" | "online" | "access">,
  ): void {
    const decision = processingAdmissionPreview(
      "cloud",
      false,
      account,
      this.view(),
    );
    if (decision.mode !== "cloud" || !decision.allowed)
      throw new Error(
        decision.signInRequired
          ? "SIGN_IN_REQUIRED"
          : (decision.reason ?? "CLOUD_POLICY_UNAVAILABLE"),
      );
  }
  preview(
    requested: ProcessingMode,
    localReady: boolean,
    account: Pick<AccountView, "state" | "online" | "access">,
  ) {
    return processingAdmissionPreview(
      requested,
      localReady,
      account,
      this.view(),
    );
  }
  dispose(): void {
    this.disposed = true;
    this.ownerEpoch++;
    for (const stop of this.stops) stop();
    this.stops.length = 0;
    this.listeners.clear();
  }
}
