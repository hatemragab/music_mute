import { StoreNativeAuthority } from "../browser/store-native.js";
import {
  parseConsumerUpdateCommand,
  type ConsumerUpdateView,
} from "../../shared/update-contracts.js";
import { STORE_PRODUCTS } from "../../shared/store-contracts.js";

/** Reserved product destinations, not proof of publication or an available update. */
const destinations = Object.freeze({
  gui: `https://apps.microsoft.com/detail/${STORE_PRODUCTS.gui.storeId}`,
  worker: `https://apps.microsoft.com/detail/${STORE_PRODUCTS.worker.storeId}`,
});
export const STORE_UPDATE_VIEW: Readonly<ConsumerUpdateView> = Object.freeze({
  distribution: "microsoft-store",
  phase: "idle",
  available: null,
  required: false,
  automaticDiscovery: false,
  problem: null,
});
/** A user command opens only a fixed Store product. It cannot download/install
 * executable archives, mutate Windows update preferences or claim currency. */
export async function storeUpdateDestination(
  authority: StoreNativeAuthority,
  input: unknown,
): Promise<string> {
  if (arguments.length !== 2) throw new Error("STORE_UPDATE_DENIED");
  const command = parseConsumerUpdateCommand(input);
  if (command.action !== "store_open") throw new Error("STORE_UPDATE_DENIED");
  StoreNativeAuthority.prototype.creatorProof.call(authority);
  // The native query revalidates the actual GUI's current generation. Presence
  // of Worker is an observation; it supplies no processing/update authority.
  await StoreNativeAuthority.prototype.inspectWorker.call(authority);
  StoreNativeAuthority.prototype.creatorProof.call(authority);
  return destinations[command.product];
}
