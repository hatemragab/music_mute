import type {
  ConsumerOwnedProcess,
  ConsumerStorageCleanupReceipt,
  ConsumerCacheFileIdentity,
} from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import type { StoreCpuOperationExpectation } from "../../../../worker/src/platform/windows/consumer-store-cpu.js";
type Completed = Extract<ConsumerStorageCleanupReceipt, { state: "completed" }>;
const completions = new WeakMap<HostContext, Map<string, Completed>>();
/** Caller owns cache/pin mutation authority. Failed ACK retries the captured
 * metadata closure, never another byte deletion. Native persists lost replies. */
async function retire(
  host: HostContext,
  key: string,
  operation: () => Promise<ConsumerStorageCleanupReceipt>,
  acknowledge?: (receipt: Completed) => Promise<void>,
): Promise<void> {
  let retained = completions.get(host);
  if (!retained) {
    retained = new Map();
    completions.set(host, retained);
  }
  let receipt = retained.get(key);
  if (!receipt) {
    if (retained.size >= 256) throw new Error("STORAGE_RECOVERY_PENDING");
    const result = await operation();
    if (result.state !== "completed")
      throw new Error("STORAGE_RECOVERY_PENDING");
    receipt = result;
    retained.set(key, receipt);
  }
  if (acknowledge) await acknowledge(receipt);
  else {
    if (!host.native.acknowledgeStorageCleanup)
      throw new Error("STORAGE_RECOVERY_PENDING");
    await host.native.acknowledgeStorageCleanup(receipt);
  }
  retained.delete(key);
}
export function retireStorageLibraryArtifact(
  host: HostContext,
  id: string,
  relative: string,
  identity: ConsumerCacheFileIdentity,
): Promise<void> {
  return retire(
    host,
    `artifact:${id}:${relative}:${JSON.stringify(identity)}`,
    async () => {
      if (!host.native.discardLibraryArtifact)
        throw new Error("STORAGE_RECOVERY_PENDING");
      return host.native.discardLibraryArtifact(id, relative, identity);
    },
  );
}
export function discardStoragePartial(
  host: HostContext,
  id: string,
): Promise<void> {
  return retire(host, `partial:${id}`, async () => {
    if (!host.native.discardStoragePartial)
      throw new Error("STORAGE_RECOVERY_PENDING");
    return host.native.discardStoragePartial(id);
  });
}
export function retireStorageWorkspaceMarker(
  host: HostContext,
  relative: string,
  owner: ConsumerOwnedProcess | StoreCpuOperationExpectation,
): Promise<void> {
  if ("distribution" in owner)
    return retire(
      host,
      `store-cpu-workspace:${relative}:${owner.token}`,
      async () => {
        if (!host.native.retireStoreCpuWorkspaceMarker)
          throw new Error("STORAGE_RECOVERY_PENDING");
        return host.native.retireStoreCpuWorkspaceMarker(relative, owner);
      },
      async (receipt) => {
        if (!host.native.acknowledgeStoreCpuWorkspaceMarker)
          throw new Error("STORAGE_RECOVERY_PENDING");
        await host.native.acknowledgeStoreCpuWorkspaceMarker(receipt, owner);
      },
    );
  return retire(host, `workspace:${relative}:${owner.nonce}`, async () => {
    if (!host.native.retireStorageWorkspaceMarker)
      throw new Error("STORAGE_RECOVERY_PENDING");
    return host.native.retireStorageWorkspaceMarker(relative, owner);
  });
}
