import { StoreMediaTools } from "../prepare/store-media-tools.js";
import { createWindowsBrowserToolkit } from "./toolkit-factory.js";

/** Shared extension behavior; the genuine Store tools port selects its actual
 * Worker Session execution path inside the common media operation. */
export function createStoreBrowserToolkit(
  options: Omit<
    Parameters<typeof createWindowsBrowserToolkit>[0],
    "operations"
  > & {
    operations: StoreMediaTools;
  },
) {
  StoreMediaTools.prototype.assertHost.call(options.operations, options.host);
  return createWindowsBrowserToolkit(options);
}
