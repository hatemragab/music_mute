import { isDeepStrictEqual } from "node:util";
import { PERSONAL_RECIPE_DIGESTS } from "../personal/timeline.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { WINDOWS_CONSUMER_PINS } from "../../../../worker/src/platform/windows/consumer-pins.js";
import {
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import {
  parseStorePreparationBinding,
  storePreparationTarget,
  type StorePreparationBinding,
} from "../prepare/store-model-ready.js";
import {
  fleetRecordAuthority,
  parseFleetRecord,
  type FleetEnrollmentRecord,
} from "./store.js";

export const STORE_ACTIVE_RUNTIME_KEY = "store_active_runtime";
interface StoreFleetActiveCommon {
  distribution: "microsoft-store";
  archiveDigest: null;
  authority: string;
  transaction: string;
  runtimeIdentity: string;
  storeBinding: StorePreparationBinding;
  modelDigest: string;
  fixtureDigest: string;
  qualification: unknown;
  qualifiedAt: string;
}
export type StoreFleetActiveProof = StoreFleetActiveCommon &
  (
    | { version: 1 }
    | {
        version: 2;
        source: "legacy-consumer-repair";
        approvalQualificationSha256: string;
      }
  );
function invalid(): never {
  throw new Error("FLEET_ACTIVE_RUNTIME_INVALID");
}
/** Bounded local observations. The live reader separately validates genuine
 * code, held model, current boot/hardware and original immutable enrollment. */
export function parseStoreFleetActiveProof(
  input: unknown,
  enrollment: FleetEnrollmentRecord,
): StoreFleetActiveProof {
  try {
    const record = parseFleetRecord(enrollment, enrollment.sid);
    if (record.phase !== "complete" || !record.machineCredential) invalid();
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    )
      invalid();
    const descriptors = Object.getOwnPropertyDescriptors(input),
      version = descriptors.version;
    if (!version?.enumerable || !("value" in version)) invalid();
    const legacyRepair = version.value === 2;
    if (
      legacyRepair
        ? record.prepared.distribution !== undefined
        : record.prepared.distribution !== "microsoft-store"
    )
      invalid();
    const fields = [
        "version",
        "distribution",
        "archiveDigest",
        "authority",
        "transaction",
        "runtimeIdentity",
        "storeBinding",
        "modelDigest",
        "fixtureDigest",
        "qualification",
        "qualifiedAt",
        ...(legacyRepair ? ["source", "approvalQualificationSha256"] : []),
      ],
      keys = Reflect.ownKeys(input),
      row: Record<string, unknown> = Object.create(null);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      invalid();
    for (const key of fields) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
      row[key] = descriptor.value;
    }
    const binding = parseStorePreparationBinding(row.storeBinding);
    if (
      (legacyRepair
        ? row.version !== 2 ||
          row.source !== "legacy-consumer-repair" ||
          typeof row.approvalQualificationSha256 !== "string" ||
          !/^[a-f0-9]{64}$/u.test(row.approvalQualificationSha256)
        : row.version !== 1) ||
      row.distribution !== "microsoft-store" ||
      row.archiveDigest !== null ||
      row.authority !== fleetRecordAuthority(record) ||
      typeof row.transaction !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        row.transaction,
      ) ||
      row.runtimeIdentity !== storePreparationTarget(binding) ||
      binding.sid !== record.sid ||
      row.modelDigest !== MODEL.sha256 ||
      row.modelDigest !== record.prepared.modelDigest ||
      row.fixtureDigest !== record.prepared.fixtureDigest ||
      !isDeepStrictEqual(
        binding.recipeDigests,
        record.prepared.distribution === "microsoft-store"
          ? record.prepared.storeBinding.recipeDigests
          : PERSONAL_RECIPE_DIGESTS,
      ) ||
      typeof row.qualifiedAt !== "string" ||
      !Number.isFinite(Date.parse(row.qualifiedAt)) ||
      Date.parse(row.qualifiedAt) > Date.now() ||
      Buffer.byteLength(JSON.stringify(row)) > 16384
    )
      invalid();
    const evidence = parseQualificationEvidence(row.qualification, {
      runtimeProfile: "windows-user",
      expectedUserSid: record.sid,
      expectedFixtureDigest: record.prepared.fixtureDigest,
    });
    if (
      !evidence.gpuIdentity ||
      evidence.modelDigest !== MODEL.sha256 ||
      evidence.releaseManifestDigest !== binding.runtimeManifestSha256 ||
      evidence.runtimeDiagnostics?.onnxRuntime !==
        WINDOWS_CONSUMER_PINS.onnxRuntime ||
      Object.entries(binding.recipeDigests).some(
        ([id, digest]) => evidence.recipeDigests[id] !== digest,
      )
    )
      invalid();
    resolveQualifiedGpuIdentity(
      {
        ...record.prepared.gpu,
        driverVersion: evidence.gpuIdentity.driverVersion,
        ...(record.prepared.bootIdentity !== binding.bootIdentity
          ? { luid: evidence.gpuIdentity.luid }
          : {}),
      },
      [evidence.gpuIdentity],
    );
    return structuredClone({
      ...row,
      storeBinding: binding,
    }) as unknown as StoreFleetActiveProof;
  } catch {
    return invalid();
  }
}
