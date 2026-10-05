import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createMacUserLayout } from "../macos/user-paths.js";
import {
  MacCommandBusyError,
  withMacUserCommandLock,
} from "../macos/command-lock.js";
import { MacLaunchAgentController } from "../macos/launch-agent.js";
import {
  NativeLockBusyError,
  withNativeLock,
} from "../../runtime/native-lock.js";
import { createWindowsServiceLayout } from "../windows/service-definition.js";
import { WindowsServiceController } from "../windows/native-service.js";
import {
  cleanupWorkerStorage,
  macWorkerStorageLayout,
  windowsWorkerStorageLayout,
} from "./storage-maintenance.js";

/** No engine, benchmark or transfer has started yet; the operator lock fences commands. */
export async function maintainStorageAtStartup(
  configPath: string,
): Promise<void> {
  try {
    const operation = async () => {
      if (process.platform === "darwin") {
        const layout = createMacUserLayout(homedir());
        if (resolve(configPath) !== resolve(layout.configPath)) return;
        const service = await new MacLaunchAgentController(
          process.getuid?.() ?? 0,
        ).status();
        if (!service.loaded || service.pid !== process.pid) return;
        return await withMacUserCommandLock(
          layout.commandLockPath,
          () =>
            cleanupWorkerStorage({
              layout: macWorkerStorageLayout(layout),
              apply: true,
            }),
          "cleanup",
        );
      }
      if (process.platform === "win32") {
        const layout = createWindowsServiceLayout(dirname(dirname(configPath)));
        if (resolve(configPath) !== resolve(layout.configPath)) return;
        if (
          !(await new WindowsServiceController(
            layout,
          ).isCurrentRuntimeProcess())
        )
          return;
        return await withNativeLock(layout.commandLockPath, () =>
          cleanupWorkerStorage({
            layout: windowsWorkerStorageLayout(layout),
            apply: true,
            stateOnly: true,
          }),
        );
      }
    };
    const result = await operation();
    if (result && (result.reclaimedBytes > 0 || result.status === "partial"))
      console.log(
        JSON.stringify({
          kind: "storage-maintenance",
          status: result.status,
          reclaimedBytes: result.reclaimedBytes,
          warnings: result.warnings,
        }),
      );
  } catch (error) {
    // Install/update deliberately holds this lock while booting the candidate.
    if (
      error instanceof MacCommandBusyError ||
      error instanceof NativeLockBusyError
    )
      return;
    console.warn(
      "MusicMute storage cleanup deferred; run mw cleanup --dry-run for inspection",
    );
  }
}
