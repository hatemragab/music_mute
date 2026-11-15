import { randomUUID } from "node:crypto";
import { compareWorkerReleaseVersions } from "../../../../worker/src/platform/shared/release-version.js";
import {
  consumerUpdateIdentity,
  consumerUpdateRequired,
  consumerUpdateVersions,
  verifyConsumerUpdate,
  consumerUpdateSourceDescriptor,
  type ConsumerUpdateTrust,
} from "./metadata.js";
import type {
  ConsumerUpdateMetadata,
  ConsumerUpdateView,
  ConsumerVersionSet,
  ConsumerUpdateScope,
  ConsumerUpdateSource,
} from "../../shared/update-contracts.js";

export interface ConsumerUpdateJournal {
  transaction: string;
  identity: string;
  signed: unknown;
  previous: ConsumerVersionSet;
  /** Omitted only in legacy protected journals; every new transaction persists it. */
  scope?: ConsumerUpdateScope;
  /** Legacy absence selects the app channel; catalog never borrows app trust. */
  source?: ConsumerUpdateSource;
  sourceDescriptor?: string;
  fleetForce?: ConsumerUpdateFleetForce;
  advancedOwner?: ConsumerUpdateAdvancedOwner;
  startedAt: string;
  phase:
    | "downloading"
    | "staged"
    | "fenced"
    | "activating"
    | "restart-required"
    | "health-check"
    | "complete"
    | "rolling-back"
    | "rolled-back"
    | "blocked";
}
export interface ConsumerUpdateFleetForce {
  machineId: string;
  authority: string;
  expectedRevision: number;
}
export interface ConsumerUpdateAdvancedOwner {
  machineId: string;
  authority: string;
}
export interface ConsumerUpdateReview extends ConsumerUpdateAdvancedOwner {
  transaction: string;
  force?: boolean;
  expectedRevision?: number;
}
export interface ConsumerUpdateState {
  version: 1;
  automaticDiscovery: boolean;
  highestSequence: number;
  observed: { sequence: number; identity: string } | null;
  journal: ConsumerUpdateJournal | null;
  quarantined: string[];
}
export interface ConsumerUpdateStore {
  read(): Promise<ConsumerUpdateState | null>;
  write(state: ConsumerUpdateState): Promise<void>;
}
export interface ConsumerUpdateStartupState {
  recoveryRequired: boolean;
  invalidState: boolean;
  transaction: string | null;
}
export interface ConsumerUpdateMaintenanceLease {
  release(): Promise<void>;
  /** Retire old session authority after a changed runtime, preserving its saved intent. */ commit(): Promise<void>;
}
export interface ConsumerUpdatePorts {
  trust: ConsumerUpdateTrust;
  sourceTrust?(source: ConsumerUpdateSource): Promise<ConsumerUpdateTrust>;
  store: ConsumerUpdateStore;
  current(): Promise<ConsumerVersionSet>;
  /** Capture operational qualification before mint; recovery uses only journal.scope. */
  operationScope?(): Promise<ConsumerUpdateScope>;
  candidate(
    signal: AbortSignal,
    source?: ConsumerUpdateSource,
  ): Promise<unknown>;
  /** Current-SID native Prepare mutex: no filename/PID-only installation lock. */ lock(): Promise<{
    release(): Promise<void>;
  } | null>;
  stage(
    metadata: ConsumerUpdateMetadata,
    transaction: string,
    signal: AbortSignal,
  ): Promise<void>;
  verifyStage(
    metadata: ConsumerUpdateMetadata,
    transaction: string,
    signal: AbortSignal,
  ): Promise<void>;
  /** Reject until playback/cache pins and pending account save/outbox mutations are safe. */ preserveConsumers(
    signal: AbortSignal,
  ): Promise<void>;
  maintenance(
    transaction: string,
    signal: AbortSignal,
  ): Promise<ConsumerUpdateMaintenanceLease>;
  /** Reserve and completely capture exact rollback bytes before the activation checkpoint. */
  backup(
    metadata: ConsumerUpdateMetadata,
    transaction: string,
    signal: AbortSignal,
  ): Promise<void>;
  /** Called only after installer-start acknowledgement and durable restart checkpoint. */
  restartRequired(): Promise<void>;
  /** Verify app publisher and runtime inventory, qualify selected GPU, publish exact active receipts. */ activate(
    metadata: ConsumerUpdateMetadata,
    transaction: string,
    signal: AbortSignal,
  ): Promise<void | "restart-required">;
  health(
    metadata: ConsumerUpdateMetadata,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Restore only the exact prior DPAPI-bound release; this never lowers highestSequence. */ rollback(
    previous: ConsumerVersionSet,
    transaction: string,
    signal: AbortSignal,
  ): Promise<void | "restart-required">;
  verifyPrevious(
    previous: ConsumerVersionSet,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Immutable staging/archive retention, active/previous/pinned paths excluded. */ cleanup(
    retain: readonly string[],
    signal: AbortSignal,
  ): Promise<void>;
  now?: () => Date;
}
const empty = (): ConsumerUpdateState => ({
  version: 1,
  automaticDiscovery: false,
  highestSequence: 0,
  observed: null,
  journal: null,
  quarantined: [],
});
const HASH = /^[a-f0-9]{64}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export function parseConsumerUpdateState(value: unknown): ConsumerUpdateState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("UPDATE_STATE_INVALID");
  const row = value as ConsumerUpdateState;
  if (
    Object.keys(row).sort().join() !==
      "automaticDiscovery,highestSequence,journal,observed,quarantined,version" ||
    row.version !== 1 ||
    typeof row.automaticDiscovery !== "boolean" ||
    !Number.isSafeInteger(row.highestSequence) ||
    row.highestSequence < 0 ||
    !Array.isArray(row.quarantined) ||
    row.quarantined.length > 32 ||
    row.quarantined.some((id) => !HASH.test(id)) ||
    new Set(row.quarantined).size !== row.quarantined.length
  )
    throw new Error("UPDATE_STATE_INVALID");
  if (
    row.observed !== null &&
    (!row.observed ||
      Object.keys(row.observed).sort().join() !== "identity,sequence" ||
      !Number.isSafeInteger(row.observed.sequence) ||
      row.observed.sequence < 1 ||
      row.observed.sequence !== row.highestSequence ||
      !HASH.test(row.observed.identity))
  )
    throw new Error("UPDATE_STATE_INVALID");
  if (row.journal !== null) {
    const journal = row.journal;
    if (
      !journal ||
      [
        "identity",
        "phase",
        "previous",
        "signed",
        "startedAt",
        "transaction",
      ].some((key) => !Object.hasOwn(journal, key)) ||
      Object.keys(journal).some(
        (key) =>
          ![
            "identity",
            "phase",
            "previous",
            "scope",
            "signed",
            "startedAt",
            "transaction",
            "source",
            "sourceDescriptor",
            "fleetForce",
            "advancedOwner",
          ].includes(key),
      ) ||
      !UUID.test(journal.transaction) ||
      !HASH.test(journal.identity) ||
      !Number.isFinite(Date.parse(journal.startedAt)) ||
      ![
        "downloading",
        "staged",
        "fenced",
        "activating",
        "restart-required",
        "health-check",
        "complete",
        "rolling-back",
        "rolled-back",
        "blocked",
      ].includes(journal.phase)
    )
      throw new Error("UPDATE_STATE_INVALID");
    assertVersions(journal.previous);
    consumerUpdateJournalScope(journal);
    consumerUpdateJournalSource(journal);
    if (Object.hasOwn(journal, "fleetForce"))
      assertConsumerFleetForce(journal.fleetForce);
    if (Object.hasOwn(journal, "advancedOwner"))
      assertConsumerAdvancedOwner(journal.advancedOwner);
  }
  if (Buffer.byteLength(JSON.stringify(row)) > 16384)
    throw new Error("UPDATE_STATE_INVALID");
  const result = structuredClone(row);
  if (result.journal)
    result.journal.scope = consumerUpdateJournalScope(result.journal);
  if (Buffer.byteLength(JSON.stringify(result)) > 16384)
    throw new Error("UPDATE_STATE_INVALID");
  return result;
}
export function assertConsumerFleetForce(
  value: unknown,
): asserts value is ConsumerUpdateFleetForce {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("UPDATE_STATE_INVALID");
  const row = value as ConsumerUpdateFleetForce;
  if (
    Object.keys(row).sort().join() !== "authority,expectedRevision,machineId" ||
    !UUID.test(row.machineId) ||
    !HASH.test(row.authority) ||
    !Number.isSafeInteger(row.expectedRevision) ||
    row.expectedRevision < 1
  )
    throw new Error("UPDATE_STATE_INVALID");
}
export function assertConsumerAdvancedOwner(
  value: unknown,
): asserts value is ConsumerUpdateAdvancedOwner {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("UPDATE_STATE_INVALID");
  const row = value as ConsumerUpdateAdvancedOwner;
  if (
    Object.keys(row).sort().join() !== "authority,machineId" ||
    !UUID.test(row.machineId) ||
    !HASH.test(row.authority)
  )
    throw new Error("UPDATE_STATE_INVALID");
}
export function consumerUpdateJournalSource(
  journal: ConsumerUpdateJournal,
): ConsumerUpdateSource {
  const source = Object.hasOwn(journal, "source") ? journal.source : "app";
  if (
    (source !== "app" && source !== "catalog") ||
    Object.hasOwn(journal, "source") !==
      Object.hasOwn(journal, "sourceDescriptor") ||
    (Object.hasOwn(journal, "sourceDescriptor") &&
      (typeof journal.sourceDescriptor !== "string" ||
        !HASH.test(journal.sourceDescriptor))) ||
    (source === "catalog" &&
      (!journal.sourceDescriptor ||
        consumerUpdateJournalScope(journal) !== "prepared"))
  )
    throw new Error("UPDATE_STATE_INVALID");
  return source;
}
export function consumerUpdateJournalScope(
  journal: ConsumerUpdateJournal,
): ConsumerUpdateScope {
  const value = Object.hasOwn(journal, "scope")
    ? journal.scope
    : journal.previous.runtime === null
      ? "app-only"
      : "prepared";
  if (
    (value !== "app-only" && value !== "prepared") ||
    (value === "prepared" && journal.previous.runtime === null)
  )
    throw new Error("UPDATE_STATE_INVALID");
  return value;
}
function assertVersions(versions: ConsumerVersionSet): void {
  if (!versions || Object.keys(versions).sort().join() !== "app,model,runtime")
    throw new Error("UPDATE_STATE_INVALID");
  if ((versions.runtime === null) !== (versions.model === null))
    throw new Error("UPDATE_STATE_INVALID");
  for (const [kind, item] of Object.entries(versions)) {
    if (kind !== "app" && item === null) continue;
    if (
      !item ||
      Object.keys(item).sort().join() !== "sha256,version" ||
      typeof item.version !== "string" ||
      !/^[0-9][A-Za-z0-9.-]{0,63}$/u.test(item.version) ||
      !HASH.test(item.sha256)
    )
      throw new Error("UPDATE_STATE_INVALID");
  }
}
function problem(error: unknown): string {
  const value = error instanceof Error ? error.message : "";
  if (/^(?:UPDATE_[A-Z_]{1,48}|GPU_BUSY)$/u.test(value)) return value;
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  return code === "ENOSPC"
    ? "UPDATE_LOW_DISK"
    : ["EACCES", "EPERM", "EBUSY"].includes(String(code))
      ? "UPDATE_FILE_IN_USE"
      : "UPDATE_FAILED";
}
function sameVersions(
  a: ConsumerVersionSet,
  b: ConsumerVersionSet,
  scope: ConsumerUpdateScope,
): boolean {
  return (
    scope === "app-only"
      ? (["app"] as const)
      : (["app", "runtime", "model"] as const)
  ).every(
    (kind) =>
      a[kind] === null ||
      (a[kind]!.version === b[kind]?.version &&
        a[kind]!.sha256 === b[kind]?.sha256),
  );
}
function requiredForScope(
  metadata: ConsumerUpdateMetadata,
  current: ConsumerVersionSet,
  scope: ConsumerUpdateScope,
): boolean {
  return scope === "app-only"
    ? compareWorkerReleaseVersions(
        current.app.version,
        metadata.required.minimumAppVersion,
      ) < 0
    : consumerUpdateRequired(metadata, current);
}
/** Discovery never activates. Every side effect after staging has a durable prior checkpoint. */
export class ConsumerUpdateController {
  private value: ConsumerUpdateView = {
    phase: "idle",
    available: null,
    required: false,
    automaticDiscovery: false,
    problem: null,
  };
  private readonly listeners = new Set<(view: ConsumerUpdateView) => void>();
  private running = false;
  constructor(private readonly ports: ConsumerUpdatePorts) {}
  private async sourceTrust(
    source: ConsumerUpdateSource,
    journal?: ConsumerUpdateJournal,
  ): Promise<ConsumerUpdateTrust> {
    if (source !== "app" && source !== "catalog")
      throw new Error("UPDATE_REQUEST_INVALID");
    const trust = this.ports.sourceTrust
      ? await this.ports.sourceTrust(source)
      : source === "app"
        ? this.ports.trust
        : null;
    if (!trust) throw new Error("UPDATE_CATALOG_UNAVAILABLE");
    if (
      journal?.sourceDescriptor &&
      journal.sourceDescriptor !== consumerUpdateSourceDescriptor(trust)
    )
      throw new Error("UPDATE_SOURCE_CHANGED");
    return trust;
  }
  private assertSource(
    source: ConsumerUpdateSource,
    metadata: ConsumerUpdateMetadata,
    previous: ConsumerVersionSet,
    scope: ConsumerUpdateScope,
  ): void {
    if (
      source === "catalog" &&
      (scope !== "prepared" ||
        previous.app.version !== metadata.app.version ||
        previous.app.sha256 !== metadata.app.payloadSha256)
    )
      throw new Error(
        scope !== "prepared"
          ? "UPDATE_PREPARE_REQUIRED"
          : "UPDATE_CATALOG_APP_MISMATCH",
      );
  }
  /** Private Main/Advanced recovery admission: exact protected transaction,
   * original machine authority, source and signed target; no HTTP or mutation. */
  async matchesAdvancedRecovery(
    expected: ConsumerUpdateAdvancedOwner & {
      transaction: string;
      source: "app" | "catalog";
    },
  ): Promise<boolean> {
    const state = await this.state(),
      journal = state.journal;
    if (
      !journal ||
      journal.transaction !== expected.transaction ||
      consumerUpdateJournalSource(journal) !== expected.source ||
      journal.advancedOwner?.machineId !== expected.machineId ||
      journal.advancedOwner.authority !== expected.authority
    )
      return false;
    const metadata = verifyConsumerUpdate(
      journal.signed,
      await this.sourceTrust(expected.source, journal),
      state.highestSequence,
      new Date(journal.startedAt),
    );
    return consumerUpdateIdentity(metadata) === journal.identity;
  }
  snapshot(): ConsumerUpdateView {
    return structuredClone(this.value);
  }
  subscribe(listener: (view: ConsumerUpdateView) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }
  private publish(patch: Partial<ConsumerUpdateView>): void {
    Object.assign(this.value, patch);
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        this.listeners.delete(listener);
      }
    }
  }
  private async state(): Promise<ConsumerUpdateState> {
    return parseConsumerUpdateState((await this.ports.store.read()) ?? empty());
  }
  private async operationScope(
    previous: ConsumerVersionSet,
  ): Promise<ConsumerUpdateScope> {
    const scope = this.ports.operationScope
      ? await this.ports.operationScope()
      : previous.runtime === null
        ? "app-only"
        : "prepared";
    if (
      (scope !== "app-only" && scope !== "prepared") ||
      (scope === "prepared" && previous.runtime === null)
    )
      throw new Error("UPDATE_STATE_INVALID");
    return scope;
  }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.running) throw new Error("UPDATE_BUSY");
    this.running = true;
    let lock: Awaited<ReturnType<ConsumerUpdatePorts["lock"]>> = null;
    try {
      lock = await this.ports.lock();
      if (!lock) throw new Error("UPDATE_BUSY");
      return await action();
    } finally {
      try {
        if (lock) await lock.release();
      } finally {
        this.running = false;
      }
    }
  }
  private async save(state: ConsumerUpdateState): Promise<void> {
    await this.ports.store.write(parseConsumerUpdateState(state));
  }
  /** Read protected startup state before any session launch/Prepare. Never fetches or activates. */
  async initialize(): Promise<ConsumerUpdateStartupState> {
    if (this.running) throw new Error("UPDATE_BUSY");
    let transaction: string | null = null;
    try {
      const state = await this.state(),
        journal = state.journal;
      this.publish({ automaticDiscovery: state.automaticDiscovery });
      if (!journal || ["complete", "rolled-back"].includes(journal.phase)) {
        this.publish({
          phase:
            (journal?.phase as "complete" | "rolled-back" | undefined) ??
            "idle",
          available: null,
          required: false,
          problem: null,
          ...(journal
            ? {
                scope: consumerUpdateJournalScope(journal),
              }
            : {}),
        });
        return {
          recoveryRequired: false,
          invalidState: false,
          transaction: null,
        };
      }
      transaction = journal.transaction;
      const metadata = verifyConsumerUpdate(
        journal.signed,
        await this.sourceTrust(consumerUpdateJournalSource(journal), journal),
        state.highestSequence,
        new Date(journal.startedAt),
      );
      if (consumerUpdateIdentity(metadata) !== journal.identity)
        throw new Error("UPDATE_STATE_INVALID");
      this.publish({
        phase:
          journal.phase === "restart-required" ? "restart-required" : "blocked",
        available: consumerUpdateVersions(metadata),
        scope: consumerUpdateJournalScope(journal),
        required: requiredForScope(
          metadata,
          journal.previous,
          consumerUpdateJournalScope(journal),
        ),
        problem: "UPDATE_RECOVERY_REQUIRED",
      });
      return { recoveryRequired: true, invalidState: false, transaction };
    } catch (error) {
      this.publish({
        phase: "blocked",
        available: null,
        required: false,
        problem: problem(error),
      });
      return { recoveryRequired: true, invalidState: true, transaction };
    }
  }
  async automaticDiscovery(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("UPDATE_REQUEST_INVALID");
    await this.exclusive(async () => {
      const state = await this.state();
      await this.save({ ...state, automaticDiscovery: enabled });
      this.publish({ automaticDiscovery: enabled });
    });
  }
  async check(
    signal: AbortSignal,
    automatic = false,
    source: ConsumerUpdateSource = "app",
  ): Promise<ConsumerUpdateView> {
    return this.exclusive(async () => {
      const state = await this.state();
      this.publish({ automaticDiscovery: state.automaticDiscovery });
      if (
        state.journal &&
        !["complete", "rolled-back"].includes(state.journal.phase)
      ) {
        this.publish({ phase: "blocked", problem: "UPDATE_RECOVERY_REQUIRED" });
        throw new Error("UPDATE_RECOVERY_REQUIRED");
      }
      if (automatic && !state.automaticDiscovery) return this.snapshot();
      try {
        const trust = await this.sourceTrust(source),
          signed = await this.ports.candidate(signal, source),
          metadata = verifyConsumerUpdate(
            signed,
            trust,
            state.highestSequence,
            this.ports.now?.(),
          ),
          id = consumerUpdateIdentity(metadata),
          current = await this.ports.current();
        assertVersions(current);
        const scope = await this.operationScope(current);
        this.assertSource(source, metadata, current, scope);
        this.checkReplay(state, metadata, id, current);
        await this.save({
          ...state,
          highestSequence: metadata.sequence,
          observed: { sequence: metadata.sequence, identity: id },
        });
        const versions = consumerUpdateVersions(metadata);
        this.publish({
          phase: sameVersions(current, versions, scope)
            ? "current"
            : "available",
          available: versions,
          scope,
          required: requiredForScope(metadata, current, scope),
          problem: null,
        });
        return this.snapshot();
      } catch (error) {
        this.publish({ phase: "blocked", problem: problem(error) });
        throw error;
      }
    });
  }
  private checkReplay(
    state: ConsumerUpdateState,
    metadata: ConsumerUpdateMetadata,
    id: string,
    current: ConsumerVersionSet,
  ): void {
    if (
      state.observed?.sequence === metadata.sequence &&
      state.observed.identity !== id
    )
      throw new Error("UPDATE_REPLAY");
    if (state.quarantined.includes(id)) throw new Error("UPDATE_QUARANTINED");
    for (const kind of ["app", "runtime", "model"] as const) {
      if (current[kind] === null) continue;
      const compare = compareWorkerReleaseVersions(
        metadata[kind].version,
        current[kind]!.version,
      );
      if (compare < 0) throw new Error("UPDATE_DOWNGRADE");
      if (
        compare === 0 &&
        current[kind]!.sha256 !== consumerUpdateVersions(metadata)[kind].sha256
      )
        throw new Error("UPDATE_IMMUTABLE_IDENTITY_CHANGED");
    }
  }
  async install(
    signal: AbortSignal,
    source: ConsumerUpdateSource = "app",
    review?: ConsumerUpdateReview,
  ): Promise<ConsumerUpdateView> {
    return this.exclusive(async () => {
      const state = await this.state();
      if (
        state.journal &&
        !["complete", "rolled-back"].includes(state.journal.phase)
      )
        throw new Error("UPDATE_RECOVERY_REQUIRED");
      const trust = await this.sourceTrust(source),
        signed = await this.ports.candidate(signal, source),
        metadata = verifyConsumerUpdate(
          signed,
          trust,
          state.highestSequence,
          this.ports.now?.(),
        ),
        identity = consumerUpdateIdentity(metadata),
        previous = await this.ports.current();
      assertVersions(previous);
      const scope = await this.operationScope(previous);
      let fleetForce: ConsumerUpdateFleetForce | undefined;
      let advancedOwner: ConsumerUpdateAdvancedOwner | undefined;
      if (review) {
        if (
          Object.keys(review).some(
            (key) =>
              ![
                "authority",
                "expectedRevision",
                "machineId",
                "transaction",
                "force",
              ].includes(key),
          ) ||
          !UUID.test(review.transaction)
        )
          throw new Error("UPDATE_REQUEST_INVALID");
        advancedOwner = {
          machineId: review.machineId,
          authority: review.authority,
        };
        assertConsumerAdvancedOwner(advancedOwner);
        if (review.force === true) {
          const force = {
            ...advancedOwner,
            expectedRevision: review.expectedRevision,
          };
          assertConsumerFleetForce(force);
          fleetForce = force;
        } else if (
          (Object.hasOwn(review, "force") && review.force !== false) ||
          Object.hasOwn(review, "expectedRevision")
        )
          throw new Error("UPDATE_REQUEST_INVALID");
      }
      this.assertSource(source, metadata, previous, scope);
      this.checkReplay(state, metadata, identity, previous);
      if (sameVersions(previous, consumerUpdateVersions(metadata), scope)) {
        this.publish({
          phase: "current",
          problem: null,
          scope,
          required: requiredForScope(metadata, previous, scope),
        });
        return this.snapshot();
      }
      const next: ConsumerUpdateState = {
        ...state,
        highestSequence: metadata.sequence,
        observed: { sequence: metadata.sequence, identity },
        journal: {
          transaction: review?.transaction ?? randomUUID(),
          identity,
          signed,
          previous,
          scope,
          source,
          sourceDescriptor: consumerUpdateSourceDescriptor(trust),
          ...(fleetForce ? { fleetForce } : {}),
          ...(advancedOwner ? { advancedOwner } : {}),
          startedAt: (this.ports.now?.() ?? new Date()).toISOString(),
          phase: "downloading",
        },
      };
      await this.save(next);
      return this.apply(next, metadata, signal, false);
    });
  }
  async recover(signal: AbortSignal): Promise<ConsumerUpdateView> {
    return this.exclusive(async () => {
      const state = await this.state(),
        journal = state.journal;
      if (!journal) {
        this.publish({ phase: "idle", problem: null });
        return this.snapshot();
      }
      const metadata = verifyConsumerUpdate(
        journal.signed,
        await this.sourceTrust(consumerUpdateJournalSource(journal), journal),
        state.highestSequence,
        new Date(journal.startedAt),
      );
      if (consumerUpdateIdentity(metadata) !== journal.identity)
        throw new Error("UPDATE_STATE_INVALID");
      this.assertSource(
        consumerUpdateJournalSource(journal),
        metadata,
        journal.previous,
        consumerUpdateJournalScope(journal),
      );
      if (["complete", "rolled-back"].includes(journal.phase)) {
        this.publish({
          phase: journal.phase as "complete" | "rolled-back",
          scope: consumerUpdateJournalScope(journal),
          problem: null,
        });
        return this.snapshot();
      }
      return this.apply(state, metadata, signal, true);
    });
  }
  private async apply(
    state: ConsumerUpdateState,
    metadata: ConsumerUpdateMetadata,
    signal: AbortSignal,
    recovery: boolean,
  ): Promise<ConsumerUpdateView> {
    const journal = state.journal!;
    const scope = consumerUpdateJournalScope(journal);
    this.publish({
      scope,
      available: consumerUpdateVersions(metadata),
      required: requiredForScope(metadata, journal.previous, scope),
    });
    let lease: ConsumerUpdateMaintenanceLease | undefined;
    let changed = [
        "activating",
        "restart-required",
        "health-check",
        "rolling-back",
        "blocked",
      ].includes(journal.phase),
      retainFence = false;
    const checkpoint = async (phase: ConsumerUpdateJournal["phase"]) => {
      journal.phase = phase;
      await this.save(state);
    };
    const finalize = async () => {
      if (journal.phase !== "health-check") await checkpoint("health-check");
      try {
        await lease!.commit();
      } catch {
        // Main may already have rebound the verified target authority. Never
        // overwrite its live model to compensate for uncertain finalization.
        retainFence = true;
        throw new Error("UPDATE_FINALIZE_UNCONFIRMED");
      }
      lease = undefined;
      await checkpoint("complete");
    };
    try {
      if (!changed) {
        this.publish({
          phase: "downloading",
          available: consumerUpdateVersions(metadata),
          scope,
          required: requiredForScope(metadata, journal.previous, scope),
          problem: null,
        });
        await this.ports.stage(metadata, journal.transaction, signal);
        await this.ports.verifyStage(metadata, journal.transaction, signal);
        await checkpoint("staged");
      }
      await this.ports.preserveConsumers(signal);
      this.publish({ phase: "waiting" });
      lease = await this.ports.maintenance(journal.transaction, signal);
      if (!changed) await checkpoint("fenced");
      if (recovery && changed) {
        // Never guess whether a partially switched release is healthy.
        if (await this.ports.health(metadata, signal)) {
          await finalize();
          this.publish({ phase: "complete", problem: null });
          return this.snapshot();
        }
        if (["blocked", "rolling-back"].includes(journal.phase))
          throw new Error("UPDATE_HEALTH_FAILED");
      }
      this.publish({ phase: "activating" });
      await this.ports.backup(metadata, journal.transaction, signal);
      signal.throwIfAborted();
      await checkpoint("activating");
      changed = true;
      const activation = await this.ports.activate(
        metadata,
        journal.transaction,
        signal,
      );
      if (activation === "restart-required") {
        retainFence = true;
        await checkpoint("restart-required");
        this.publish({ phase: "restart-required", problem: null });
        await this.ports.restartRequired();
        return this.snapshot();
      }
      this.publish({ phase: "health-check" });
      await checkpoint("health-check");
      if (!(await this.ports.health(metadata, signal)))
        throw new Error("UPDATE_HEALTH_FAILED");
      await finalize();
      this.publish({ phase: "complete", problem: null });
      await this.ports
        .cleanup(
          [
            journal.identity,
            ...Object.values(journal.previous).flatMap((item) =>
              item ? [item.sha256] : [],
            ),
          ],
          signal,
        )
        .catch(() => this.publish({ problem: "UPDATE_CLEANUP_PENDING" }));
      return this.snapshot();
    } catch (error) {
      if (
        !changed &&
        journal.fleetForce &&
        error instanceof Error &&
        error.message === "UPDATE_FORCE_CONFIRMATION_STALE"
      ) {
        await checkpoint("rolled-back");
        this.publish({ phase: "rolled-back", problem: error.message });
      } else if (
        changed &&
        lease &&
        problem(error) === "UPDATE_SESSION_STOP_UNCONFIRMED"
      ) {
        retainFence = true;
        await checkpoint("blocked");
        this.publish({ phase: "blocked", problem: problem(error) });
      } else if (
        changed &&
        lease &&
        ["UPDATE_INSTALLER_UNCONFIRMED", "UPDATE_INSTALLER_RUNNING"].includes(
          problem(error),
        )
      ) {
        retainFence = true;
        await checkpoint("restart-required");
        this.publish({ phase: "blocked", problem: problem(error) });
      } else if (changed && lease && !retainFence) {
        try {
          await checkpoint("rolling-back");
          const rollbackSignal = AbortSignal.timeout(120000);
          const rollback = await this.ports.rollback(
            journal.previous,
            journal.transaction,
            rollbackSignal,
          );
          if (rollback === "restart-required") {
            retainFence = true;
            this.publish({
              phase: "restart-required",
              problem: "UPDATE_HEALTH_FAILED",
            });
            await this.ports.restartRequired();
            return this.snapshot();
          }
          if (
            !(await this.ports.verifyPrevious(journal.previous, rollbackSignal))
          )
            throw new Error("UPDATE_ROLLBACK_UNCONFIRMED");
          state.quarantined = [
            ...new Set([...state.quarantined, journal.identity]),
          ].slice(-32);
          await checkpoint("rolled-back");
          this.publish({ phase: "rolled-back", problem: problem(error) });
        } catch {
          retainFence = true;
          await checkpoint("blocked");
          this.publish({
            phase: "blocked",
            problem: "UPDATE_ROLLBACK_UNCONFIRMED",
          });
        }
      } else {
        this.publish({
          phase: problem(error) === "UPDATE_BUSY" ? "waiting" : "blocked",
          problem: problem(error),
        });
      }
      throw error;
    } finally {
      if (lease && !retainFence) await lease.release();
    }
  }
}
