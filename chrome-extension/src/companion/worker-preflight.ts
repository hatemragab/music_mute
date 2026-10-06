import { dirname, isAbsolute, join, resolve } from "node:path";
import { reclaimIdlePersonalReservation } from "../../../worker/src/runtime/personal-admission.js";
import { loadLocalConfig } from "./config.js";
import { retireIdleLocalEngine, supportsLocalEngine } from "./local-engine.js";

/** App-owned worker preparation never inherits developer or account environment overrides. */
export async function retireAppEngineForWorker(
  resources: string,
  support: string,
): Promise<void> {
  if (
    !isAbsolute(resources) ||
    resolve(resources) !== resources ||
    !isAbsolute(support) ||
    resolve(support) !== support
  )
    throw new Error("WORKER_COORDINATION_UNSAFE");
  const config = await loadLocalConfig({
    MUSICMUTE_LOCAL_APP_RESOURCES: resources,
    MUSICMUTE_LOCAL_ROOT: support,
  });
  if (!config.app_resources || !(await supportsLocalEngine(config)))
    throw new Error("ENGINE_SERVICE_REQUIRED");
  await reclaimIdlePersonalReservation(
    join(dirname(support), "MusicMuteWorker", "state"),
  );
  // No engine is started here. A matching existing service must retire and exit
  // before qualification can load its own model; active work is never killed.
  await retireIdleLocalEngine(config);
}
