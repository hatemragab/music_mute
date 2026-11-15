import { PACKAGE_DATA_ROOT_NAMES } from "../../shared/package-build-profile.js";
import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import {
  resolveQualifiedGpuIdentity,
  type DirectmlGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import { WorkerControlPlaneClient } from "../../../../worker/src/runtime/control-plane-client.js";
import {
  initializeLocalLifecycle,
  loadLocalLifecycle,
  setLocalLifecycleIntent,
} from "../../../../worker/src/runtime/local-lifecycle.js";
import type { PersonalAdmission } from "../../../../worker/src/runtime/personal-admission.js";
import { WorkerHintClient } from "../../../../worker/src/runtime/worker-hint-client.js";
import { WorkerRuntime } from "../../../../worker/src/runtime/worker-runtime.js";
import { readCurrentFleetGpu } from "../admission/current-gpu.js";
import { readPrivateBytes } from "../prepare/private-files.js";
import { StoreFleetChildContext } from "../session/store-fleet-child-context.js";
import { StoreNodeIssuer } from "../session/store-node-issuer.js";
import {
  consumerCapacityIdentity,
  consumerFleetRuntimeSlots,
} from "./advanced/capacity.js";
import { consumerFleetRemoved } from "./advanced/removal-marker.js";
import { FleetInferenceTracker } from "./inference.js";
import { readStoreFleetRuntimeIdentity } from "./store-active-runtime.js";
import { StoreFleetMachineSupervisor } from "./store-machine-supervisor.js";
import { StoreFleetTransfers } from "./store-transfers.js";
import {
  parseFleetRecord,
  VaultFleetStore,
  type FleetEnrollmentRecord,
} from "./store.js";
import { StoreFleetWorkspace } from "./store-workspace.js";

export interface StoreFleetWorkerRuntime {
  readonly runtime: WorkerRuntime;
  readonly inference: FleetInferenceTracker;
  readonly gpu: DirectmlGpuIdentity;
  /** The fixed agent retains this actual owner and joins it before retiring
   * its Context; WorkerRuntime.stop does not close a transfer client itself. */
  readonly transfers: StoreFleetTransfers;
}
function denied(): never {
  throw new Error("FLEET_CONTEXT_INVALID");
}
function admissionMethods(admission: PersonalAdmission): PersonalAdmission {
  if (!admission || typeof admission !== "object")
    throw new Error("FLEET_ADMISSION_UNAVAILABLE");
  function method<K extends keyof PersonalAdmission>(
    name: K,
  ): PersonalAdmission[K] {
    const descriptor = Object.getOwnPropertyDescriptor(admission, name);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    )
      throw new Error("FLEET_ADMISSION_UNAVAILABLE");
    return descriptor.value as PersonalAdmission[K];
  }
  const start = method("start"),
    pending = method("pending"),
    grant = method("grant"),
    stop = method("stop");
  return Object.freeze({
    start: (wake: () => void) => Reflect.apply(start, admission, [wake]),
    pending: () => Reflect.apply(pending, admission, []),
    grant: () => Reflect.apply(grant, admission, []),
    stop: () => Reflect.apply(stop, admission, []),
  });
}

/** The fixed Fleet entry composes its own genuine Store actors in one module
 * graph. Enrollment/capacity observations never select a legacy executable,
 * isolated fork, CPU provider or writable runtime release. */
export async function createStoreFleetWorkerRuntime(
  context: StoreFleetChildContext,
  record: FleetEnrollmentRecord,
  personalAdmission: PersonalAdmission,
): Promise<StoreFleetWorkerRuntime> {
  if (
    arguments.length !== 3 ||
    process.platform !== "win32" ||
    process.arch !== "x64"
  )
    denied();
  StoreFleetChildContext.prototype.assertAssociation.call(context);
  const captured = parseFleetRecord(record, context.ownerIdentity.sid),
    admission = admissionMethods(personalAdmission),
    initial =
      await StoreFleetChildContext.prototype.assertCurrent.call(context),
    host = context.host,
    native = context.native,
    issuer = context.storeIssuer,
    binding = initial.binding;
  StoreNodeIssuer.prototype.assertNative.call(issuer, native);
  const identity = await native.identity();
  if (
    context.role !== "fleet" ||
    host.native !== native ||
    captured.phase !== "complete" ||
    !captured.machineCredential ||
    !captured.machineId ||
    identity.sid !== captured.sid ||
    identity.nativeArch !== "x64" ||
    identity.processArch !== "x64" ||
    identity.osMajor !== 10 ||
    identity.osBuild < 19045 ||
    identity.sessionId !== context.ownerIdentity.sessionId ||
    host.identity.sid !== identity.sid ||
    host.identity.sessionId !== identity.sessionId ||
    context.personalRoot !==
      win32.join(identity.localAppData, PACKAGE_DATA_ROOT_NAMES.personal) ||
    context.fleetRoot !==
      win32.join(identity.localAppData, PACKAGE_DATA_ROOT_NAMES.fleet) ||
    context.releaseRoot !== issuer.workerRoot ||
    issuer.inventorySha256 !== binding.inventorySha256 ||
    binding.sid !== identity.sid
  )
    denied();
  const store = new VaultFleetStore(
      native,
      captured.sid,
      captured.backendOrigin,
    ),
    signal = new AbortController().signal;
  const current = async () => {
    const view =
      await StoreFleetChildContext.prototype.assertCurrent.call(context);
    if (
      !isDeepStrictEqual(view.binding, binding) ||
      !isDeepStrictEqual(await store.read(), captured) ||
      (await consumerFleetRemoved(native, captured)) ||
      (await native.bootIdentity()) !== binding.bootIdentity
    )
      denied();
  };
  await current();
  const active = await readStoreFleetRuntimeIdentity(issuer, captured, signal),
    gpu = resolveQualifiedGpuIdentity(active.gpu, [
      await readCurrentFleetGpu(native, binding.inventorySha256, issuer),
    ]);
  if (
    active.release !== binding.inventorySha256 ||
    active.manifestDigest !== binding.runtimeManifestSha256 ||
    active.modelDigest !== MODEL.sha256 ||
    active.bootIdentity !== binding.bootIdentity ||
    !isDeepStrictEqual(active.storeBinding, binding)
  )
    denied();
  await current();
  const capacity = await consumerFleetRuntimeSlots({
    native,
    record: captured,
    identity: consumerCapacityIdentity({
      bootIdentity: active.bootIdentity,
      host: identity,
      gpu,
      manifestDigest: binding.runtimeManifestSha256,
      modelDigest: MODEL.sha256,
      fixtureDigest: active.fixtureDigest,
    }),
    readReceipt: (relative) => readPrivateBytes(host, relative, 2 * 1024 ** 2),
  });
  const capability = captured.prepared.report.capabilities[0];
  if (
    !capability ||
    capability.provider !== "directml" ||
    capability.platform !== "windows-amd64"
  )
    denied();
  const slots = capacity.workerIds.map((workerId, slotIndex) => ({
    workerId,
    gpuId: capability.gpuId,
    slotIndex,
    recipeIds: Object.freeze([...capability.recipeIds]),
    provider: "directml" as const,
    directmlDeviceId: gpu.deviceIndex,
  }));
  await current();
  for (const relative of ["work", "state", "logs"])
    if (
      (await native.ensurePrivateDirectory("fleet", relative)) !==
      win32.join(context.fleetRoot, relative)
    )
      denied();
  const lifecyclePath = win32.join(
      context.fleetRoot,
      "state",
      "lifecycle.json",
    ),
    statusPath = win32.join(context.fleetRoot, "state", "runtime-status.json");
  try {
    await lstat(lifecyclePath);
    await native.validatePath("fleet", "state\\lifecycle.json", "file");
    await loadLocalLifecycle(lifecyclePath);
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    await native.validatePath("fleet", "state\\lifecycle.json", "absent");
    await initializeLocalLifecycle(lifecyclePath);
  }
  await current();
  // Parent control must acknowledge this exact owner and its saved intent
  // before the existing runtime may accept a claim.
  await setLocalLifecycleIntent(lifecyclePath, "paused");
  await current();
  let supervisor: StoreFleetMachineSupervisor | undefined,
    transfers: StoreFleetTransfers | undefined;
  try {
    supervisor = await StoreFleetMachineSupervisor.open(
      host,
      issuer,
      slots.map(({ workerId, gpuId }) => ({ workerId, gpuId })),
      capacity.validatedMaxWorkersPerGpu,
      gpu,
    );
    transfers = await StoreFleetTransfers.open(host, issuer);
    const workspace = await StoreFleetWorkspace.open(host, issuer),
      inferenceIdle = () => native.inferenceIdle(),
      inference = new FleetInferenceTracker(supervisor, inferenceIdle);
    await inference.initialize();
    await current();
    const control = new WorkerControlPlaneClient({
        baseUrl: captured.backendOrigin,
        credential: captured.machineCredential,
      }),
      bin = win32.join(issuer.workerRoot, "runtime", "bin"),
      runtime = new WorkerRuntime(
        {
          machineId: captured.machineId,
          slots,
          validatedMaxWorkersPerGpu: capacity.validatedMaxWorkersPerGpu,
          workRoot: win32.join(context.fleetRoot, "work"),
          modelCacheRoot: win32.join(context.personalRoot, "models"),
          ffmpegPath: win32.join(bin, "ffmpeg.exe"),
          ffprobePath: win32.join(bin, "ffprobe.exe"),
          localLifecyclePath: lifecyclePath,
          localRuntimeStatusPath: statusPath,
          personalAdmission: admission,
          terminatedInferenceIdle: inferenceIdle,
          workspace,
          hintClientFactory: (onHint) => new WorkerHintClient(control, onHint),
        },
        control,
        transfers,
        inference,
      );
    await current();
    return Object.freeze({
      runtime,
      inference,
      gpu: Object.freeze({ ...gpu }),
      transfers,
    });
  } catch (error) {
    const cleanup = await Promise.allSettled([
        ...(supervisor
          ? [
              Promise.resolve().then(() =>
                StoreFleetMachineSupervisor.prototype.stop.call(supervisor!),
              ),
            ]
          : []),
        ...(transfers
          ? [
              Promise.resolve().then(() =>
                StoreFleetTransfers.prototype.close.call(transfers!),
              ),
            ]
          : []),
      ]),
      failures = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      );
    if (failures.length)
      throw new AggregateError([error, ...failures], "CHILD_SHUTDOWN_PENDING");
    throw error;
  }
}
