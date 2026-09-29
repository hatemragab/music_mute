import { lstat, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { loadRuntimeConfig } from "../../runtime/runtime-config.js";
import { executeWindowsServiceManager } from "./cli.js";
import {
  WindowsServiceController,
  type WindowsServiceActions,
} from "./native-service.js";
import { assertWindowsPrivateDataFile } from "./private-data.js";
import { verifyWindowsRelease } from "./release-manifest.js";
import {
  createWindowsReleaseLayout,
  type WindowsServiceLayout,
} from "./service-definition.js";
import { readWindowsActiveVersion } from "./active-release.js";
import { windowsOperationPending } from "./user-maintenance.js";

/** Resolve only an exact installed layout before reading credentials or executing code. */
export function preservedWindowsRelease(
  layout: WindowsServiceLayout,
  config: Record<string, unknown>,
) {
  if (typeof config.engineRoot !== "string")
    throw new TypeError("Preserved runtime path is missing");
  const relative = win32.relative(layout.releasesRoot, config.engineRoot);
  const match = /^([0-9A-Za-z][0-9A-Za-z._+-]{0,63})\\app\\engine$/u.exec(
    relative,
  );
  if (!match)
    throw new TypeError(
      "Preserved runtime must belong to an installed release",
    );
  const version = match[1]!;
  const release = createWindowsReleaseLayout(layout, version);
  const expected = {
    engineRoot: release.engineRoot,
    pythonPath: release.pythonPath,
    ffmpegPath: release.ffmpegPath,
    ffprobePath: release.ffprobePath,
    workRoot: layout.workRoot,
    modelCacheRoot: layout.modelCacheRoot,
    credentialFile: layout.credentialPath,
    localLifecyclePath: layout.lifecyclePath,
    localRuntimeStatusPath: layout.runtimeStatusPath,
  };
  for (const [key, path] of Object.entries(expected)) {
    const value = config[key];
    if (typeof value !== "string" || value.toLowerCase() !== path.toLowerCase())
      throw new TypeError(
        "Preserved runtime does not match the installed layout",
      );
  }
  if (
    config.capacityValidationFile !== undefined &&
    config.capacityValidationFile !==
      win32.join(layout.stateRoot, "capacity-validation.json")
  )
    throw new TypeError(
      "Preserved capacity receipt does not match the installed layout",
    );
  return { version, release };
}

export async function inspectPreservedWindowsInstallation(
  layout: WindowsServiceLayout,
) {
  await new WindowsServiceController(layout).assertPrivateInstallation();
  await assertWindowsPrivateDataFile(layout.configPath);
  const info = await lstat(layout.configPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 65536
  )
    throw new TypeError("Preserved runtime config is unsafe");
  let config: unknown;
  try {
    config = JSON.parse(await readFile(layout.configPath, "utf8"));
  } catch {
    throw new TypeError("Preserved runtime config is invalid");
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new TypeError("Preserved runtime config is invalid");
  const result = preservedWindowsRelease(
    layout,
    config as Record<string, unknown>,
  );
  await assertWindowsPrivateDataFile(layout.credentialPath);
  await assertWindowsPrivateDataFile(layout.lifecyclePath);
  const manifest = await verifyWindowsRelease(result.release.releaseRoot);
  if (manifest.releaseVersion !== result.version)
    throw new TypeError(
      "Preserved release identity does not match its directory",
    );
  // Full admission validation includes the actual release/host-bound capacity receipt.
  await loadRuntimeConfig(layout.configPath);
  return result;
}

export async function reactivateWindowsInstallation(options: {
  layout: WindowsServiceLayout;
  service?: WindowsServiceActions;
  inspect?: typeof inspectPreservedWindowsInstallation;
  pending?: typeof windowsOperationPending;
  activeVersion?: typeof readWindowsActiveVersion;
  manager?: typeof executeWindowsServiceManager;
}) {
  const { layout } = options;
  const service = options.service ?? new WindowsServiceController(layout);
  await service.assertPrivateInstallation();
  if (await (options.pending ?? windowsOperationPending)(layout))
    throw new Error(
      "Recover the interrupted operation before reactivating the worker",
    );
  const preserved = await (
    options.inspect ?? inspectPreservedWindowsInstallation
  )(layout);
  const native = await service.inspect();
  if (native.state !== "absent") {
    if (
      (await (options.activeVersion ?? readWindowsActiveVersion)(layout)) !==
      preserved.version
    )
      throw new TypeError("Active and preserved releases disagree");
    return {
      action: "install",
      status: "already-installed",
      releaseVersion: preserved.version,
    };
  }
  // The native manager revalidates under both native locks and journals changes.
  await (options.manager ?? executeWindowsServiceManager)(
    win32.join(
      preserved.release.releaseRoot,
      "installer",
      "manage-windows-service.ps1",
    ),
    [
      "-Action",
      "Reactivate",
      "-InstallRoot",
      layout.installRoot,
      "-Release",
      preserved.release.releaseRoot,
    ],
  );
  if (
    (await service.inspect()).state !== "running" ||
    (await (options.activeVersion ?? readWindowsActiveVersion)(layout)) !==
      preserved.version
  )
    throw new Error(
      "Windows reactivation did not establish the expected running release",
    );
  return {
    action: "install",
    status: "reactivated",
    releaseVersion: preserved.version,
  };
}
