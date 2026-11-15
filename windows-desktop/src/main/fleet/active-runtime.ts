import {
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import type { WindowsPreparationOperations } from "../prepare/operations.js";
import type { TrustedPreparationGpuSelection } from "../prepare/qualification-runner.js";
import type { WindowsConsumerNative } from "../../../../worker/src/platform/windows/consumer-native.js";
import {
  fleetRecordAuthority,
  type FleetEnrollmentRecord,
  type FleetPreparedIdentity,
} from "./store.js";

const SHA = /^[a-f0-9]{64}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
export interface FleetActiveRuntimeProof {
  version: 2;
  bootIdentity: string;
  sid: string;
  authority: string;
  transaction: string;
  updateIdentity: string;
  release: string;
  manifestDigest: string;
  archiveDigest: string;
  modelDigest: string;
  fixtureDigest: string;
  approvedRecipeDigests: Record<string, string>;
  qualification: unknown;
  qualifiedAt: string;
}
export interface FleetRuntimeIdentity extends Omit<
  FleetPreparedIdentity,
  "report" | "output" | "bootIdentity"
> {
  bootIdentity: string;
  source: "enrollment" | "consumer-update";
  qualification: unknown | null;
  output: FleetPreparedIdentity["output"] | null;
}
export type FleetExpectedRuntime = Pick<
  FleetPreparedIdentity,
  "release" | "manifestDigest" | "modelDigest"
> &
  Partial<Pick<FleetPreparedIdentity, "archiveDigest">>;

/** Local qualification never changes the original machine report or grants backend permission. */
export function parseFleetActiveRuntime(
  value: unknown,
  record: FleetEnrollmentRecord,
): FleetActiveRuntimeProof {
  const fail = (): never => {
    throw new Error("FLEET_ACTIVE_RUNTIME_INVALID");
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const v = value as FleetActiveRuntimeProof;
  if (
    Object.keys(v).sort().join() !==
      "approvedRecipeDigests,archiveDigest,authority,bootIdentity,fixtureDigest,manifestDigest,modelDigest,qualification,qualifiedAt,release,sid,transaction,updateIdentity,version" ||
    v.version !== 2 ||
    typeof v.bootIdentity !== "string" ||
    !SHA.test(v.bootIdentity) ||
    record.phase !== "complete" ||
    v.sid !== record.sid ||
    v.authority !== fleetRecordAuthority(record) ||
    !UUID.test(v.transaction) ||
    [
      v.updateIdentity,
      v.release,
      v.manifestDigest,
      v.archiveDigest,
      v.modelDigest,
      v.fixtureDigest,
    ].some((id) => typeof id !== "string" || !SHA.test(id)) ||
    v.fixtureDigest !== record.prepared.fixtureDigest ||
    typeof v.qualifiedAt !== "string" ||
    !Number.isFinite(Date.parse(v.qualifiedAt)) ||
    Date.parse(v.qualifiedAt) > Date.now() ||
    !v.approvedRecipeDigests ||
    typeof v.approvedRecipeDigests !== "object" ||
    Array.isArray(v.approvedRecipeDigests) ||
    Buffer.byteLength(JSON.stringify(v), "utf8") > 16384
  )
    return fail();
  try {
    const evidence = parseQualificationEvidence(v.qualification, {
      runtimeProfile: "windows-user",
      expectedUserSid: record.sid,
      expectedFixtureDigest: record.prepared.fixtureDigest,
    });
    const recipes = record.prepared.report.capabilities[0]!.recipeIds;
    if (
      !evidence.gpuIdentity ||
      evidence.releaseManifestDigest !== v.manifestDigest ||
      evidence.modelDigest !== v.modelDigest ||
      Object.keys(v.approvedRecipeDigests).length !== recipes.length ||
      recipes.some(
        (recipe) =>
          !SHA.test(v.approvedRecipeDigests[recipe] ?? "") ||
          v.approvedRecipeDigests[recipe] !== evidence.recipeDigests[recipe],
      )
    )
      return fail();
    // Fresh guarded qualification permits a new driver on the same approved physical adapter.
    resolveQualifiedGpuIdentity(
      {
        ...record.prepared.gpu,
        // Fresh explicit cross-witness/legacy migration rebinds the volatile LUID;
        // all stable descriptor fields are still checked. This is not a GPU serial.
        ...(record.prepared.bootIdentity === undefined ||
        record.prepared.bootIdentity !== v.bootIdentity
          ? { luid: evidence.gpuIdentity.luid }
          : {}),
        driverVersion: evidence.gpuIdentity.driverVersion,
      },
      [evidence.gpuIdentity],
    );
  } catch {
    return fail();
  }
  return structuredClone(v);
}
export function resolveActiveFleetIdentity(
  record: FleetEnrollmentRecord,
  proof: unknown | null,
  expected?: FleetExpectedRuntime,
): FleetRuntimeIdentity {
  if (record.prepared.distribution === "microsoft-store")
    throw new Error("FLEET_PREPARE_REQUIRED");
  if (record.phase !== "complete") throw new Error("FLEET_NOT_ENROLLED");
  let identity: FleetRuntimeIdentity;
  if (proof === null) {
    if (!record.prepared.bootIdentity)
      throw new Error("FLEET_PREPARE_REQUIRED");
    const { report: _report, ...prepared } = record.prepared;
    identity = {
      ...prepared,
      bootIdentity: record.prepared.bootIdentity,
      source: "enrollment",
      qualification: null,
    };
  } else {
    const active = parseFleetActiveRuntime(proof, record);
    const evidence = parseQualificationEvidence(active.qualification, {
      runtimeProfile: "windows-user",
      expectedUserSid: record.sid,
      expectedFixtureDigest: active.fixtureDigest,
    });
    identity = {
      source: "consumer-update",
      bootIdentity: active.bootIdentity,
      release: active.release,
      manifestDigest: active.manifestDigest,
      archiveDigest: active.archiveDigest,
      modelDigest: active.modelDigest,
      fixtureDigest: active.fixtureDigest,
      gpu: evidence.gpuIdentity!,
      qualification: active.qualification,
      qualificationPath: null,
      output: null,
    };
  }
  if (
    expected &&
    (identity.release !== expected.release ||
      identity.manifestDigest !== expected.manifestDigest ||
      identity.modelDigest !== expected.modelDigest ||
      (expected.archiveDigest !== undefined &&
        identity.archiveDigest !== expected.archiveDigest))
  )
    throw new Error("FLEET_PREPARE_REQUIRED");
  return identity;
}
export async function readActiveFleetIdentity(
  native: Pick<WindowsConsumerNative, "vaultRead" | "bootIdentity">,
  record: FleetEnrollmentRecord,
  expected?: FleetExpectedRuntime,
): Promise<FleetRuntimeIdentity> {
  const boot = await native.bootIdentity();
  if (!SHA.test(boot)) throw new Error("FLEET_PREPARE_REQUIRED");
  const bytes = await native.vaultRead("fleet", "active_runtime");
  if (!bytes) {
    const identity = resolveActiveFleetIdentity(record, null, expected);
    if (identity.bootIdentity !== boot)
      throw new Error("FLEET_PREPARE_REQUIRED");
    return identity;
  }
  try {
    if (bytes.length > 16384) throw new Error("FLEET_ACTIVE_RUNTIME_INVALID");
    const raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (raw?.version === 1 && raw.bootIdentity === undefined) {
      parseFleetActiveRuntime(
        { ...raw, version: 2, bootIdentity: boot },
        record,
      );
      throw new Error("FLEET_PREPARE_REQUIRED");
    }
    const identity = resolveActiveFleetIdentity(record, raw, expected);
    if (identity.bootIdentity !== boot)
      throw new Error("FLEET_PREPARE_REQUIRED");
    return identity;
  } catch (error) {
    if (error instanceof Error && error.message === "FLEET_PREPARE_REQUIRED")
      throw error;
    throw new Error("FLEET_ACTIVE_RUNTIME_INVALID");
  } finally {
    bytes.fill(0);
  }
}

/** Operational fleet proof: Ready pins plus current hardware/driver/witness, independent of personal adapter choice. */
export async function readOperationalFleetIdentity(
  native: Pick<
    WindowsConsumerNative,
    "vaultRead" | "bootIdentity" | "enumerateGpus"
  >,
  record: FleetEnrollmentRecord,
  expected?: FleetExpectedRuntime,
): Promise<FleetRuntimeIdentity> {
  const active = await readActiveFleetIdentity(native, record, expected);
  try {
    const gpu = resolveQualifiedGpuIdentity(
      active.gpu,
      await native.enumerateGpus(),
    );
    if ((await native.bootIdentity()) !== active.bootIdentity)
      throw new Error();
    return { ...active, gpu };
  } catch {
    throw new Error("FLEET_PREPARE_REQUIRED");
  }
}
/** Select from the last accepted witness/LUID; an old original receipt cannot relax a current overlay. */
export async function readApprovedFleetGpuSelection(
  native: Pick<WindowsConsumerNative, "vaultRead" | "bootIdentity">,
  record: FleetEnrollmentRecord,
  expectedBootIdentity: string,
): Promise<TrustedPreparationGpuSelection> {
  if (
    !SHA.test(expectedBootIdentity) ||
    (await native.bootIdentity()) !== expectedBootIdentity
  )
    throw new Error("FLEET_PREPARE_REQUIRED");
  let acceptedBoot = record.prepared.bootIdentity,
    approvedGpu = record.prepared.gpu;
  const bytes = await native.vaultRead("fleet", "active_runtime");
  if (bytes)
    try {
      if (bytes.length > 16384) throw new Error();
      const raw = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (raw?.version === 1 && raw.bootIdentity === undefined) {
        const legacy = { ...record, prepared: { ...record.prepared } };
        delete legacy.prepared.bootIdentity;
        parseFleetActiveRuntime(
          { ...raw, version: 2, bootIdentity: expectedBootIdentity },
          legacy,
        );
        // Legacy proof has no witness. Only a separately bound original can retain its LUID.
      } else {
        const active = parseFleetActiveRuntime(raw, record),
          evidence = parseQualificationEvidence(active.qualification, {
            runtimeProfile: "windows-user",
            expectedUserSid: record.sid,
            expectedFixtureDigest: record.prepared.fixtureDigest,
          });
        acceptedBoot = active.bootIdentity;
        approvedGpu = evidence.gpuIdentity!;
      }
    } catch {
      throw new Error("FLEET_ACTIVE_RUNTIME_INVALID");
    } finally {
      bytes.fill(0);
    }
  return {
    approvedGpu: structuredClone(approvedGpu),
    expectedBootIdentity,
    allowLuidRebind:
      acceptedBoot === undefined || acceptedBoot !== expectedBootIdentity,
  };
}

/** Personal and fleet receipts share W11's one physical GPU policy; ordinal reorder alone is not hardware change. */
export function fleetGpuReadyAligned(
  ready: Pick<
    Awaited<ReturnType<WindowsPreparationOperations["snapshotReady"]>>,
    "bootIdentity" | "evidence"
  >,
  fleet: { bootIdentity: string; gpu: FleetPreparedIdentity["gpu"] },
): boolean {
  try {
    if (
      ready.bootIdentity !== fleet.bootIdentity ||
      !ready.evidence.gpuIdentity
    )
      return false;
    resolveQualifiedGpuIdentity(fleet.gpu, [ready.evidence.gpuIdentity]);
    return true;
  } catch {
    return false;
  }
}
