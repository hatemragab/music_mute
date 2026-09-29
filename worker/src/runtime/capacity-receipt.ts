import { parseCapacityBenchmarkReport } from "../platform/shared/capacity-benchmark.js";
import {
  stableCapacityGpuIdentity,
  type installedCapacityIdentity,
} from "./capacity-identity.js";

type CapacityIdentity = Awaited<ReturnType<typeof installedCapacityIdentity>>;
type Measurements = ReturnType<typeof parseCapacityBenchmarkReport>;
const LIFETIME_MS = 7 * 24 * 60 * 60_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KEYS = new Set([
  "schemaVersion",
  "status",
  "machineId",
  "validatedMaxWorkersPerGpu",
  "hostDigest",
  "validatedAt",
  "expiresAt",
  "measurements",
]);

/** The receipt includes the evidence, so startup rechecks every recipe's gates. */
export function createCapacityReceipt(options: {
  machineId: string;
  identity: CapacityIdentity;
  measurements: Measurements;
  now?: number;
}) {
  const now = options.now ?? Date.now();
  const receipt = parseCapacityReceipt(
    {
      schemaVersion: 3,
      status: "PASS",
      machineId: options.machineId,
      validatedMaxWorkersPerGpu: 2,
      hostDigest: options.identity.hostDigest,
      validatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LIFETIME_MS).toISOString(),
      measurements: options.measurements,
    },
    { machineId: options.machineId, provider: options.identity.provider, now },
  );
  assertCapacityReceiptIdentity(receipt, options.identity);
  return receipt;
}

export function parseCapacityReceipt(
  value: unknown,
  options: {
    machineId: string;
    provider: "mps" | "directml";
    now?: number;
  },
) {
  const record = object(value);
  const now = options.now ?? Date.now();
  if (
    Object.keys(record).some((key) => !KEYS.has(key)) ||
    record.schemaVersion !== 3 ||
    record.status !== "PASS" ||
    record.machineId !== options.machineId ||
    !UUID.test(options.machineId) ||
    record.validatedMaxWorkersPerGpu !== 2 ||
    typeof record.hostDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.hostDigest) ||
    typeof record.validatedAt !== "string" ||
    typeof record.expiresAt !== "string"
  )
    throw new TypeError("Capacity benchmark evidence did not pass");
  const start = Date.parse(record.validatedAt);
  const end = Date.parse(record.expiresAt);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(now) ||
    start > now + 5 * 60_000 ||
    end <= now ||
    end <= start ||
    end - start > LIFETIME_MS
  )
    throw new TypeError(
      "Capacity benchmark evidence expired or has invalid dates",
    );
  const measurements = object(record.measurements);
  const validated = parseCapacityBenchmarkReport(measurements, {
    provider: options.provider,
    fixtureDigest: String(measurements.fixtureDigest),
    warmupRuns: Number(measurements.warmupRuns),
    measuredRuns: Number(measurements.measuredRuns),
    stored: true,
  });
  if (validated.status !== "PASS")
    throw new TypeError("Capacity benchmark measurements did not pass");
  return {
    schemaVersion: 3 as const,
    status: "PASS" as const,
    machineId: options.machineId,
    validatedMaxWorkersPerGpu: 2 as const,
    hostDigest: record.hostDigest,
    validatedAt: record.validatedAt,
    expiresAt: record.expiresAt,
    measurements: validated,
  };
}

export function assertCapacityReceiptIdentity(
  receipt: ReturnType<typeof parseCapacityReceipt>,
  identity: CapacityIdentity,
): void {
  for (const key of [
    "releaseManifestDigest",
    "modelDigest",
    "fixtureDigest",
    "provider",
  ] as const) {
    if (receipt.measurements[key] !== identity[key])
      throw new TypeError(
        "Capacity benchmark does not match the installed runtime",
      );
  }
  const gpu =
    receipt.measurements.provider === "directml"
      ? stableCapacityGpuIdentity(receipt.measurements.gpuIdentity)
      : null;
  if (
    receipt.hostDigest !== identity.hostDigest ||
    JSON.stringify(gpu) !== JSON.stringify(identity.gpuIdentity)
  )
    throw new TypeError(
      "Capacity benchmark does not match the installed runtime",
    );
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Capacity benchmark evidence is invalid");
  return value as Record<string, unknown>;
}
