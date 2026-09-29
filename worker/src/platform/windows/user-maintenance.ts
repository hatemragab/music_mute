import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { executeWindowsServiceManager } from "./cli.js";
import {
  WindowsServiceController,
  type WindowsServiceActions,
} from "./native-service.js";
import { verifyWindowsRelease } from "./release-manifest.js";
import {
  createWindowsReleaseLayout,
  type WindowsServiceLayout,
} from "./service-definition.js";
import { readWindowsActiveVersion } from "./active-release.js";
import { readAdministratorRecord } from "./user-updater.js";

export async function readWindowsRecoveryVersion(
  layout: WindowsServiceLayout,
): Promise<string | undefined> {
  const journal = await readAdministratorRecord(
    join(layout.serviceRoot, "operation-recovery", "journal.json"),
  );
  if (journal === null) return undefined;
  if (
    journal.schemaVersion !== 3 ||
    typeof journal.recoveryVersion !== "string" ||
    (journal.recoveryVersion !== "" &&
      !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(journal.recoveryVersion))
  )
    throw new TypeError("Windows recovery release identity is invalid");
  return journal.recoveryVersion || undefined;
}

export async function windowsOperationPending(
  layout: Pick<WindowsServiceLayout, "serviceRoot">,
): Promise<boolean> {
  // Any object at this name blocks work, including a malformed journal or link.
  // Permission and IO failures propagate instead of being mistaken for absence.
  return await lstat(join(layout.serviceRoot, "operation-recovery")).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

/** Recovery must work without reading the potentially interrupted runtime config. */
export async function recoverWindowsOperation(options: {
  layout: WindowsServiceLayout;
  releaseVersion?: string;
  leaveStopped?: boolean;
  service?: WindowsServiceActions;
  recoveryVersion?: typeof readWindowsRecoveryVersion;
}) {
  const { layout } = options;
  const service = options.service ?? new WindowsServiceController(layout);
  await service.assertPrivateInstallation();
  const version =
    options.releaseVersion ??
    (await (options.recoveryVersion ?? readWindowsRecoveryVersion)(layout)) ??
    (await readWindowsActiveVersion(layout));
  const release = createWindowsReleaseLayout(layout, version);
  const manifest = await verifyWindowsRelease(release.releaseRoot);
  if (manifest.releaseVersion !== version)
    throw new TypeError(
      "Recovery release identity does not match its directory",
    );
  // PowerShell owns the installer mutex and operator lock. It validates the
  // complete durable journal before restoring anything, and is idempotent when
  // no journal exists. Acquiring the operator lock here would deadlock recovery.
  await executeWindowsServiceManager(
    join(release.releaseRoot, "installer", "manage-windows-service.ps1"),
    [
      "-Action",
      "Recover",
      "-InstallRoot",
      layout.installRoot,
      ...(options.leaveStopped ? ["-LeaveStopped"] : []),
    ],
  );
  return { action: "recover", status: "ok", service: await service.inspect() };
}
