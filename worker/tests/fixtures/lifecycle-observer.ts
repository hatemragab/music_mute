import { watch } from "node:fs";
import { basename, dirname } from "node:path";
import { loadLocalLifecycle } from "../../src/runtime/local-lifecycle.js";
import {
  loadLocalRuntimeStatus,
  writeLocalRuntimeStatus,
} from "../../src/runtime/local-runtime-status.js";

/** Emulate the running worker's acknowledgement in service-controller fixtures. */
export function observeFixtureLifecycle(layout: {
  lifecyclePath: string;
  runtimeStatusPath: string;
}): () => Promise<void> {
  let pending = Promise.resolve();
  let failure: unknown;
  const watcher = watch(dirname(layout.lifecyclePath), (_event, filename) => {
    if (String(filename) !== basename(layout.lifecyclePath)) return;
    pending = pending
      .then(async () => {
        const lifecycle = await loadLocalLifecycle(layout.lifecyclePath);
        if (lifecycle.intent !== "draining") return;
        const status = await loadLocalRuntimeStatus(layout.runtimeStatusPath);
        await writeLocalRuntimeStatus(
          layout.runtimeStatusPath,
          status.activeAttemptIds,
          {
            ...status,
            observedLifecycle: {
              revision: lifecycle.revision,
              intent: lifecycle.intent,
            },
          },
        );
      })
      .catch((error: unknown) => {
        // Purge tests remove the installation while its fake controller is stopped.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure = error;
      });
  });
  return async () => {
    watcher.close();
    await pending;
    if (failure) throw failure;
  };
}
