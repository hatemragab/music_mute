import { createHash, randomUUID } from "node:crypto";
import { lstat, statfs } from "node:fs/promises";
import type { PrivateWritable } from "../../../../../worker/src/platform/windows/consumer-private-file.js";
import { win32 } from "node:path";
import { WorkerControlPlaneClient } from "../../../../../worker/src/runtime/control-plane-client.js";
import {
  processIdentityFromWire,
  processIdentityToWire,
  type WindowsConsumerNative,
} from "../../../../../worker/src/platform/windows/consumer-native.js";
import { resolveQualifiedGpuIdentity } from "../../../../../worker/src/enrollment/report-builder.js";
import type { FileCapabilities } from "../../file-capabilities.js";
import type { HostContext } from "../../host-context.js";
import type { WindowsPreparationOperations } from "../../prepare/operations.js";
import {
  newPrivateFile,
  readPrivateBytes,
  writePrivateAtomic,
} from "../../prepare/private-files.js";
import type { SessionClient } from "../../session/control.js";
import { createSessionMaintenancePort } from "../../session/maintenance.js";
import { createSessionForcePort } from "../../session/force.js";
import type { FleetAdvancedUpdates } from "../../update/advanced-dispatch.js";
import {
  storageBirth,
  type StorageBirth,
} from "../../storage/write-journal.js";
import {
  VaultFleetStore,
  fleetRecordAuthority,
  type FleetEnrollmentRecord,
  parseFleetPurgedTombstone,
} from "../store.js";
import {
  createFleetPrivateFiles,
  WindowsFleetInspection,
} from "./inspection.js";
import {
  WindowsAdvancedBenchmarkRunner,
  type BenchmarkOwnershipJournal,
} from "./benchmark-runner.js";
import {
  WindowsFleetAdvancedController,
  AdvancedForceReviewStale,
  parseAdvancedJournal,
  sameAdvancedIdentity,
  type AdvancedIdentity,
  type AdvancedJournal,
  type AdvancedConfirmationResources,
} from "./controller.js";
import {
  createConsumerFleetCapacityReceipt,
  consumerCapacityIdentity,
  parseConsumerFleetCapacity,
  readConsumerFleetCapacity,
  validateConsumerCapacityReceipt,
} from "./capacity.js";
import { readActiveFleetIdentity } from "../active-runtime.js";
import {
  applyFleetRemoval,
  clearConsumerFleetLogs,
  inspectFleetRemoval,
} from "./files.js";
import { createFleetDiagnosticArchive } from "./archive.js";
import { consumerFleetRemoved } from "./removal-marker.js";
import type { FleetAdvancedMutation } from "../../../shared/fleet-advanced-contracts.js";
import { verifyAdvancedCandidate } from "./candidate.js";
import {
  readAdvancedBaseline,
  openAdvancedExport,
  type AdvancedBenchmarkExports,
  type AdvancedBenchmarkDestination,
  type AdvancedExportEntry,
} from "./benchmark-exports.js";
import {
  compareBenchmarkReports,
  type RepeatedBenchmarkReport,
} from "../../../../../worker/src/platform/shared/file-benchmark.js";
import { purgeFleetQualificationArtifacts } from "./purge.js";
import { StoreFleetAdvancedRuntime } from "./store-runtime.js";
export interface WindowsFleetAdvancedOptions {
  host: HostContext;
  native: Pick<WindowsConsumerNative, "isOwnedProcess">;
  operations: Pick<
    WindowsPreparationOperations,
    "snapshotReady" | "snapshotReadyStatus"
  >;
  session: Pick<SessionClient, "command">;
  files: FileCapabilities;
  fileOwner: string | (() => string);
  storage: {
    protectTree(
      relative: string,
      purpose: "processing",
      planned: true,
    ): Promise<{ release(): Promise<void> }>;
    beginWrite(
      relative: string,
      kind: "tree",
    ): Promise<{
      captureCreated(birth: StorageBirth): Promise<void>;
      settle(): Promise<void>;
      handoff(): Promise<void>;
    }>;
    trackWorkspace(
      relative: string,
      owner: import("../../../../../worker/src/platform/windows/consumer-native.js").ConsumerOwnedProcess,
      purpose: "processing",
    ): Promise<{ release(): Promise<void> }>;
  };
  /** Root binds its trusted native destination registry; bytes are a real sanitized ZIP. */
  exportArchive(
    capability: string,
    archive: Buffer,
    filename: string,
    signal: AbortSignal,
  ): Promise<void>;
  updates?: FleetAdvancedUpdates;
  benchmarkExports?: AdvancedBenchmarkExports;
  onChanged?: () => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
}
type SharedOptions = Omit<
  WindowsFleetAdvancedOptions,
  "native" | "operations"
> &
  (
    | {
        native: WindowsFleetAdvancedOptions["native"];
        operations: WindowsFleetAdvancedOptions["operations"];
        storeRuntime?: never;
      }
    | {
        storeRuntime: StoreFleetAdvancedRuntime;
        native?: never;
        operations?: never;
      }
  );
/** Existing Legacy entry; its operations and runtime launcher are unchanged. */
export function createWindowsFleetAdvanced(
  options: WindowsFleetAdvancedOptions,
) {
  return createFleetAdvancedBusiness(options);
}
/** Shared business strategy. Store callers must supply the real private
 * Store factory; no receiving DTO or Legacy operations adapter grants rights. */
export async function createFleetAdvancedBusiness(options: SharedOptions) {
  const storeRuntime = options.storeRuntime,
    legacyOperations = options.operations;
  if (storeRuntime) {
    if (legacyOperations || options.native)
      throw new Error("STORE_FLEET_ADVANCED_REQUIRED");
    StoreFleetAdvancedRuntime.prototype.assertHost.call(
      storeRuntime,
      options.host,
    );
  } else if (
    options.host.storeAuthority ||
    !legacyOperations ||
    !options.native
  )
    throw new Error("STORE_FLEET_ADVANCED_REQUIRED");
  const legacyReady = (signal: AbortSignal) => {
    if (!legacyOperations) throw new Error("STORE_FLEET_ADVANCED_REQUIRED");
    return legacyOperations.snapshotReady(signal);
  };
  const currentReady = (signal: AbortSignal, status = false) => {
    if (storeRuntime)
      return StoreFleetAdvancedRuntime.prototype.ready.call(
        storeRuntime,
        signal,
      );
    if (!legacyOperations) throw new Error("STORE_FLEET_ADVANCED_REQUIRED");
    return status
      ? legacyOperations.snapshotReadyStatus(signal)
      : legacyOperations.snapshotReady(signal);
  };
  const currentActive = async (
    record: FleetEnrollmentRecord,
    signal: AbortSignal,
    ready: Awaited<ReturnType<typeof currentReady>>,
  ) => {
    if (storeRuntime)
      return StoreFleetAdvancedRuntime.prototype.active.call(
        storeRuntime,
        record,
        signal,
      );
    if (ready.archiveSha256 === null)
      throw new Error("STORE_FLEET_ADVANCED_REQUIRED");
    return readActiveFleetIdentity(options.host.native, record, {
      release: ready.release,
      manifestDigest: ready.manifestSha256,
      archiveDigest: ready.archiveSha256,
      modelDigest: ready.modelSha256,
    });
  };
  const { host } = options,
    fleetRoot = await host.native.ensurePrivateDirectory("fleet"),
    store = new VaultFleetStore(host.native, host.identity.sid);
  const files = createFleetPrivateFiles(host.native, fleetRoot),
    maintenance = storeRuntime
      ? StoreFleetAdvancedRuntime.prototype.maintenancePort.call(storeRuntime)
      : createSessionMaintenancePort(options.session);
  const now = () => options.now?.() ?? Date.now();
  const benchmarkResources = new WeakMap<
    AdvancedConfirmationResources,
    {
      identity: string;
      mutation: string;
      baseline: RepeatedBenchmarkReport | null;
      destinations: Partial<
        Record<"audio" | "report", AdvancedBenchmarkDestination>
      >;
    }
  >();
  const confirmationResources = new Set<AdvancedConfirmationResources>(),
    unreturnedResources = new Set<AdvancedConfirmationResources>();
  const releaseUnreturnedResources = async () => {
    const results = await Promise.allSettled(
      [...unreturnedResources].map((resource) => resource.release()),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  const prepareConfirmation = async (
    mutation: FleetAdvancedMutation,
    expected: AdvancedIdentity,
    signal: AbortSignal,
  ): Promise<AdvancedConfirmationResources> => {
    // An earlier partial construction never reached the controller. Retain
    // and retire only that original owner before claiming more destinations.
    await releaseUnreturnedResources();
    const destinations: Partial<
      Record<"audio" | "report", AdvancedBenchmarkDestination>
    > = {};
    let released = false,
      releasing: Promise<void> | undefined,
      originalRelease: Promise<void> | undefined;
    const resource: AdvancedConfirmationResources = {
      release: () => {
        if (released) return Promise.resolve();
        if (releasing) return releasing;
        const attempt = Promise.resolve().then(async () => {
          const result = await Promise.allSettled(
            Object.entries(destinations).map(async ([kind, destination]) => {
              await destination.release();
              const key = kind as "audio" | "report";
              if (destinations[key] === destination) delete destinations[key];
            }),
          );
          const failed = result.find((entry) => entry.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
          released = true;
          confirmationResources.delete(resource);
          unreturnedResources.delete(resource);
        });
        originalRelease ??= attempt;
        releasing = attempt;
        void attempt.catch(() => {
          if (releasing === attempt) releasing = undefined;
        });
        return attempt;
      },
    };
    // Destination claims may have effects before confirmation construction
    // can return. Keep their exact resource reachable through failed cleanup.
    confirmationResources.add(resource);
    try {
      if ("force" in mutation && mutation.force === true) {
        const current = await options.session.command(
          { version: 1, request_id: randomUUID(), action: "status" },
          signal,
        );
        if (
          !Number.isSafeInteger(current.revision) ||
          current.revision < 1 ||
          current.maintenance
        )
          throw new Error("ADVANCED_BUSY");
        resource.forceRevision = current.revision;
      }
      let baseline: RepeatedBenchmarkReport | null = null;
      if (mutation.action === "benchmark_file") {
        for (const kind of ["audio", "report"] as const) {
          const capability =
            kind === "audio"
              ? mutation.audioDestinationCapability
              : mutation.reportDestinationCapability;
          if (capability) {
            if (!options.benchmarkExports)
              throw new Error("ADVANCED_EXPORT_UNAVAILABLE");
            destinations[kind] = await options.benchmarkExports.claim(
              capability,
              kind,
              signal,
            );
          }
        }
        if (mutation.baselineCapability)
          baseline = await readAdvancedBaseline(
            options.files,
            mutation.baselineCapability,
            typeof options.fileOwner === "function"
              ? options.fileOwner()
              : options.fileOwner,
            host.identity.sid,
            signal,
          );
      }
      benchmarkResources.set(resource, {
        identity: expected.digest,
        mutation: JSON.stringify(mutation),
        baseline,
        destinations,
      });
      return resource;
    } catch (error) {
      try {
        await resource.release();
      } catch (cleanupError) {
        unreturnedResources.add(resource);
        throw new AggregateError(
          [error, cleanupError],
          "ADVANCED_CONFIRMATION_CLEANUP_PENDING",
        );
      }
      throw error;
    }
  };
  const record = async (): Promise<FleetEnrollmentRecord> => {
    const r = await store.read();
    if (!r || !r.machineId || !["complete", "revoked"].includes(r.phase))
      throw new Error("FLEET_NOT_ENROLLED");
    return r;
  };
  const identity = async (): Promise<AdvancedIdentity> => {
    const r = await store.read();
    if (!r) {
      const tombstone = await store.readPurgedTombstone();
      if (!tombstone) throw new Error("FLEET_NOT_ENROLLED");
      return {
        sid: tombstone.sid,
        machineId: tombstone.machineId,
        revision: tombstone.onboardingRevision,
        digest: tombstone.authority,
      };
    }
    if (!r.machineId || !["complete", "revoked"].includes(r.phase))
      throw new Error("FLEET_NOT_ENROLLED");
    return {
      sid: r.sid,
      machineId: r.machineId!,
      revision: r.onboardingRevision,
      digest: fleetRecordAuthority(r),
    };
  };
  const ownedAuthority = async <T>(
    expected: AdvancedIdentity,
    action: () => Promise<T>,
  ): Promise<T> => {
    const lease = await host.native.acquireMutex("cache");
    if (!lease) throw new Error("FLEET_BUSY");
    try {
      if (!sameAdvancedIdentity(await identity(), expected))
        throw new Error("ADVANCED_MACHINE_CHANGED");
      return await action();
    } finally {
      await host.native.releaseMutex(lease);
    }
  };
  const owned = async <T>(
    expected: AdvancedIdentity,
    action: (r: FleetEnrollmentRecord) => Promise<T>,
  ): Promise<T> => {
    const lease = await host.native.acquireMutex("cache");
    if (!lease) throw new Error("FLEET_BUSY");
    try {
      const r = await record();
      if (
        !sameAdvancedIdentity(
          {
            sid: r.sid,
            machineId: r.machineId!,
            revision: r.onboardingRevision,
            digest: fleetRecordAuthority(r),
          },
          expected,
        )
      )
        throw new Error("ADVANCED_MACHINE_CHANGED");
      return await action(r);
    } finally {
      await host.native.releaseMutex(lease);
    }
  };
  const vaultRead = async (key: string): Promise<unknown | null> => {
    const bytes = await host.native.vaultRead("fleet", key);
    if (!bytes) return null;
    if (bytes.length > 16384) throw new Error("ADVANCED_JOURNAL_INVALID");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  };
  const vaultWrite = async (key: string, value: unknown): Promise<void> => {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 16384) throw new Error("ADVANCED_JOURNAL_INVALID");
    await host.native.vaultWrite("fleet", key, bytes);
  };
  const journal = {
    read: async (): Promise<AdvancedJournal | null> => {
      const raw = await vaultRead("advanced_journal");
      return raw === null ? null : parseAdvancedJournal(raw);
    },
    write: async (value: AdvancedJournal): Promise<void> =>
      ownedAuthority(value.identity, () =>
        vaultWrite("advanced_journal", parseAdvancedJournal(value)),
      ),
  };
  const ownership = {
    read: async (): Promise<BenchmarkOwnershipJournal | null> => {
      const raw = await vaultRead("benchmark_owner");
      if (raw === null) return null;
      const v = raw as BenchmarkOwnershipJournal;
      if (
        !v ||
        typeof v !== "object" ||
        Object.keys(v).sort().join() !==
          "owner,phase,release,requestId,transaction,version" ||
        v.version !== 1 ||
        !/^[a-f0-9-]{36}$/u.test(v.transaction) ||
        !/^[a-f0-9-]{36}$/u.test(v.requestId) ||
        !/^[a-f0-9]{64}$/u.test(v.release) ||
        !["staging", "launching", "owned", "exited"].includes(v.phase) ||
        (!["staging", "launching"].includes(v.phase) && !v.owner)
      )
        throw new Error("ADVANCED_JOURNAL_INVALID");
      if (v.owner) {
        if (
          v.owner.role !== "prepare" ||
          !/^[a-f0-9]{64}$/u.test(v.owner.nonce)
        )
          throw new Error("ADVANCED_JOURNAL_INVALID");
        v.owner.identity = processIdentityFromWire(
          processIdentityToWire(v.owner.identity),
        );
        if (v.owner.identity.sid !== host.identity.sid)
          throw new Error("ADVANCED_JOURNAL_INVALID");
      }
      return v;
    },
    write: async (value: BenchmarkOwnershipJournal) => {
      const j = await journal.read();
      if (!j || j.transaction !== value.transaction)
        throw new Error("ADVANCED_JOURNAL_INVALID");
      await owned(j.identity, () => vaultWrite("benchmark_owner", value));
    },
  };
  const pendingWrites = new Map<
      string,
      { settle(): Promise<void>; handoff(): Promise<void> }
    >(),
    pendingPins = new Map<string, { release(): Promise<void> }>();
  const benchmark = storeRuntime
    ? {
        run: StoreFleetAdvancedRuntime.prototype.runBenchmark.bind(
          storeRuntime,
        ),
        recover:
          StoreFleetAdvancedRuntime.prototype.recoverBenchmark.bind(
            storeRuntime,
          ),
      }
    : new WindowsAdvancedBenchmarkRunner({
        host,
        ready: legacyReady,
        ownership,
        beforeLaunch: async (configuration) => {
          await pendingWrites.get(configuration.requestId)?.handoff();
          pendingWrites.delete(configuration.requestId);
        },
        trackWorkspace: (configuration, owner) =>
          options.storage.trackWorkspace(
            `prepare\\work\\${configuration.requestId}`,
            owner,
            "processing",
          ),
      });
  const capacityContext = async (
    r: FleetEnrollmentRecord,
    signal: AbortSignal,
    depth: "status" | "full" = "full",
  ) => {
    const ready = await currentReady(signal, depth === "status");
    const active = await currentActive(r, signal, ready);
    const gpu = resolveQualifiedGpuIdentity(
      active.gpu,
      await host.native.enumerateGpus(),
    );
    return consumerCapacityIdentity({
      bootIdentity: active.bootIdentity,
      host: host.identity,
      gpu,
      manifestDigest: ready.manifestSha256,
      modelDigest: ready.modelSha256,
      fixtureDigest: r.prepared.fixtureDigest,
    });
  };
  const capacity = async (signal: AbortSignal) => {
    const r = await record(),
      state = await readConsumerFleetCapacity(host.native, r);
    let validatedWorkers = 1,
      problem: string | null = null,
      expiresAt: string | null = null;
    if (state.receipt) {
      try {
        const bytes = await readPrivateBytes(
          host,
          state.receipt.relativePath,
          2 * 1024 ** 2,
        );
        if (
          createHash("sha256").update(bytes).digest("hex") !==
          state.receipt.sha256
        )
          throw new Error("ADVANCED_CAPACITY_INVALID");
        const receipt = validateConsumerCapacityReceipt(
          JSON.parse(bytes.toString("utf8")),
          r,
          await capacityContext(r, signal, "status"),
          now(),
        );
        validatedWorkers = 2;
        expiresAt = receipt.expiresAt;
      } catch {
        problem = "ADVANCED_CAPACITY_REQUALIFICATION_REQUIRED";
      }
    }
    const status = await inspection.status();
    return {
      selectedWorkers: state.selectedWorkers,
      validatedWorkers,
      effectiveLocalWorkers: Math.min(state.selectedWorkers, validatedWorkers),
      problem,
      expiresAt,
      backendPermission: {
        current: false,
        source: "runtime-cache",
        revision: status?.cachedPolicy?.revision ?? null,
        note: "The runtime obtains and applies current backend recipe capacity before claims; a local PASS is not backend permission.",
      },
    };
  };
  const inspection = new WindowsFleetInspection({
    host,
    ...(options.native ? { native: options.native } : {}),
    ...(storeRuntime ? { storeRuntime } : {}),
    files,
    session: options.session,
    record,
    ready: (signal) => currentReady(signal),
    readyStatus: (signal) => currentReady(signal, true),
    capacity,
    now,
  });
  const control = (r: FleetEnrollmentRecord) => {
    if (!r.machineCredential) throw new Error("FLEET_REVOKED");
    return new WorkerControlPlaneClient({
      baseUrl: r.backendOrigin,
      credential: r.machineCredential,
      maxAttempts: 1,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  };
  const previewCleanup = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const plan = await inspectFleetRemoval(host.native, fleetRoot, "work");
    // Any transfer owner marker is uncertainty; its workspace is not eligible.
    const marked = new Set(
      plan.entries
        .filter((entry) => entry.relative.endsWith("\\transfer-owner.json"))
        .map((entry) => entry.relative.split("\\")[1]),
    );
    const selected = plan.entries.filter(
      (entry) =>
        /^[a-f0-9-]{36}$/u.test(entry.relative.split("\\")[1] ?? "") &&
        !marked.has(entry.relative.split("\\")[1]),
    );
    return {
      scope: "consumer-fleet-scratch",
      eligibleAfterMaintenance: true,
      reclaimableBytes: selected.reduce((sum, entry) => sum + entry.bytes, 0),
      files: selected.length,
      protectedTransferWorkspaces: marked.size,
      runtimeAndModelPreserved: true,
      plan: {
        entries: selected,
        directories: plan.directories.filter(
          (relative) =>
            !marked.has(relative.split("\\")[1]) &&
            /^[a-f0-9-]{36}$/u.test(relative.split("\\")[1] ?? ""),
        ),
        bytes: selected.reduce((sum, entry) => sum + entry.bytes, 0),
      },
    };
  };
  const copyInput = async (
    capability: string,
    requestId: string,
    signal: AbortSignal,
  ) => {
    const selected = await options.files.consume(
      capability,
      typeof options.fileOwner === "function"
        ? options.fileOwner()
        : options.fileOwner,
    );
    const relativePath = `prepare\\work\\${requestId}\\source.wav`;
    let destination: PrivateWritable | undefined;
    const hash = createHash("sha256");
    try {
      await host.native.validatePath("personal", "", "directory");
      const free = await statfs(host.personalRoot, { bigint: true });
      if (free.bavail * free.bsize < BigInt(3 * 1024 ** 3 + selected.bytes))
        throw new Error("DISK_SPACE_LOW");
      await host.directory(`prepare\\work\\${requestId}`);
      destination = await newPrivateFile(host, relativePath);
      const before = await selected.file.stat({ bigint: true });
      let offset = 0;
      if (
        before.size !== BigInt(selected.bytes) ||
        selected.bytes > 256 * 1024 ** 2
      )
        throw new Error("INPUT_CHANGED");
      const buffer = Buffer.alloc(1024 * 1024);
      while (offset < selected.bytes) {
        signal.throwIfAborted();
        const read = await selected.file.read(
          buffer,
          0,
          Math.min(buffer.length, selected.bytes - offset),
          offset,
        );
        if (!read.bytesRead) throw new Error("INPUT_CHANGED");
        const chunk = buffer.subarray(0, read.bytesRead);
        hash.update(chunk);
        await destination.writeFile(chunk);
        offset += chunk.length;
      }
      const after = await selected.file.stat({ bigint: true });
      if (
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        throw new Error("INPUT_CHANGED");
      await destination.sync();
      return {
        relativePath,
        bytes: selected.bytes,
        sha256: hash.digest("hex"),
      };
    } finally {
      await destination?.close();
      await selected.file.close();
    }
  };
  const mutate = async (
    mutation: FleetAdvancedMutation,
    expected: AdvancedIdentity,
    transaction: string,
    signal: AbortSignal,
    confirmed: () => Promise<void>,
    resources?: AdvancedConfirmationResources,
  ): Promise<unknown> => {
    let r = await record();
    if (fleetRecordAuthority(r) !== expected.digest)
      throw new Error("ADVANCED_MACHINE_CHANGED");
    if (mutation.action === "update") {
      if (!options.updates) throw new Error("UPDATE_UNAVAILABLE");
      return options.updates
        .install(signal, mutation.source ?? "app", {
          transaction,
          machineId: expected.machineId,
          authority: expected.digest,
          ...(mutation.force === true
            ? { force: true, expectedRevision: resources?.forceRevision ?? 0 }
            : {}),
        })
        .catch((error) => {
          if (
            error instanceof Error &&
            error.message === "UPDATE_FORCE_CONFIRMATION_STALE"
          )
            throw new AdvancedForceReviewStale();
          throw error;
        });
    }
    if ("force" in mutation && mutation.force === true) {
      if (!resources?.forceRevision)
        throw new Error("ADVANCED_CONFIRMATION_EXPIRED");
      const forced = await createSessionForcePort(options.session)
        .force(
          {
            reason: mutation.action,
            machineId: expected.machineId,
            authority: expected.digest,
            expectedRevision: resources.forceRevision,
            confirmation: transaction,
          },
          signal,
        )
        .catch((error) => {
          if (
            error instanceof Error &&
            error.message === "FORCE_CONFIRMATION_STALE"
          )
            throw new AdvancedForceReviewStale();
          throw error;
        });
      if (mutation.action === "stop" || mutation.action === "restart") {
        await confirmed();
        await options.onChanged?.().catch(() => {});
        return {
          action: mutation.action,
          force: true,
          savedIntent: forced.fleet.intent,
          phase: forced.fleet.phase,
        };
      }
      if (
        forced.maintenance?.transaction !== transaction ||
        forced.maintenance.phase !== "idle"
      )
        throw new Error("ADVANCED_BUSY");
      if (storeRuntime)
        await StoreFleetAdvancedRuntime.prototype.adoptForced.call(
          storeRuntime,
          transaction,
          signal,
        );
    }
    if (
      mutation.action === "benchmark_file" ||
      mutation.action === "benchmark_capacity"
    ) {
      if (
        r.phase !== "complete" ||
        (await consumerFleetRemoved(host.native, r))
      )
        throw new Error("FLEET_NOT_ENROLLED");
      const requestId = randomUUID(),
        relativePath = `prepare\\approved\\${r.prepared.fixtureDigest}.wav`;
      if (storeRuntime)
        StoreFleetAdvancedRuntime.prototype.stageBenchmark.call(
          storeRuntime,
          transaction,
          requestId,
        );
      const snapshot = await currentReady(signal);
      const extras = resources ? benchmarkResources.get(resources) : undefined;
      if (
        extras &&
        (extras.identity !== expected.digest ||
          extras.mutation !== JSON.stringify(mutation))
      )
        throw new Error("ADVANCED_CONFIRMATION_EXPIRED");
      if (
        mutation.action === "benchmark_file" &&
        (mutation.baselineCapability ||
          mutation.audioDestinationCapability ||
          mutation.reportDestinationCapability) &&
        !extras
      )
        throw new Error("ADVANCED_CONFIRMATION_EXPIRED");
      const candidate =
        mutation.action === "benchmark_file" && mutation.candidateRelease
          ? storeRuntime
            ? await StoreFleetAdvancedRuntime.prototype.currentCandidate.call(
                storeRuntime,
                mutation.candidateRelease,
                signal,
              )
            : await verifyAdvancedCandidate(
                host,
                mutation.candidateRelease,
                signal,
              )
          : undefined;
      await ownership.write({
        version: 1,
        transaction,
        requestId,
        release: snapshot.release,
        phase: "staging",
        owner: null,
      });
      const protection = await options.storage.protectTree(
        `prepare\\work\\${requestId}`,
        "processing",
        true,
      );
      pendingPins.set(transaction, protection);
      const writer = await options.storage.beginWrite(
        `prepare\\work\\${requestId}`,
        "tree",
      );
      pendingWrites.set(requestId, writer);
      await host.directory(`prepare\\work\\${requestId}`);
      await writer.captureCreated(
        storageBirth(
          await lstat(
            win32.join(host.personalRoot, "prepare", "work", requestId),
            { bigint: true },
          ),
        ),
      );
      const fixture =
        mutation.action === "benchmark_file"
          ? await copyInput(mutation.inputCapability, requestId, signal)
          : {
              relativePath,
              sha256: r.prepared.fixtureDigest,
              bytes: Number(
                (await lstat(win32.join(host.personalRoot, relativePath))).size,
              ),
            };
      // Finish the GUI scratch writer before the fixed Store child retains
      // its input tree. Legacy keeps the runner's existing beforeLaunch hook.
      if (storeRuntime) {
        await writer.handoff();
        pendingWrites.delete(requestId);
      }
      const result = await benchmark.run(
        transaction,
        {
          requestId,
          operation: mutation.action,
          fixture,
          recipe:
            mutation.action === "benchmark_file"
              ? mutation.recipe
              : "kim-vocals-v2",
          warmupRuns:
            mutation.action === "benchmark_file" ? mutation.warmupRuns : 1,
          measuredRuns:
            mutation.action === "benchmark_file" ? mutation.measuredRuns : 3,
          ...(candidate ? { candidate } : {}),
          ...(mutation.action === "benchmark_file"
            ? {
                groupSize: mutation.groupSize ?? 1,
                saveAudio: mutation.saveAudio ?? false,
              }
            : {}),
        },
        signal,
      );
      if (mutation.action === "benchmark_capacity") {
        const context = await capacityContext(r, signal),
          receipt = createConsumerFleetCapacityReceipt(
            r,
            context,
            result.report as Parameters<
              typeof createConsumerFleetCapacityReceipt
            >[2],
            now(),
          );
        const relative = `prepare\\results\\${requestId}.capacity.json`,
          bytes = Buffer.from(JSON.stringify(receipt));
        await writePrivateAtomic(host, relative, bytes);
        await owned(expected, async (current) => {
          const state = await readConsumerFleetCapacity(host.native, current);
          await vaultWrite(
            "capacity",
            parseConsumerFleetCapacity(
              {
                ...state,
                receipt: {
                  relativePath: relative,
                  sha256: createHash("sha256").update(bytes).digest("hex"),
                },
              },
              current,
            ),
          );
        });
        await confirmed();
        await protection.release();
        pendingPins.delete(transaction);
        return {
          kind: "two-worker-capacity",
          status: "PASS",
          validatedWorkers: 2,
          selectedWorkersUnchanged: true,
          backendPermissionRequired: true,
          expiresAt: receipt.expiresAt,
          recipes: receipt.measurements.recipes.map((recipe) => ({
            recipeId: recipe.recipeId,
            passed: recipe.passed,
            throughputSpeedup: recipe.throughputSpeedup,
          })),
        };
      }
      const report = result.report as RepeatedBenchmarkReport,
        comparison = extras?.baseline
          ? compareBenchmarkReports(extras.baseline, report)
          : null;
      const opened: AdvancedExportEntry[] = [];
      try {
        if (extras?.destinations.report) {
          const bytes = Buffer.from(JSON.stringify({ ...report, comparison }));
          if (bytes.length > 2 * 1024 ** 2)
            throw new Error("ADVANCED_RESULT_TOO_LARGE");
          const relative = `prepare\\work\\${requestId}\\benchmark-report.json`;
          await writePrivateAtomic(host, relative, bytes);
          const entry = await openAdvancedExport(
            host,
            relative,
            "MusicMute-worker-benchmark.json",
            {
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
            signal,
          );
          opened.push(entry);
          await extras.destinations.report.write([entry], signal);
        }
        if (extras?.destinations.audio) {
          if (
            report.savedAudioArtifacts.length > 26 ||
            report.savedAudioArtifacts.reduce(
              (sum, entry) => sum + entry.bytes,
              0,
            ) >
              1024 ** 3
          )
            throw new Error("ADVANCED_RESULT_TOO_LARGE");
          const entries: AdvancedExportEntry[] = [];
          for (const artifact of report.savedAudioArtifacts) {
            const entry = await openAdvancedExport(
              host,
              `prepare\\work\\${requestId}\\saved-audio\\${artifact.fileName}`,
              artifact.fileName,
              artifact,
              signal,
            );
            opened.push(entry);
            entries.push(entry);
          }
          await extras.destinations.audio.write(entries, signal);
        }
        await confirmed();
      } finally {
        await Promise.allSettled(opened.map((entry) => entry.file.close()));
      }
      await protection.release();
      pendingPins.delete(transaction);
      return {
        kind: "file-benchmark",
        status: "PASS",
        recipe: report.recipeId,
        warmupRuns: report.warmupRuns,
        measuredRuns: report.measuredRuns,
        measurements: report.measuredSummary,
        memoryScope: report.memoryScope,
        timingScope: report.timingScope,
        groupSize: 1,
        sourceMode: report.sourceMode,
        candidateRelease: candidate?.release ?? null,
        comparison,
        savedAudioArtifacts: report.savedAudioArtifacts.length,
        audioExported: !!extras?.destinations.audio,
        reportExported: !!extras?.destinations.report,
        sourcePreserved: true,
      };
    }
    if (mutation.action === "capacity") {
      if (
        r.phase !== "complete" ||
        !r.machineCredential ||
        (await consumerFleetRemoved(host.native, r))
      )
        throw new Error("FLEET_NOT_ENROLLED");
      await owned(expected, async (current) => {
        const state = await readConsumerFleetCapacity(host.native, current);
        if (mutation.workers === 2) {
          if (!state.receipt) throw new Error("ADVANCED_CAPACITY_REQUIRED");
          const bytes = await readPrivateBytes(
            host,
            state.receipt.relativePath,
            2 * 1024 ** 2,
          );
          if (
            createHash("sha256").update(bytes).digest("hex") !==
            state.receipt.sha256
          )
            throw new Error("ADVANCED_CAPACITY_INVALID");
          validateConsumerCapacityReceipt(
            JSON.parse(bytes.toString("utf8")),
            current,
            await capacityContext(current, signal),
            now(),
          );
          const status = await inspection.status();
          if (!status?.sessionId || !status.incarnation)
            throw new Error("ADVANCED_BACKEND_CAPACITY_UNAVAILABLE");
          const config = await control(current).config(
            status.sessionId,
            status.incarnation,
            signal,
          );
          if (
            config.machineId !== current.machineId ||
            !config.claimAllowed ||
            config.machineStatus !== "active" ||
            !config.policy.acceptClaims ||
            !config.policy.recipes.some(
              (recipe) =>
                current.prepared.report.capabilities[0]!.recipeIds.includes(
                  recipe.recipeId,
                ) &&
                recipe.enabled &&
                recipe.maxSlotsPerMachine >= 2,
            )
          )
            throw new Error("ADVANCED_BACKEND_CAPACITY_UNAVAILABLE");
        }
        await vaultWrite("capacity", {
          ...state,
          selectedWorkers: mutation.workers,
        });
      });
      await confirmed();
      return {
        selectedWorkers: mutation.workers,
        backendPolicyRemainsAuthoritative: true,
      };
    }
    if (mutation.action === "revoke") {
      if (!r.retiredAuthority) {
        const remembered = (await vaultRead("confirmed_unpair")) as {
          version: number;
          machineId: string;
          authority: string;
          confirmedAt: string;
          revision: number;
        } | null;
        if (
          remembered &&
          (Object.keys(remembered).sort().join() !==
            "authority,confirmedAt,machineId,revision,version" ||
            remembered.version !== 1 ||
            !/^[a-f0-9-]{36}$/u.test(remembered.machineId) ||
            !/^[a-f0-9]{64}$/u.test(remembered.authority) ||
            !Number.isFinite(Date.parse(remembered.confirmedAt)) ||
            !Number.isSafeInteger(remembered.revision) ||
            remembered.revision < 1)
        )
          throw new Error("ADVANCED_REVOCATION_STATE_INVALID");
        if (
          !remembered ||
          remembered.machineId !== expected.machineId ||
          remembered.authority !== expected.digest
        ) {
          const response = await control(r).unpair(
            mutation.force === true,
            signal,
          );
          if (
            response.machineId !== expected.machineId ||
            !response.confirmed ||
            response.status !== "revoked"
          )
            throw new Error("ADVANCED_MACHINE_CHANGED");
          await owned(expected, () =>
            vaultWrite("confirmed_unpair", {
              version: 1,
              machineId: r.machineId,
              authority: expected.digest,
              confirmedAt: new Date(now()).toISOString(),
              revision: response.revision,
            }),
          );
        }
      }
      r = await store.retireIfCurrent(expected.digest);
      await options.session.command(
        {
          version: 1,
          request_id: randomUUID(),
          action: "fleet_intent",
          intent: "stopped",
        },
        signal,
      );
      await confirmed();
      if (mutation.force === true)
        await maintenance.cancel(transaction, signal);
      await options.onChanged?.().catch(() => {});
      return {
        machineId: expected.machineId,
        status: "revoked",
        confirmed: true,
      };
    }
    if (mutation.action === "remove") {
      await options.session.command(
        {
          version: 1,
          request_id: randomUUID(),
          action: "fleet_intent",
          intent: "stopped",
        },
        signal,
      );
      await owned(expected, () =>
        vaultWrite("removed", {
          version: 1,
          machineId: r.machineId,
          authority: expected.digest,
          removedAt: new Date(now()).toISOString(),
        }),
      );
      await confirmed();
      await options.onChanged?.().catch(() => {});
      return {
        removed: "consumer-fleet-role",
        backendRevoked: r.phase === "revoked",
        preserved: [
          "account",
          "personal",
          "runtime",
          "model",
          "Chrome registration",
        ],
        appUninstall: "Use the per-user app uninstaller separately",
      };
    }
    if (mutation.action === "restore") {
      if (r.phase !== "complete" || !r.machineCredential)
        throw new Error("FLEET_REVOKED");
      const active = await currentReady(signal),
        identity = await currentActive(r, signal, active);
      if (!active.evidence.gpuIdentity)
        throw new Error("FLEET_PREPARE_REQUIRED");
      resolveQualifiedGpuIdentity(identity.gpu, [active.evidence.gpuIdentity]);
      const state = await control(r).machineStatus(signal);
      if (state.machineId !== r.machineId || state.status !== "active")
        throw new Error("FLEET_APPROVAL_REQUIRED");
      await options.session.command(
        {
          version: 1,
          request_id: randomUUID(),
          action: "fleet_intent",
          intent: "stopped",
        },
        signal,
      );
      await owned(expected, () => host.native.vaultDelete("fleet", "removed"));
      await confirmed();
      await options.onChanged?.().catch(() => {});
      return {
        restored: "consumer-fleet-role",
        machineId: r.machineId,
        identityPreserved: true,
        savedIntent: "stopped",
        explicitStartRequired: true,
      };
    }
    if (mutation.action === "purge") {
      if (
        r.phase !== "revoked" ||
        r.retiredAuthority !== expected.digest ||
        !(await consumerFleetRemoved(host.native, r))
      )
        throw new Error("ADVANCED_REVOKE_AND_REMOVE_REQUIRED");
      const prepare = await host.native.acquireMutex("prepare");
      if (!prepare) throw new Error("ADVANCED_BUSY");
      try {
        if (
          prepare.scope !== "prepare" ||
          prepare.identity.sid !== host.identity.sid ||
          prepare.identity.sessionId !== host.identity.sessionId ||
          prepare.abandoned
        )
          throw new Error("ADVANCED_PURGE_RECOVERY_REQUIRED");
        const plans = await Promise.all(
          (
            [
              "work",
              "logs",
              "state",
              "reports",
              "enrollment",
              "consumer-config.json",
            ] as const
          ).map((root) => inspectFleetRemoval(host.native, fleetRoot, root)),
        );
        await owned(expected, async () => {
          const qualificationBytes = await purgeFleetQualificationArtifacts(
            host,
            r,
            signal,
          );
          for (const plan of plans)
            await applyFleetRemoval(host.native, fleetRoot, plan, signal);
          for (const key of [
            "capacity",
            "active_runtime",
            ...(storeRuntime ? ["store_active_runtime"] : []),
            "fleet_ticket",
            "child_bootstrap",
            "benchmark_owner",
          ])
            await host.native.vaultDelete("fleet", key);
          const tombstone = parseFleetPurgedTombstone(
            {
              version: 1,
              sid: r.sid,
              machineId: r.machineId,
              workerId: r.workerId,
              onboardingRevision: r.onboardingRevision,
              authority: expected.digest,
              purgedAt: new Date(now()).toISOString(),
            },
            host.identity.sid,
          );
          await vaultWrite("purged_tombstone", tombstone);
          await host.native.vaultDelete("fleet", "enrollment");
          for (const key of ["confirmed_unpair", "removed"])
            await host.native.vaultDelete("fleet", key);
          plans.push({
            entries: [],
            directories: [],
            bytes: qualificationBytes,
          });
        });
        await confirmed();
        return {
          purged: "consumer-fleet-data",
          bytes: plans.reduce((sum, plan) => sum + plan.bytes, 0),
          preserved: [
            "noncredential purge receipt",
            "account",
            "personal",
            "shared runtime",
            "model",
            "Chrome registration",
          ],
        };
      } finally {
        await host.native.releaseMutex(prepare);
      }
    }
    if (mutation.action === "clear_logs") {
      const result = await owned(expected, () =>
        clearConsumerFleetLogs(host.native, files),
      );
      await confirmed();
      return { ...result, incompleteHistory: true };
    }
    if (mutation.action === "cleanup") {
      const preview = await previewCleanup(signal);
      await owned(expected, () =>
        applyFleetRemoval(host.native, fleetRoot, preview.plan, signal),
      );
      await confirmed();
      return {
        reclaimedBytes: preview.reclaimableBytes,
        protectedTransferWorkspaces: preview.protectedTransferWorkspaces,
        runtimeAndModelPreserved: true,
      };
    }
    throw new Error("ADVANCED_REQUEST_INVALID");
  };
  const recover = async (
    j: AdvancedJournal,
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (j.mutation.action === "update") {
      if (!options.updates) throw new Error("UPDATE_UNAVAILABLE");
      return options.updates.recover(signal);
    }
    if (!("force" in j.mutation && j.mutation.force === true)) {
      if (
        storeRuntime &&
        j.phase === "waiting" &&
        StoreFleetAdvancedRuntime.prototype.mutationActive.call(storeRuntime)
      )
        await StoreFleetAdvancedRuntime.prototype.recoverAcquisition.call(
          storeRuntime,
          j.transaction,
        );
      else await maintenance.acquire(j.transaction, signal);
    } else if (
      storeRuntime &&
      j.mutation.action === "revoke" &&
      j.phase !== "waiting" &&
      j.phase !== "fenced"
    ) {
      if (
        StoreFleetAdvancedRuntime.prototype.mutationActive.call(storeRuntime)
      ) {
        if (
          j.phase === "running" &&
          (await StoreFleetAdvancedRuntime.prototype.recoverForcedAdmission.call(
            storeRuntime,
            j.transaction,
            signal,
          )) === "interrupted"
        )
          return {
            operation: j.mutation.action,
            interruptedBeforeEffect: true,
          };
      } else
        await StoreFleetAdvancedRuntime.prototype.adoptForced.call(
          storeRuntime,
          j.transaction,
          signal,
        );
    }
    if (j.mutation.action === "purge") {
      const tombstone = await store.readPurgedTombstone();
      if (tombstone) {
        if (tombstone.authority !== j.identity.digest)
          throw new Error("ADVANCED_MACHINE_CHANGED");
        await ownedAuthority(j.identity, async () => {
          for (const key of ["enrollment", "confirmed_unpair", "removed"])
            await host.native.vaultDelete("fleet", key);
        });
        return {
          operation: "purge",
          recoveredConfirmedEffect: true,
          identityRetired: true,
        };
      }
    }
    if (j.phase === "waiting" || j.phase === "fenced")
      return { operation: j.mutation.action, interruptedBeforeEffect: true };
    if (["benchmark_file", "benchmark_capacity"].includes(j.mutation.action)) {
      await benchmark.recover(j.transaction);
      const owner = await ownership.read();
      if (owner) {
        await pendingWrites.get(owner.requestId)?.settle();
        pendingWrites.delete(owner.requestId);
      }
      await pendingPins.get(j.transaction)?.release();
      pendingPins.delete(j.transaction);
      return {
        operation: j.mutation.action,
        interrupted: true,
        explicitBenchmarkRequired: true,
      };
    }
    if (j.phase === "effect-confirmed")
      return { operation: j.mutation.action, recoveredConfirmedEffect: true };
    return mutate(
      j.mutation,
      j.identity,
      j.transaction,
      signal,
      async () => journal.write({ ...j, phase: "effect-confirmed" }),
      j.forceRevision
        ? { forceRevision: j.forceRevision, release: async () => {} }
        : undefined,
    );
  };
  const controller = new WindowsFleetAdvancedController({
    identity,
    prepareConfirmation,
    journal,
    maintenance,
    read: async (section, filter, signal) => {
      if (!(await store.read())) {
        const tombstone = await store.readPurgedTombstone();
        if (!tombstone) throw new Error("FLEET_NOT_ENROLLED");
        return {
          section,
          machineId: tombstone.machineId,
          purged: true,
          identityRetired: true,
          historyAvailable: false,
          explicitEnrollmentRequired: true,
        };
      }
      return inspection.read(section, filter, signal);
    },
    previewCleanup: async (signal) => {
      const { plan: _plan, ...safe } = await previewCleanup(signal);
      return safe;
    },
    mutate,
    recover,
    export: (capability, data, signal) =>
      options.exportArchive(
        capability,
        createFleetDiagnosticArchive(data),
        "MusicMute-worker-diagnostics.zip",
        signal,
      ),
    updateCheck: (signal, source) => {
      if (!options.updates) throw new Error("UPDATE_UNAVAILABLE");
      return options.updates.check(signal, source);
    },
    assertAvailable: async (mutation) => {
      if (
        storeRuntime &&
        mutation.action === "update" &&
        mutation.force === true
      )
        throw new Error("STORE_UPDATE_DENIED");
      if (storeRuntime)
        await StoreFleetAdvancedRuntime.prototype.assertAvailable.call(
          storeRuntime,
          mutation.action,
        );
      if (mutation.action === "update" && !options.updates)
        throw new Error("UPDATE_UNAVAILABLE");
    },
    now,
  });
  return {
    controller,
    inspection,
    benchmark,
    async pendingUpdateRecovery() {
      const saved = await journal.read();
      if (
        !saved ||
        saved.phase === "complete" ||
        saved.mutation.action !== "update"
      )
        return null;
      if (!sameAdvancedIdentity(await identity(), saved.identity))
        throw new Error("ADVANCED_MACHINE_CHANGED");
      return {
        transaction: saved.transaction,
        machineId: saved.identity.machineId,
        authority: saved.identity.digest,
        source: saved.mutation.source ?? "app",
      };
    },
    async close() {
      inspection.close();
      await controller.dispose();
      await releaseUnreturnedResources();
      if (confirmationResources.size)
        throw new Error("ADVANCED_CONFIRMATION_CLEANUP_PENDING");
      for (const [transaction, pin] of pendingPins) {
        await benchmark.recover(transaction);
        const receipt = await ownership.read();
        if (receipt) {
          await pendingWrites.get(receipt.requestId)?.settle();
          pendingWrites.delete(receipt.requestId);
        }
        await pin.release();
        pendingPins.delete(transaction);
      }
    },
  };
}
