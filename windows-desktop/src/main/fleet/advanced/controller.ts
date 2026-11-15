import { randomUUID } from "node:crypto";
import { isCurrentUserSid } from "../../../../../worker/src/platform/windows/consumer-native-policy.js";
import { sanitizeDiagnostic } from "../../../../../worker/src/agent/diagnostic-redaction.js";
import {
  parseFleetAdvancedCommand,
  parseFleetAdvancedMutation,
  type FleetAdvancedCommand,
  type FleetAdvancedFilter,
  type FleetAdvancedMutation,
  type FleetAdvancedRead,
  type FleetAdvancedView,
} from "../../../shared/fleet-advanced-contracts.js";

export interface AdvancedIdentity {
  sid: string;
  machineId: string;
  revision: number;
  digest: string;
}
/** Only an authenticated distinct Session pre-effect rejection can mint this. */
export class AdvancedForceReviewStale extends Error {
  constructor() {
    super("ADVANCED_FORCE_CONFIRMATION_STALE");
  }
}
export interface AdvancedJournal {
  version: 1;
  transaction: string;
  identity: AdvancedIdentity;
  mutation: FleetAdvancedMutation;
  phase: "waiting" | "fenced" | "running" | "effect-confirmed" | "complete";
  forceRevision?: number;
  startedAt: string;
}
export interface AdvancedJournalPort {
  read(): Promise<AdvancedJournal | null>;
  write(value: AdvancedJournal): Promise<void>;
}
export interface AdvancedConfirmationResources {
  release(): Promise<void>;
  forceRevision?: number;
}
export interface FleetAdvancedPorts {
  identity(): Promise<AdvancedIdentity>;
  journal: AdvancedJournalPort;
  read(
    section: FleetAdvancedRead,
    filter: FleetAdvancedFilter,
    signal: AbortSignal,
  ): Promise<unknown>;
  previewCleanup(signal: AbortSignal): Promise<unknown>;
  maintenance: {
    acquire(
      transaction: string,
      signal: AbortSignal,
    ): Promise<{ release(): Promise<void> }>;
    cancel(transaction: string, signal: AbortSignal): Promise<void>;
  };
  mutate(
    mutation: FleetAdvancedMutation,
    identity: AdvancedIdentity,
    transaction: string,
    signal: AbortSignal,
    confirmed: () => Promise<void>,
    resources?: AdvancedConfirmationResources,
  ): Promise<unknown>;
  /** Must prove the exact prior owned tree exited before releasing maintenance. */
  recover(journal: AdvancedJournal, signal: AbortSignal): Promise<unknown>;
  export(
    destinationCapability: string,
    data: unknown,
    signal: AbortSignal,
  ): Promise<void>;
  updateCheck(
    signal: AbortSignal,
    source?: "app" | "catalog",
  ): Promise<unknown>;
  assertAvailable?(
    mutation: FleetAdvancedMutation,
    signal: AbortSignal,
  ): Promise<void>;
  now?: () => number;
  prepareConfirmation?(
    mutation: FleetAdvancedMutation,
    identity: AdvancedIdentity,
    signal: AbortSignal,
  ): Promise<AdvancedConfirmationResources>;
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export function parseAdvancedJournal(value: unknown): AdvancedJournal {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("ADVANCED_JOURNAL_INVALID");
  const v = value as Record<string, unknown>,
    identity = v.identity as AdvancedIdentity;
  if (
    Object.keys(v).sort().join() !==
      (Object.hasOwn(v, "forceRevision")
        ? "forceRevision,identity,mutation,phase,startedAt,transaction,version"
        : "identity,mutation,phase,startedAt,transaction,version") ||
    v.version !== 1 ||
    typeof v.transaction !== "string" ||
    !UUID.test(v.transaction) ||
    !["waiting", "fenced", "running", "effect-confirmed", "complete"].includes(
      String(v.phase),
    ) ||
    typeof v.startedAt !== "string" ||
    !Number.isFinite(Date.parse(v.startedAt)) ||
    !identity ||
    Object.keys(identity).sort().join() !== "digest,machineId,revision,sid" ||
    !isCurrentUserSid(identity.sid) ||
    !UUID.test(identity.machineId) ||
    !Number.isSafeInteger(identity.revision) ||
    identity.revision < 1 ||
    !/^[a-f0-9]{64}$/u.test(identity.digest)
  )
    throw new Error("ADVANCED_JOURNAL_INVALID");
  const mutation = parseFleetAdvancedMutation(v.mutation);
  if (
    Object.hasOwn(v, "forceRevision") &&
    (!Number.isSafeInteger(v.forceRevision) || Number(v.forceRevision) < 1)
  )
    throw new Error("ADVANCED_JOURNAL_INVALID");
  if (
    ("force" in mutation && mutation.force === true) !==
    Object.hasOwn(v, "forceRevision")
  )
    throw new Error("ADVANCED_JOURNAL_INVALID");
  return {
    version: 1,
    transaction: v.transaction,
    identity: structuredClone(identity),
    mutation,
    ...(Object.hasOwn(v, "forceRevision")
      ? { forceRevision: Number(v.forceRevision) }
      : {}),
    phase: v.phase as AdvancedJournal["phase"],
    startedAt: v.startedAt,
  };
}
export function sameAdvancedIdentity(
  a: AdvancedIdentity,
  b: AdvancedIdentity,
): boolean {
  return (
    a.sid === b.sid &&
    a.machineId === b.machineId &&
    a.revision === b.revision &&
    a.digest === b.digest
  );
}
/** Last defense before a renderer/export boundary; private fields are never passed through. */
export function sanitizeAdvancedData(value: unknown): unknown {
  let nodes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > 20000 || depth > 16)
      throw new Error("ADVANCED_RESULT_TOO_LARGE");
    if (v == null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string")
      return sanitizeDiagnostic(v)
        .replace(
          /(?:[A-Za-z]:\\|\/(?:Users|home|tmp|private)\/)[^\r\n"<>]*/gu,
          "[PRIVATE_PATH]",
        )
        .slice(0, 1000);
    if (Array.isArray(v))
      return v.slice(0, 1000).map((entry) => walk(entry, depth + 1));
    if (typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .filter(
            ([key]) =>
              !/token|credential|password|secret|authorization|cookie|(?:^|_)url$|(?:^|_)path$|capability|outputPath|modelPath|relativePath/iu.test(
                key,
              ),
          )
          .map(([key, entry]) => [key.slice(0, 100), walk(entry, depth + 1)]),
      );
    return null;
  };
  const result = walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024)
    throw new Error("ADVANCED_RESULT_TOO_LARGE");
  return result;
}
function problem(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return /^(?:ADVANCED|FLEET|UPDATE|INPUT|LIBRARY|DISK|WORKER)_[A-Z0-9_]{1,64}$/u.test(
    code,
  )
    ? code
    : "ADVANCED_UNAVAILABLE";
}
/** One mutation lane with durable recovery; confirmation never authorizes another machine. */
export class WindowsFleetAdvancedController {
  private value: FleetAdvancedView = {
    phase: "idle",
    machineId: null,
    section: null,
    data: null,
    confirmation: null,
    problem: null,
    cancellable: false,
  };
  private readonly listeners = new Set<(view: FleetAdvancedView) => void>();
  private readonly confirmations = new Map<
    string,
    {
      mutation: FleetAdvancedMutation;
      identity: AdvancedIdentity;
      expiresAt: number;
      resources?: AdvancedConfirmationResources;
    }
  >();
  private readonly retiringResources = new Map<
    AdvancedConfirmationResources,
    { original?: Promise<void>; current?: Promise<void> | undefined }
  >();
  private active: { abort: AbortController; task: Promise<void> } | null = null;
  private disposed = false;
  private retiring = false;
  constructor(private readonly ports: FleetAdvancedPorts) {}
  snapshot(): FleetAdvancedView {
    return structuredClone(this.value);
  }
  subscribe(listener: (view: FleetAdvancedView) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }
  private publish(value: Partial<FleetAdvancedView>): void {
    if (this.disposed) return;
    this.value = { ...this.value, ...value };
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot());
      } catch {
        /* Observer failures cannot change the durable operation. */
      }
    }
  }
  async initialize(): Promise<void> {
    const journal = await this.ports.journal.read();
    this.publish({
      phase: journal && journal.phase !== "complete" ? "recovery" : "idle",
      machineId: journal?.identity.machineId ?? null,
      problem:
        journal && journal.phase !== "complete"
          ? "ADVANCED_RECOVERY_REQUIRED"
          : null,
    });
  }
  execute(value: unknown): Promise<void> {
    const command = parseFleetAdvancedCommand(value);
    if (this.disposed) return Promise.reject(new Error("ADVANCED_CLOSED"));
    if (
      this.retiring &&
      command.type !== "CANCEL" &&
      command.type !== "RECOVER"
    )
      return Promise.reject(new Error("ADVANCED_CLOSED"));
    if (command.type === "CANCEL") {
      const released = this.releaseConfirmations();
      const runningTask = this.active?.task;
      if (this.value.phase === "confirmation")
        this.publish({ phase: "idle", confirmation: null, problem: null });
      this.active?.abort.abort(new Error("ADVANCED_CANCELLED"));
      return released.then(() => runningTask ?? Promise.resolve());
    }
    if (this.active) return Promise.reject(new Error("ADVANCED_BUSY"));
    const abort = new AbortController();
    const task = Promise.resolve()
      .then(() => this.run(command, abort.signal))
      .catch((error) => {
        this.publish({
          phase: this.value.phase === "recovery" ? "recovery" : "error",
          problem: problem(error),
          cancellable: false,
        });
        throw error;
      })
      .finally(() => {
        if (this.active?.abort === abort) this.active = null;
      });
    this.active = { abort, task };
    return task;
  }
  private async identity(
    expected?: AdvancedIdentity,
  ): Promise<AdvancedIdentity> {
    const actual = await this.ports.identity();
    if (expected && !sameAdvancedIdentity(actual, expected))
      throw new Error("ADVANCED_MACHINE_CHANGED");
    return actual;
  }
  private async run(
    command: FleetAdvancedCommand,
    signal: AbortSignal,
  ): Promise<void> {
    const journal = await this.ports.journal.read();
    if (command.type === "RECOVER") {
      if (!journal || journal.phase === "complete") {
        this.publish({ phase: "idle", problem: null });
        return;
      }
      this.publish({ phase: "recovery", problem: null, cancellable: false });
      await this.identity(journal.identity);
      const result = await this.ports.recover(journal, signal);
      if (journal.mutation.action !== "update")
        await this.ports.maintenance.cancel(journal.transaction, signal);
      await this.ports.journal.write({ ...journal, phase: "complete" });
      this.publish({
        phase: "complete",
        data: sanitizeAdvancedData(result),
        confirmation: null,
        problem: null,
      });
      return;
    }
    if (
      journal &&
      journal.phase !== "complete" &&
      !["READ", "EXPORT"].includes(command.type)
    )
      throw new Error("ADVANCED_RECOVERY_REQUIRED");
    if (command.type === "READ") {
      this.publish({
        phase: "loading",
        section: command.section,
        confirmation: null,
        problem: null,
        cancellable: true,
      });
      const identity = await this.identity(),
        data = await this.ports.read(
          command.section,
          command.filter ?? {},
          signal,
        );
      await this.identity(identity);
      signal.throwIfAborted();
      this.publish({
        phase: "idle",
        machineId: identity.machineId,
        data: sanitizeAdvancedData(data),
        cancellable: false,
      });
      return;
    }
    if (command.type === "EXPORT") {
      await this.ports.export(
        command.destinationCapability,
        sanitizeAdvancedData({
          schemaVersion: 1,
          scope: "windows-user-fleet",
          section: this.value.section,
          data: this.value.data,
        }),
        signal,
      );
      return;
    }
    if (command.type === "CLEANUP_PREVIEW" || command.type === "UPDATE_CHECK") {
      const data =
        command.type === "CLEANUP_PREVIEW"
          ? await this.ports.previewCleanup(signal)
          : await this.ports.updateCheck(
              signal,
              "source" in command ? command.source : undefined,
            );
      this.publish({
        phase: "idle",
        section: command.type === "CLEANUP_PREVIEW" ? "cleanup" : "update",
        data: sanitizeAdvancedData(data),
        problem: null,
      });
      return;
    }
    if (command.type === "CONFIRM") {
      if (this.retiringResources.size)
        throw new Error("ADVANCED_RECOVERY_REQUIRED");
      await this.ports.assertAvailable?.(command.mutation, signal);
      const identity = await this.identity(),
        now = this.ports.now?.() ?? Date.now();
      signal.throwIfAborted();
      for (const [key, entry] of this.confirmations)
        if (entry.expiresAt <= now) {
          this.confirmations.delete(key);
          await this.releaseResources(entry.resources);
        }
      if (this.confirmations.size >= 8)
        throw new Error("ADVANCED_CONFIRMATION_LIMIT");
      const resources = await this.ports.prepareConfirmation?.(
        command.mutation,
        identity,
        signal,
      );
      try {
        await this.identity(identity);
        signal.throwIfAborted();
      } catch (error) {
        await this.releaseResources(resources);
        throw error;
      }
      const token = randomUUID(),
        expiresAt = now + 5 * 60_000;
      this.confirmations.set(token, {
        identity,
        mutation: command.mutation,
        expiresAt,
        ...(resources ? { resources } : {}),
      });
      this.publish({
        phase: "confirmation",
        machineId: identity.machineId,
        confirmation: {
          token,
          action: command.mutation.action,
          expiresAt: new Date(expiresAt).toISOString(),
          ...("force" in command.mutation && command.mutation.force === true
            ? { force: true }
            : {}),
          ...(command.mutation.action === "update" && command.mutation.source
            ? { source: command.mutation.source }
            : {}),
        },
        problem: null,
      });
      return;
    }
    if (command.type !== "RUN") throw new Error("ADVANCED_REQUEST_INVALID");
    const confirmed = this.confirmations.get(command.confirmation);
    this.confirmations.delete(command.confirmation);
    if (
      !confirmed ||
      confirmed.expiresAt <= (this.ports.now?.() ?? Date.now())
    ) {
      await this.releaseResources(confirmed?.resources);
      throw new Error("ADVANCED_CONFIRMATION_EXPIRED");
    }
    try {
      await this.ports.assertAvailable?.(confirmed.mutation, signal);
      await this.identity(confirmed.identity);
      let state: AdvancedJournal = {
        version: 1,
        transaction: randomUUID(),
        identity: confirmed.identity,
        mutation: confirmed.mutation,
        phase: "waiting",
        startedAt: new Date(this.ports.now?.() ?? Date.now()).toISOString(),
        ...("force" in confirmed.mutation && confirmed.mutation.force === true
          ? { forceRevision: confirmed.resources?.forceRevision ?? 0 }
          : {}),
      };
      state = parseAdvancedJournal(state);
      const checkpoint = async (phase: AdvancedJournal["phase"]) => {
        state = { ...state, phase };
        await this.ports.journal.write(state);
      };
      await checkpoint("waiting");
      this.publish({
        phase: "waiting",
        section: "operation",
        confirmation: null,
        problem: null,
        cancellable: true,
      });
      let lease: { release(): Promise<void> } | undefined,
        safeToResume = false;
      try {
        if (
          state.mutation.action !== "update" &&
          !("force" in state.mutation && state.mutation.force === true)
        )
          lease = await this.ports.maintenance.acquire(
            state.transaction,
            signal,
          );
        await checkpoint("fenced");
        await this.identity(state.identity);
        signal.throwIfAborted();
        await checkpoint("running");
        this.publish({ phase: "running" });
        const data = await this.ports.mutate(
          state.mutation,
          state.identity,
          state.transaction,
          signal,
          () => checkpoint("effect-confirmed"),
          confirmed.resources,
        );
        // mutate resolves only after its children and durable effects are confirmed.
        safeToResume = true;
        await checkpoint("effect-confirmed");
        await lease?.release();
        lease = undefined;
        await checkpoint("complete");
        this.publish({
          phase: "complete",
          data: sanitizeAdvancedData(data),
          cancellable: false,
          problem: null,
        });
      } catch (error) {
        if (error instanceof AdvancedForceReviewStale) {
          await checkpoint("complete");
          this.publish({
            phase: "error",
            cancellable: false,
            problem: error.message,
          });
          throw error;
        }
        // No resume on an uncertain native tree, backend acknowledgement or journal write.
        if (lease && safeToResume) {
          try {
            await lease.release();
          } catch {
            /* Recovery retains the transaction. */
          }
        }
        this.publish({
          phase: "recovery",
          cancellable: false,
          problem: problem(error),
        });
        throw error;
      }
    } finally {
      await this.releaseResources(confirmed.resources);
    }
  }
  private releaseResources(
    resources: AdvancedConfirmationResources | undefined,
  ): Promise<void> {
    if (!resources) return Promise.resolve();
    let owner = this.retiringResources.get(resources);
    if (!owner) {
      owner = {};
      this.retiringResources.set(resources, owner);
    }
    if (owner.current) return owner.current;
    const original = owner,
      task = Promise.resolve().then(() => resources.release());
    original.current = task;
    original.original ??= task;
    void task.then(
      () => {
        if (this.retiringResources.get(resources) === original)
          this.retiringResources.delete(resources);
      },
      () => {
        if (original.current === task) original.current = undefined;
      },
    );
    return task;
  }
  private async releaseConfirmations(): Promise<void> {
    const entries = [...this.confirmations.values()];
    this.confirmations.clear();
    // Withdraw tokens immediately, retaining failed resource owners separately.
    for (const entry of entries)
      if (entry.resources && !this.retiringResources.has(entry.resources))
        this.retiringResources.set(entry.resources, {});
    const results = await Promise.allSettled(
      [...this.retiringResources.keys()].map((resources) =>
        this.releaseResources(resources),
      ),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  /** Store shutdown fences intake while the original durable recovery remains
   * reachable. Disposal follows only after that owner's cleanup is confirmed. */
  async beginRetirement(): Promise<void> {
    this.retiring = true;
    this.active?.abort.abort(new Error("ADVANCED_CLOSED"));
    await this.active?.task.catch(() => {});
    await this.releaseConfirmations();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.active?.abort.abort(new Error("ADVANCED_CLOSED"));
    await this.active?.task.catch(() => {});
    await this.releaseConfirmations();
    this.listeners.clear();
  }
}
