import { createHash, randomUUID } from "node:crypto";
import { cpus, totalmem } from "node:os";
import {
  parseCapacityReceipt,
  assertCapacityReceiptIdentity,
  createCapacityReceipt,
} from "../../../../../worker/src/runtime/capacity-receipt.js";
import { stableCapacityGpuIdentity } from "../../../../../worker/src/runtime/capacity-gpu-identity.js";
import type { DirectmlGpuIdentity } from "../../../../../worker/src/enrollment/report-builder.js";
import type {
  ConsumerHostIdentity,
  WindowsConsumerNative,
} from "../../../../../worker/src/platform/windows/consumer-native.js";
import { fleetRecordAuthority, type FleetEnrollmentRecord } from "../store.js";
export interface ConsumerFleetCapacityState {
  version: 1;
  machineId: string;
  authority: string;
  selectedWorkers: 1 | 2;
  secondWorkerId: string;
  receipt: { relativePath: string; sha256: string } | null;
}
const UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  SHA = /^[a-f0-9]{64}$/u;
function capacityState(value: unknown): ConsumerFleetCapacityState {
  const v = value as ConsumerFleetCapacityState;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join() !==
      "authority,machineId,receipt,secondWorkerId,selectedWorkers,version" ||
    v.version !== 1 ||
    !UUID.test(v.machineId) ||
    !SHA.test(v.authority) ||
    ![1, 2].includes(v.selectedWorkers) ||
    !UUID.test(v.secondWorkerId) ||
    (v.receipt !== null &&
      (!v.receipt ||
        Object.keys(v.receipt).sort().join() !== "relativePath,sha256" ||
        !/^prepare\\results\\[a-f0-9-]{36}\.capacity\.json$/u.test(
          v.receipt.relativePath,
        ) ||
        !SHA.test(v.receipt.sha256)))
  )
    throw new Error("ADVANCED_CAPACITY_INVALID");
  return structuredClone(v);
}
export function parseConsumerFleetCapacity(
  value: unknown,
  record: FleetEnrollmentRecord,
): ConsumerFleetCapacityState {
  const v = capacityState(value);
  if (
    v.machineId !== record.machineId ||
    v.authority !== fleetRecordAuthority(record) ||
    v.secondWorkerId === record.workerId
  )
    throw new Error("ADVANCED_CAPACITY_INVALID");
  return v;
}
export async function readConsumerFleetCapacity(
  native: Pick<WindowsConsumerNative, "vaultRead">,
  record: FleetEnrollmentRecord,
): Promise<ConsumerFleetCapacityState> {
  const bytes = await native.vaultRead("fleet", "capacity");
  const originalSlot = (): ConsumerFleetCapacityState => ({
    version: 1,
    machineId: record.machineId!,
    authority: fleetRecordAuthority(record),
    selectedWorkers: 1,
    secondWorkerId: randomUUID(),
    receipt: null,
  });
  if (!bytes) return originalSlot();
  if (bytes.length > 4096) throw new Error("ADVANCED_CAPACITY_INVALID");
  const state = capacityState(JSON.parse(bytes.toString("utf8")));
  if (
    state.machineId !== record.machineId ||
    state.authority !== fleetRecordAuthority(record)
  )
    return originalSlot();
  return parseConsumerFleetCapacity(state, record);
}
/** Actual Windows host/GPU evidence, independent of the backend's slot permission. */
export function consumerCapacityIdentity(options: {
  bootIdentity: string;
  host: ConsumerHostIdentity;
  gpu: DirectmlGpuIdentity;
  manifestDigest: string;
  modelDigest: string;
  fixtureDigest: string;
}) {
  if (!SHA.test(options.bootIdentity))
    throw new Error("ADVANCED_CAPACITY_INVALID");
  const gpuIdentity = stableCapacityGpuIdentity(options.gpu, {
    allowDeviceOrdinal: true,
  });
  return {
    provider: "directml" as const,
    releaseManifestDigest: options.manifestDigest,
    modelDigest: options.modelDigest,
    fixtureDigest: options.fixtureDigest,
    gpuIdentity,
    hostDigest: createHash("sha256")
      .update(
        JSON.stringify({
          sid: options.host.sid,
          bootIdentity: options.bootIdentity,
          osBuild: options.host.osBuild,
          arch: options.host.processArch,
          processors: cpus().map(({ model }) => model),
          memoryBytes: totalmem(),
          gpu: options.gpu,
        }),
      )
      .digest("hex"),
  };
}
export function validateConsumerCapacityReceipt(
  raw: unknown,
  record: FleetEnrollmentRecord,
  identity: ReturnType<typeof consumerCapacityIdentity>,
  now = Date.now(),
) {
  const receipt = parseCapacityReceipt(raw, {
    machineId: record.machineId!,
    provider: "directml",
    expectedUserSid: record.sid,
    now,
  });
  assertCapacityReceiptIdentity(receipt, identity, {
    expectedUserSid: record.sid,
  });
  return receipt;
}
export function createConsumerFleetCapacityReceipt(
  record: FleetEnrollmentRecord,
  identity: ReturnType<typeof consumerCapacityIdentity>,
  measurements: Parameters<typeof createCapacityReceipt>[0]["measurements"],
  now?: number,
) {
  return createCapacityReceipt({
    machineId: record.machineId!,
    identity,
    measurements,
    expectedUserSid: record.sid,
    ...(now === undefined ? {} : { now }),
  });
}
/** Expired/changed two-worker evidence reduces to the original one qualified slot. */
export async function consumerFleetRuntimeSlots(options: {
  native: Pick<WindowsConsumerNative, "vaultRead">;
  record: FleetEnrollmentRecord;
  identity: ReturnType<typeof consumerCapacityIdentity>;
  readReceipt(relative: string): Promise<Buffer>;
  now?: number;
}) {
  const state = await readConsumerFleetCapacity(options.native, options.record);
  let maximum: 1 | 2 = 1,
    problem: string | null = null;
  if (state.selectedWorkers === 2) {
    try {
      if (!state.receipt) throw new Error("ADVANCED_CAPACITY_REQUIRED");
      const bytes = await options.readReceipt(state.receipt.relativePath);
      if (
        bytes.length > 8 * 1024 ** 2 ||
        createHash("sha256").update(bytes).digest("hex") !==
          state.receipt.sha256
      )
        throw new Error("ADVANCED_CAPACITY_INVALID");
      validateConsumerCapacityReceipt(
        JSON.parse(bytes.toString("utf8")),
        options.record,
        options.identity,
        options.now,
      );
      maximum = 2;
    } catch {
      problem = "ADVANCED_CAPACITY_REQUALIFICATION_REQUIRED";
    }
  }
  const workerIds =
    maximum === 2
      ? [options.record.workerId, state.secondWorkerId]
      : [options.record.workerId];
  return {
    workerIds,
    validatedMaxWorkersPerGpu: maximum,
    requestedWorkers: state.selectedWorkers,
    problem,
  };
}
