import {
  parseDirectmlGpuIdentity,
  type DirectmlGpuIdentity,
} from "../../enrollment/report-builder.js";
import {
  ConsumerNativeError,
  object,
  processIdentityFromWire,
  type ConsumerProcessIdentity,
} from "./consumer-native-policy.js";

export type ConsumerGpuIdentity = DirectmlGpuIdentity;
export interface ConsumerGpuLease {
  luid: string;
  nonce: string;
  identity: ConsumerProcessIdentity;
  abandoned: boolean;
  gpu: ConsumerGpuIdentity;
}
export function parseConsumerGpu(value: unknown): ConsumerGpuIdentity {
  try {
    return parseDirectmlGpuIdentity(value);
  } catch {
    throw new ConsumerNativeError("GPU_INVENTORY_UNAVAILABLE");
  }
}
export function parseConsumerGpuLease(value: unknown): ConsumerGpuLease | null {
  const input = object(value);
  if (input.acquired === false) return null;
  if (
    input.acquired !== true ||
    typeof input.luid !== "string" ||
    !/^[a-f0-9]{16}$/u.test(input.luid) ||
    typeof input.nonce !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.nonce) ||
    typeof input.abandoned !== "boolean"
  )
    throw new ConsumerNativeError("PROTOCOL_MISMATCH");
  const gpu = parseConsumerGpu(input.gpu);
  if (gpu.luid !== input.luid)
    throw new ConsumerNativeError("GPU_GUARD_UNSAFE");
  return {
    luid: input.luid,
    nonce: input.nonce,
    identity: processIdentityFromWire(input.identity),
    abandoned: input.abandoned,
    gpu,
  };
}
