import { parseDirectmlIdentity } from "../platform/shared/file-benchmark.js";
/** A DXGI LUID changes at reboot; hardware and driver identity remain in the receipt. */
export function stableCapacityGpuIdentity(
  value: unknown,
  options: { allowDeviceOrdinal?: boolean } = {},
): Record<string, unknown> {
  const { luid: _luid, ...identity } = parseDirectmlIdentity(value, options);
  if (options.allowDeviceOrdinal) {
    const { deviceIndex: _ordinal, ...physical } = identity;
    return physical;
  }
  return identity;
}
