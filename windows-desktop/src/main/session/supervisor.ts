import { createHash, randomUUID } from "node:crypto";
import {
  sameConsumerProcess,
  type ConsumerHostIdentity,
  type ConsumerOwnedProcess,
  type ConsumerProcessIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  SESSION_MAX_RECEIPTS,
  SESSION_RESTART_LIMIT,
  type FleetIntent,
  type SessionAccountScope,
  type SessionCommand,
  type SessionProblem,
  type SessionRole,
  type SessionSnapshot,
  type StartupState,
} from "../../shared/session-contracts.js";

export interface RestartBudget {
  attempts: number;
  nextStartAt: number;
  blocked: boolean;
}
export interface SessionPersistentState {
  version: 1;
  sid: string;
  revision: number;
  fleetIntent: FleetIntent;
  restartPending: boolean;
  maintenance: {
    transaction: string;
    peer: ConsumerProcessIdentity;
    idle: boolean;
    /** A reviewed force is never cleared by timeout/Node exit/ordinary release. */
    force?: {
      requestId: string;
      reason: "stop" | "restart" | "update" | "revoke";
      owner: ConsumerOwnedProcess | null;
    };
  } | null;
  owner: { nonce: string; identity: ConsumerProcessIdentity } | null;
  budgets: Record<SessionRole, RestartBudget>;
  receipts: { requestId: string; digest: string }[];
}
export interface SessionStatePort {
  read(): Promise<SessionPersistentState | null>;
  write(state: SessionPersistentState): Promise<void>;
}
export interface SessionNativePort {
  identity(): Promise<ConsumerHostIdentity>;
  acquireSessionLock(): Promise<{
    nonce: string;
    identity: ConsumerProcessIdentity;
    abandoned: boolean;
  }>;
  releaseSessionLock(nonce: string): Promise<void>;
  processIdentity(pid: number): Promise<ConsumerProcessIdentity | null>;
  launchOwned(
    role: SessionRole,
    release: string,
  ): Promise<ConsumerOwnedProcess>;
  stopOwned(owner: ConsumerOwnedProcess): Promise<void>;
  ownedTreeExited?(owner: ConsumerOwnedProcess): Promise<boolean>;
  inspectStartup(): Promise<StartupState>;
  legacyWorkerConflict(): Promise<boolean>;
  /** A read-only Store fence observation can defer processing before restart
   * budget mutation. Final launch still takes the actual preparation gate. */
  processingAdmissionReady?(): Promise<boolean>;
  close(): Promise<void>;
}
export interface FleetSessionPort {
  eligibility(): Promise<{
    enrolled: boolean;
    approved: boolean;
    prepared: boolean;
  }>;
  reconcile(owner: ConsumerOwnedProcess, signal: AbortSignal): Promise<void>;
  setIntent(
    owner: ConsumerOwnedProcess,
    intent: Exclude<FleetIntent, "stopped">,
    signal: AbortSignal,
  ): Promise<void>;
  gracefulStop(owner: ConsumerOwnedProcess, signal: AbortSignal): Promise<void>;
  pauseForSleep(
    owner: ConsumerOwnedProcess,
    signal: AbortSignal,
  ): Promise<void>;
}
export interface PersonalSessionPort {
  idle?(): Promise<boolean>;
  prepared(): Promise<boolean>;
  reconcile(owner: ConsumerOwnedProcess, signal: AbortSignal): Promise<void>;
  detachOwner(ownerId: string, signal: AbortSignal): Promise<void>;
  applyAccountScope(scope: SessionAccountScope | null): Promise<void>;
  gracefulStop(owner: ConsumerOwnedProcess, signal: AbortSignal): Promise<void>;
}
export interface SessionClock {
  now(): number;
  random(): number;
  schedule(action: () => void, delayMs: number): () => void;
}
const clock: SessionClock = {
  now: Date.now,
  random: Math.random,
  schedule: (action, delayMs) => {
    const timer = setTimeout(action, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
const freshBudget = (): RestartBudget => ({
  attempts: 0,
  nextStartAt: 0,
  blocked: false,
});
export function freshSessionState(sid: string): SessionPersistentState {
  return {
    version: 1,
    sid,
    revision: 1,
    fleetIntent: "stopped",
    restartPending: false,
    maintenance: null,
    owner: null,
    budgets: { personal: freshBudget(), fleet: freshBudget() },
    receipts: [],
  };
}
type PersonalOwner = {
  kind: "desktop" | "chrome";
  peer: ConsumerProcessIdentity;
};

/** Serialized control, durable intent before admission, independent owner trees. */
export class SessionSupervisor {
  private state: SessionPersistentState | null = null;
  private host: ConsumerHostIdentity | null = null;
  private lockNonce: string | null = null;
  private readonly owners = new Map<string, PersonalOwner>();
  private readonly children: Partial<
    Record<SessionRole, ConsumerOwnedProcess>
  > = {};
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: SessionSnapshot) => void>();
  private readonly retries: Partial<Record<SessionRole, () => void>> = {};
  private readonly volatileReceipts = new Map<string, string>();
  private readonly completedMaintenance = new Map<
    string,
    {
      peer: ConsumerProcessIdentity;
      resumed: boolean;
    }
  >();
  private drainRetry: (() => void) | undefined;
  private publication = 0;
  private accountScope: SessionAccountScope | null = null;
  private snapshotValue: SessionSnapshot = {
    version: 1,
    instance_id: randomUUID(),
    release: "",
    revision: 0,
    phase: "starting",
    fleet: { intent: "stopped", phase: "stopped", problem: null },
    personal: { owners: 0, phase: "stopped", problem: null },
    startup: "unknown",
    maintenance: null,
  };
  constructor(
    private readonly options: {
      release: string;
      native: SessionNativePort;
      state: SessionStatePort;
      fleet: FleetSessionPort;
      personal: PersonalSessionPort;
      clock?: SessionClock;
      shutdownMs?: number;
      maintenanceReady?: () => Promise<boolean>;
      forceAuthority?: {
        verifyPeer(peer: ConsumerProcessIdentity): Promise<boolean>;
        identity(): Promise<{ machineId: string; authority: string } | null>;
      };
    },
  ) {
    this.snapshotValue.release = options.release;
  }
  private get time(): SessionClock {
    return this.options.clock ?? clock;
  }

  start(): Promise<SessionSnapshot> {
    return this.serialize(async () => {
      if (this.state) return this.snapshot();
      this.host = await this.options.native.identity();
      const guard = await this.options.native.acquireSessionLock();
      this.lockNonce = guard.nonce;
      if (
        guard.identity.sid !== this.host.sid ||
        guard.identity.sessionId !== this.host.sessionId
      )
        throw new Error("SESSION_IDENTITY_CONFLICT");
      let previous: SessionPersistentState | null;
      try {
        previous = await this.options.state.read();
      } catch {
        this.block("STATE_UNAVAILABLE");
        throw new Error("STATE_UNAVAILABLE");
      }
      if (previous && previous.sid !== this.host.sid) {
        this.block("SESSION_IDENTITY_CONFLICT");
        throw new Error("SESSION_IDENTITY_CONFLICT");
      }
      if (previous?.owner) {
        const current = await this.options.native.processIdentity(
          previous.owner.identity.pid,
        );
        if (current && sameConsumerProcess(current, previous.owner.identity)) {
          this.block("SESSION_IDENTITY_CONFLICT");
          throw new Error("SESSION_IDENTITY_CONFLICT");
        }
      }
      this.state = previous ?? freshSessionState(this.host.sid);
      await this.persist({
        ...this.state,
        owner: { nonce: guard.nonce, identity: guard.identity },
      });
      this.snapshotValue.startup = await this.options.native.inspectStartup();
      this.snapshotValue.phase = guard.abandoned ? "recovering" : "running";
      await this.reconcileFleet();
      if (this.snapshot().phase !== "blocked")
        this.snapshotValue.phase = "running";
      return this.publish();
    });
  }

  command(
    command: SessionCommand,
    peer: ConsumerProcessIdentity,
  ): Promise<SessionSnapshot> {
    if (command.action === "wait_state") return this.waitState(command, peer);
    return this.serialize(async () => {
      this.assertSession(peer);
      if (command.action === "maintenance_resume")
        return this.resumeMaintenance(command, peer);
      if (command.action === "fleet_force")
        return this.forceFleet(command, peer);
      if (
        command.action === "maintenance_begin" ||
        command.action === "maintenance_end" ||
        command.action === "maintenance_commit"
      )
        return this.maintenanceCommand(command, peer);
      if (command.action === "status") return this.snapshot();
      const digest = createHash("sha256")
        .update(JSON.stringify(command))
        .digest("hex");
      const volatileReceipt = this.volatileReceipts.get(command.request_id);
      if (volatileReceipt) {
        if (volatileReceipt !== digest) throw new Error("REQUEST_ID_REUSED");
        return this.snapshot();
      }
      const receipt = this.state!.receipts.find(
        (item) => item.requestId === command.request_id,
      );
      if (receipt) {
        if (receipt.digest !== digest) throw new Error("REQUEST_ID_REUSED");
        return this.snapshot();
      }
      // Save intent and idempotency receipt before process/claim mutations.
      // A failed/uncertain write never triggers a child launch or claim.
      if (
        command.action === "personal_attach" ||
        command.action === "personal_detach"
      ) {
        const existing = this.owners.get(command.owner_id);
        if (
          existing &&
          (!sameConsumerProcess(existing.peer, peer) ||
            (command.action === "personal_attach" &&
              existing.kind !== command.owner_kind))
        )
          throw new Error("PEER_DENIED");
      }
      const next = structuredClone(this.state!);
      const durable =
        command.action === "fleet_intent" || command.action === "fleet_restart";
      if (durable)
        next.receipts = [
          ...next.receipts,
          { requestId: command.request_id, digest },
        ].slice(-SESSION_MAX_RECEIPTS);
      const forcedReceipt =
        this.state!.maintenance?.force &&
        this.state!.receipts.find(
          (item) =>
            item.requestId === this.state!.maintenance!.force!.requestId,
        );
      if (
        forcedReceipt &&
        !next.receipts.some(
          (item) => item.requestId === forcedReceipt.requestId,
        )
      )
        next.receipts = [
          forcedReceipt,
          ...next.receipts.slice(-(SESSION_MAX_RECEIPTS - 1)),
        ];
      if (command.action === "fleet_intent") {
        next.fleetIntent = command.intent;
        next.restartPending = false;
      }
      if (command.action === "fleet_restart") {
        next.budgets.fleet = freshBudget();
        next.restartPending = true;
      }
      await this.persist(next);
      switch (command.action) {
        case "fleet_intent":
          await this.reconcileFleet();
          break;
        case "fleet_restart":
          await this.reconcileFleet();
          break;
        case "personal_attach": {
          const previous = this.owners.get(command.owner_id);
          if (
            previous &&
            (!sameConsumerProcess(previous.peer, peer) ||
              previous.kind !== command.owner_kind)
          )
            throw new Error("PEER_DENIED");
          this.owners.set(command.owner_id, {
            kind: command.owner_kind,
            peer: structuredClone(peer),
          });
          if (
            !previous ||
            !this.children.personal ||
            this.snapshotValue.personal.phase !== "running"
          )
            await this.reconcilePersonal();
          break;
        }
        case "personal_detach": {
          const existing = this.owners.get(command.owner_id);
          if (existing && !sameConsumerProcess(existing.peer, peer))
            throw new Error("PEER_DENIED");
          if (existing) {
            await this.deadline((signal) =>
              this.options.personal.detachOwner(command.owner_id, signal),
            );
            this.owners.delete(command.owner_id);
          }
          // The initialized personal role owns a logged-in-session model cache.
          // Detaching the last window cancels its jobs but preserves that cache.
          // Session shutdown, maintenance and fleet yield still positively stop it.
          break;
        }
        case "account_scope":
          await this.options.personal.applyAccountScope(command.scope);
          this.accountScope = structuredClone(command.scope);
          break;
      }
      if (!durable) {
        this.volatileReceipts.set(command.request_id, digest);
        if (this.volatileReceipts.size > SESSION_MAX_RECEIPTS)
          this.volatileReceipts.delete(
            this.volatileReceipts.keys().next().value!,
          );
      }
      return this.publish();
    });
  }

  sessionEvent(
    kind: "lock" | "unlock" | "suspend" | "resume" | "network",
  ): Promise<SessionSnapshot> {
    return this.serialize(async () => {
      this.assertRunning();
      if (kind === "suspend") {
        this.snapshotValue.phase = "sleeping";
        const fleet = this.children.fleet;
        if (fleet)
          await this.deadline((signal) =>
            this.options.fleet.pauseForSleep(fleet, signal),
          );
      } else if (kind === "resume" || kind === "network") {
        this.snapshotValue.phase = "recovering";
        await this.reconcileFleet();
        if (this.children.personal)
          await this.deadline((signal) =>
            this.options.personal.reconcile(this.children.personal!, signal),
          );
        if (this.snapshot().phase !== "blocked")
          this.snapshotValue.phase = "running";
      }
      // Lock/unlock never imply logout or a deliberate change to saved intent.
      return this.publish();
    });
  }

  childExited(owner: ConsumerOwnedProcess): Promise<SessionSnapshot> {
    return this.serialize(async () => {
      this.assertRunning();
      const role = owner.role as SessionRole;
      const current = this.children[role];
      if (
        !current ||
        current.nonce !== owner.nonce ||
        !sameConsumerProcess(current.identity, owner.identity)
      )
        return this.snapshot();
      await this.options.native.stopOwned(current);
      delete this.children[role];
      const budget = this.state!.budgets[role];
      this.roleState(
        role,
        budget.attempts >= SESSION_RESTART_LIMIT ? "blocked" : "recovering",
        budget.attempts >= SESSION_RESTART_LIMIT
          ? "RESTART_BUDGET_EXHAUSTED"
          : "CHILD_CREATION_FAILED",
      );
      if (this.state!.maintenance) await this.advanceMaintenance();
      else if (budget.attempts < SESSION_RESTART_LIMIT)
        this.scheduleRetry(role);
      return this.publish();
    });
  }

  usefulWork(owner: ConsumerOwnedProcess): Promise<void> {
    return this.serialize(async () => {
      const role = owner.role as SessionRole;
      const current = this.children[role];
      if (
        !this.state ||
        !current ||
        current.nonce !== owner.nonce ||
        !sameConsumerProcess(current.identity, owner.identity)
      )
        return;
      const next = structuredClone(this.state);
      next.budgets[role] = freshBudget();
      await this.persist(next);
    });
  }

  logout(): Promise<void> {
    return this.serialize(async () => {
      if (this.snapshotValue.phase === "logged-out") return;
      for (const role of ["personal", "fleet"] as const) this.retries[role]?.();
      this.drainRetry?.();
      this.drainRetry = undefined;
      const results = await Promise.allSettled([
        this.stopRole("personal", true),
        this.stopRole("fleet", true),
      ]);
      this.snapshotValue.phase = "logged-out";
      this.owners.clear();
      try {
        if (this.state) await this.persist({ ...this.state, owner: null });
      } finally {
        try {
          if (this.lockNonce)
            await this.options.native.releaseSessionLock(this.lockNonce);
        } finally {
          this.lockNonce = null;
          await this.options.native.close();
          this.publish();
        }
      }
      if (results.some((result) => result.status === "rejected"))
        throw new Error("CHILD_SHUTDOWN_PENDING");
    });
  }

  snapshot(): SessionSnapshot {
    return structuredClone(this.snapshotValue);
  }
  currentAccountScope(): SessionAccountScope | null {
    return structuredClone(this.accountScope);
  }
  maintenanceActive(): boolean {
    return (
      this.state?.maintenance !== null && this.state?.maintenance !== undefined
    );
  }
  /** Authenticated child activity is a wake, never an idle claim. Query the real
   * role/Job/admission ports under the same serialized maintenance authority. */
  refreshMaintenance(owner?: ConsumerOwnedProcess): Promise<SessionSnapshot> {
    return this.serialize(async () => {
      this.assertRunning();
      if (owner) {
        const current = this.children.personal;
        if (
          owner.role !== "personal" ||
          !current ||
          current.nonce !== owner.nonce ||
          !sameConsumerProcess(current.identity, owner.identity)
        )
          throw new Error("PEER_DENIED");
      }
      if (this.state!.maintenance) await this.advanceMaintenance();
      return this.publish();
    });
  }
  private async advanceMaintenance(): Promise<void> {
    if (!this.state!.maintenance) return;
    if (
      this.state!.maintenance.force?.owner &&
      !(await this.confirmForcedFleetExit())
    )
      return;
    const fleetStopped = await this.stopRole("fleet"),
      personalIdle =
        !this.children.personal ||
        (await this.options.personal.idle?.()) === true,
      personalStopped = personalIdle && (await this.stopRole("personal")),
      gpuIdle =
        !!this.options.maintenanceReady &&
        (await this.options.maintenanceReady());
    if (
      fleetStopped &&
      personalStopped &&
      gpuIdle &&
      !this.state!.maintenance.idle
    ) {
      await this.persist({
        ...this.state!,
        maintenance: { ...this.state!.maintenance, idle: true },
      });
      this.snapshotValue.maintenance = {
        transaction: this.state!.maintenance.transaction,
        phase: "idle",
      };
    }
  }
  private async confirmForcedFleetExit(): Promise<boolean> {
    const force = this.state!.maintenance?.force;
    if (!force?.owner) return true;
    if (
      !this.options.native.ownedTreeExited ||
      !(await this.options.native.ownedTreeExited(force.owner))
    )
      return false;
    const current = this.children.fleet;
    if (
      current &&
      (current.nonce !== force.owner.nonce ||
        !sameConsumerProcess(current.identity, force.owner.identity))
    )
      throw new Error("PEER_DENIED");
    delete this.children.fleet;
    this.roleState("fleet", "stopped", null);
    await this.persist({
      ...this.state!,
      maintenance: {
        ...this.state!.maintenance!,
        force: { ...force, owner: null },
      },
    });
    return true;
  }
  private async forceFleet(
    command: Extract<SessionCommand, { action: "fleet_force" }>,
    peer: ConsumerProcessIdentity,
  ): Promise<SessionSnapshot> {
    const authority = this.options.forceAuthority;
    if (!authority || !(await authority.verifyPeer(peer)))
      throw new Error("PEER_DENIED");
    const identity = await authority.identity();
    if (
      !identity ||
      identity.machineId !== command.machine_id ||
      identity.authority !== command.authority
    )
      throw new Error("PEER_DENIED");
    const digest = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    const receipt = this.state!.receipts.find(
      (item) => item.requestId === command.request_id,
    );
    if (receipt) {
      if (receipt.digest !== digest) throw new Error("REQUEST_ID_REUSED");
      if (this.state!.maintenance?.force?.requestId !== command.request_id)
        return this.snapshot();
      // Replayed ACK never kills a replacement role. It can reconcile only the
      // exact persisted old Job certificate after a lost stop/cleanup reply.
      if (!(await this.confirmForcedFleetExit()))
        throw new Error("CHILD_SHUTDOWN_PENDING");
    } else {
      if (command.expected_revision !== this.snapshotValue.revision)
        throw new Error("FORCE_CONFIRMATION_STALE");
      if (this.state!.maintenance) throw new Error("SESSION_UNAVAILABLE");
      if (
        (command.reason === "update" || command.reason === "revoke") &&
        this.children.personal &&
        (await this.options.personal.idle?.()) !== true
      )
        throw new Error("UPDATE_BUSY");
      const next = structuredClone(this.state!);
      next.receipts = [
        ...next.receipts,
        { requestId: command.request_id, digest },
      ].slice(-SESSION_MAX_RECEIPTS);
      if (command.reason === "stop") {
        next.fleetIntent = "stopped";
        next.restartPending = false;
      }
      if (command.reason === "restart") {
        next.restartPending = true;
        next.budgets.fleet = freshBudget();
      }
      next.maintenance = {
        transaction: command.confirmation,
        peer: structuredClone(peer),
        idle: false,
        force: {
          requestId: command.request_id,
          reason: command.reason,
          owner: this.children.fleet
            ? structuredClone(this.children.fleet)
            : null,
        },
      };
      await this.persist(next);
      this.snapshotValue.maintenance = {
        transaction: command.confirmation,
        phase: "draining",
      };
      this.retries.fleet?.();
      delete this.retries.fleet;
      this.drainRetry?.();
      this.drainRetry = undefined;
      this.publish();
      const currentIdentity = await authority.identity();
      if (
        !currentIdentity ||
        currentIdentity.machineId !== command.machine_id ||
        currentIdentity.authority !== command.authority
      )
        throw new Error("PEER_DENIED");
      if (next.maintenance.force!.owner) {
        try {
          await this.options.native.stopOwned(next.maintenance.force!.owner);
        } catch {
          /* A lost ACK is reconciled only by the exact Job certificate. */
        }
      }
      if (!(await this.confirmForcedFleetExit())) {
        this.roleState("fleet", "blocked", "CHILD_SHUTDOWN_PENDING");
        this.publish();
        throw new Error("CHILD_SHUTDOWN_PENDING");
      }
    }
    if (command.reason === "update" || command.reason === "revoke") {
      return this.maintenanceCommand(
        {
          version: 1,
          request_id: command.request_id,
          action: "maintenance_begin",
          transaction: command.confirmation,
        },
        peer,
      );
    }
    await this.persist({ ...this.state!, maintenance: null });
    this.snapshotValue.maintenance = null;
    await this.reconcileFleet();
    return this.publish();
  }
  private async maintenanceCommand(
    command: Extract<
      SessionCommand,
      { action: "maintenance_begin" | "maintenance_end" | "maintenance_commit" }
    >,
    peer: ConsumerProcessIdentity,
  ): Promise<SessionSnapshot> {
    const old = this.state!.maintenance;
    if (old?.force && !(await this.confirmForcedFleetExit()))
      throw new Error("CHILD_SHUTDOWN_PENDING");
    if (
      old &&
      (old.transaction !== command.transaction ||
        (!sameConsumerProcess(old.peer, peer) &&
          sameConsumerProcess(
            (await this.options.native.processIdentity(old.peer.pid)) ?? {
              ...old.peer,
              pid: 0,
            },
            old.peer,
          )))
    )
      throw new Error("PEER_DENIED");
    if (command.action === "maintenance_commit") {
      if (
        !old ||
        this.snapshotValue.maintenance?.phase !== "idle" ||
        this.children.personal ||
        this.children.fleet
      )
        throw new Error("SESSION_UNAVAILABLE");
      await this.persist({ ...this.state!, maintenance: null, owner: null });
      this.snapshotValue.maintenance = null;
      this.snapshotValue.phase = "logged-out";
      return this.publish();
    }
    if (command.action === "maintenance_end") {
      if (!old) return this.snapshot();
      await this.persist({
        ...this.state!,
        maintenance: null,
        budgets: old.idle
          ? { personal: freshBudget(), fleet: freshBudget() }
          : this.state!.budgets,
      });
      if (this.options.native.processingAdmissionReady) {
        this.completedMaintenance.set(old.transaction, {
          peer: structuredClone(old.peer),
          resumed: false,
        });
        if (this.completedMaintenance.size > SESSION_MAX_RECEIPTS)
          this.completedMaintenance.delete(
            this.completedMaintenance.keys().next().value!,
          );
      }
      this.snapshotValue.maintenance = null;
      await this.reconcileFleet();
      await this.reconcilePersonal();
      return this.publish();
    }
    await this.persist({
      ...this.state!,
      maintenance: {
        transaction: command.transaction,
        peer: structuredClone(peer),
        idle: false,
      },
    });
    this.snapshotValue.maintenance = {
      transaction: command.transaction,
      phase: "draining",
    };
    this.publish();
    await this.advanceMaintenance();
    return this.publish();
  }
  private async resumeMaintenance(
    command: Extract<SessionCommand, { action: "maintenance_resume" }>,
    peer: ConsumerProcessIdentity,
  ): Promise<SessionSnapshot> {
    const completed = this.completedMaintenance.get(command.transaction),
      inspect = this.options.native.processingAdmissionReady;
    if (
      !inspect ||
      command.instance_id !== this.snapshotValue.instance_id ||
      !completed ||
      this.state!.maintenance ||
      !sameConsumerProcess(completed.peer, peer)
    )
      throw new Error("PEER_DENIED");
    if (completed.resumed) return this.snapshot();
    // Only the original completed transaction/current instance can wake saved
    // intent. A caller supplies no intent, idle proof or replacement role.
    // The real mutex/WAL observation and final role gate remain mandatory.
    if ((await inspect.call(this.options.native)) !== true)
      throw new Error("UPDATE_BUSY");
    await this.reconcileFleet();
    await this.reconcilePersonal();
    completed.resumed = true;
    return this.publish();
  }
  private async waitState(
    command: Extract<SessionCommand, { action: "wait_state" }>,
    peer: ConsumerProcessIdentity,
  ): Promise<SessionSnapshot> {
    await this.serialize(async () => this.assertSession(peer));
    const current = this.snapshot();
    if (
      current.instance_id !== command.instance_id ||
      current.revision > command.after_revision
    )
      return current;
    return new Promise<SessionSnapshot>((resolve) => {
      let remove = () => {};
      const timer = setTimeout(() => {
        remove();
        resolve(this.snapshot());
      }, 20_000);
      const finish = (snapshot: SessionSnapshot) => {
        clearTimeout(timer);
        remove();
        resolve(snapshot);
      };
      remove = this.subscribe((snapshot) => {
        if (
          snapshot.instance_id !== command.instance_id ||
          snapshot.revision > command.after_revision
        )
          finish(snapshot);
      });
      // subscribe delivers immediately; close its handle if a change raced registration.
      if (this.snapshot().revision > command.after_revision) {
        clearTimeout(timer);
        remove();
        resolve(this.snapshot());
      }
    });
  }
  roleOwner(role: SessionRole): ConsumerOwnedProcess | undefined {
    const owner = this.children[role];
    return owner ? structuredClone(owner) : undefined;
  }
  authorizePersonalOwner(
    ownerId: string,
    peer: ConsumerProcessIdentity,
    kind?: "desktop" | "chrome",
  ): Promise<void> {
    return this.serialize(async () => {
      this.assertSession(peer);
      const owner = this.owners.get(ownerId);
      if (
        !owner ||
        !sameConsumerProcess(owner.peer, peer) ||
        (kind !== undefined && owner.kind !== kind)
      )
        throw new Error("PEER_DENIED");
    });
  }
  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(): SessionSnapshot {
    this.snapshotValue.revision = ++this.publication;
    this.snapshotValue.fleet.intent = this.state?.fleetIntent ?? "stopped";
    this.snapshotValue.personal.owners = this.owners.size;
    if (
      this.state?.maintenance &&
      this.snapshotValue.maintenance?.transaction !==
        this.state.maintenance.transaction
    )
      this.snapshotValue.maintenance = {
        transaction: this.state.maintenance.transaction,
        phase: this.state.maintenance.idle ? "idle" : "draining",
      };
    const value = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(value));
      } catch {
        this.listeners.delete(listener);
      }
    }
    return value;
  }
  private async persist(next: SessionPersistentState): Promise<void> {
    const candidate = { ...structuredClone(next), revision: next.revision + 1 };
    try {
      await this.options.state.write(candidate);
    } catch {
      this.block("STATE_UNAVAILABLE");
      throw new Error("STATE_UNAVAILABLE");
    }
    this.state = candidate;
  }
  private async reconcileFleet(): Promise<void> {
    this.assertRunning();
    if (this.state!.maintenance) {
      if (this.state!.maintenance.force?.owner) {
        this.roleState("fleet", "blocked", "CHILD_SHUTDOWN_PENDING");
        return;
      }
      await this.stopRole("fleet");
      return;
    }
    if (
      this.state!.fleetIntent !== "stopped" &&
      (await this.processingAdmissionDeferred("fleet"))
    )
      return;
    if (this.state!.restartPending) {
      if (!(await this.stopRole("fleet"))) return;
      await this.persist({ ...this.state!, restartPending: false });
    }
    if (this.state!.fleetIntent === "stopped") {
      await this.stopRole("fleet");
      return;
    }
    const eligibility = await this.options.fleet.eligibility();
    const problem: SessionProblem = !eligibility.enrolled
      ? "NOT_ENROLLED"
      : !eligibility.approved
        ? "APPROVAL_REQUIRED"
        : !eligibility.prepared
          ? "PREPARE_REQUIRED"
          : (await this.options.native.legacyWorkerConflict())
            ? "LEGACY_WORKER_CONFLICT"
            : null;
    if (problem) {
      if (this.children.fleet)
        await this.deadline((signal) =>
          this.options.fleet.pauseForSleep(this.children.fleet!, signal),
        );
      this.roleState(
        "fleet",
        problem === "NOT_ENROLLED" ? "absent" : "blocked",
        problem,
      );
      return;
    }
    if (this.snapshotValue.phase === "sleeping") return;
    const child = await this.ensureRole("fleet");
    if (!child) return;
    try {
      await this.deadline(async (signal) => {
        await this.options.fleet.reconcile(child, signal);
        await this.options.fleet.setIntent(
          child,
          this.state!.fleetIntent as Exclude<FleetIntent, "stopped">,
          signal,
        );
      });
      this.roleState(
        "fleet",
        this.state!.fleetIntent as "running" | "paused" | "draining",
        null,
      );
    } catch {
      this.roleState("fleet", "recovering", "CLAIM_RECONCILIATION_FAILED");
    }
  }
  private async reconcilePersonal(): Promise<void> {
    if (this.state?.maintenance) return;
    if (this.owners.size === 0 || this.snapshotValue.phase === "sleeping")
      return;
    if (await this.processingAdmissionDeferred("personal")) return;
    if (!(await this.options.personal.prepared())) {
      this.roleState("personal", "blocked", "PREPARE_REQUIRED");
      return;
    }
    if (await this.options.native.legacyWorkerConflict()) {
      this.roleState("personal", "blocked", "LEGACY_WORKER_CONFLICT");
      return;
    }
    const child = await this.ensureRole("personal");
    if (!child) return;
    try {
      await this.deadline((signal) =>
        this.options.personal.reconcile(child, signal),
      );
      this.roleState("personal", "running", null);
    } catch {
      this.roleState("personal", "recovering", "CLAIM_RECONCILIATION_FAILED");
    }
  }
  private async ensureRole(
    role: SessionRole,
  ): Promise<ConsumerOwnedProcess | undefined> {
    if (this.children[role]) return this.children[role];
    const budget = this.state!.budgets[role];
    if (budget.blocked || budget.attempts >= SESSION_RESTART_LIMIT) {
      this.roleState(role, "blocked", "RESTART_BUDGET_EXHAUSTED");
      return undefined;
    }
    if (budget.nextStartAt > this.time.now()) {
      this.roleState(role, "recovering", "CHILD_CREATION_FAILED");
      this.scheduleRetry(role);
      return undefined;
    }
    const next = structuredClone(this.state!);
    next.budgets[role] = {
      attempts: budget.attempts + 1,
      nextStartAt:
        this.time.now() +
        Math.round(
          Math.min(30_000, 1000 * 2 ** budget.attempts) *
            (0.5 + this.time.random() * 0.5),
        ),
      blocked: false,
    };
    await this.persist(next);
    this.roleState(role, "starting", null);
    try {
      const child = await this.options.native.launchOwned(
        role,
        this.options.release,
      );
      if (
        child.role !== role ||
        child.identity.sid !== this.host!.sid ||
        child.identity.sessionId !== this.host!.sessionId
      )
        throw new Error("SESSION_IDENTITY_CONFLICT");
      this.children[role] = child;
      return child;
    } catch {
      this.roleState(
        role,
        next.budgets[role].attempts >= SESSION_RESTART_LIMIT
          ? "blocked"
          : "recovering",
        next.budgets[role].attempts >= SESSION_RESTART_LIMIT
          ? "RESTART_BUDGET_EXHAUSTED"
          : "CHILD_CREATION_FAILED",
      );
      if (next.budgets[role].attempts < SESSION_RESTART_LIMIT)
        this.scheduleRetry(role);
      return undefined;
    }
  }
  private async processingAdmissionDeferred(
    role: SessionRole,
  ): Promise<boolean> {
    const inspect = this.options.native.processingAdmissionReady;
    if (!inspect) return false;
    try {
      if ((await inspect.call(this.options.native)) === true) return false;
    } catch {
      // Unknown mutex/WAL state keeps the intake fence. It is not a failed
      // child creation and must not spend the retained restart budget.
    }
    this.roleState(role, "blocked", "PREPARE_REQUIRED");
    return true;
  }
  private scheduleRetry(role: SessionRole): void {
    this.retries[role]?.();
    this.retries[role] = this.time.schedule(
      () => {
        delete this.retries[role];
        void this.serialize(async () => {
          if (this.snapshotValue.phase === "logged-out") return;
          if (role === "fleet") await this.reconcileFleet();
          else await this.reconcilePersonal();
          this.publish();
        }).catch(() => {
          this.block("STATE_UNAVAILABLE");
          this.publish();
        });
      },
      Math.max(
        0,
        (this.state?.budgets[role].nextStartAt ?? 0) - this.time.now(),
      ),
    );
  }
  private async stopRole(role: SessionRole, force = false): Promise<boolean> {
    this.retries[role]?.();
    delete this.retries[role];
    const child = this.children[role];
    if (!child) {
      this.roleState(role, "stopped", null);
      return true;
    }
    try {
      try {
        await this.deadline((signal) =>
          role === "fleet"
            ? this.options.fleet.gracefulStop(child, signal)
            : this.options.personal.gracefulStop(child, signal),
        );
      } catch {
        if (!force) {
          this.roleState(role, "recovering", "CHILD_SHUTDOWN_PENDING");
          if (role === "fleet") this.scheduleDrainRetry();
          return false;
        }
      }
      await this.options.native.stopOwned(child);
      delete this.children[role];
      this.roleState(role, "stopped", null);
      if (role === "fleet") {
        this.drainRetry?.();
        this.drainRetry = undefined;
      }
      return true;
    } catch {
      this.roleState(role, "blocked", "CHILD_SHUTDOWN_PENDING");
      throw new Error("CHILD_SHUTDOWN_PENDING");
    }
  }
  private scheduleDrainRetry(): void {
    if (this.drainRetry) return;
    this.drainRetry = this.time.schedule(() => {
      this.drainRetry = undefined;
      void this.serialize(async () => {
        if (this.snapshotValue.phase === "logged-out") return;
        await this.reconcileFleet();
        if (this.state!.maintenance) await this.advanceMaintenance();
        this.publish();
      }).catch(() => {
        this.block("STATE_UNAVAILABLE");
        this.publish();
      });
    }, 5000);
  }
  private async deadline(
    action: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("CHILD_SHUTDOWN_PENDING")),
      this.options.shutdownMs ?? 10_000,
    );
    try {
      await Promise.race([
        action(controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(controller.signal.reason),
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private roleState(
    role: SessionRole,
    phase:
      | "absent"
      | "stopped"
      | "starting"
      | "running"
      | "paused"
      | "draining"
      | "recovering"
      | "blocked",
    problem: SessionProblem,
  ): void {
    if (role === "fleet") {
      this.snapshotValue.fleet.phase = phase;
      this.snapshotValue.fleet.problem = problem;
    } else {
      this.snapshotValue.personal.phase =
        phase as SessionSnapshot["personal"]["phase"];
      this.snapshotValue.personal.problem = problem;
    }
  }
  private block(problem: SessionProblem): void {
    this.snapshotValue.phase = "blocked";
    this.snapshotValue.fleet.problem = problem;
  }
  private assertRunning(): void {
    if (
      !this.state ||
      !this.host ||
      !this.lockNonce ||
      this.snapshotValue.phase === "logged-out"
    )
      throw new Error("SESSION_UNAVAILABLE");
  }
  private assertSession(peer: ConsumerProcessIdentity): void {
    this.assertRunning();
    if (peer.sid !== this.host!.sid || peer.sessionId !== this.host!.sessionId)
      throw new Error("PEER_DENIED");
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(action);
    this.queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}
