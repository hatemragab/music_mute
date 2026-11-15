import type { HostContext } from "../host-context.js";
import { StoreCpuOperation } from "./store-cpu-operation.js";
import { StoreGuiCpuOperation } from "./store-gui-media.js";
export type StoreCpuOwner = StoreCpuOperation | StoreGuiCpuOperation;
/** Classification alone grants nothing. Every effect uses the original
 * class's private fields through its actual prototype methods below. */
export function isStoreCpuOwner(value: unknown): value is StoreCpuOwner {
  return (
    value instanceof StoreCpuOperation || value instanceof StoreGuiCpuOperation
  );
}
export function assertStoreCpuOwnerHost(
  owner: StoreCpuOwner,
  host: HostContext,
): void {
  if (owner instanceof StoreCpuOperation)
    StoreCpuOperation.prototype.assertHost.call(owner, host);
  else StoreGuiCpuOperation.prototype.assertHost.call(owner, host);
}
export function storeCpuOwnerExpectation(owner: StoreCpuOwner) {
  return owner instanceof StoreCpuOperation
    ? StoreCpuOperation.prototype.expectation.call(owner)
    : StoreGuiCpuOperation.prototype.expectation.call(owner);
}
export function storeCpuOwnerRetired(owner: StoreCpuOwner): Promise<boolean> {
  return owner instanceof StoreCpuOperation
    ? StoreCpuOperation.prototype.inspectRetired.call(owner)
    : StoreGuiCpuOperation.prototype.inspectRetired.call(owner);
}
