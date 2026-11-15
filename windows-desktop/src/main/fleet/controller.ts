import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isCurrentUserSid } from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  WorkerEnrollmentClient,
  WorkerEnrollmentError,
  type WorkerInstallationReport,
} from "../../../../worker/src/enrollment/enrollment-client.js";
import {
  WorkerControlPlaneClient,
  ControlPlaneError,
  type WorkerMachineStatus,
} from "../../../../worker/src/runtime/control-plane-client.js";
import { uploadQualificationResult } from "../../../../worker/src/enrollment/qualification-upload.js";
import { accountRequest, type AccountFetch } from "../account/transport.js";
import type { AccountSessionScope } from "../account/account-controller.js";
import type { AccountView } from "../../shared/account-contracts.js";
import {
  parseFleetCommand,
  type FleetCommand,
  type FleetEligibility,
  type FleetView,
  type FleetIntent,
} from "../../shared/fleet-contracts.js";
import {
  parseFleetRecord,
  fleetRecordAuthority,
  type FleetEnrollmentRecord,
  type FleetPreparedIdentity,
  type FleetStorePort,
} from "./store.js";
export interface FleetPreparationPort {
  snapshot(signal: AbortSignal): Promise<FleetPreparedIdentity>;
  verify(identity: FleetPreparedIdentity, signal: AbortSignal): Promise<void>;
  qualify(
    record: FleetEnrollmentRecord,
    client: WorkerEnrollmentClient,
    signal: AbortSignal,
  ): Promise<FleetPreparedIdentity>;
  /** Validate the existing qualification-output identity, then use the existing bounded upload. */
  upload(
    record: FleetEnrollmentRecord,
    client: WorkerEnrollmentClient,
    signal: AbortSignal,
  ): Promise<void>;
}
export interface FleetControlState {
  intent: FleetIntent;
  revision: number;
}
export interface FleetControlPort {
  read(): Promise<FleetControlState>;
  intent(
    intent: FleetIntent,
    requestId: string,
    signal: AbortSignal,
  ): Promise<FleetControlState>;
  restart(requestId: string, signal: AbortSignal): Promise<FleetControlState>;
}
export interface FleetAccountPort {
  view(): AccountView;
  sessionScope(): AccountSessionScope | null;
  assertScope(scope: AccountSessionScope): void;
  authorization(forceRefresh?: boolean): Promise<string>;
}
export interface FleetControllerOptions {
  backendOrigin: string;
  installationId: string;
  sid: string;
  account: FleetAccountPort;
  store: FleetStorePort;
  preparation: FleetPreparationPort;
  controls: FleetControlPort;
  fetch?: AccountFetch;
  now?: () => number;
}
const SAFE_ERRORS = new Set([
  "FLEET_STATE_CORRUPT",
  "FLEET_BUSY",
  "FLEET_DRAIN_PENDING",
  "FLEET_PREPARE_REQUIRED",
  "FLEET_APPROVAL_REQUIRED",
  "FLEET_GOOGLE_REQUIRED",
  "FLEET_RECENT_AUTH_REQUIRED",
  "FLEET_ACCOUNT_REQUIRED",
  "FLEET_SESSION_CHANGED",
  "FLEET_INVITATION_EXPIRED",
  "FLEET_QUALIFICATION_REJECTED",
  "FLEET_PERMISSION_REVOKED",
  "FLEET_NOT_ENROLLED",
  "FLEET_NETWORK_UNAVAILABLE",
  "FLEET_CONTROL_UNAVAILABLE",
]);
function errorCode(error: unknown): string {
  if (
    error instanceof WorkerEnrollmentError ||
    error instanceof ControlPlaneError
  ) {
    if (
      error.status === 401 ||
      error.status === 403 ||
      error.code === "WORKER_MACHINE_DELETED"
    )
      return "FLEET_PERMISSION_REVOKED";
    if (error.retryable) return "FLEET_NETWORK_UNAVAILABLE";
  }
  const accountCode =
    error instanceof Error && "code" in error ? error.code : null;
  if (accountCode === "GOOGLE_SIGN_IN_REQUIRED") return "FLEET_GOOGLE_REQUIRED";
  if (accountCode === "WORKER_REGISTRATION_NOT_ALLOWED")
    return "FLEET_APPROVAL_REQUIRED";
  if (
    accountCode === "FRESH_AUTH_REQUIRED" ||
    accountCode === "REAUTHENTICATION_REQUIRED"
  )
    return "FLEET_RECENT_AUTH_REQUIRED";
  if (
    accountCode === "NETWORK_UNAVAILABLE" ||
    accountCode === "SERVICE_UNAVAILABLE"
  )
    return "FLEET_NETWORK_UNAVAILABLE";
  const code = error instanceof Error ? error.message : "";
  return SAFE_ERRORS.has(code) ? code : "FLEET_CONTROL_UNAVAILABLE";
}
function origin(value: string): string {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.origin !== value || u.username || u.password)
    throw new Error("FLEET_CONFIG_INVALID");
  return value;
}
function tokenIdentity(
  token: string,
): { uid: string; provider: string; authTime: number } | null {
  try {
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts[1]!.length > 32768 ||
      !/^[A-Za-z0-9_-]+$/.test(parts[1]!)
    )
      return null;
    const row = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const firebase = row.firebase as Record<string, unknown>;
    if (
      typeof row.sub !== "string" ||
      row.sub.length > 128 ||
      !Number.isSafeInteger(row.auth_time) ||
      typeof firebase?.sign_in_provider !== "string"
    )
      return null;
    return {
      uid: row.sub,
      provider: firebase.sign_in_provider,
      authTime: row.auth_time as number,
    };
  } catch {
    return null;
  }
}
/** Account authorization gates enrollment only. Saved fleet credentials remain independent. */
export class FleetController {
  private record: FleetEnrollmentRecord | null = null;
  private operation: {
    abort: AbortController;
    promise: Promise<FleetView>;
  } | null = null;
  private disposed = false;
  private autoEnrollmentAllowed = false;
  private value: FleetView = {
    state: "absent",
    eligibility: "signed-out",
    busy: false,
    machineId: null,
    label: null,
    intent: "stopped",
    connected: false,
    backendState: null,
    activeAttempts: null,
    claimsAllowed: false,
    errorCode: null,
    autoEnrollmentAllowed: false,
  };
  private readonly listeners = new Set<(view: FleetView) => void>();
  private readonly client: WorkerEnrollmentClient;
  private readonly fetcher: AccountFetch;
  constructor(private readonly options: FleetControllerOptions) {
    origin(options.backendOrigin);
    if (
      !isCurrentUserSid(options.sid) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        options.installationId,
      )
    )
      throw new Error("FLEET_CONFIG_INVALID");
    this.fetcher = options.fetch ?? fetch;
    this.client = new WorkerEnrollmentClient({
      baseUrl: options.backendOrigin,
      fetch: this.workerFetch,
      maxAttempts: 3,
    });
  }
  private readonly workerFetch: typeof fetch = (input, init) =>
    this.fetcher(String(input), init ?? {});
  private get now(): number {
    return (this.options.now ?? Date.now)();
  }
  view(): FleetView {
    return structuredClone(this.value);
  }
  subscribe(listener: (view: FleetView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(patch: Partial<FleetView>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.view());
      } catch {
        /* View consumers cannot change durable authority. */
      }
    }
  }
  execute(value: unknown): Promise<FleetView> {
    const command = parseFleetCommand(value);
    if (this.disposed)
      return Promise.reject(new Error("FLEET_CONTROL_UNAVAILABLE"));
    if (this.operation) return Promise.reject(new Error("FLEET_BUSY"));
    const abort = new AbortController();
    const promise = Promise.resolve().then(async () => {
      this.publish({ busy: true, errorCode: null });
      try {
        await this.run(command, abort.signal);
      } catch (error) {
        const code = errorCode(error);
        this.publish({
          errorCode: code,
          ...(code === "FLEET_PERMISSION_REVOKED"
            ? {
                connected: false,
                claimsAllowed: false,
                ...(this.record?.phase === "complete"
                  ? { state: "revoked" as const }
                  : {}),
              }
            : {}),
          ...(["ENROLL", "RESTORE", "RENEW_INVITATION"].includes(
            command.type,
          ) &&
          this.record &&
          this.record.phase !== "complete"
            ? { state: "interrupted" as const }
            : {}),
          renewInvitationAvailable:
            code === "FLEET_INVITATION_EXPIRED" &&
            this.record?.phase === "invitation" &&
            Date.parse(this.record.invitationExpiresAt) <= this.now,
        });
      } finally {
        this.operation = null;
        if (!this.disposed) this.publish({ busy: false });
      }
      return this.view();
    });
    this.operation = { abort, promise };
    return promise;
  }
  restore(): Promise<FleetView> {
    return this.execute({ type: "RESTORE" });
  }
  async eligibility(
    signal: AbortSignal = AbortSignal.timeout(15000),
  ): Promise<FleetEligibility> {
    const account = this.options.account.view(),
      scope = this.options.account.sessionScope();
    if (!scope || account.state !== "signed-in") return "signed-out";
    if (!account.googleSignInActive) return "google-required";
    if (!account.online) return "unavailable";
    const token = await this.options.account.authorization();
    this.options.account.assertScope(scope);
    const identity = tokenIdentity(token),
      now = Math.floor(this.now / 1000);
    if (
      !identity ||
      identity.uid !== scope.firebaseUid ||
      identity.provider !== "google.com" ||
      identity.authTime > now + 60 ||
      identity.authTime < now - 300
    )
      return "recent-auth-required";
    if (!account.user?.workerRegistrationAllowed) return "approval-required";
    try {
      await this.options.preparation.snapshot(signal);
      this.options.account.assertScope(scope);
    } catch {
      return "prepare-required";
    }
    return "ready";
  }
  private async run(command: FleetCommand, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (command.type === "RESTORE") {
      this.autoEnrollmentAllowed = false;
      this.publish({ autoEnrollmentAllowed: false });
      this.record = await this.options.store.read();
      this.autoEnrollmentAllowed =
        !this.record &&
        !!this.options.store.readPurgedTombstone &&
        !(await this.options.store.readPurgedTombstone());
      signal.throwIfAborted();
      this.displayRecord();
      if (this.record?.phase === "complete") {
        this.receiveControl(await this.options.controls.read());
        await this.reconcileStatus(signal);
      } else if (this.record && this.record.phase !== "revoked") {
        await this.enroll(signal);
      }
      return;
    }
    if (command.type === "CHECK_ELIGIBILITY") {
      this.publish({ eligibility: await this.eligibility(signal) });
      return;
    }
    if (command.type === "ENROLL") {
      await this.enroll(signal);
      return;
    }
    if (command.type === "RENEW_INVITATION") {
      await this.renewInvitation(signal);
      return;
    }
    if (!this.record) {
      this.record = await this.options.store.read();
      this.displayRecord();
    }
    const record = this.record;
    if (!record || record.phase !== "complete")
      throw new Error("FLEET_NOT_ENROLLED");
    if (command.type === "REVOKE") {
      if (!this.options.store.rememberUnpairAndRetire)
        throw new Error("FLEET_CONTROL_UNAVAILABLE");
      // The session authority durably saves Stop before remote revocation.
      this.receiveControl(
        await this.options.controls.intent("stopped", randomUUID(), signal),
      );
      const control = this.control(record);
      const revoked = await control.unpair(false, signal).catch((error) => {
        if (error instanceof ControlPlaneError && error.status === 409)
          throw new Error("FLEET_DRAIN_PENDING");
        throw error;
      });
      if (
        revoked.machineId !== record.machineId ||
        !revoked.confirmed ||
        revoked.status !== "revoked"
      )
        throw new Error("FLEET_CONTROL_UNAVAILABLE");
      this.record = await this.options.store.rememberUnpairAndRetire(
        fleetRecordAuthority(record),
        {
          machineId: revoked.machineId,
          revision: revoked.revision,
          confirmedAt: new Date(this.now).toISOString(),
        },
      );
      this.displayRecord();
      return;
    }
    const intent: FleetIntent =
      command.type === "PAUSE"
        ? "paused"
        : command.type === "DRAIN"
          ? "draining"
          : command.type === "STOP"
            ? "stopped"
            : "running";
    if (command.type === "RESTART") {
      this.receiveControl(
        await this.options.controls.restart(randomUUID(), signal),
      );
    } else {
      this.receiveControl(
        await this.options.controls.intent(intent, randomUUID(), signal),
      );
    }
  }
  private async renewInvitation(signal: AbortSignal): Promise<void> {
    const current = await this.options.store.read(),
      scope = this.options.account.sessionScope();
    this.record = current;
    if (
      !current ||
      current.phase !== "invitation" ||
      Date.parse(current.invitationExpiresAt) > this.now ||
      !this.options.store.renewInvitationIfCurrent
    )
      throw new Error("FLEET_CONTROL_UNAVAILABLE");
    if (!scope || scope.firebaseUid !== current.ownerUid)
      throw new Error("FLEET_SESSION_CHANGED");
    const eligibility = await this.eligibility(signal);
    this.options.account.assertScope(scope);
    this.publish({ eligibility });
    if (eligibility !== "ready")
      throw new Error(
        eligibility === "google-required"
          ? "FLEET_GOOGLE_REQUIRED"
          : eligibility === "approval-required"
            ? "FLEET_APPROVAL_REQUIRED"
            : eligibility === "recent-auth-required"
              ? "FLEET_RECENT_AUTH_REQUIRED"
              : eligibility === "prepare-required"
                ? "FLEET_PREPARE_REQUIRED"
                : "FLEET_ACCOUNT_REQUIRED",
      );
    const prepared = await this.options.preparation.snapshot(signal),
      token = await this.options.account.authorization();
    this.options.account.assertScope(scope);
    const response = await accountRequest(
      this.fetcher,
      `${this.options.backendOrigin}/users/me/worker-installation`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Installation-Id": this.options.installationId,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
      { signal },
    );
    this.options.account.assertScope(scope);
    if (!response || typeof response !== "object" || Array.isArray(response))
      throw new Error("FLEET_CONTROL_UNAVAILABLE");
    const row = response as Record<string, unknown>;
    if (
      typeof row.credential !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(row.credential) ||
      typeof row.expires_at !== "string" ||
      Date.parse(row.expires_at) <= this.now
    )
      throw new Error("FLEET_CONTROL_UNAVAILABLE");
    const replacement: FleetEnrollmentRecord = {
      ...current,
      enrollmentCredential: row.credential,
      invitationExpiresAt: row.expires_at,
      prepared,
      label: prepared.report.label,
    };
    this.record = await this.options.store.renewInvitationIfCurrent(
      current,
      replacement,
    );
    this.displayRecord();
    await this.enroll(signal);
  }
  private async enroll(signal: AbortSignal): Promise<void> {
    this.record = await this.options.store.read();
    if (this.record?.phase === "complete") {
      this.displayRecord();
      return;
    }
    if (this.record?.phase === "revoked")
      throw new Error("FLEET_PERMISSION_REVOKED");
    if (!this.record) {
      this.autoEnrollmentAllowed = false;
      this.publish({ autoEnrollmentAllowed: false });
      // Explicit enrollment may replace a valid retired marker, but damaged
      // protected marker state cannot become authority even for this command.
      const purged = await this.options.store.readPurgedTombstone?.();
      const eligibility = await this.eligibility(signal);
      this.publish({ eligibility });
      const codes: Partial<Record<FleetEligibility, string>> = {
        "signed-out": "FLEET_ACCOUNT_REQUIRED",
        "google-required": "FLEET_GOOGLE_REQUIRED",
        "recent-auth-required": "FLEET_RECENT_AUTH_REQUIRED",
        "approval-required": "FLEET_APPROVAL_REQUIRED",
        "prepare-required": "FLEET_PREPARE_REQUIRED",
        unavailable: "FLEET_NETWORK_UNAVAILABLE",
      };
      if (eligibility !== "ready") throw new Error(codes[eligibility]);
      const scope = this.options.account.sessionScope()!;
      const sessionState = await this.options.controls.read();
      const prepared = await this.options.preparation.snapshot(signal),
        token = await this.options.account.authorization();
      this.options.account.assertScope(scope);
      const response = await accountRequest(
        this.fetcher,
        `${this.options.backendOrigin}/users/me/worker-installation`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Installation-Id": this.options.installationId,
            "Content-Type": "application/json",
          },
          body: "{}",
        },
        { signal },
      );
      this.options.account.assertScope(scope);
      if (!response || typeof response !== "object" || Array.isArray(response))
        throw new Error("FLEET_CONTROL_UNAVAILABLE");
      const row = response as Record<string, unknown>;
      if (
        typeof row.credential !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(row.credential) ||
        typeof row.expires_at !== "string" ||
        Date.parse(row.expires_at) <= this.now
      )
        throw new Error("FLEET_CONTROL_UNAVAILABLE");
      const record: FleetEnrollmentRecord = {
        ...(purged ? { startAfterEnrollment: false } : {}),
        version: 1,
        sid: this.options.sid,
        ownerUid: scope.firebaseUid,
        backendOrigin: this.options.backendOrigin,
        label: prepared.report.label,
        onboardingRevision: sessionState.revision,
        phase: "invitation",
        prepared,
        requests: {
          exchange: randomUUID(),
          upload: randomUUID(),
          confirm: randomUUID(),
          report: randomUUID(),
          activate: randomUUID(),
        },
        enrollmentCredential: row.credential,
        invitationExpiresAt: row.expires_at,
        installationId: null,
        installationCredential: null,
        machineCredential: randomBytes(32).toString("base64url"),
        workerId: randomUUID(),
        reportRevision: null,
        machineId: null,
        credentialRevision: null,
      };
      // Durable handoff matches Mac: subsequent app signout cannot interrupt fleet onboarding.
      await this.persist(record);
    }
    let record = this.record;
    if (!record) throw new Error("FLEET_STATE_CORRUPT");
    const save = async (next: FleetEnrollmentRecord) => {
      await this.persist(next);
      record = next;
    };
    this.publish({ state: "installing" });
    await this.options.preparation.verify(record.prepared, signal);
    if (record.phase === "invitation") {
      if (!record.enrollmentCredential) throw new Error("FLEET_STATE_CORRUPT");
      if (Date.parse(record.invitationExpiresAt) <= this.now)
        throw new Error("FLEET_INVITATION_EXPIRED");
      const exchange = await this.client.exchange(
        record.enrollmentCredential,
        record.requests.exchange,
        signal,
      );
      await save({
        ...record,
        phase: "exchanged",
        installationId: exchange.installationId,
        installationCredential: exchange.credential,
      });
    }
    if (record.phase === "exchanged") {
      const approved = await this.options.preparation.qualify(
        record,
        this.client,
        signal,
      );
      if (
        approved.release !== record.prepared.release ||
        approved.manifestDigest !== record.prepared.manifestDigest ||
        approved.archiveDigest !== record.prepared.archiveDigest ||
        approved.modelDigest !== record.prepared.modelDigest
      )
        throw new Error("FLEET_PREPARE_REQUIRED");
      await save({ ...record, phase: "qualified", prepared: approved });
    }
    if (record.phase === "qualified") {
      await this.options.preparation.upload(record, this.client, signal);
      await save({ ...record, phase: "uploaded" });
    }
    if (record.phase === "uploaded") {
      const result = await this.client.report(
        record.installationId!,
        record.installationCredential!,
        record.requests.report,
        0,
        record.prepared.report,
        signal,
      );
      if (result.outcomeCode !== null)
        throw new Error("FLEET_QUALIFICATION_REJECTED");
      await save({
        ...record,
        phase: "reported",
        reportRevision: result.revision,
      });
    }
    if (record.phase === "reported") {
      if (!record.machineCredential) throw new Error("FLEET_STATE_CORRUPT");
      const activation = await this.client.activate(
        record.installationId!,
        record.installationCredential!,
        record.requests.activate,
        record.reportRevision!,
        createHash("sha256").update(record.machineCredential).digest("hex"),
        signal,
      );
      await save({
        ...record,
        phase: "activated",
        machineId: activation.machineId,
        credentialRevision: activation.credentialRevision,
      });
    }
    if (record.phase === "activated")
      await save({ ...record, phase: "complete" });
    this.displayRecord();
    const sessionState = await this.options.controls.read();
    if (
      record.startAfterEnrollment !== false &&
      sessionState.revision === record.onboardingRevision
    )
      this.receiveControl(
        await this.options.controls.intent("running", randomUUID(), signal),
      );
    else this.receiveControl(sessionState);
    await this.reconcileStatus(signal);
  }
  private async persist(record: FleetEnrollmentRecord): Promise<void> {
    const checked = parseFleetRecord(
      record,
      this.options.sid,
      this.options.backendOrigin,
    );
    await this.options.store.write(checked);
    this.record = checked;
    this.publish({
      machineId: checked.machineId,
      label: checked.label,
    });
  }
  private displayRecord(): void {
    const r = this.record;
    this.publish({
      state: !r
        ? "absent"
        : r.phase === "revoked"
          ? "revoked"
          : r.phase === "complete"
            ? "registered"
            : "interrupted",
      machineId: r?.machineId ?? null,
      label: r?.label ?? null,
      connected: false,
      backendState: null,
      activeAttempts: null,
      claimsAllowed: false,
      renewInvitationAvailable:
        r?.phase === "invitation" &&
        Date.parse(r.invitationExpiresAt) <= this.now,
      autoEnrollmentAllowed: !r && this.autoEnrollmentAllowed,
    });
  }
  private receiveControl(state: FleetControlState): void {
    if (
      !state ||
      !["running", "paused", "draining", "stopped"].includes(state.intent) ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 1
    )
      throw new Error("FLEET_CONTROL_UNAVAILABLE");
    this.publish({
      intent: state.intent,
      ...(state.intent !== "running" ? { claimsAllowed: false } : {}),
    });
  }
  private control(record: FleetEnrollmentRecord): WorkerControlPlaneClient {
    if (!record.machineCredential) throw new Error("FLEET_REVOKED");
    return new WorkerControlPlaneClient({
      baseUrl: record.backendOrigin,
      credential: record.machineCredential,
      fetch: this.workerFetch,
      maxAttempts: 2,
    });
  }
  private async reconcileStatus(signal: AbortSignal): Promise<void> {
    const record = this.record;
    if (!record || record.phase !== "complete") return;
    const status: WorkerMachineStatus =
      await this.control(record).machineStatus(signal);
    if (status.machineId !== record.machineId)
      throw new Error("FLEET_PERMISSION_REVOKED");
    this.publish({
      connected: true,
      backendState: status.status,
      activeAttempts: status.activeAttempts,
      claimsAllowed: status.claimsAllowed && this.value.intent === "running",
    });
  }
  /** Closes UI work only. Saved fleet configuration and intent are preserved. */
  dispose(): void {
    this.disposed = true;
    this.operation?.abort.abort();
    this.listeners.clear();
  }
}
export async function uploadPreparedFleetQualification(
  record: FleetEnrollmentRecord,
  client: WorkerEnrollmentClient,
  signal: AbortSignal,
  fetcher?: typeof fetch,
): Promise<void> {
  await uploadQualificationResult({
    client,
    installationId: record.installationId!,
    installationCredential: record.installationCredential!,
    grantRequestId: record.requests.upload,
    confirmRequestId: record.requests.confirm,
    outputPath: record.prepared.output.path,
    expectedBytes: record.prepared.output.bytes,
    expectedSha256: record.prepared.output.sha256,
    signal,
    ...(fetcher ? { fetch: fetcher } : {}),
  });
}
export type { WorkerInstallationReport };
