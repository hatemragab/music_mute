import { lstat, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { WorkerControlPlaneClient } from "../../runtime/control-plane-client.js";
import {
  loadLocalLifecycle,
  setLocalLifecycleIntent,
} from "../../runtime/local-lifecycle.js";
import { loadLocalRuntimeStatus } from "../../runtime/local-runtime-status.js";
import { withNativeLock } from "../../runtime/native-lock.js";
import { readMaintenanceConnection } from "../../runtime/runtime-config.js";
import { waitForLocalDrain } from "../shared/local-drain.js";
import { awaitUnpair } from "../shared/unpair.js";
import {
  loadConfirmedUnpairReceipt,
  writeConfirmedUnpairReceipt,
} from "../shared/unpair-receipt.js";
import {
  WindowsServiceController,
  type WindowsServiceActions,
} from "./native-service.js";
import { assertWindowsPrivateDataFile } from "./private-data.js";
import type { WindowsServiceLayout } from "./service-definition.js";
import { windowsOperationPending } from "./user-maintenance.js";

interface RemovalDependencies {
  layout: WindowsServiceLayout;
  service?: WindowsServiceActions;
  lock?: typeof withNativeLock;
  wait?: (milliseconds: number) => Promise<void>;
  drainTimeoutMs?: number;
  privateFile?: typeof assertWindowsPrivateDataFile;
}
export interface WindowsUnpairOptions extends RemovalDependencies {
  force: boolean;
  unpairTimeoutMs?: number;
  connection?: typeof readMaintenanceConnection;
  unpair?: (force: boolean) => Promise<{ confirmed: true; machineId: string }>;
}
export interface WindowsUninstallOptions extends RemovalDependencies {
  purge: boolean;
  uninstallService?: () => Promise<void>;
  executablePath?: string;
}

export function windowsUnpairReceiptPath(layout: WindowsServiceLayout): string {
  return join(layout.serviceRoot, "unpaired.json");
}

export async function unpairWindowsWorker(options: WindowsUnpairOptions) {
  const { layout } = options;
  const service = options.service ?? new WindowsServiceController(layout);
  await service.assertPrivateInstallation();
  return await (options.lock ?? withNativeLock)(
    layout.commandLockPath,
    async () => {
      await requireNoRecovery(layout);
      const receiptPath = windowsUnpairReceiptPath(layout);
      const receipt = await loadConfirmedUnpairReceipt(receiptPath);
      if (receipt) {
        await drainAndStop({ ...options, service }, options.force);
        await cleanupUnpaired(options, receipt.machineId);
        return {
          status: "ok",
          action: "unpair",
          confirmed: true,
          machineId: receipt.machineId,
          replayed: true,
        };
      }
      const connection = await (
        options.connection ?? readMaintenanceConnection
      )(layout.configPath);
      await setLocalLifecycleIntent(layout.lifecyclePath, "draining");
      await drainAndStop({ ...options, service }, options.force);
      const client = options.unpair
        ? undefined
        : new WorkerControlPlaneClient({
            baseUrl: connection.backendBaseUrl,
            credential: connection.credential,
            allowInsecureLoopback: connection.allowInsecureLoopback,
          });
      const confirmation = await awaitUnpair(
        options.unpair ?? ((forced) => client!.unpair(forced)),
        options.force,
        {
          ...(options.wait ? { wait: options.wait } : {}),
          ...(options.unpairTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.unpairTimeoutMs }),
        },
      );
      if (
        confirmation.confirmed !== true ||
        confirmation.machineId !== connection.machineId
      )
        throw new Error(
          "Backend unpair confirmation does not match this machine",
        );
      // A failed write leaves the credentials available for another authenticated retry.
      await writeConfirmedUnpairReceipt(receiptPath, confirmation.machineId);
      await cleanupUnpaired(options, confirmation.machineId);
      return {
        status: "ok",
        action: "unpair",
        confirmed: true,
        machineId: confirmation.machineId,
        replayed: false,
      };
    },
  );
}

export async function uninstallWindowsWorker(options: WindowsUninstallOptions) {
  const { layout, purge } = options;
  const service = options.service ?? new WindowsServiceController(layout);
  if (!(await exists(layout.installRoot))) {
    if ((await service.inspect()).state !== "absent")
      throw new Error(
        "Service exists without its installation; repair it before uninstalling",
      );
    return {
      status: "ok",
      action: purge ? "purge" : "uninstall",
      preservedData: !purge,
      replayed: true,
    };
  }
  await service.assertPrivateInstallation();
  return await (options.lock ?? withNativeLock)(
    layout.commandLockPath,
    async () => {
      await requireNoRecovery(layout);
      if (purge) {
        if (
          !(await loadConfirmedUnpairReceipt(
            windowsUnpairReceiptPath(layout),
          )) ||
          (await exists(layout.configPath)) ||
          (await exists(layout.credentialPath))
        )
          throw new Error("Purge requires a backend-confirmed unpair first");
        const executable = relative(
          layout.installRoot,
          options.executablePath ?? process.execPath,
        );
        if (
          executable === "" ||
          (!isAbsolute(executable) &&
            executable !== ".." &&
            !executable.startsWith(
              `..${process.platform === "win32" ? "\\" : "/"}`,
            ))
        )
          throw new Error(
            "Run uninstall --purge using the CLI and Node installed outside the managed runtime",
          );
      }
      await drainAndStop({ ...options, service }, false);
      await (
        options.uninstallService ??
        (() => new WindowsServiceController(layout).uninstall())
      )();
      if ((await service.inspect()).state !== "absent")
        throw new Error("Windows service removal is not complete");
      for (const path of [
        layout.serviceConfigPath,
        layout.serviceExecutablePath,
        layout.activeReleasePath,
      ])
        await removeRegularFile(path);
      if (purge) await rm(layout.installRoot, { recursive: true, force: true });
      return {
        status: "ok",
        action: purge ? "purge" : "uninstall",
        preservedData: !purge,
        replayed: false,
      };
    },
  );
}

async function requireNoRecovery(layout: WindowsServiceLayout): Promise<void> {
  if (await windowsOperationPending(layout))
    throw new Error(
      "Windows maintenance recovery is required; run mw recover before removal",
    );
}

async function cleanupUnpaired(
  options: RemovalDependencies,
  machineId: string,
): Promise<void> {
  const { layout } = options;
  if (await exists(layout.configPath)) {
    await (options.privateFile ?? assertWindowsPrivateDataFile)(
      layout.configPath,
    );
    const info = await lstat(layout.configPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 2 ||
      info.size > 64 * 1024
    )
      throw new Error("Runtime configuration is unsafe for unpair cleanup");
    const value = JSON.parse(
      await readFile(layout.configPath, "utf8"),
    ) as unknown;
    if (
      !value ||
      typeof value !== "object" ||
      !("machineId" in value) ||
      value.machineId !== machineId
    )
      throw new Error(
        "Unpair receipt does not match the current configuration",
      );
  }
  await removeRegularFile(layout.credentialPath);
  await removeRegularFile(layout.configPath);
}

async function drainAndStop(
  options: RemovalDependencies & { service: WindowsServiceActions },
  force: boolean,
): Promise<void> {
  const { layout, service } = options;
  const native = await service.inspect();
  if (native.state === "pending")
    throw new Error("Windows service transition is in progress");
  if (native.state === "absent") return;
  const previous = await loadLocalLifecycle(layout.lifecyclePath);
  const draining =
    previous.intent === "draining"
      ? previous
      : await setLocalLifecycleIntent(layout.lifecyclePath, "draining");
  try {
    // A queued restart can cross the first inspection. Bind drain validation to
    // the service observed after claims have been disabled locally.
    const current = await service.inspect();
    if (current.state === "pending")
      throw new Error("Windows service transition is in progress");
    if (current.state === "running" && !force) {
      const snapshot = await loadLocalRuntimeStatus(layout.runtimeStatusPath);
      if (
        current.runtimeProcessId === null ||
        current.runtimeStartedAt === null ||
        snapshot.processId !== current.runtimeProcessId ||
        Date.parse(snapshot.updatedAt) < Date.parse(current.runtimeStartedAt)
      )
        throw new Error(
          "Current Windows runtime status is unavailable; use unpair --force only to interrupt the worker",
        );
      await waitForLocalDrain({
        runtimeStatusPath: layout.runtimeStatusPath,
        expectedRevision: draining.revision,
        force: false,
        ...(options.wait ? { wait: options.wait } : {}),
        ...(options.drainTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.drainTimeoutMs }),
      });
    }
    await service.stop();
    const after = await service.inspect();
    if (after.state !== "stopped" && after.state !== "absent")
      throw new Error("Windows worker did not stop");
  } finally {
    if (previous.intent !== "draining")
      await setLocalLifecycleIntent(layout.lifecyclePath, previous.intent);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function removeRegularFile(path: string): Promise<void> {
  if (!(await exists(path))) return;
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Refusing to remove an unexpected installation entry");
  await rm(path);
}
