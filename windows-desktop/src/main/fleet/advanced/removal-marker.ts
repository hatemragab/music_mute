import type { WindowsConsumerNative } from "../../../../../worker/src/platform/windows/consumer-native.js";
import { fleetRecordAuthority, type FleetEnrollmentRecord } from "../store.js";
export async function consumerFleetRemoved(
  native: Pick<WindowsConsumerNative, "vaultRead">,
  record: FleetEnrollmentRecord,
): Promise<boolean> {
  const bytes = await native.vaultRead("fleet", "removed");
  if (!bytes) return false;
  if (bytes.length > 1024) throw new Error("ADVANCED_REMOVAL_STATE_INVALID");
  const marker = JSON.parse(bytes.toString("utf8")) as {
    version: number;
    machineId: string;
    authority: string;
    removedAt: string;
  };
  if (
    !marker ||
    Object.keys(marker).sort().join() !==
      "authority,machineId,removedAt,version" ||
    marker.version !== 1 ||
    !/^[a-f0-9-]{36}$/u.test(marker.machineId) ||
    !/^[a-f0-9]{64}$/u.test(marker.authority) ||
    !Number.isFinite(Date.parse(marker.removedAt))
  )
    throw new Error("ADVANCED_REMOVAL_STATE_INVALID");
  return (
    marker.machineId === record.machineId &&
    marker.authority === fleetRecordAuthority(record)
  );
}
