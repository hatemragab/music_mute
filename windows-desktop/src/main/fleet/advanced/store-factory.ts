import {
  createFleetAdvancedBusiness,
  type WindowsFleetAdvancedOptions,
} from "./factory.js";
import { StoreFleetAdvancedRuntime } from "./store-runtime.js";
import type { StorePreparationOperations } from "../../prepare/store-operations.js";
import type { StorePrepareMaintenance } from "../../prepare/store-maintenance.js";
import type { StoreDesktopConnection } from "../../session/store-desktop-client.js";
export type StoreFleetAdvancedOptions = Omit<
  WindowsFleetAdvancedOptions,
  "native" | "operations" | "session"
> & {
  operations: StorePreparationOperations;
  connection: StoreDesktopConnection;
  maintenance: StorePrepareMaintenance;
  rebind(): Promise<void>;
};
/** The Store entry creates private branded ports, then reuses the existing
 * Advanced controller, confirmation, reports, capacity and removal journeys. */
export async function createStoreFleetAdvanced(
  options: StoreFleetAdvancedOptions,
) {
  const runtime = StoreFleetAdvancedRuntime.open(
    options.host,
    options.operations,
    options.connection,
    options.maintenance,
    options.rebind,
  );
  const {
    operations: _operations,
    connection,
    maintenance: _maintenance,
    rebind: _rebind,
    ...shared
  } = options;
  const business = await createFleetAdvancedBusiness({
    ...shared,
    storeRuntime: runtime,
    session: connection.client,
  });
  const retirement: {
    original?: Promise<void>;
    current?: Promise<void>;
    failed: boolean;
    complete: boolean;
  } = { failed: false, complete: false };
  const attempt = (recover: boolean) => {
    retirement.failed = false;
    const task = Promise.resolve().then(async () => {
      await business.controller.beginRetirement();
      if (StoreFleetAdvancedRuntime.prototype.mutationActive.call(runtime)) {
        if (!recover) throw new Error("ADVANCED_RECOVERY_REQUIRED");
        // Recovery consumes the original durable journal and private Holding;
        // it never acknowledges cleanup merely because the command failed.
        await business.controller.execute({ type: "RECOVER" });
        if (StoreFleetAdvancedRuntime.prototype.mutationActive.call(runtime))
          throw new Error("ADVANCED_RECOVERY_REQUIRED");
      }
      await business.close();
      await StoreFleetAdvancedRuntime.prototype.close.call(runtime);
      retirement.complete = true;
    });
    retirement.current = task;
    retirement.original ??= task;
    void task.catch(() => {
      if (retirement.current === task) retirement.failed = true;
    });
    return task;
  };
  const close = () => {
    if (retirement.complete) return retirement.current!;
    if (retirement.current && !retirement.failed) return retirement.current;
    return attempt(retirement.failed);
  };
  return {
    ...business,
    runtime,
    close,
    recoverClose: close,
  };
}
