import { randomUUID } from "node:crypto";
import type { SessionPersistentState } from "./supervisor.js";
import type { FleetIntent } from "../../shared/session-contracts.js";

export interface LoginWorkerEligibility {
  state: SessionPersistentState;
  /** Immutable original approved enrollment authority, never a newly invented report. */
  authority: string;
  removed: boolean;
}
export type LoginWorkerResult =
  | {
      outcome: "noop";
      reason:
        | "unenrolled"
        | "saved-intent"
        | "changed-intent"
        | "existing-owner"
        | "restart-blocked";
    }
  | { outcome: "blocked"; reason: "recovery" | "busy" | "tree-proof" }
  | { outcome: "started"; qualification: "current" | "requalified" };
export interface LoginWorkerPorts {
  authorize(): Promise<void>;
  eligibility(): Promise<LoginWorkerEligibility | null>;
  existingOwner(): Promise<boolean>;
  recoveryPending(): Promise<boolean>;
  acquireActivation(): Promise<{ release(): Promise<void> } | null>;
  acquirePrepare(): Promise<{ release(): Promise<void> } | null>;
  treesIdle(): Promise<boolean>;
  prepareTreesIdle(): Promise<boolean>;
  /** On this exact uncertainty, retain both real fences until recovery proves terminal cleanup. */
  cleanupUncertain(error: unknown): boolean;
  recoverUncertainCleanup(signal: AbortSignal): Promise<void>;
  currentQualification(): Promise<boolean>;
  requalifyInstalled(signal: AbortSignal): Promise<void>;
  refreshApprovedFleet(transaction: string, signal: AbortSignal): Promise<void>;
  launch(intent: Exclude<FleetIntent, "stopped">): Promise<boolean>;
}
function eligible(row: LoginWorkerEligibility | null): boolean {
  return (
    !!row &&
    !row.removed &&
    row.state.fleetIntent !== "stopped" &&
    !row.state.maintenance &&
    !row.state.budgets.fleet.blocked
  );
}
function sameIntent(
  first: LoginWorkerEligibility,
  next: LoginWorkerEligibility | null,
): boolean {
  return (
    eligible(next) &&
    next!.authority === first.authority &&
    next!.state.sid === first.state.sid &&
    next!.state.revision === first.state.revision &&
    next!.state.fleetIntent === first.state.fleetIntent
  );
}
/** No account authority, no second saved-intent writer, no network/download/CPU fallback.
 * Prepare and activation are real native leases; every launch reads the latest policy again. */
export async function runLoginWorkerBootstrap(
  ports: LoginWorkerPorts,
  signal: AbortSignal,
): Promise<LoginWorkerResult> {
  signal.throwIfAborted();
  await ports.authorize();
  const first = structuredClone(await ports.eligibility());
  if (!first) return { outcome: "noop", reason: "unenrolled" };
  if (first.state.budgets.fleet.blocked)
    return { outcome: "noop", reason: "restart-blocked" };
  if (!eligible(first)) return { outcome: "noop", reason: "saved-intent" };
  if (await ports.existingOwner())
    return { outcome: "noop", reason: "existing-owner" };
  if (await ports.recoveryPending())
    return { outcome: "blocked", reason: "recovery" };
  const activation = await ports.acquireActivation();
  if (!activation) return { outcome: "blocked", reason: "busy" };
  let qualification: "current" | "requalified" = "current",
    canLaunch = false,
    retainUncertain = false;
  try {
    await ports.authorize();
    signal.throwIfAborted();
    if (!sameIntent(first, await ports.eligibility()))
      return { outcome: "noop", reason: "changed-intent" };
    if (await ports.existingOwner())
      return { outcome: "noop", reason: "existing-owner" };
    if (await ports.recoveryPending())
      return { outcome: "blocked", reason: "recovery" };
    if (!(await ports.treesIdle()))
      return { outcome: "blocked", reason: "tree-proof" };
    if (!(await ports.currentQualification())) {
      const prepare = await ports.acquirePrepare();
      if (!prepare) return { outcome: "blocked", reason: "busy" };
      try {
        await ports.authorize();
        signal.throwIfAborted();
        if (!sameIntent(first, await ports.eligibility()))
          return { outcome: "noop", reason: "changed-intent" };
        if (!(await ports.prepareTreesIdle()))
          return { outcome: "blocked", reason: "tree-proof" };
        await ports.requalifyInstalled(signal);
        if (!sameIntent(first, await ports.eligibility()))
          return { outcome: "noop", reason: "changed-intent" };
        await ports.authorize();
        await ports.refreshApprovedFleet(randomUUID(), signal);
        signal.throwIfAborted();
        if (!sameIntent(first, await ports.eligibility()))
          return { outcome: "noop", reason: "changed-intent" };
        if (!(await ports.currentQualification()))
          throw new Error("FLEET_PREPARE_REQUIRED");
        qualification = "requalified";
      } catch (error) {
        if (ports.cleanupUncertain(error)) {
          retainUncertain = true;
          await ports.recoverUncertainCleanup(signal);
          retainUncertain = false;
        }
        throw error;
      } finally {
        if (!retainUncertain) await prepare.release();
      }
    }
    await ports.authorize();
    signal.throwIfAborted();
    if (!sameIntent(first, await ports.eligibility()))
      return { outcome: "noop", reason: "changed-intent" };
    if (await ports.recoveryPending())
      return { outcome: "blocked", reason: "recovery" };
    canLaunch = true;
  } finally {
    if (!retainUncertain) await activation.release();
  }
  if (canLaunch) {
    await ports.authorize();
    signal.throwIfAborted();
    // The session agent itself reads saved intent after winning its SID-wide lock.
    if (!sameIntent(first, await ports.eligibility()))
      return { outcome: "noop", reason: "changed-intent" };
    if (await ports.existingOwner())
      return { outcome: "noop", reason: "existing-owner" };
    if (
      !(await ports.launch(
        first.state.fleetIntent as Exclude<FleetIntent, "stopped">,
      ))
    )
      return { outcome: "noop", reason: "changed-intent" };
    return { outcome: "started", qualification };
  }
  throw new Error("SESSION_CONTEXT_INVALID");
}
