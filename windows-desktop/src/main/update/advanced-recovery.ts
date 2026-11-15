import type { DesktopCommand } from "../../shared/contracts.js";
import type { ConsumerUpdateController } from "./controller.js";

type RecoveryReceipt = Parameters<
  ConsumerUpdateController["matchesAdvancedRecovery"]
>[0];

/** A fenced Advanced recovery may only reuse its existing protected updater
 * transaction. This readonly check never creates a session, updater or authority. */
export async function authorizeAdvancedUpdateRecovery(options: {
  command: DesktopCommand;
  advanced?: { pendingUpdateRecovery(): Promise<RecoveryReceipt | null> };
  updater?: Pick<ConsumerUpdateController, "matchesAdvancedRecovery">;
  current(): boolean;
  signal: AbortSignal;
}): Promise<boolean> {
  if (
    options.command.type !== "FLEET_ADVANCED" ||
    options.command.command.type !== "RECOVER" ||
    !options.advanced ||
    !options.updater
  )
    return false;
  try {
    options.signal.throwIfAborted();
    if (!options.current()) return false;
    const receipt = await options.advanced.pendingUpdateRecovery();
    options.signal.throwIfAborted();
    if (!receipt || !options.current()) return false;
    const matches = await options.updater.matchesAdvancedRecovery(receipt);
    options.signal.throwIfAborted();
    return matches && options.current();
  } catch {
    // Missing/corrupt/changed proof never authorizes the exceptional receiving path.
    return false;
  }
}
