import { randomUUID } from "node:crypto";
import {
  parseAccountCommand,
  canUnlinkWindowsProvider,
  type AccountCommand,
  type AccountDeviceView,
  type AccountProvider,
  type AccountRecoveryView,
  type AccountUserView,
  type AccountView,
} from "../../shared/account-contracts.js";
import { AccountError, accountFailure, record, text } from "./errors.js";
import { accountRequest, type AccountFetch } from "./transport.js";
import type { GoogleOAuthPort } from "./google-oauth.js";

export interface PublicAccountConfiguration {
  backend_base_url: string;
  firebase_api_key: string;
  firebase_project_id: string;
  google_desktop_client_id?: string;
}
export interface AccountSessionScope {
  firebaseUid: string;
  generation: string;
}
export interface StoredCredential {
  firebaseUid: string;
  idToken: string;
  refreshToken: string;
  expiresAt: number;
  user: AccountUserView | null;
  deletionPending: boolean;
}
export interface AccountVaultPort {
  load(): Promise<StoredCredential | null>;
  save(credential: StoredCredential): Promise<void>;
  remove(): Promise<void>;
}
/** Tombstone is independent of vault removal, matching the macOS saved-signout fence. */
export interface AccountStatePort {
  readSignedOut(): Promise<boolean>;
  writeSignedOut(signedOut: boolean): Promise<void>;
  /** Publish in-memory scope and invalidate listeners before any awaited durable I/O. */
  publishScope(scope: AccountSessionScope | null): Promise<void>;
  saveMetadataRevision?(revision: number): Promise<void>;
}
export interface WindowsInstallationReport {
  installationId: string;
  appVersion: string;
  buildNumber: number;
  metadataRevision: number;
  osVersion: string;
  deviceModel?: string;
}
export interface AccountControllerOptions {
  configuration: PublicAccountConfiguration;
  installation: WindowsInstallationReport;
  vault: AccountVaultPort;
  state: AccountStatePort;
  google: GoogleOAuthPort;
  fetch?: AccountFetch;
  now?: () => number;
}
const revoked = new Set([
  "TOKEN_EXPIRED",
  "INVALID_REFRESH_TOKEN",
  "USER_DISABLED",
  "USER_NOT_FOUND",
  "INVALID_ID_TOKEN",
  "ACCOUNT_DISABLED",
  "ACCOUNT_DELETED",
  "UNAUTHENTICATED",
]);
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const safeInt = (
  value: unknown,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new AccountError("MALFORMED_RESPONSE");
  return value;
};
function date(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const result = text(value, 64);
  if (!Number.isFinite(Date.parse(result)))
    throw new AccountError("MALFORMED_RESPONSE");
  return result;
}
function userView(value: unknown): AccountUserView {
  const user = record(value);
  const providers = user.providers;
  if (
    !Array.isArray(providers) ||
    providers.length > 5 ||
    providers.some(
      (provider) =>
        !["password", "google.com", "apple.com"].includes(String(provider)),
    ) ||
    typeof user.email_verified !== "boolean"
  )
    throw new AccountError("MALFORMED_RESPONSE");
  const id = text(user.id, 24);
  if (!/^[a-f0-9]{24}$/.test(id)) throw new AccountError("MALFORMED_RESPONSE");
  return {
    id,
    displayName: text(user.display_name, 100, 0),
    email: user.email == null ? null : text(user.email, 254),
    emailVerified: user.email_verified,
    providers: [...new Set(providers)] as AccountProvider[],
    workerRegistrationAllowed: user.worker_registration_allowed === true,
  };
}
export function validatePublicAccountConfiguration(
  value: PublicAccountConfiguration,
): PublicAccountConfiguration {
  const config = record(value);
  if (
    Object.values(config).some(
      (field) => typeof field === "string" && /[\p{Cc}\p{Cf}]/u.test(field),
    )
  )
    throw new AccountError("CONFIGURATION_REQUIRED");
  if (
    ["backend_base_url", "firebase_api_key", "firebase_project_id"].some(
      (key) => typeof config[key] !== "string",
    ) ||
    (config.google_desktop_client_id !== undefined &&
      typeof config.google_desktop_client_id !== "string")
  )
    throw new AccountError("CONFIGURATION_REQUIRED");
  const url = new URL(String(config.backend_base_url));
  if (
    Object.keys(config).some(
      (key) =>
        ![
          "backend_base_url",
          "firebase_api_key",
          "firebase_project_id",
          "google_desktop_client_id",
        ].includes(key),
    ) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname) ||
    !/^[A-Za-z0-9_-]{20,200}$/.test(String(config.firebase_api_key)) ||
    !/^[a-z][a-z0-9-]{4,62}$/.test(String(config.firebase_project_id)) ||
    (config.google_desktop_client_id !== undefined &&
      (!/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(
        String(config.google_desktop_client_id),
      ) ||
        String(config.google_desktop_client_id).length > 256))
  )
    throw new AccountError("CONFIGURATION_REQUIRED");
  return { ...value, backend_base_url: url.origin };
}

/** This class is main/agent-only. Never export an instance through Electron IPC. */
export class AccountController {
  private readonly options: AccountControllerOptions;
  private readonly fetcher: AccountFetch;
  private readonly now: () => number;
  private disposed = false;
  private closing: Promise<void> | undefined;
  private readonly retirements = new Set<Promise<void>>();
  private generation = randomUUID();
  private credential: StoredCredential | null = null;
  private appPolicy: {
    revision: number | null;
    requireVerifiedEmail: boolean;
    minimumBuild: number | null;
  } | null = null;
  private operation: { id: symbol; abort: AbortController } | null = null;
  private refreshing: {
    scope: AccountSessionScope;
    promise: Promise<string>;
    abort: AbortController;
  } | null = null;
  private vaultWrites: Promise<unknown> = Promise.resolve();
  private stateWrites: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(view: AccountView) => void>();
  private viewState: AccountView = {
    state: "signed-out",
    busy: false,
    online: false,
    googleSignInActive: false,
    user: null,
    devices: [],
    nextDeviceCursor: null,
    recovery: null,
    minimumBuild: null,
    access: { allowed: false, reason: "UNAUTHENTICATED" },
    verificationCooldownSeconds: 0,
    resetCooldownSeconds: 0,
    errorCode: null,
    noticeCode: null,
  };
  private verificationRetryAt = 0;
  private resetRetryAt = 0;
  constructor(options: AccountControllerOptions) {
    try {
      validatePublicAccountConfiguration(options.configuration);
    } catch {
      throw new AccountError("CONFIGURATION_REQUIRED");
    }
    const installation = options.installation;
    if (
      !uuid.test(installation.installationId) ||
      !installation.appVersion ||
      installation.appVersion.length > 32 ||
      !Number.isInteger(installation.buildNumber) ||
      installation.buildNumber < 1 ||
      installation.buildNumber > 2147483647 ||
      !Number.isSafeInteger(installation.metadataRevision) ||
      installation.metadataRevision < 1 ||
      installation.metadataRevision >= Number.MAX_SAFE_INTEGER ||
      !installation.osVersion ||
      installation.osVersion.length > 64
    )
      throw new AccountError("CONFIGURATION_REQUIRED");
    this.options = {
      ...options,
      configuration: validatePublicAccountConfiguration(options.configuration),
      installation: { ...installation },
    };
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }
  view(): AccountView {
    const scope = this.sessionScope();
    return structuredClone({
      ...this.viewState,
      ...(scope && this.viewState.user
        ? {
            destructiveReview: {
              accountId: this.viewState.user.id,
              generation: scope.generation,
            },
          }
        : {}),
      verificationCooldownSeconds: Math.max(
        0,
        Math.ceil((this.verificationRetryAt - this.now()) / 1000),
      ),
      resetCooldownSeconds: Math.max(
        0,
        Math.ceil((this.resetRetryAt - this.now()) / 1000),
      ),
    });
  }
  /** Trusted global app policy from checkout or a current owner snapshot. */
  receiveAppPolicy(value: unknown): void {
    if (this.disposed) return;
    const policy = record(value),
      platforms = record(policy.platforms);
    if (typeof policy.require_verified_email !== "boolean")
      throw new AccountError("MALFORMED_RESPONSE");
    const desktop =
      platforms.windows == null ? null : record(platforms.windows);
    const minimum = desktop?.minimum_build;
    const next = {
      revision: policy.revision === undefined ? null : safeInt(policy.revision),
      requireVerifiedEmail: policy.require_verified_email,
      minimumBuild: minimum == null ? null : safeInt(minimum, 1, 2147483647),
    };
    if (
      this.appPolicy?.revision == null ||
      (next.revision !== null && next.revision >= this.appPolicy.revision)
    )
      this.appPolicy = next;
    this.applyAppPolicyGate();
    this.emit();
  }
  private applyAppPolicyGate(): void {
    if (!this.appPolicy) return;
    this.viewState.minimumBuild = this.appPolicy.minimumBuild;
    if (
      this.credential &&
      !this.credential.deletionPending &&
      this.viewState.user
    ) {
      if (
        this.appPolicy.requireVerifiedEmail &&
        !this.viewState.user.emailVerified
      )
        this.viewState.access = {
          allowed: false,
          reason: "EMAIL_VERIFICATION_REQUIRED",
        };
      else if (
        this.viewState.minimumBuild !== null &&
        this.options.installation.buildNumber < this.viewState.minimumBuild
      )
        this.viewState.access = {
          allowed: false,
          reason: "APP_UPDATE_REQUIRED",
        };
      else if (
        ["APP_UPDATE_REQUIRED", "EMAIL_VERIFICATION_REQUIRED"].includes(
          this.viewState.access.reason ?? "",
        )
      )
        this.viewState.access = { allowed: true, reason: null };
    }
  }
  /** A current full snapshot can update the owner permission; a cached foreign owner cannot. */
  receiveWorkerRegistration(value: unknown, scope: AccountSessionScope): void {
    this.assertScope(scope);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as Record<string, unknown>).worker_registration_allowed !==
        "boolean"
    )
      throw new AccountError("MALFORMED_RESPONSE");
    const allowed = (value as Record<string, unknown>)
      .worker_registration_allowed as boolean;
    if (this.viewState.user)
      this.viewState.user = {
        ...this.viewState.user,
        workerRegistrationAllowed: allowed,
      };
    if (this.credential?.user)
      this.credential.user = {
        ...this.credential.user,
        workerRegistrationAllowed: allowed,
      };
    this.emit();
  }
  /** Terminal owner-bound socket rejection; no refresh or remote logout is inferred. */
  receiveAuthorizationRejection(
    code: string,
    scope: AccountSessionScope,
  ): Promise<void> {
    try {
      this.assertScope(scope);
    } catch (error) {
      return Promise.reject(error);
    }
    if (
      ![
        "UNAUTHENTICATED",
        "ACCOUNT_DISABLED",
        "ACCOUNT_DELETED",
        "ACCOUNT_DELETION_PENDING",
      ].includes(code)
    )
      return Promise.reject(new AccountError("MALFORMED_RESPONSE"));
    this.operation?.abort.abort();
    this.operation = null;
    this.viewState.busy = false;
    this.viewState.googleSignInActive = false;
    const task =
      code === "ACCOUNT_DELETION_PENDING"
        ? this.markDeletionPending()
        : this.clearSession();
    this.viewState.errorCode = code;
    this.emit();
    return task;
  }
  subscribe(listener: (view: AccountView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {
        /* A presentation observer cannot change account authority. */
      }
    }
  }
  sessionScope(): AccountSessionScope | null {
    return !this.disposed && this.credential && !this.credential.deletionPending
      ? {
          firebaseUid: this.credential.firebaseUid,
          generation: this.generation,
        }
      : null;
  }
  private internalScope(): AccountSessionScope {
    if (this.disposed) throw new AccountError("SESSION_CHANGED");
    if (!this.credential) throw new AccountError("UNAUTHENTICATED");
    return {
      firebaseUid: this.credential.firebaseUid,
      generation: this.generation,
    };
  }
  assertScope(scope: AccountSessionScope): void {
    if (
      this.disposed ||
      scope.generation !== this.generation ||
      scope.firebaseUid !== this.credential?.firebaseUid
    )
      throw new AccountError("SESSION_CHANGED");
  }
  private assertEpoch(epoch: string): void {
    if (this.disposed || epoch !== this.generation)
      throw new AccountError("SESSION_CHANGED");
  }
  captureOwnerFence(): () => void {
    const scope = this.sessionScope();
    if (!scope) throw new AccountError("UNAUTHENTICATED");
    return () => this.assertScope(scope);
  }
  /** Close UI-owned work without deleting a saved account or fleet credential. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation = randomUUID();
    this.operation?.abort.abort();
    this.operation = null;
    this.refreshing?.abort.abort();
    this.refreshing = null;
    this.listeners.clear();
  }
  activity(): { busy: boolean; refreshing: boolean } {
    return {
      busy:
        this.operation !== null ||
        this.viewState.busy ||
        this.retirements.size > 0,
      refreshing: this.refreshing !== null,
    };
  }
  /** Keep DPAPI/native alive through a refresh cancellation and its queued durable writes. */
  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    const refresh = this.refreshing?.promise;
    this.dispose();
    return (this.closing = (async () => {
      await Promise.allSettled([refresh, ...this.retirements]);
      await Promise.allSettled([this.vaultWrites, this.stateWrites]);
    })());
  }
  async authorizedSession(): Promise<{
    firebase_uid: string;
    session_generation: string;
    id_token: string;
    installation_id: string;
  }> {
    const scope = this.sessionScope();
    if (!scope)
      throw new AccountError(
        this.credential?.deletionPending
          ? "ACCOUNT_DELETION_PENDING"
          : "UNAUTHENTICATED",
      );
    const token = await this.authorization();
    this.assertScope(scope);
    return {
      firebase_uid: scope.firebaseUid,
      session_generation: scope.generation,
      id_token: token,
      installation_id: this.options.installation.installationId,
    };
  }
  async authorization(forceRefresh = false): Promise<string> {
    if (this.credential?.deletionPending)
      throw new AccountError("ACCOUNT_DELETION_PENDING");
    return this.token(forceRefresh);
  }
  private async token(forceRefresh = false): Promise<string> {
    const scope = this.internalScope();
    const current = this.credential!;
    if (!forceRefresh && current.expiresAt > this.now() + 120000)
      return current.idToken;
    if (
      !this.refreshing ||
      this.refreshing.scope.generation !== scope.generation
    ) {
      const abort = new AbortController();
      const promise = (async () => {
        const value = await accountRequest(
          this.fetcher,
          `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(this.options.configuration.firebase_api_key)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: current.refreshToken,
            }).toString(),
          },
          { signal: abort.signal },
        );
        this.assertScope(scope);
        const refreshed = this.parseCredential(value);
        if (refreshed.firebaseUid !== scope.firebaseUid)
          throw new AccountError("SESSION_CHANGED");
        await this.accept(
          {
            ...refreshed,
            user: this.viewState.user,
            deletionPending: current.deletionPending,
          },
          false,
          scope.generation,
        );
        this.assertScope(scope);
        return refreshed.idToken;
      })();
      this.refreshing = { scope, promise, abort };
    }
    const refresh = this.refreshing;
    try {
      return await refresh.promise;
    } catch (error) {
      if (
        scope.generation === this.generation &&
        revoked.has(accountFailure(error).code)
      )
        await this.clearSession();
      throw error;
    } finally {
      if (this.refreshing === refresh) this.refreshing = null;
    }
  }
  async execute(input: AccountCommand | unknown): Promise<AccountView> {
    if (this.disposed) return { ...this.view(), errorCode: "SESSION_CHANGED" };
    let command: AccountCommand;
    try {
      command = parseAccountCommand(input);
    } catch (error) {
      this.viewState.errorCode = accountFailure(error).code;
      this.emit();
      return this.view();
    }
    if (command.type === "CANCEL_SIGN_IN") {
      this.operation?.abort.abort();
      this.operation = null;
      this.generation = randomUUID();
      this.refreshing?.abort.abort();
      this.refreshing = null;
      this.viewState.busy = false;
      this.viewState.googleSignInActive = false;
      this.viewState.state = this.credential
        ? this.credential.deletionPending
          ? "deletion-pending"
          : "signed-in"
        : "signed-out";
      this.emit();
      const cancelledEpoch = this.generation;
      await this.stateMutation(
        () => this.options.state.publishScope(this.sessionScope()),
        () => this.assertEpoch(cancelledEpoch),
      ).catch(() => undefined);
      return this.view();
    }
    if (command.type === "LOGOUT") {
      try {
        await this.clearSession();
      } catch (error) {
        this.viewState.errorCode = accountFailure(error).code;
        this.emit();
      }
      return this.view();
    }
    if (this.operation) {
      this.viewState.errorCode = "BUSY";
      this.emit();
      return this.view();
    }
    const operation = { id: Symbol(), abort: new AbortController() };
    this.operation = operation;
    const epoch = this.generation;
    this.viewState.busy = true;
    this.viewState.errorCode = null;
    this.viewState.noticeCode = null;
    this.emit();
    try {
      await this.perform(command, epoch, operation.abort.signal);
    } catch (error) {
      if (this.operation === operation) {
        const failure = accountFailure(error);
        this.viewState.errorCode = failure.code;
        if (failure.code === "NETWORK_UNAVAILABLE")
          this.viewState.online = false;
        if (failure.retryAfterSeconds) {
          if (command.type === "SEND_VERIFICATION")
            this.verificationRetryAt =
              this.now() + failure.retryAfterSeconds * 1000;
          if (command.type === "RESET_PASSWORD")
            this.resetRetryAt = this.now() + failure.retryAfterSeconds * 1000;
        }
        if (failure.code === "ACCOUNT_DELETION_PENDING" && this.credential)
          await this.markDeletionPending();
        else if (revoked.has(failure.code) && this.credential)
          await this.clearSession().catch(() => undefined);
      }
    } finally {
      if (this.operation === operation) {
        this.operation = null;
        this.viewState.busy = false;
        this.viewState.googleSignInActive = false;
        if (this.viewState.state === "restoring")
          this.viewState.state = this.credential
            ? this.credential.deletionPending
              ? "deletion-pending"
              : "signed-in"
            : "signed-out";
        this.emit();
      }
    }
    return this.view();
  }
  private async perform(
    command: AccountCommand,
    epoch: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      ["DELETE_ACCOUNT", "LOGOUT_ALL", "UNLINK_PROVIDER"].includes(
        command.type,
      ) &&
      "expectedAccountId" in command
    ) {
      const scope = this.sessionScope();
      if (
        !scope ||
        command.expectedAccountId !== this.viewState.user?.id ||
        command.expectedSessionGeneration !== scope.generation
      )
        throw new AccountError("SESSION_CHANGED");
    }
    switch (command.type) {
      case "RESTORE":
        return this.restore(epoch, signal);
      case "SIGN_IN_EMAIL":
      case "SIGN_UP_EMAIL": {
        if (this.credential) throw new AccountError("SESSION_CHANGED");
        this.validateEmail(command.email);
        this.validatePassword(command.password);
        if (
          command.type === "SIGN_UP_EMAIL" &&
          (command.password.length < 6 ||
            command.password !== command.confirmation ||
            !command.name.trim())
        )
          throw new AccountError("INVALID_INPUT");
        let value = await this.firebase(
          command.type === "SIGN_UP_EMAIL" ? "signUp" : "signInWithPassword",
          {
            email: command.email.trim(),
            password: command.password,
            returnSecureToken: true,
          },
          signal,
        );
        this.assertEpoch(epoch);
        if (command.type === "SIGN_UP_EMAIL") {
          value = await this.firebase(
            "update",
            {
              idToken: value.idToken,
              displayName: command.name.trim(),
              returnSecureToken: true,
            },
            signal,
          );
          this.assertEpoch(epoch);
        }
        return this.completeSignIn(
          this.parseCredential(value),
          epoch,
          signal,
          true,
        );
      }
      case "SIGN_IN_GOOGLE": {
        if (!command.link && this.credential)
          throw new AccountError("SESSION_CHANGED");
        const scope = command.link ? this.internalScope() : null;
        const linkingToken = command.link ? await this.token() : undefined;
        this.assertEpoch(epoch);
        const googleToken = await this.googleIdentity(epoch, signal);
        const value = await this.firebase(
          "signInWithIdp",
          this.googleBody(googleToken, linkingToken),
          signal,
        );
        this.assertEpoch(epoch);
        const credential = this.parseCredential(value);
        if (scope && credential.firebaseUid !== scope.firebaseUid)
          throw new AccountError("SESSION_CHANGED");
        return this.completeSignIn(credential, epoch, signal, !command.link);
      }
      case "RESET_PASSWORD": {
        this.validateEmail(command.email);
        if (this.resetRetryAt > this.now())
          throw new AccountError("RATE_LIMITED");
        await this.backend(
          "POST",
          "/auth/password-reset-requests",
          { email: command.email.trim() },
          { authenticated: false, epoch, signal },
        );
        this.resetRetryAt = this.now() + 30000;
        this.viewState.noticeCode = "PASSWORD_RESET_REQUESTED";
        return;
      }
      case "SEND_VERIFICATION": {
        if (this.verificationRetryAt > this.now())
          throw new AccountError("RATE_LIMITED");
        await this.backend("POST", "/auth/verification-emails", {}, { signal });
        this.verificationRetryAt = this.now() + 60000;
        this.viewState.noticeCode = "VERIFICATION_SENT";
        return;
      }
      case "RECHECK_VERIFICATION": {
        const scope = this.internalScope();
        await this.token(true);
        const value = await this.backend(
          "POST",
          "/auth/profile-synchronizations",
          {},
          { signal },
        );
        this.setUser(value.user);
        if (value.policy !== undefined) this.receiveAppPolicy(value.policy);
        await this.vaultMutation(
          () => this.options.vault.save(structuredClone(this.credential!)),
          () => this.assertScope(scope),
        );
        this.viewState.noticeCode = this.viewState.user?.emailVerified
          ? "EMAIL_VERIFIED"
          : "EMAIL_NOT_VERIFIED";
        return;
      }
      case "REAUTHENTICATE":
        return this.reauthenticate(command.password, signal);
      case "LINK_PASSWORD": {
        this.validatePassword(command.password);
        if (
          command.password.length < 6 ||
          command.password !== command.confirmation ||
          !this.viewState.user?.email
        )
          throw new AccountError("INVALID_INPUT");
        const scope = this.internalScope();
        const token = await this.token();
        this.assertScope(scope);
        const value = await this.firebase(
          "update",
          {
            idToken: token,
            email: this.viewState.user.email,
            password: command.password,
            returnSecureToken: true,
          },
          signal,
        );
        this.assertScope(scope);
        const updated = this.parseCredential(value);
        if (updated.firebaseUid !== scope.firebaseUid)
          throw new AccountError("SESSION_CHANGED");
        await this.accept(
          { ...updated, user: this.viewState.user },
          false,
          scope.generation,
        );
        return this.bootstrap(signal);
      }
      case "UNLINK_PROVIDER": {
        const user = this.viewState.user;
        if (!user || !canUnlinkWindowsProvider(user, command.provider))
          throw new AccountError("LAST_SIGN_IN_METHOD");
        await this.reauthenticate(command.password, signal);
        const scope = this.internalScope();
        const token = await this.token();
        this.assertScope(scope);
        const value = await this.firebase(
          "update",
          {
            idToken: token,
            deleteProvider: [command.provider],
            returnSecureToken: true,
          },
          signal,
        );
        this.assertScope(scope);
        const updated = this.parseCredential(value);
        if (updated.firebaseUid !== scope.firebaseUid)
          throw new AccountError("SESSION_CHANGED");
        await this.accept(
          { ...updated, user: this.viewState.user },
          false,
          scope.generation,
        );
        return this.bootstrap(signal);
      }
      case "LOGOUT_ALL": {
        await this.backend("POST", "/auth/session-revocations", {}, { signal });
        return this.clearSession();
      }
      case "DELETE_ACCOUNT": {
        await this.reauthenticate(command.password, signal);
        const scope = this.internalScope();
        const receipt = await this.backend("DELETE", "/users/me", undefined, {
          signal,
        });
        this.assertScope(scope);
        if (receipt.status !== "accepted")
          throw new AccountError("MALFORMED_RESPONSE");
        await this.markDeletionPending();
        this.viewState.noticeCode = "ACCOUNT_DELETION_REQUESTED";
        return this.loadRecovery(signal);
      }
      case "LOAD_DEVICES":
        return this.loadDevices(command.before, signal);
      case "HIDE_DEVICE": {
        await this.backend(
          "DELETE",
          `/users/me/devices/${command.installationId.toLowerCase()}`,
          undefined,
          { signal },
        );
        this.viewState.devices = this.viewState.devices.filter(
          (device) =>
            device.installationId.toLowerCase() !==
            command.installationId.toLowerCase(),
        );
        return;
      }
      case "LOAD_RECOVERY":
        return this.loadRecovery(signal);
      case "REQUEST_RECOVERY": {
        if (this.viewState.recovery?.recoveryAvailable !== true)
          throw new AccountError("RECOVERY_UNAVAILABLE");
        await this.backend(
          "POST",
          "/users/me/account-recovery",
          {},
          { signal },
        );
        await this.loadRecovery(signal);
        this.viewState.noticeCode = "ACCOUNT_RECOVERY_REQUESTED";
        return;
      }
      case "RECONNECT":
        return this.bootstrap(signal);
      default:
        throw new AccountError("INVALID_INPUT");
    }
  }
  private async restore(epoch: string, signal: AbortSignal): Promise<void> {
    if (this.credential) return;
    this.viewState.state = "restoring";
    this.emit();
    try {
      if (await this.options.state.readSignedOut()) return;
      this.assertEpoch(epoch);
      const stored = await this.options.vault.load();
      this.assertEpoch(epoch);
      if (!stored) return;
      this.validateStored(stored);
      this.credential = structuredClone(stored);
      this.generation = randomUUID();
      this.viewState.user = stored.user;
      this.viewState.state = stored.deletionPending
        ? "deletion-pending"
        : "signed-in";
      const restoredEpoch = this.generation;
      await this.stateMutation(
        () => this.options.state.publishScope(this.sessionScope()),
        () => this.assertEpoch(restoredEpoch),
      );
    } catch (error) {
      if (error instanceof AccountError) throw error;
      throw new AccountError("VAULT_UNAVAILABLE");
    }
    if (this.credential) {
      if (this.credential.deletionPending) await this.loadRecovery(signal);
      else await this.bootstrap(signal);
    }
  }
  private validateEmail(email: string): void {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 254)
      throw new AccountError("INVALID_INPUT");
  }
  private validatePassword(password: string): void {
    if (!password || password.length > 4096)
      throw new AccountError("INVALID_INPUT");
  }
  private parseCredential(value: Record<string, unknown>): StoredCredential {
    const firebaseUid = text(value.localId ?? value.user_id, 128);
    const idToken = text(value.idToken ?? value.id_token, 16384, 20);
    const refreshToken = text(
      value.refreshToken ?? value.refresh_token,
      16384,
      20,
    );
    const raw = value.expiresIn ?? value.expires_in;
    if (typeof raw !== "string" || !/^[0-9]{1,5}$/.test(raw))
      throw new AccountError("MALFORMED_RESPONSE");
    const seconds = Number(raw);
    if (seconds < 1 || seconds > 86400)
      throw new AccountError("MALFORMED_RESPONSE");
    this.validateTokenProject(idToken, firebaseUid);
    return {
      firebaseUid,
      idToken,
      refreshToken,
      expiresAt: this.now() + seconds * 1000,
      user: null,
      deletionPending: false,
    };
  }
  private validateTokenProject(token: string, uid: string): void {
    if (
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) ||
      token.length > 16384
    )
      throw new AccountError("MALFORMED_RESPONSE");
    try {
      const claims = record(
        JSON.parse(
          Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
        ),
      );
      if (
        claims.aud !== this.options.configuration.firebase_project_id ||
        claims.iss !==
          `https://securetoken.google.com/${this.options.configuration.firebase_project_id}` ||
        claims.sub !== uid
      )
        throw new Error();
    } catch {
      throw new AccountError("SESSION_CHANGED");
    }
    // This detects project/UID mix-ups; Firebase and the backend verify signatures.
  }
  private validateStored(credential: StoredCredential): void {
    text(credential.firebaseUid, 128);
    text(credential.refreshToken, 16384, 20);
    safeInt(credential.expiresAt);
    this.validateTokenProject(credential.idToken, credential.firebaseUid);
    if (typeof credential.deletionPending !== "boolean")
      throw new AccountError("MALFORMED_RESPONSE");
    if (credential.user) {
      const user = credential.user;
      credential.user = userView({
        id: user.id,
        display_name: user.displayName,
        email: user.email,
        email_verified: user.emailVerified,
        providers: user.providers,
        worker_registration_allowed: user.workerRegistrationAllowed,
      });
    }
  }
  private async vaultMutation(
    action: () => Promise<void>,
    guard?: () => void,
  ): Promise<void> {
    const result = this.vaultWrites
      .catch(() => undefined)
      .then(async () => {
        guard?.();
        try {
          await action();
        } catch {
          throw new AccountError("VAULT_UNAVAILABLE");
        }
        guard?.();
      });
    this.vaultWrites = result;
    return result;
  }
  private async stateMutation(
    action: () => Promise<void>,
    guard?: () => void,
  ): Promise<void> {
    const result = this.stateWrites
      .catch(() => undefined)
      .then(async () => {
        guard?.();
        try {
          await action();
        } catch {
          throw new AccountError("VAULT_UNAVAILABLE");
        }
        guard?.();
      });
    this.stateWrites = result;
    return result;
  }
  private async accept(
    credential: StoredCredential,
    rotate: boolean,
    epoch: string,
  ): Promise<void> {
    this.assertEpoch(epoch);
    await this.vaultMutation(
      () => this.options.vault.save(structuredClone(credential)),
      () => this.assertEpoch(epoch),
    );
    this.assertEpoch(epoch);
    await this.stateMutation(
      () => this.options.state.writeSignedOut(false),
      () => this.assertEpoch(epoch),
    );
    this.assertEpoch(epoch);
    this.credential = credential;
    if (rotate) {
      this.generation = randomUUID();
      this.viewState.devices = [];
      this.viewState.recovery = null;
      this.verificationRetryAt = 0;
    }
    this.viewState.user = credential.user;
    this.viewState.state = credential.deletionPending
      ? "deletion-pending"
      : "signed-in";
    const acceptedEpoch = this.generation;
    await this.stateMutation(
      () => this.options.state.publishScope(this.sessionScope()),
      () => this.assertEpoch(acceptedEpoch),
    );
  }
  private setUser(value: unknown): void {
    const user = userView(value);
    this.viewState.user = user;
    if (this.credential) this.credential.user = user;
  }
  private async completeSignIn(
    credential: StoredCredential,
    epoch: string,
    signal: AbortSignal,
    rotate: boolean,
  ): Promise<void> {
    let bootstrap: Record<string, unknown>;
    try {
      bootstrap = await this.bootstrapWith(credential.idToken, epoch, signal);
    } catch (error) {
      if (accountFailure(error).code === "ACCOUNT_DELETION_PENDING") {
        this.assertEpoch(epoch);
        await this.accept(
          { ...credential, deletionPending: true },
          rotate,
          epoch,
        );
        await this.loadRecovery(signal);
        return;
      }
      throw error;
    }
    this.assertEpoch(epoch);
    credential.user = userView(bootstrap.user);
    await this.accept(credential, rotate, epoch);
    this.applyBootstrap(bootstrap);
  }
  private applyBootstrap(value: Record<string, unknown>): void {
    const policy = record(value.policy);
    const platform = record(record(policy.platforms).windows);
    const minimum = platform.minimum_build;
    this.viewState.minimumBuild =
      minimum == null ? null : safeInt(minimum, 1, 2147483647);
    const access = record(value.access);
    if (typeof access.allowed !== "boolean")
      throw new AccountError("MALFORMED_RESPONSE");
    this.viewState.access = {
      allowed: access.allowed,
      reason: access.allowed
        ? null
        : new AccountError(
            typeof access.reason === "string"
              ? access.reason
              : "ACCOUNT_REQUEST_FAILED",
          ).code,
    };
    this.viewState.online = true;
    if (policy.require_verified_email !== undefined)
      this.receiveAppPolicy(policy);
    else this.applyAppPolicyGate();
  }
  private async bootstrap(signal?: AbortSignal): Promise<void> {
    const scope = this.internalScope();
    const token = await this.token();
    this.assertScope(scope);
    const value = await this.bootstrapWith(token, scope.generation, signal);
    this.assertScope(scope);
    this.setUser(value.user);
    this.applyBootstrap(value);
    this.credential!.deletionPending = false;
    this.viewState.state = "signed-in";
    await this.vaultMutation(
      () => this.options.vault.save(structuredClone(this.credential!)),
      () => this.assertScope(scope),
    );
    await this.stateMutation(
      () => this.options.state.publishScope(this.sessionScope()),
      () => this.assertScope(scope),
    );
  }
  private reportBody(): Record<string, unknown> {
    const value = this.options.installation;
    return {
      installation_id: value.installationId.toLowerCase(),
      platform: "windows",
      app_version: value.appVersion,
      build_number: value.buildNumber,
      metadata_revision: value.metadataRevision,
      os_version: value.osVersion,
      ...(value.deviceModel ? { device_model: value.deviceModel } : {}),
    };
  }
  private async bootstrapWith(
    token: string,
    epoch: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    try {
      return await this.backend("POST", "/auth/sessions", this.reportBody(), {
        token,
        epoch,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (accountFailure(error).code !== "DEVICE_REPORT_CONFLICT") throw error;
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 5; page++) {
        const value = await this.backend(
          "GET",
          `/users/me/devices?limit=50${cursor ? `&before=${cursor}` : ""}`,
          undefined,
          { token, epoch, ...(signal ? { signal } : {}) },
        );
        if (!Array.isArray(value.items) || value.items.length > 50)
          throw new AccountError("MALFORMED_RESPONSE");
        const own = value.items
          .map(record)
          .find(
            (item) =>
              item.installation_id ===
              this.options.installation.installationId.toLowerCase(),
          );
        if (own) {
          if (own.platform !== "windows")
            throw new AccountError("DEVICE_REPORT_CONFLICT");
          const revision =
            Math.max(
              safeInt(own.metadata_revision, 1, Number.MAX_SAFE_INTEGER - 1),
              this.options.installation.metadataRevision,
            ) + 1;
          if (
            !Number.isSafeInteger(revision) ||
            revision >= Number.MAX_SAFE_INTEGER
          )
            throw new AccountError("DEVICE_REPORT_CONFLICT");
          this.options.installation.metadataRevision = revision;
          await this.options.state.saveMetadataRevision?.(revision);
          this.assertEpoch(epoch);
          return this.backend("POST", "/auth/sessions", this.reportBody(), {
            token,
            epoch,
            ...(signal ? { signal } : {}),
          });
        }
        if (value.next_cursor === null) break;
        if (
          typeof value.next_cursor !== "string" ||
          !/^[a-f0-9]{24}$/.test(value.next_cursor) ||
          seen.has(value.next_cursor)
        )
          throw new AccountError("DEVICE_REPORT_CONFLICT");
        cursor = value.next_cursor;
        seen.add(cursor);
      }
      throw new AccountError("DEVICE_REPORT_CONFLICT");
    }
  }
  private async reauthenticate(
    password: string,
    signal: AbortSignal,
  ): Promise<void> {
    const scope = this.internalScope();
    let value: Record<string, unknown>;
    if (!password && this.viewState.user?.providers.includes("google.com")) {
      const google = await this.googleIdentity(scope.generation, signal);
      value = await this.firebase(
        "signInWithIdp",
        this.googleBody(google),
        signal,
      );
    } else {
      if (!this.viewState.user?.email || !password)
        throw new AccountError("FRESH_AUTH_REQUIRED");
      this.validatePassword(password);
      value = await this.firebase(
        "signInWithPassword",
        { email: this.viewState.user.email, password, returnSecureToken: true },
        signal,
      );
    }
    this.assertScope(scope);
    const credential = this.parseCredential(value);
    if (credential.firebaseUid !== scope.firebaseUid)
      throw new AccountError("SESSION_CHANGED");
    await this.accept(
      {
        ...credential,
        user: this.viewState.user,
        deletionPending: this.credential!.deletionPending,
      },
      false,
      scope.generation,
    );
  }
  private googleBody(
    token: string,
    linkingToken?: string,
  ): Record<string, unknown> {
    return {
      postBody: new URLSearchParams({
        id_token: token,
        providerId: "google.com",
      }).toString(),
      requestUri: "http://localhost",
      returnSecureToken: true,
      ...(linkingToken ? { idToken: linkingToken } : {}),
    };
  }
  private async googleIdentity(
    epoch: string,
    signal: AbortSignal,
  ): Promise<string> {
    const clientId = this.options.configuration.google_desktop_client_id;
    if (!clientId) throw new AccountError("CONFIGURATION_REQUIRED");
    this.viewState.googleSignInActive = true;
    this.emit();
    const code = await this.options.google.authorize(clientId, signal);
    this.assertEpoch(epoch);
    if (
      !/^[\x21-\x7e]{1,4096}$(?![\s\S])/.test(code.authorizationCode) ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(code.codeVerifier) ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/oauth2callback$/.test(
        code.redirectUri,
      ) ||
      Number(new URL(code.redirectUri).port) > 65535
    )
      throw new AccountError("MALFORMED_RESPONSE");
    const value = await this.backend(
      "POST",
      "/auth/desktop-google-token-exchanges",
      {
        authorization_code: code.authorizationCode,
        code_verifier: code.codeVerifier,
        redirect_uri: code.redirectUri,
      },
      { authenticated: false, epoch, signal, limit: 32768 },
    );
    this.assertEpoch(epoch);
    const token = text(value.google_id_token, 16384, 20);
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))
      throw new AccountError("MALFORMED_RESPONSE");
    return token;
  }
  private firebase(
    endpoint: "signUp" | "signInWithPassword" | "signInWithIdp" | "update",
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return accountRequest(
      this.fetcher,
      `https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${encodeURIComponent(this.options.configuration.firebase_api_key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { signal },
    );
  }
  private async backend(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    options: {
      authenticated?: boolean;
      token?: string;
      epoch?: string;
      signal?: AbortSignal;
      limit?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    const epoch = options.epoch ?? this.generation;
    const scope =
      !options.token && options.authenticated !== false
        ? this.internalScope()
        : null;
    const origin = this.options.configuration.backend_base_url;
    const url = new URL(path, origin);
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      url.origin !== origin ||
      url.hash
    )
      throw new AccountError("INVALID_INPUT");
    const token =
      options.token ??
      (options.authenticated !== false ? await this.token() : undefined);
    this.assertEpoch(epoch);
    const request = (bearer?: string) =>
      accountRequest(
        this.fetcher,
        url.toString(),
        {
          method,
          headers: {
            Accept: "application/json",
            "X-Installation-Id": this.options.installation.installationId,
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.limit ? { limit: options.limit } : {}),
        },
      );
    let value: Record<string, unknown>;
    try {
      value = await request(token);
    } catch (error) {
      if (
        scope &&
        method === "GET" &&
        accountFailure(error).code === "UNAUTHENTICATED"
      ) {
        this.assertScope(scope);
        const refreshed = await this.token(true);
        this.assertScope(scope);
        value = await request(refreshed);
      } else throw error;
    }
    this.assertEpoch(epoch);
    if (scope) this.assertScope(scope);
    return value;
  }
  private async loadDevices(
    before: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const value = await this.backend(
      "GET",
      `/users/me/devices?limit=20${before ? `&before=${before}` : ""}`,
      undefined,
      { signal },
    );
    if (!Array.isArray(value.items) || value.items.length > 20)
      throw new AccountError("MALFORMED_RESPONSE");
    const devices = value.items.map((entry): AccountDeviceView => {
      const item = record(entry);
      const installationId = text(item.installation_id, 36);
      if (!uuid.test(installationId))
        throw new AccountError("MALFORMED_RESPONSE");
      return {
        installationId,
        platform: text(item.platform, 20),
        appVersion: text(item.app_version, 32),
        buildNumber: safeInt(item.build_number, 1, 2147483647),
        metadataRevision: safeInt(item.metadata_revision),
        osVersion: text(item.os_version, 64),
        deviceModel:
          item.device_model == null ? null : text(item.device_model, 100),
        lastSeenAt: date(item.last_seen_at),
        current:
          installationId.toLowerCase() ===
          this.options.installation.installationId.toLowerCase(),
      };
    });
    if (
      value.next_cursor !== null &&
      (typeof value.next_cursor !== "string" ||
        !/^[a-f0-9]{24}$/.test(value.next_cursor))
    )
      throw new AccountError("MALFORMED_RESPONSE");
    this.viewState.devices = before
      ? [
          ...this.viewState.devices.filter(
            (old) =>
              !devices.some(
                (item) => item.installationId === old.installationId,
              ),
          ),
          ...devices,
        ].slice(-250)
      : devices;
    this.viewState.nextDeviceCursor = value.next_cursor;
  }
  private async loadRecovery(signal?: AbortSignal): Promise<void> {
    const value = await this.backend(
      "GET",
      "/users/me/account-recovery",
      undefined,
      signal ? { signal } : {},
    );
    const deletion = value.deletion == null ? null : record(value.deletion);
    const request = value.request == null ? null : record(value.request);
    const recovery: AccountRecoveryView = {
      accountStatus: text(value.account_status, 30),
      recoverUntil: deletion ? date(deletion.recover_until) : null,
      recoveryAvailable: deletion?.recovery_available === true,
      requestStatus: request?.status == null ? null : text(request.status, 30),
    };
    this.viewState.recovery = recovery;
    if (
      recovery.accountStatus === "active" &&
      this.credential?.deletionPending
    ) {
      this.credential.deletionPending = false;
      await this.bootstrap(signal);
    }
  }
  private trackRetirement(task: Promise<void>): Promise<void> {
    this.retirements.add(task);
    const done = () => {
      this.retirements.delete(task);
      this.emit();
    };
    void task.then(done, done);
    return task;
  }
  private publishRetiredScope(): Promise<void> {
    // Host publishes memory/listener fences synchronously; durable state remains separately FIFO.
    try {
      return Promise.resolve(this.options.state.publishScope(null));
    } catch {
      return Promise.reject(new AccountError("VAULT_UNAVAILABLE"));
    }
  }
  private markDeletionPending(): Promise<void> {
    if (!this.credential) return Promise.resolve();
    this.generation = randomUUID();
    this.refreshing?.abort.abort();
    this.refreshing = null;
    this.credential.deletionPending = true;
    this.viewState.state = "deletion-pending";
    this.viewState.online = false;
    this.viewState.devices = [];
    this.viewState.access = {
      allowed: false,
      reason: "ACCOUNT_DELETION_PENDING",
    };
    const epoch = this.generation,
      credential = structuredClone(this.credential),
      scope = this.publishRetiredScope();
    const task = this.trackRetirement(
      Promise.allSettled([
        scope,
        this.vaultMutation(
          () => this.options.vault.save(credential),
          () => this.assertEpoch(epoch),
        ),
      ]).then((results) => {
        for (const result of results)
          if (result.status === "rejected")
            throw result.reason instanceof AccountError
              ? result.reason
              : new AccountError("VAULT_UNAVAILABLE");
      }),
    );
    this.emit();
    return task;
  }
  private clearSession(): Promise<void> {
    this.generation = randomUUID();
    this.operation?.abort.abort();
    this.operation = null;
    this.refreshing?.abort.abort();
    this.refreshing = null;
    this.credential = null;
    this.verificationRetryAt = 0;
    this.viewState = {
      ...this.viewState,
      state: "signed-out",
      busy: false,
      online: false,
      googleSignInActive: false,
      user: null,
      devices: [],
      nextDeviceCursor: null,
      recovery: null,
      access: { allowed: false, reason: "UNAUTHENTICATED" },
      minimumBuild: null,
      errorCode: null,
      noticeCode: null,
    };
    const scope = this.publishRetiredScope();
    // Queue cleanup before yielding so a new login is always persisted after
    // this account's tombstone/removal, including during slow native writes.
    const task = this.trackRetirement(
      Promise.allSettled([
        scope,
        this.stateMutation(() => this.options.state.writeSignedOut(true)),
        this.vaultMutation(() => this.options.vault.remove()),
      ]).then((results) => {
        if (results.some((result) => result.status === "rejected"))
          throw new AccountError("VAULT_UNAVAILABLE");
      }),
    );
    this.emit();
    return task;
  }
}
