import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DarwinFileLockBusyError,
  withDarwinFileLock,
} from "../../runtime/darwin-file-lock.js";
import { withMacUserCommandLock } from "./command-lock.js";
import {
  authorizePersonalMaintenanceUnderLock,
  reclaimIdlePersonalReservation,
} from "../../runtime/personal-admission.js";
import {
  loadLocalLifecycle,
  setLocalLifecycleIntent,
  type LocalLifecycleIntent,
} from "../../runtime/local-lifecycle.js";
import {
  writeLaunchAgentPlist,
  type LaunchAgentStatus,
} from "./launch-agent.js";
import type { MacUserLayout } from "./user-paths.js";
import { AppControlError } from "./app-control-protocol.js";

interface MaintenanceService {
  status(): Promise<LaunchAgentStatus>;
  bootstrap(path: string): Promise<void>;
  bootout(): Promise<void>;
}

interface MaintenanceJournal {
  schemaVersion: 1;
  intent: LocalLifecycleIntent;
  loaded: boolean;
  stopped: boolean;
  phase: "preparing" | "stopped" | "restoring";
}

export function requiresMacAppMaintenance(
  command: string,
  arguments_: readonly string[],
): boolean {
  return (
    ["benchmark", "benchmark-file", "capacity"].includes(command) ||
    (command === "cleanup" && arguments_.includes("--apply"))
  );
}

/** Caller holds the existing worker command lock for the entire transaction. */
export async function withMacAppMaintenance<T>(options: {
  layout: MacUserLayout;
  service: MaintenanceService;
  stop: () => Promise<void>;
  operation: () => Promise<T>;
  progress?: (stage: string) => void;
  beforeRestore?: () => Promise<void>;
}): Promise<T> {
  await recoverMacAppMaintenance(
    options.layout,
    options.service,
    options.progress,
    options.beforeRestore,
  );
  const prior = await loadLocalLifecycle(options.layout.lifecyclePath);
  const service = await options.service.status();
  // A registered, failed service must not silently become running after an audit.
  if (service.loaded && !service.running)
    throw new AppControlError("MAINTENANCE_RECOVERY_REQUIRED");
  const journal: MaintenanceJournal = {
    schemaVersion: 1,
    intent: prior.intent,
    loaded: service.loaded,
    stopped: false,
    phase: "preparing",
  };
  // The personal service checks the maintenance journal under this same short
  // lock before granting a GPU reservation. Publishing first fences new work
  // while fleet drain is in progress, without holding a lock across that drain.
  await withAdmissionLock(options.layout, async () => {
    try {
      await authorizePersonalMaintenanceUnderLock(options.layout.stateRoot);
    } catch {
      throw new AppControlError("WORKER_PERSONAL_BUSY");
    }
    await writeJournal(options.layout, journal);
  });
  try {
    options.progress?.("draining");
    await options.stop();
    if ((await options.service.status()).loaded)
      throw new AppControlError("DRAIN_FAILED");
    await setLocalLifecycleIntent(options.layout.lifecyclePath, "draining");
    journal.stopped = true;
    await writeJournal(options.layout, { ...journal, phase: "stopped" });
    try {
      await reclaimIdlePersonalReservation(options.layout.stateRoot);
    } catch {
      throw new AppControlError("WORKER_PERSONAL_BUSY");
    }
    options.progress?.("running");
    return await options.operation();
  } finally {
    options.progress?.("restoring");
    await restoreJournal(
      options.layout,
      options.service,
      journal,
      options.beforeRestore,
    );
  }
}

/** Recovery changes no identity, credentials or backend pause; only the saved local intent. */
export async function recoverMacAppMaintenance(
  layout: MacUserLayout,
  service: MaintenanceService,
  progress?: (stage: string) => void,
  beforeRestore?: () => Promise<void>,
): Promise<void> {
  const path = journalPath(layout);
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 4096 ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new AppControlError("MAINTENANCE_RECOVERY_REQUIRED");
  let journal: MaintenanceJournal;
  try {
    const value = JSON.parse(
      await readFile(path, "utf8"),
    ) as MaintenanceJournal;
    if (
      !value ||
      value.schemaVersion !== 1 ||
      !["active", "paused", "draining"].includes(value.intent) ||
      typeof value.loaded !== "boolean" ||
      typeof value.stopped !== "boolean" ||
      !["preparing", "stopped", "restoring"].includes(value.phase) ||
      Object.keys(value).some(
        (key) =>
          !["schemaVersion", "intent", "loaded", "stopped", "phase"].includes(
            key,
          ),
      )
    )
      throw new Error();
    journal = value;
  } catch {
    throw new AppControlError("MAINTENANCE_RECOVERY_REQUIRED");
  }
  progress?.("restoring");
  await restoreJournal(layout, service, journal, beforeRestore);
}

async function restoreJournal(
  layout: MacUserLayout,
  service: MaintenanceService,
  journal: MaintenanceJournal,
  beforeRestore?: () => Promise<void>,
): Promise<void> {
  try {
    await writeJournal(layout, { ...journal, phase: "restoring" });
    // Qualification temporarily registers a different LaunchAgent. An interrupted
    // benchmark must never restore that registration as if it were the supervisor.
    if (journal.stopped && (await service.status()).loaded)
      await service.bootout();
    await writeLaunchAgentPlist(layout);
    const current = await loadLocalLifecycle(layout.lifecyclePath);
    if (current.intent !== journal.intent)
      await setLocalLifecycleIntent(layout.lifecyclePath, journal.intent);
    const status = await service.status();
    if (journal.loaded && !status.loaded) {
      await beforeRestore?.();
      await service.bootstrap(layout.plistPath);
    } else if (!journal.loaded && status.loaded) await service.bootout();
    await rm(journalPath(layout));
  } catch {
    throw new AppControlError("MAINTENANCE_RECOVERY_REQUIRED");
  }
}

function journalPath(layout: MacUserLayout): string {
  return join(layout.stateRoot, "app-maintenance.json");
}

/** Any reservation, including an unreadable/unknown one, fences GPU maintenance. */
export async function hasMacPersonalReservation(
  layout: MacUserLayout,
): Promise<boolean> {
  try {
    await lstat(join(layout.stateRoot, "personal-admission.json"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

/** Called under the worker command lock; never guesses about a live/reused PID. */
export async function recoverMacAppPreparationFence(
  layout: MacUserLayout,
): Promise<void> {
  const path = join(layout.stateRoot, "app-preparation.json");
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 4096 ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new AppControlError("MAINTENANCE_RECOVERY_REQUIRED");
  const value = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    !["install", "adopt", "update", "recover"].includes(
      String(value.operation),
    ) ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "pid", "operation"].includes(key),
    )
  )
    throw new AppControlError("MAINTENANCE_RECOVERY_REQUIRED");
  try {
    process.kill(value.pid as number, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      throw new AppControlError("MAINTENANCE_RECOVERY_REQUIRED");
    await rm(path);
    return;
  }
  throw new AppControlError("COMMAND_BUSY");
}

export async function withMacAppPreparationFence<T>(
  layout: MacUserLayout,
  operation: "install" | "adopt" | "update" | "recover",
  action: () => Promise<T>,
): Promise<T> {
  await recoverMacAppPreparationFence(layout);
  const path = join(layout.stateRoot, "app-preparation.json");
  await withAdmissionLock(layout, async () => {
    try {
      await authorizePersonalMaintenanceUnderLock(layout.stateRoot);
    } catch {
      throw new AppControlError("WORKER_PERSONAL_BUSY");
    }
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, operation })}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(layout.stateRoot, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  });
  try {
    return await action();
  } finally {
    await rm(path, { force: true });
  }
}

async function withAdmissionLock<T>(
  layout: MacUserLayout,
  operation: () => Promise<T>,
): Promise<T> {
  const path = join(layout.stateRoot, "app-admission.lock");
  try {
    if (process.platform === "darwin")
      return await withDarwinFileLock(path, operation);
    // Unsupported hosts never reach this through the production facade. The
    // existing command-lock fallback keeps injected portable fixtures exclusive.
    return await withMacUserCommandLock(
      path,
      operation,
      "app-maintenance-admission",
    );
  } catch (error) {
    if (error instanceof DarwinFileLockBusyError)
      throw new AppControlError("COMMAND_BUSY");
    throw error;
  }
}

async function writeJournal(
  layout: MacUserLayout,
  journal: MaintenanceJournal,
): Promise<void> {
  const temporary = `${journalPath(layout)}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, journalPath(layout));
    const directory = await open(layout.stateRoot, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}
