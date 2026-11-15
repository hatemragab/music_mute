import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import {
  parseQualificationEvidence,
  resolveQualifiedGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import { readApprovedLegacyFleetQualification } from "./store-approval-witness.js";
import { StoreNodeIssuer } from "../session/store-node-issuer.js";
import { HostContext } from "../host-context.js";
import { readStoreRoleReadiness } from "../prepare/store-readiness.js";
import { StorePreparationOperations } from "../prepare/store-operations.js";
import type { TrustedPreparationGpuSelection } from "../prepare/qualification-runner.js";
import type { StorePreparationBinding } from "../prepare/store-model-ready.js";
import { readPrivateBytes } from "../prepare/private-files.js";
import {
  fleetRecordAuthority,
  parseFleetRecord,
  type FleetEnrollmentRecord,
} from "./store.js";
import {
  parseStoreFleetActiveProof,
  STORE_ACTIVE_RUNTIME_KEY,
} from "./store-active-proof.js";

function denied(): never {
  throw new Error("FLEET_PREPARE_REQUIRED");
}
function decode(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) denied();
  return parseStrictJson(text, 16384, 1024);
}
/** The caller is private code below, after a real GUI or Node brand check. */
async function readBoundRuntime(
  host: HostContext,
  record: FleetEnrollmentRecord,
  ready: Awaited<ReturnType<StorePreparationOperations["snapshotStoreReady"]>>,
  currentBinding: () => Promise<StorePreparationBinding>,
  signal: AbortSignal,
) {
  const snapshot = parseFleetRecord(record, host.identity.sid);
  if (snapshot.phase !== "complete" || !snapshot.machineCredential) denied();
  const prepared = snapshot.prepared,
    authority = fleetRecordAuthority(snapshot),
    activeBytes = await host.native.vaultRead(
      "fleet",
      STORE_ACTIVE_RUNTIME_KEY,
    );
  let qualification: unknown,
    binding: StorePreparationBinding,
    qualificationPath: string | null,
    legacyApprovalDigest: string | undefined,
    source:
      "store-enrollment" | "store-requalification" | "legacy-consumer-repair";
  if (activeBytes) {
    try {
      const active = parseStoreFleetActiveProof(decode(activeBytes), snapshot);
      qualification = active.qualification;
      binding = active.storeBinding;
      qualificationPath = null;
      source =
        active.version === 2
          ? "legacy-consumer-repair"
          : "store-requalification";
      if (active.version === 2)
        legacyApprovalDigest = active.approvalQualificationSha256;
      if (
        active.version === 2 &&
        (await readApprovedLegacyFleetQualification(host, snapshot)).sha256 !==
          active.approvalQualificationSha256
      )
        denied();
    } finally {
      activeBytes.fill(0);
    }
  } else {
    if (prepared.distribution !== "microsoft-store") denied();
    binding = prepared.storeBinding;
    const relative = `prepare\\approved\\qualification-${createHash("sha256").update(snapshot.requests.report).digest("hex")}.json`;
    if (prepared.qualificationPath !== win32.join(host.personalRoot, relative))
      denied();
    const bytes = await readPrivateBytes(host, relative, 16384);
    try {
      qualification = decode(bytes);
    } finally {
      bytes.fill(0);
    }
    qualificationPath = prepared.qualificationPath;
    source = "store-enrollment";
  }
  if (
    !isDeepStrictEqual(binding, ready.binding) ||
    prepared.modelDigest !== MODEL.sha256
  )
    denied();
  const evidence = parseQualificationEvidence(qualification, {
    runtimeProfile: "windows-user",
    expectedUserSid: snapshot.sid,
    expectedFixtureDigest: prepared.fixtureDigest,
  });
  if (
    !evidence.gpuIdentity ||
    evidence.releaseManifestDigest !== binding.runtimeManifestSha256 ||
    evidence.modelDigest !== MODEL.sha256 ||
    Object.entries(binding.recipeDigests).some(
      ([id, digest]) => evidence.recipeDigests[id] !== digest,
    ) ||
    prepared.report.capabilities[0]!.recipeIds.some(
      (id) => !binding.recipeDigests[id],
    )
  )
    denied();
  if (source === "store-enrollment") {
    if (
      evidence.uploadCandidate.path !== prepared.output.path ||
      evidence.uploadCandidate.resultBytes !== prepared.output.bytes ||
      evidence.uploadCandidate.resultDigest !== prepared.output.sha256
    )
      denied();
    resolveQualifiedGpuIdentity(prepared.gpu, [evidence.gpuIdentity]);
  }
  const currentGpus = await host.native.enumerateGpus();
  let gpu: ReturnType<typeof resolveQualifiedGpuIdentity>;
  try {
    gpu = resolveQualifiedGpuIdentity(evidence.gpuIdentity, currentGpus);
  } catch {
    return denied();
  }
  if (
    !isDeepStrictEqual(await currentBinding(), binding) ||
    (await host.native.bootIdentity()) !== binding.bootIdentity ||
    fleetRecordAuthority(record) !== authority ||
    !isDeepStrictEqual(record, snapshot) ||
    (legacyApprovalDigest !== undefined &&
      (await readApprovedLegacyFleetQualification(host, snapshot)).sha256 !==
        legacyApprovalDigest)
  )
    denied();
  signal.throwIfAborted();
  return Object.freeze({
    distribution: "microsoft-store" as const,
    source,
    archiveDigest: null,
    storeBinding: binding,
    bootIdentity: binding.bootIdentity,
    release: binding.inventorySha256,
    manifestDigest: binding.runtimeManifestSha256,
    modelDigest: MODEL.sha256,
    fixtureDigest: prepared.fixtureDigest,
    qualification,
    qualificationPath,
    evidence,
    gpu,
    output: Object.freeze({
      path: evidence.uploadCandidate.path,
      bytes: evidence.uploadCandidate.resultBytes,
      sha256: evidence.uploadCandidate.resultDigest,
    }),
  });
}

/** Current runtime observations only. The genuine private Node issuer, held
 * Store code and qualified model/GPU are revalidated on both sides. A stored
 * enrollment, report or signature-kind DTO creates no execution authority. */
export async function readStoreFleetRuntimeIdentity(
  issuer: StoreNodeIssuer,
  record: FleetEnrollmentRecord,
  signal: AbortSignal,
) {
  if (arguments.length !== 3) denied();
  // Invoke the real getter so forged prototype objects and overridden caller
  // getters fail before a helper, filesystem or model operation is attempted.
  const role = Object.getOwnPropertyDescriptor(
    StoreNodeIssuer.prototype,
    "nodeRole",
  )!.get!.call(issuer);
  if (role !== "session-agent" && role !== "fleet") denied();
  signal.throwIfAborted();
  if (record.phase !== "complete" || !record.machineCredential) denied();
  const native = await StoreNodeIssuer.prototype.openNative.call(issuer);
  try {
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    const host = await HostContext.initialize(native, "0.1.0", 1),
      ready = await readStoreRoleReadiness(host, issuer, signal);
    if (!ready) denied();
    const identity = await readBoundRuntime(
      host,
      record,
      ready,
      async () => {
        StoreNodeIssuer.prototype.assertNative.call(issuer, native);
        return (await StoreNodeIssuer.prototype.codeView.call(issuer)).binding;
      },
      signal,
    );
    StoreNodeIssuer.prototype.assertNative.call(issuer, native);
    signal.throwIfAborted();
    return identity;
  } finally {
    // An unconfirmed close propagates; the SDK retains the original owner.
    await native.close();
  }
}
/** GUI recovery/Advanced read through the existing genuine data/code owner. */
export async function readStoreFleetRuntimeIdentityForGui(
  host: HostContext,
  operations: StorePreparationOperations,
  record: FleetEnrollmentRecord,
  signal: AbortSignal,
) {
  if (arguments.length !== 4) denied();
  StorePreparationOperations.prototype.assertHost.call(operations, host);
  const ready =
      await StorePreparationOperations.prototype.snapshotStoreReady.call(
        operations,
        signal,
      ),
    identity = await readBoundRuntime(
      host,
      record,
      ready,
      async () => {
        StorePreparationOperations.prototype.assertHost.call(operations, host);
        return (
          await StorePreparationOperations.prototype.mediaCodeView.call(
            operations,
            signal,
          )
        ).binding;
      },
      signal,
    );
  StorePreparationOperations.prototype.assertHost.call(operations, host);
  return identity;
}
/** Trusted selection observations for an already-held Prepare owner. */
export async function readStoreApprovedFleetGpuSelection(
  host: HostContext,
  operations: StorePreparationOperations,
  record: FleetEnrollmentRecord,
  signal: AbortSignal,
): Promise<TrustedPreparationGpuSelection> {
  if (arguments.length !== 4) denied();
  StorePreparationOperations.prototype.assertHost.call(operations, host);
  const snapshot = parseFleetRecord(record, host.identity.sid);
  if (snapshot.phase !== "complete" || !snapshot.machineCredential) denied();
  const view = await StorePreparationOperations.prototype.mediaCodeView.call(
      operations,
      signal,
    ),
    bytes = await host.native.vaultRead("fleet", STORE_ACTIVE_RUNTIME_KEY);
  let acceptedBoot = snapshot.prepared.bootIdentity,
    approvedGpu = snapshot.prepared.gpu;
  if (bytes)
    try {
      const active = parseStoreFleetActiveProof(decode(bytes), snapshot),
        evidence = parseQualificationEvidence(active.qualification, {
          runtimeProfile: "windows-user",
          expectedUserSid: snapshot.sid,
          expectedFixtureDigest: snapshot.prepared.fixtureDigest,
        });
      if (
        active.version === 2 &&
        (await readApprovedLegacyFleetQualification(host, snapshot)).sha256 !==
          active.approvalQualificationSha256
      )
        denied();
      acceptedBoot = active.storeBinding.bootIdentity;
      approvedGpu = evidence.gpuIdentity!;
    } finally {
      bytes.fill(0);
    }
  else if (snapshot.prepared.distribution !== "microsoft-store") denied();
  if (
    !isDeepStrictEqual(
      (
        await StorePreparationOperations.prototype.mediaCodeView.call(
          operations,
          signal,
        )
      ).binding,
      view.binding,
    ) ||
    (await host.native.bootIdentity()) !== view.binding.bootIdentity ||
    !isDeepStrictEqual(record, snapshot)
  )
    denied();
  StorePreparationOperations.prototype.assertHost.call(operations, host);
  return {
    approvedGpu: structuredClone(approvedGpu),
    expectedBootIdentity: view.binding.bootIdentity,
    allowLuidRebind: acceptedBoot !== view.binding.bootIdentity,
  };
}
export type StoreFleetRuntimeIdentity = Awaited<
  ReturnType<typeof readStoreFleetRuntimeIdentity>
>;
