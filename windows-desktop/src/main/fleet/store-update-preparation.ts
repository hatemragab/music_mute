import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import {
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import { readApprovedLegacyFleetQualification } from "./store-approval-witness.js";
import { PERSONAL_RECIPE_DIGESTS } from "../personal/timeline.js";
import { StorePreparationOperations } from "../prepare/store-operations.js";
import { PrepareFailure, type PrepareTarget } from "../prepare/controller.js";
import {
  privateFingerprint,
  verifyPrivateFile,
  readPrivateBytes,
} from "../prepare/private-files.js";
import {
  selectTrustedPreparationGpu,
  assertApprovedPreparationFixture,
} from "../prepare/qualification-runner.js";
import { storePreparationTarget } from "../prepare/store-model-ready.js";
import type { HostContext } from "../host-context.js";
import { fleetRecordAuthority, VaultFleetStore } from "./store.js";
import {
  readStoreFleetRuntimeIdentityForGui,
  readStoreApprovedFleetGpuSelection,
} from "./store-active-runtime.js";
import {
  parseStoreFleetActiveProof,
  STORE_ACTIVE_RUNTIME_KEY,
} from "./store-active-proof.js";

/** Requalification under the genuine operation owner's already-held Prepare
 * lease and acknowledged live maintenance fence. No backend approval, original
 * credential/report, production recipe or writable executable is replaced. */
interface QualificationOptions {
  host: HostContext;
  operations: StorePreparationOperations;
  target: PrepareTarget;
  transaction: string;
}
export async function refreshApprovedStoreFleetRuntime(
  options: QualificationOptions,
  signal: AbortSignal,
) {
  if (arguments.length !== 2) throw new Error("UPDATE_MAINTENANCE_REQUIRED");
  return qualifyApprovedRuntime(options, signal, false);
}
/** Explicit repair only. The immutable legacy approval remains intact; genuine
 * Store qualification publishes a separately tagged local runtime overlay. */
export async function repairApprovedLegacyStoreFleetRuntime(
  options: QualificationOptions,
  signal: AbortSignal,
) {
  if (arguments.length !== 2) throw new Error("UPDATE_MAINTENANCE_REQUIRED");
  return qualifyApprovedRuntime(options, signal, true);
}
async function qualifyApprovedRuntime(
  options: QualificationOptions,
  signal: AbortSignal,
  legacyRepair: boolean,
) {
  const { host, operations, target } = options;
  StorePreparationOperations.prototype.assertHost.call(operations, host);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
      options.transaction,
    )
  )
    throw new Error("UPDATE_MAINTENANCE_REQUIRED");
  await StorePreparationOperations.prototype.assertHeldMutation.call(
    operations,
    target,
    signal,
  );
  const store = new VaultFleetStore(host.native, host.identity.sid),
    record = await store.read();
  if (!record || record.phase !== "complete") return null;
  if (
    legacyRepair
      ? record.prepared.distribution !== undefined
      : record.prepared.distribution !== "microsoft-store"
  )
    throw new Error("FLEET_PREPARE_REQUIRED");
  const view = await StorePreparationOperations.prototype.mediaCodeView.call(
    operations,
    signal,
  );
  if (
    !isDeepStrictEqual(
      view.binding.recipeDigests,
      record.prepared.distribution === "microsoft-store"
        ? record.prepared.storeBinding.recipeDigests
        : PERSONAL_RECIPE_DIGESTS,
    ) ||
    record.prepared.modelDigest !== MODEL.sha256
  )
    throw new Error("FLEET_INTEGRITY_INVALID");
  const originalApproval = legacyRepair
    ? await readApprovedLegacyFleetQualification(host, record)
    : null;
  const selection = legacyRepair
      ? {
          approvedGpu: record.prepared.gpu,
          expectedBootIdentity: view.binding.bootIdentity,
          allowLuidRebind:
            record.prepared.bootIdentity !== view.binding.bootIdentity,
        }
      : await readStoreApprovedFleetGpuSelection(
          host,
          operations,
          record,
          signal,
        ),
    selected = selectTrustedPreparationGpu(
      selection,
      view.binding.bootIdentity,
      await host.native.enumerateGpus(),
    );
  try {
    const current = await readStoreFleetRuntimeIdentityForGui(
        host,
        operations,
        record,
        signal,
      ),
      ready =
        await StorePreparationOperations.prototype.snapshotStoreReady.call(
          operations,
          signal,
        );
    if (ready.evidence.gpuIdentity) {
      let aligned = false;
      try {
        resolveQualifiedGpuIdentity(selected, [ready.evidence.gpuIdentity]);
        resolveQualifiedGpuIdentity(selected, [current.gpu]);
        aligned = true;
      } catch {
        /* Independently qualify the approved physical adapter below. */
      }
      if (aligned && !legacyRepair) {
        await StorePreparationOperations.prototype.assertHeldMutation.call(
          operations,
          target,
          signal,
        );
        return null;
      }
    }
  } catch (error) {
    if (
      !(
        error instanceof PrepareFailure &&
        ["INTEGRITY_INVALID", "GPU_UNSUPPORTED"].includes(error.code)
      ) &&
      !(error instanceof Error && error.message === "FLEET_PREPARE_REQUIRED")
    )
      throw error;
  }
  // The original raw approval remains an immutable witness of fixture/recipes.
  const qualificationRelative = `prepare\\approved\\qualification-${createHash("sha256").update(record.requests.report).digest("hex")}.json`;
  if (
    record.prepared.qualificationPath !==
    win32.join(host.personalRoot, qualificationRelative)
  )
    throw new Error("FLEET_INTEGRITY_INVALID");
  const originalBytes = await readPrivateBytes(
    host,
    qualificationRelative,
    16384,
  );
  let original: ReturnType<typeof parseQualificationEvidence>;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(originalBytes);
    if (text.charCodeAt(0) === 0xfeff)
      throw new Error("FLEET_INTEGRITY_INVALID");
    original = parseQualificationEvidence(parseStrictJson(text, 16384, 1024), {
      runtimeProfile: "windows-user",
      expectedUserSid: record.sid,
      expectedFixtureDigest: record.prepared.fixtureDigest,
    });
  } finally {
    originalBytes.fill(0);
  }
  if (
    !original.gpuIdentity ||
    original.releaseManifestDigest !== record.prepared.manifestDigest ||
    original.modelDigest !== MODEL.sha256 ||
    !isDeepStrictEqual(original.recipeDigests, view.binding.recipeDigests) ||
    original.uploadCandidate.path !== record.prepared.output.path ||
    original.uploadCandidate.resultDigest !== record.prepared.output.sha256 ||
    original.uploadCandidate.resultBytes !== record.prepared.output.bytes
  )
    throw new Error("FLEET_INTEGRITY_INVALID");
  resolveQualifiedGpuIdentity(record.prepared.gpu, [original.gpuIdentity]);
  const relativePath = `prepare\\approved\\${record.prepared.fixtureDigest}.wav`,
    fingerprint = await privateFingerprint(host, relativePath),
    fixture = {
      relativePath,
      sha256: record.prepared.fixtureDigest,
      bytes: fingerprint.bytes,
    };
  assertApprovedPreparationFixture(fixture);
  if (
    (await verifyPrivateFile(host, relativePath, fixture.bytes, signal))
      .sha256 !== fixture.sha256
  )
    throw new Error("UPDATE_FLEET_FIXTURE_UNAVAILABLE");
  // Approval, both production recipes and the approved input are validated
  // before even the missing-model repair stage can cause qualification effects.
  if (
    legacyRepair &&
    !(await StorePreparationOperations.prototype.reuse.call(
      operations,
      "model",
      target,
      signal,
    ))
  )
    await StorePreparationOperations.prototype.perform.call(
      operations,
      "model",
      target,
      signal,
      () => {},
    );
  await StorePreparationOperations.prototype.requalifyInstalled.call(
    operations,
    signal,
    selection,
  );
  const result =
    await StorePreparationOperations.prototype.qualifyApprovedFixtureHeld.call(
      operations,
      target,
      fixture,
      signal,
      selection,
    );
  if (
    !result.evidence.gpuIdentity ||
    result.bootIdentity !== view.binding.bootIdentity
  )
    throw new Error("FLEET_PREPARE_REQUIRED");
  resolveQualifiedGpuIdentity(selected, [result.evidence.gpuIdentity]);
  const proof = parseStoreFleetActiveProof(
    {
      ...(legacyRepair
        ? {
            version: 2,
            source: "legacy-consumer-repair",
            approvalQualificationSha256: originalApproval!.sha256,
          }
        : { version: 1 }),
      distribution: "microsoft-store",
      archiveDigest: null,
      authority: fleetRecordAuthority(record),
      transaction: options.transaction,
      runtimeIdentity: storePreparationTarget(view.binding),
      storeBinding: view.binding,
      modelDigest: MODEL.sha256,
      fixtureDigest: fixture.sha256,
      qualification: result.raw,
      qualifiedAt: new Date().toISOString(),
    },
    record,
  );
  await StorePreparationOperations.prototype.assertHeldMutation.call(
    operations,
    target,
    signal,
  );
  const lock = await host.native.acquireMutex("cache");
  if (!lock) throw new Error("UPDATE_BUSY");
  try {
    const current = await store.read(),
      ready =
        await StorePreparationOperations.prototype.snapshotStoreReady.call(
          operations,
          signal,
        );
    if (
      !current ||
      !isDeepStrictEqual(current, record) ||
      !isDeepStrictEqual(ready.binding, view.binding) ||
      (legacyRepair &&
        (await readApprovedLegacyFleetQualification(host, record)).sha256 !==
          originalApproval!.sha256)
    )
      throw new Error("UPDATE_FLEET_CHANGED");
    resolveQualifiedGpuIdentity(selected, [ready.evidence.gpuIdentity!]);
    resolveQualifiedGpuIdentity(selected, await host.native.enumerateGpus());
    await StorePreparationOperations.prototype.assertHeldMutation.call(
      operations,
      target,
      signal,
    );
    await host.native.vaultDelete("fleet", "capacity");
    await host.native.vaultWrite(
      "fleet",
      STORE_ACTIVE_RUNTIME_KEY,
      Buffer.from(JSON.stringify(proof)),
    );
    await StorePreparationOperations.prototype.assertHeldMutation.call(
      operations,
      target,
      signal,
    );
  } finally {
    await host.native.releaseMutex(lock);
  }
  return proof;
}
