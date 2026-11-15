import { StoreFleetChildContext } from "../main/session/store-fleet-child-context.js";
import { StoreNodeIssuer } from "../main/session/store-node-issuer.js";
import { createStoreFleetWorkerRuntime } from "../main/fleet/store-worker-runtime.js";
import { StoreFleetTransfers } from "../main/fleet/store-transfers.js";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { ConsumerOwnedProcess } from "../../../worker/src/platform/windows/consumer-native.js";
import { verifyWindowsRelease } from "../../../worker/src/platform/windows/release-manifest.js";
import {
  resolveQualifiedGpuIdentity,
  parseQualificationEvidence,
  parseDirectmlGpuIdentity,
  type DirectmlGpuIdentity,
} from "../../../worker/src/enrollment/report-builder.js";
import type { WorkerRuntime } from "../../../worker/src/runtime/worker-runtime.js";
import type { PersonalAdmission } from "../../../worker/src/runtime/personal-admission.js";
import {
  WorkerControlPlaneClient,
  ControlPlaneError,
} from "../../../worker/src/runtime/control-plane-client.js";
import {
  initializeLocalLifecycle,
  loadLocalLifecycle,
  setLocalLifecycleIntent,
} from "../../../worker/src/runtime/local-lifecycle.js";
import { loadLocalRuntimeStatus } from "../../../worker/src/runtime/local-runtime-status.js";
import { MODEL } from "../../../chrome-extension/src/shared/local-model.js";
import type {
  SessionChildContext,
  SessionRuntimeContext,
  SessionControlTicket,
} from "../main/session/context.js";
import type { FleetSessionPort } from "../main/session/supervisor.js";
import {
  VaultFleetStore,
  type FleetEnrollmentRecord,
} from "../main/fleet/store.js";
import {
  parseFleetChildCommand,
  sendFleetCommand,
  requestFleetCommand,
  type FleetChildCommand,
  type FleetChildReply,
  safeFleetChannelError,
} from "../main/fleet/channel.js";
import { publishFleetChildConfiguration } from "../main/fleet/configuration.js";
import { openSessionChildContext } from "../main/session/bootstrap.js";
import {
  FleetRoleControl,
  type FleetRoleControlOptions,
} from "../main/fleet/role-control.js";
import { FleetInferenceTracker } from "../main/fleet/inference.js";
import { FleetRuntimeControl } from "../main/fleet/runtime-control.js";
import {
  consumerCapacityIdentity,
  consumerFleetRuntimeSlots,
} from "../main/fleet/advanced/capacity.js";
import { consumerFleetRemoved } from "../main/fleet/advanced/removal-marker.js";
import { HostContext } from "../main/host-context.js";
import { readPrivateBytes } from "../main/prepare/private-files.js";
import { readActiveFleetIdentity } from "../main/fleet/active-runtime.js";
const execute = promisify(execFile);
const fleetInference = new WeakMap<WorkerRuntime, FleetInferenceTracker>();
const fleetGpuIdentities = new WeakMap<WorkerRuntime, DirectmlGpuIdentity>();
/** The control channel must use the same resolved GPU as the qualified runtime. */
export function createQualifiedFleetRoleControl(
  gpu: DirectmlGpuIdentity | undefined,
  options: Omit<FleetRoleControlOptions, "gpuLuid">,
): FleetRoleControl {
  if (!gpu) throw new Error("FLEET_GPU_INVALID");
  return new FleetRoleControl({ ...options, gpuLuid: gpu.luid });
}
/** Parent-side port only; launch and termination remain the session guardian's responsibility. */
export interface FleetSessionControlPort extends FleetSessionPort {
  command(
    owner: ConsumerOwnedProcess,
    request: Omit<FleetChildCommand, "version" | "requestId">,
    signal: AbortSignal,
  ): Promise<FleetChildReply["data"] | undefined>;
}
export function createFleetSessionPort(
  context: SessionRuntimeContext,
): FleetSessionControlPort {
  return {
    command: (owner, request, signal) =>
      requestFleetCommand(context, owner, request, signal),
    eligibility: async () => {
      const host = await context.native.identity(),
        record = await new VaultFleetStore(context.native, host.sid).read();
      if (
        !record ||
        !record.machineCredential ||
        record.phase !== "complete" ||
        (await consumerFleetRemoved(context.native, record))
      )
        return { enrolled: false, approved: false, prepared: false };
      let prepared = false;
      try {
        const active = await readActiveFleetIdentity(context.native, record);
        prepared = active.release === context.configuration.release;
      } catch {
        /* Unbound active runtime is never prepared. */
      }
      if (prepared) await publishFleetChildConfiguration(context);
      const control = new WorkerControlPlaneClient({
        baseUrl: record.backendOrigin,
        credential: record.machineCredential,
        maxAttempts: 1,
      });
      try {
        const status = await control.machineStatus();
        return {
          enrolled: true,
          approved: status.machineId === record.machineId,
          prepared,
        };
      } catch (error) {
        if (
          error instanceof ControlPlaneError &&
          (error.status === 401 ||
            error.status === 403 ||
            error.code === "WORKER_MACHINE_DELETED")
        )
          return { enrolled: true, approved: false, prepared };
        return {
          enrolled: true,
          approved: error instanceof ControlPlaneError && error.retryable,
          prepared,
        };
      }
    },
    reconcile: (owner, signal) =>
      sendFleetCommand(context, owner, { action: "reconcile" }, signal),
    setIntent: (owner, intent, signal) =>
      sendFleetCommand(context, owner, { action: "intent", intent }, signal),
    gracefulStop: (owner, signal) =>
      sendFleetCommand(context, owner, { action: "stop" }, signal),
    pauseForSleep: (owner, signal) =>
      sendFleetCommand(context, owner, { action: "sleep" }, signal),
  };
}
/** Fixed dynamic ESM paths retain shared guardian/transfer module-relative locations. */
const storeRuntimeTransfers = new WeakMap<WorkerRuntime, StoreFleetTransfers>();
export async function createFleetWorkerRuntime(
  context: SessionChildContext,
  record: FleetEnrollmentRecord,
  personalAdmission: PersonalAdmission,
): Promise<WorkerRuntime> {
  if (context.distribution === "microsoft-store") {
    if (!(context instanceof StoreFleetChildContext))
      throw new Error("FLEET_CONTEXT_INVALID");
    StoreFleetChildContext.prototype.assertAssociation.call(context);
    const created = await createStoreFleetWorkerRuntime(
      context,
      record,
      personalAdmission,
    );
    fleetInference.set(created.runtime, created.inference);
    fleetGpuIdentities.set(created.runtime, created.gpu);
    storeRuntimeTransfers.set(created.runtime, created.transfers);
    return created.runtime;
  }
  if (
    !personalAdmission ||
    ["start", "pending", "grant", "stop"].some(
      (k) =>
        typeof (personalAdmission as unknown as Record<string, unknown>)[k] !==
        "function",
    )
  )
    throw new Error("FLEET_ADMISSION_UNAVAILABLE");
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    context.role !== "fleet" ||
    !record.machineCredential ||
    record.phase !== "complete" ||
    record.sid !== context.ownerIdentity.sid
  )
    throw new Error("FLEET_CONTEXT_INVALID");
  if (await consumerFleetRemoved(context.native, record))
    throw new Error("FLEET_NOT_ENROLLED");
  const root = context.releaseRoot,
    relative = win32.relative(context.personalRoot, root);
  await context.native.validatePath("personal", relative, "directory");
  const manifest = await verifyWindowsRelease(root, "windows-user");
  for (const entry of manifest.entries)
    await context.native.validatePath(
      "personal",
      win32.join(relative, entry.path.replaceAll("/", "\\")),
      entry.kind,
    );
  const manifestSha = createHash("sha256")
    .update(await readFile(win32.join(root, "release-manifest.json")))
    .digest("hex");
  const active = await readActiveFleetIdentity(context.native, record, {
    release: win32.basename(root),
    manifestDigest: manifestSha,
    modelDigest: MODEL.sha256,
  });
  const qualificationRelative = `prepare\\approved\\qualification-${createHash("sha256").update(record.requests.report).digest("hex")}.json`;
  let qualificationRaw = active.qualification;
  if (qualificationRaw === null) {
    if (
      !active.qualificationPath ||
      win32.resolve(active.qualificationPath).toLowerCase() !==
        win32.join(context.personalRoot, qualificationRelative).toLowerCase()
    )
      throw new Error("FLEET_INTEGRITY_INVALID");
    await context.native.validatePath(
      "personal",
      qualificationRelative,
      "file",
    );
    const qualificationStat = await lstat(active.qualificationPath);
    if (
      !qualificationStat.isFile() ||
      qualificationStat.isSymbolicLink() ||
      qualificationStat.nlink !== 1 ||
      qualificationStat.size > 16384
    )
      throw new Error("FLEET_INTEGRITY_INVALID");
    qualificationRaw = JSON.parse(
      await readFile(active.qualificationPath, "utf8"),
    );
  }
  const qualification = parseQualificationEvidence(qualificationRaw, {
    runtimeProfile: "windows-user",
    expectedUserSid: record.sid,
    expectedFixtureDigest: active.fixtureDigest,
  });
  if (
    qualification.releaseManifestDigest !== active.manifestDigest ||
    qualification.modelDigest !== active.modelDigest ||
    (active.output !== null &&
      (qualification.uploadCandidate.resultDigest !== active.output.sha256 ||
        qualification.uploadCandidate.resultBytes !== active.output.bytes)) ||
    !qualification.gpuIdentity
  )
    throw new Error("FLEET_INTEGRITY_INVALID");
  resolveQualifiedGpuIdentity(active.gpu, [qualification.gpuIdentity]);
  const modelPath = win32.join(context.personalRoot, "models", MODEL.filename);
  await context.native.validatePath(
    "personal",
    `models\\${MODEL.filename}`,
    "file",
  );
  const modelStat = await lstat(modelPath);
  if (
    !modelStat.isFile() ||
    modelStat.isSymbolicLink() ||
    modelStat.nlink !== 1 ||
    modelStat.size !== MODEL.bytes
  )
    throw new Error("FLEET_INTEGRITY_INVALID");
  // The signed model digest is independently checked by the processing child before use.
  const current = await execute(
    win32.join(root, "runtime", "python", "python.exe"),
    [
      "-I",
      "-c",
      "import json,sys;sys.path.insert(0,sys.argv[1]);from musicmute_engine.windows_gpu import enumerate_adapters;print(json.dumps(enumerate_adapters()))",
      win32.join(root, "app", "engine"),
    ],
    {
      windowsHide: true,
      cwd: context.fleetRoot,
      timeout: 60000,
      maxBuffer: 65536,
    },
  );
  const adapters: unknown = JSON.parse(current.stdout);
  if (!Array.isArray(adapters) || adapters.length > 16)
    throw new Error("FLEET_GPU_INVALID");
  const resolvedGpu = resolveQualifiedGpuIdentity(
    active.gpu,
    adapters.map(parseDirectmlGpuIdentity),
  );
  const ordinal = resolvedGpu.deviceIndex;
  await context.native.ensurePrivateDirectory("fleet", "work");
  await context.native.ensurePrivateDirectory("fleet", "state");
  await context.native.ensurePrivateDirectory("fleet", "logs");
  const lifecyclePath = win32.join(
      context.fleetRoot,
      "state",
      "lifecycle.json",
    ),
    statusPath = win32.join(context.fleetRoot, "state", "runtime-status.json");
  try {
    await lstat(lifecyclePath);
    await context.native.validatePath("fleet", "state\\lifecycle.json", "file");
    await loadLocalLifecycle(lifecyclePath);
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    await context.native.validatePath(
      "fleet",
      "state\\lifecycle.json",
      "absent",
    );
    await initializeLocalLifecycle(lifecyclePath);
  }
  // Start closed until the parent acknowledges this exact owned child and saved intent.
  await setLocalLifecycleIntent(lifecyclePath, "paused");
  const moduleUrl = (fixed: string) =>
    pathToFileURL(win32.join(root, "app", "dist", "src", fixed)).href;
  const [
    { WorkerRuntime: Runtime },
    { MachineSupervisor },
    { IsolatedWorkerTransferClient },
    { WorkerHintClient },
  ] = await Promise.all([
    import(moduleUrl("runtime/worker-runtime.js")) as Promise<
      typeof import("../../../worker/src/runtime/worker-runtime.js")
    >,
    import(moduleUrl("agent/machine-supervisor.js")) as Promise<
      typeof import("../../../worker/src/agent/machine-supervisor.js")
    >,
    import(moduleUrl("runtime/isolated-transfers.js")) as Promise<
      typeof import("../../../worker/src/runtime/isolated-transfers.js")
    >,
    import(moduleUrl("runtime/worker-hint-client.js")) as Promise<
      typeof import("../../../worker/src/runtime/worker-hint-client.js")
    >,
  ]);
  const capability = record.prepared.report.capabilities[0]!;
  const privateHost = await HostContext.initialize(context.native, "0.1.0", 1);
  const capacity = await consumerFleetRuntimeSlots({
    native: context.native,
    record,
    identity: consumerCapacityIdentity({
      bootIdentity: active.bootIdentity,
      host: privateHost.identity,
      gpu: resolvedGpu,
      manifestDigest: manifestSha,
      modelDigest: MODEL.sha256,
      fixtureDigest: active.fixtureDigest,
    }),
    readReceipt: (relative) =>
      readPrivateBytes(privateHost, relative, 2 * 1024 ** 2),
  });
  const slots = capacity.workerIds.map((workerId, slotIndex) => ({
    workerId,
    gpuId: capability.gpuId,
    slotIndex,
    recipeIds: capability.recipeIds,
    provider: "directml" as const,
    directmlDeviceId: ordinal,
  }));
  const engineRoot = win32.join(root, "app", "engine"),
    bin = win32.join(root, "runtime", "bin"),
    modelCacheRoot = win32.join(context.personalRoot, "models");
  const supervisor = new MachineSupervisor(
    slots.map((slot) => ({
      workerId: slot.workerId,
      gpuId: slot.gpuId,
      child: {
        command: win32.join(root, "runtime", "python", "python.exe"),
        windowsJobObject: true,
        windowsEngineModuleRoot: engineRoot,
        args: [
          "-I",
          "-c",
          "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('musicmute_engine.child',run_name='__main__')",
          engineRoot,
          "--model-cache-root",
          modelCacheRoot,
          "--provider",
          "directml",
          "--directml-device-id",
          String(ordinal),
        ],
        cwd: engineRoot,
        env: { MUSICMUTE_PROVIDER: "directml" },
        trustedExecutableDirectory: bin,
        requestTimeoutMs: 7200000,
      },
    })),
    capacity.validatedMaxWorkersPerGpu,
  );
  const control = new WorkerControlPlaneClient({
    baseUrl: record.backendOrigin,
    credential: record.machineCredential,
  });
  const workRoot = win32.join(context.fleetRoot, "work");
  const inferenceIdle = () => context.native.inferenceIdle();
  const trackedSupervisor = new FleetInferenceTracker(
    supervisor,
    inferenceIdle,
  );
  await trackedSupervisor.initialize();
  const runtime = new Runtime(
    {
      machineId: record.machineId!,
      slots,
      validatedMaxWorkersPerGpu: capacity.validatedMaxWorkersPerGpu,
      workRoot,
      modelCacheRoot,
      ffmpegPath: win32.join(bin, "ffmpeg.exe"),
      ffprobePath: win32.join(bin, "ffprobe.exe"),
      localLifecyclePath: lifecyclePath,
      localRuntimeStatusPath: statusPath,
      personalAdmission,
      terminatedInferenceIdle: inferenceIdle,
      hintClientFactory: (onHint) => new WorkerHintClient(control, onHint),
    },
    control,
    new IsolatedWorkerTransferClient({ workRoot }),
    trackedSupervisor,
  );
  fleetInference.set(runtime, trackedSupervisor);
  fleetGpuIdentities.set(runtime, resolvedGpu);
  return runtime;
}
/** Owned child command server; no account tokens, credential files or CLI command input. */
export async function runFleetSessionChild(
  context: SessionChildContext,
  options: {
    personalAdmission: PersonalAdmission & {
      setPending(value: boolean): Promise<void> | void;
    };
  },
): Promise<void> {
  const storeMode = context.distribution === "microsoft-store";
  if (storeMode) {
    if (!(context instanceof StoreFleetChildContext))
      throw new Error("FLEET_CONTEXT_INVALID");
    StoreFleetChildContext.prototype.assertAssociation.call(context);
  }
  delete process.env.MUSICMUTE_OWNERSHIP_NONCE;
  delete process.env.MUSICMUTE_OWNERSHIP_ROLE;
  if (
    context.role !== "fleet" ||
    !/^[a-f0-9]{64}$/.test(context.ownershipNonce)
  )
    throw new Error("FLEET_CONTEXT_INVALID");
  const record = await new VaultFleetStore(
    context.native,
    context.ownerIdentity.sid,
  ).read();
  if (!record || record.phase !== "complete" || !record.machineCredential)
    throw new Error("FLEET_NOT_ENROLLED");
  let roleControl!: FleetRoleControl;
  const admission: PersonalAdmission = {
    start: async (wake) => {
      await options.personalAdmission.start(wake);
      if (!storeMode && !roleControl.guardHeld())
        throw new Error("FLEET_GPU_ADMISSION_REQUIRED");
    },
    pending: () =>
      !roleControl.guardHeld() || options.personalAdmission.pending(),
    grant: () => options.personalAdmission.grant(),
    stop: async () => {
      await roleControl.releaseAfterExit();
      await options.personalAdmission.stop();
    },
  };
  const runtime = await createFleetWorkerRuntime(context, record, admission),
    stopping = new AbortController();
  const lifecyclePath = win32.join(
      context.fleetRoot,
      "state",
      "lifecycle.json",
    ),
    statusPath = win32.join(context.fleetRoot, "state", "runtime-status.json");
  const owner: ConsumerOwnedProcess = {
    role: "fleet",
    nonce: context.ownershipNonce,
    identity: context.ownerIdentity,
  };
  let runtimeError: unknown,
    runtimeFailed = false,
    closed = false;
  const controller = new FleetRuntimeControl({
    processId: context.ownerIdentity.pid,
    runtime,
    setIntent: (intent) => setLocalLifecycleIntent(lifecyclePath, intent),
    status: async () => {
      await context.native.validatePath(
        "fleet",
        "state\\runtime-status.json",
        "file",
      );
      return loadLocalRuntimeStatus(statusPath);
    },
    closed: () => closed,
  });
  roleControl = createQualifiedFleetRoleControl(
    fleetGpuIdentities.get(runtime),
    {
      runtime: controller,
      idle: () => fleetInference.get(runtime)?.idle() === true,
      setPending: async (value) => {
        await options.personalAdmission.setPending(value);
        runtime.hintAvailableWork();
      },
      acquireGuard: async () => {
        const expected = fleetGpuIdentities.get(runtime);
        if (!expected) throw new Error("FLEET_GPU_INVALID");
        const selected = resolveQualifiedGpuIdentity(
          expected,
          await context.native.enumerateGpus(),
        );
        if (selected.deviceIndex !== expected.deviceIndex)
          throw new Error("FLEET_GPU_INVALID");
        return context.native.acquireGpuGuard(selected);
      },
      releaseGuard: (lease) => context.native.releaseGpuGuard(lease),
    },
  );
  const running = runtime
    .run(stopping.signal)
    .catch((error) => {
      runtimeFailed = true;
      runtimeError = error;
    })
    .finally(() => {
      closed = true;
      if (storeMode) stopping.abort();
    });
  const failures: unknown[] = [];
  try {
    if (storeMode) {
      if (!(context instanceof StoreFleetChildContext))
        throw new Error("FLEET_CONTEXT_INVALID");
      const issuer = context.storeIssuer;
      await StoreNodeIssuer.prototype.serveControl.call(
        issuer,
        {
          dispatch: async (payload, peer) => {
            if (
              !(await StoreNodeIssuer.prototype.verifyControlPeer.call(
                issuer,
                peer,
                "session-agent",
              ))
            )
              throw new Error("FLEET_CONTEXT_INVALID");
            let reply: FleetChildReply;
            try {
              reply = await roleControl.execute(
                parseFleetChildCommand(payload),
              );
            } catch (error) {
              let requestId = "";
              try {
                requestId = parseFleetChildCommand(payload).requestId;
              } catch {}
              reply = {
                version: 1,
                requestId,
                ok: false,
                code: safeFleetChannelError(error),
              };
            }
            return Buffer.from(JSON.stringify(reply));
          },
        },
        stopping.signal,
      );
    } else
      while (!closed && !stopping.signal.aborted) {
        const server = await context.openNative();
        try {
          const identity = await server.identity();
          if (
            identity.sid !== owner.identity.sid ||
            identity.sessionId !== owner.identity.sessionId
          )
            throw new Error("FLEET_CONTEXT_INVALID");
          const ticket: SessionControlTicket = {
            version: 1,
            owner,
            server: identity,
            channel: randomBytes(32).toString("hex"),
            nonce: randomBytes(32).toString("hex"),
            expiresAt: Date.now() + 30000,
          };
          await context.native.vaultWrite(
            "fleet",
            "fleet_ticket",
            Buffer.from(JSON.stringify(ticket)),
          );
          const accepted = await server.pipeAccept({
            channel: ticket.channel,
            nonce: ticket.nonce,
            peer: null,
            timeoutMs: 30000,
          });
          if (
            accepted.connection.peer.sid !== owner.identity.sid ||
            accepted.connection.peer.sessionId !== owner.identity.sessionId
          )
            throw new Error("FLEET_CONTEXT_INVALID");
          let reply: FleetChildReply;
          try {
            const command = parseFleetChildCommand(accepted.payload);
            reply = await roleControl.execute(command);
          } catch (error) {
            let requestId = "";
            try {
              requestId = parseFleetChildCommand(accepted.payload).requestId;
            } catch {
              /* No untrusted text is reflected. */
            }
            reply = {
              version: 1,
              requestId,
              ok: false,
              code: safeFleetChannelError(error),
            };
          }
          await server.pipeReply(
            accepted.connection,
            Buffer.from(JSON.stringify(reply)),
          );
        } catch (error) {
          if (closed || stopping.signal.aborted) break;
          if (
            error instanceof Error &&
            error.message === "FLEET_CONTEXT_INVALID"
          )
            throw error;
        } finally {
          await server.close();
        }
      }
  } catch (error) {
    failures.push(error);
  } finally {
    stopping.abort();
    const transfers = storeRuntimeTransfers.get(runtime);
    const retirements = await Promise.allSettled([
      Promise.resolve().then(() => runtime.stop()),
      ...(transfers
        ? [
            Promise.resolve().then(() =>
              StoreFleetTransfers.prototype.close.call(transfers),
            ),
          ]
        : []),
    ]);
    await running;
    for (const result of retirements)
      if (result.status === "rejected") failures.push(result.reason);
  }
  if (runtimeFailed) failures.push(runtimeError);
  if (failures.length > 1)
    throw new AggregateError(failures, "CHILD_SHUTDOWN_PENDING");
  if (failures.length) throw failures[0];
}

export async function runFleetChildEntry(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (argv.length === 1 && argv[0] === "--store-session") {
    const context = await StoreFleetChildContext.open();
    let failed = false,
      original: unknown;
    try {
      const { createFleetPersonalAdmission } =
        await import("../main/admission/session-admission.js");
      await runFleetSessionChild(context, {
        personalAdmission: createFleetPersonalAdmission(context),
      });
    } catch (error) {
      failed = true;
      original = error;
    }
    try {
      await StoreFleetChildContext.prototype.close.call(context);
    } catch (cleanup) {
      if (failed)
        throw new AggregateError([original, cleanup], "CHILD_SHUTDOWN_PENDING");
      throw cleanup;
    }
    if (failed) throw original;
    return;
  }
  if (argv.length !== 2 || argv[0] !== "--consumer-config" || !argv[1])
    throw new Error("FLEET_CONTEXT_INVALID");
  const context = await openSessionChildContext(argv[1], "fleet");
  let failed = false,
    original: unknown;
  try {
    const { createFleetPersonalAdmission } =
      await import("../main/admission/session-admission.js");
    await runFleetSessionChild(context, {
      personalAdmission: createFleetPersonalAdmission(context),
    });
  } catch (error) {
    failed = true;
    original = error;
  }
  try {
    await context.native.close();
  } catch (cleanup) {
    if (failed)
      throw new AggregateError([original, cleanup], "CHILD_SHUTDOWN_PENDING");
    throw cleanup;
  }
  if (failed) throw original;
}
if (typeof require !== "undefined" && require.main === module) {
  runFleetChildEntry().catch(() => {
    process.exitCode = 1;
  });
}
