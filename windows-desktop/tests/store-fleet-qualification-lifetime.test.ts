import { afterEach, expect, it, vi } from "vitest";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import type { WorkerEnrollmentClient } from "../../worker/src/enrollment/enrollment-client.js";
import type { HostContext } from "../src/main/host-context.js";
import type {
  PrepareLease,
  PrepareTarget,
} from "../src/main/prepare/controller.js";
import type { StorePreparationBinding } from "../src/main/prepare/store-model-ready.js";
import type { StorePreparationOperations } from "../src/main/prepare/store-operations.js";
import type { StorePrepareMaintenance } from "../src/main/prepare/store-maintenance.js";
import type {
  FleetEnrollmentRecord,
  StoreFleetPreparedIdentity,
} from "../src/main/fleet/store.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { record } from "./fleet-fixtures.js";
import { receipt } from "./fixtures/prepare.js";

// Synthetic module-boundary owners test the real coordinator's lifetime only.
// They cannot prove an installed Store package, native lease, GPU or enrollment.
const boundary = vi.hoisted(() => {
  class Operations {
    #host: object;
    alive = true;
    targetImpl = vi.fn();
    lockImpl = vi.fn();
    ready = vi.fn();
    view = vi.fn();
    qualifier = vi.fn();
    pending = false;
    recover = vi.fn();
    constructor(host: object) {
      this.#host = host;
    }
    assertHost(host: object) {
      if (host !== this.#host || !this.alive)
        throw Error("OPERATIONS_OWNER_DENIED");
    }
    target(...args: unknown[]) {
      return this.targetImpl(...args);
    }
    lock(...args: unknown[]) {
      return this.lockImpl(...args);
    }
    snapshotStoreReady(signal: AbortSignal) {
      return this.ready(signal);
    }
    mediaCodeView(signal: AbortSignal) {
      return this.view(signal);
    }
    qualifyApprovedFixtureHeld(...args: unknown[]) {
      return this.qualifier(...args);
    }
    cleanupPending() {
      return this.pending;
    }
    recoverCleanup() {
      return this.recover();
    }
  }
  class Maintenance {
    #host: object;
    alive = true;
    begin = vi.fn();
    finish = vi.fn();
    pending = false;
    recover = vi.fn();
    recoverMutationImpl = vi.fn();
    constructor(host: object) {
      this.#host = host;
    }
    assertHost(host: object) {
      if (host !== this.#host || !this.alive)
        throw Error("MAINTENANCE_OWNER_DENIED");
    }
    beforeMutation(...args: unknown[]) {
      return this.begin(...args);
    }
    settle(...args: unknown[]) {
      return this.finish(...args);
    }
    cleanupPending() {
      return this.pending;
    }
    recoverCleanup() {
      return this.recover();
    }
    recoverMutation() {
      return this.recoverMutationImpl();
    }
  }
  return {
    Operations,
    Maintenance,
    download: vi.fn(),
    hash: vi.fn(),
    write: vi.fn(),
  };
});
vi.mock("../src/main/prepare/store-operations.js", () => ({
  StorePreparationOperations: boundary.Operations,
}));
vi.mock("../src/main/prepare/store-maintenance.js", () => ({
  StorePrepareMaintenance: boundary.Maintenance,
}));
vi.mock("../src/main/fleet/store-fixture-transfer.js", () => ({
  downloadStoreQualificationFixture: boundary.download,
}));
vi.mock("../src/main/prepare/private-files.js", () => ({
  hashPrivateFile: boundary.hash,
  writePrivateAtomic: boundary.write,
}));
vi.mock("../../worker/src/enrollment/report-builder.js", async (original) => ({
  ...(await original<object>()),
  currentHost: () => ({
    platform: "win32",
    arch: "x64",
    release: "10.0.19045",
    cpu: "Synthetic receiving CPU",
    memoryBytes: 16 * 1024 ** 3,
  }),
}));
import { StoreFleetPreparation } from "../src/main/fleet/store-preparation.js";

afterEach(() => vi.clearAllMocks());
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const old = record("exchanged"),
    product = STORE_PRODUCTS.worker,
    fullName = `${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
    binding: StorePreparationBinding = {
      package: {
        identityName: product.identityName,
        publisher: product.publisher,
        publisherId: product.publisherId,
        familyName: product.familyName,
        fullName,
        packageVersion: "0.1.3.2",
        architecture: "x64",
        signatureKind: 3,
        healthy: true,
        current: true,
        installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
      },
      inventorySha256: old.prepared.release,
      runtimeManifestSha256: old.prepared.manifestDigest,
      sid: old.sid,
      bootIdentity: old.prepared.bootIdentity!,
      recipeDigests: {
        "kim-vocals-v2": "0".repeat(64),
        "kim-vocals-v2-trim": "1".repeat(64),
      },
    },
    enrollment: FleetEnrollmentRecord & {
      prepared: StoreFleetPreparedIdentity;
    } = {
      ...old,
      prepared: {
        ...old.prepared,
        distribution: "microsoft-store",
        archiveDigest: null,
        storeBinding: binding,
        modelDigest: MODEL.sha256,
        report: {
          ...old.prepared.report,
          runtime: {
            ...old.prepared.report.runtime,
            modelDigest: MODEL.sha256,
          },
        },
      },
    },
    raw = {
      ...receipt().qualification,
      serviceIdentity: old.sid,
      fixtureDigest: "f".repeat(64),
      gpuIdentity: old.prepared.gpu,
      gpuId: `dxgi-${old.prepared.gpu.luid}`,
      directmlDeviceId: old.prepared.gpu.deviceIndex,
      resourceObservations: {
        inferenceSlots: 1,
        dedicatedVideoMemoryLimitBytes:
          old.prepared.gpu.dedicatedVideoMemoryBytes,
        sharedSystemMemoryLimitBytes:
          old.prepared.gpu.sharedSystemMemoryLimitBytes,
      },
    },
    host = {
      identity: { sid: old.sid, sessionId: 1 },
      personalRoot: "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal",
      native: {
        identity: vi.fn(async () => ({ sid: old.sid, sessionId: 1 })),
        enumerateGpus: vi.fn(async () => [old.prepared.gpu]),
      },
    } as unknown as HostContext,
    operations = new boundary.Operations(host),
    maintenance = new boundary.Maintenance(host),
    events: string[] = [],
    child = deferred<void>(),
    qualifierStarted = deferred<void>(),
    setupRelease = deferred<void>(),
    state = {
      childLive: false,
      setupHeld: false,
      activityHeld: false,
      setupFailure: undefined as Error | undefined,
      activityFailure: undefined as Error | undefined,
      settleFailure: undefined as Error | undefined,
      rebindFailure: undefined as Error | undefined,
      deferSetupRelease: false,
    },
    target: PrepareTarget = { sid: old.sid, identity: binding.inventorySha256 },
    setup = {
      release: vi.fn(async () => {
        expect(state.childLive).toBe(false);
        events.push("setup_release_attempt");
        if (state.setupFailure) throw state.setupFailure;
        if (state.deferSetupRelease) await setupRelease.promise;
        expect(state.setupHeld).toBe(true);
        state.setupHeld = false;
        events.push("setup_released");
      }),
    } satisfies PrepareLease,
    activity = {
      release: vi.fn(async () => {
        expect(state.childLive).toBe(false);
        expect(state.setupHeld).toBe(false);
        events.push("activity_release_attempt");
        if (state.activityFailure) throw state.activityFailure;
        expect(state.activityHeld).toBe(true);
        state.activityHeld = false;
        events.push("activity_released");
      }),
    } satisfies PrepareLease,
    rebind = vi.fn(async () => {
      expect(state.childLive || state.setupHeld || state.activityHeld).toBe(
        false,
      );
      events.push("rebind");
      if (state.rebindFailure) throw state.rebindFailure;
    }),
    client = {
      storeQualificationArtifacts: vi.fn(async () => ({
        model: {
          filename: MODEL.filename,
          bytes: MODEL.bytes,
          sha256: MODEL.sha256,
        },
        fixture: {
          filename: "approved.wav",
          bytes: 100,
          sha256: raw.fixtureDigest,
          contentType: "audio/wav",
          url: "https://fixture.example.invalid/approved.wav",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      })),
    };
  operations.targetImpl.mockImplementation(async () => {
    events.push("target");
    return target;
  });
  operations.lockImpl.mockImplementation(async (actual: PrepareTarget) => {
    expect(actual).toBe(target);
    events.push("setup_lock");
    state.setupHeld = true;
    return setup;
  });
  operations.ready.mockResolvedValue({
    binding,
    evidence: { gpuIdentity: old.prepared.gpu },
  });
  operations.view.mockResolvedValue({
    binding,
    manifest: { releaseVersion: product.appVersion },
  });
  operations.qualifier.mockImplementation(async (actual: PrepareTarget) => {
    expect(actual).toBe(target);
    expect(state.setupHeld && state.activityHeld).toBe(true);
    events.push("held_qualifier");
    state.childLive = true;
    qualifierStarted.resolve();
    try {
      await child.promise;
      return { raw, bootIdentity: binding.bootIdentity };
    } finally {
      state.childLive = false;
      events.push("child_settled");
    }
  });
  operations.recover.mockImplementation(async () => {
    expect(state.setupHeld).toBe(true);
    events.push("operation_cleanup");
    operations.pending = false;
  });
  maintenance.begin.mockImplementation(async (actual: PrepareTarget) => {
    expect(actual).toBe(target);
    expect(state.setupHeld).toBe(true);
    events.push("drain");
    state.activityHeld = true;
    return activity;
  });
  maintenance.recoverMutationImpl.mockImplementation(async () => {
    events.push("recover_mutation");
  });
  maintenance.recover.mockImplementation(async () => {
    events.push("maintenance_cleanup");
    maintenance.pending = false;
  });
  maintenance.finish.mockImplementation(
    async (task: Promise<unknown>, callback: () => Promise<void>) => {
      await task.catch(() => undefined);
      expect(state.childLive || state.setupHeld || state.activityHeld).toBe(
        false,
      );
      events.push("settle");
      if (state.settleFailure) throw state.settleFailure;
      await callback();
      events.push("settled");
    },
  );
  boundary.download.mockResolvedValue({
    relativePath: `prepare\\approved\\${raw.fixtureDigest}.wav`,
  });
  boundary.hash.mockResolvedValue(raw.fixtureDigest);
  boundary.write.mockImplementation(async () => {
    events.push("qualification_written");
  });
  const coordinator = StoreFleetPreparation.open(
    host,
    operations as unknown as StorePreparationOperations,
    { maintenance: maintenance as unknown as StorePrepareMaintenance, rebind },
  );
  const qualify = (received: FleetEnrollmentRecord = enrollment) =>
    coordinator.qualify(
      received,
      client as unknown as WorkerEnrollmentClient,
      new AbortController().signal,
    );
  return {
    coordinator,
    qualify,
    enrollment,
    host,
    operations,
    maintenance,
    events,
    child,
    qualifierStarted,
    setupRelease,
    state,
    setup,
    activity,
    rebind,
    client,
  };
}

it("locks, drains, holds one qualifier, positively releases setup then activity and finally settles/rebinds", async () => {
  const f = fixture(),
    task = f.qualify();
  await f.qualifierStarted.promise;
  expect(f.coordinator.qualificationActive()).toBe(true);
  expect(f.events).toEqual(["target", "setup_lock", "drain", "held_qualifier"]);
  expect(f.setup.release).not.toHaveBeenCalled();
  expect(f.activity.release).not.toHaveBeenCalled();
  expect(f.rebind).not.toHaveBeenCalled();
  f.child.resolve();
  const result = await task;
  expect(result).toMatchObject({
    distribution: "microsoft-store",
    archiveDigest: null,
    fixtureDigest: "f".repeat(64),
  });
  expect(f.events).toEqual([
    "target",
    "setup_lock",
    "drain",
    "held_qualifier",
    "child_settled",
    "qualification_written",
    "setup_release_attempt",
    "setup_released",
    "activity_release_attempt",
    "activity_released",
    "settle",
    "rebind",
    "settled",
  ]);
  expect(f.coordinator.qualificationActive()).toBe(false);
  expect(f.operations.qualifier).toHaveBeenCalledTimes(1);
});

it("retains both the original task error and cleanup error, then retries only original cleanup/task", async () => {
  const f = fixture(),
    taskError = Error("QUALIFIER_CHILD_FAILED"),
    cleanupError = Error("PREPARE_RELEASE_ACK_UNKNOWN");
  f.state.setupFailure = cleanupError;
  const first = f.qualify().catch((error: unknown) => error);
  await f.qualifierStarted.promise;
  f.child.reject(taskError);
  const failure = await first;
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([taskError, cleanupError]);
  expect(f.coordinator.qualificationActive()).toBe(true);
  expect(f.state.setupHeld && f.state.activityHeld).toBe(true);
  f.state.setupFailure = undefined;
  await expect(f.qualify(structuredClone(f.enrollment))).rejects.toBe(
    taskError,
  );
  expect(f.operations.qualifier).toHaveBeenCalledTimes(1);
  expect(f.operations.lockImpl).toHaveBeenCalledTimes(1);
  expect(f.maintenance.begin).toHaveBeenCalledTimes(1);
  expect(f.setup.release).toHaveBeenCalledTimes(2);
  expect(f.activity.release).toHaveBeenCalledTimes(1);
  expect(f.coordinator.qualificationActive()).toBe(false);
});

it.each(["setup", "activity", "settle", "rebind"] as const)(
  "keeps the exact original task/leases after %s failure and never repeats positively released effects",
  async (point) => {
    const f = fixture(),
      failure = Error(`${point}_ACK_UNKNOWN`);
    f.state[`${point}Failure`] = failure;
    const first = f.qualify();
    await f.qualifierStarted.promise;
    f.child.resolve();
    await expect(first).rejects.toBe(failure);
    expect(f.coordinator.qualificationActive()).toBe(true);
    const originalTask = f.maintenance.finish.mock.calls[0]?.[0];
    f.state[`${point}Failure`] = undefined;
    const result = await f.qualify(structuredClone(f.enrollment));
    expect(result.fixtureDigest).toBe("f".repeat(64));
    expect(f.operations.qualifier).toHaveBeenCalledTimes(1);
    expect(f.setup.release).toHaveBeenCalledTimes(point === "setup" ? 2 : 1);
    expect(f.activity.release).toHaveBeenCalledTimes(
      point === "activity" ? 2 : 1,
    );
    if (originalTask)
      expect(f.maintenance.finish.mock.calls.at(-1)![0]).toBe(originalTask);
    expect(f.coordinator.qualificationActive()).toBe(false);
  },
);

it("concurrent calls join the live original child and cannot close or duplicate its leases", async () => {
  const f = fixture(),
    first = f.qualify();
  await f.qualifierStarted.promise;
  const second = f.qualify(structuredClone(f.enrollment)),
    third = f.qualify();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.state.childLive).toBe(true);
  expect(f.setup.release).not.toHaveBeenCalled();
  expect(f.activity.release).not.toHaveBeenCalled();
  expect(f.operations.qualifier).toHaveBeenCalledTimes(1);
  f.child.resolve();
  const results = await Promise.all([first, second, third]);
  expect(results[0]).toBe(results[1]);
  expect(results[0]).toBe(results[2]);
  expect(f.setup.release).toHaveBeenCalledTimes(1);
  expect(f.activity.release).toHaveBeenCalledTimes(1);
  expect(f.maintenance.finish).toHaveBeenCalledTimes(1);
  expect(f.rebind).toHaveBeenCalledTimes(1);
});

it("concurrent callers join an in-flight positive setup release instead of dispatching duplicate closes", async () => {
  const f = fixture();
  f.state.deferSetupRelease = true;
  const first = f.qualify();
  await f.qualifierStarted.promise;
  f.child.resolve();
  await vi.waitFor(() => expect(f.setup.release).toHaveBeenCalledTimes(1));
  const second = f.qualify(),
    third = f.qualify();
  await Promise.resolve();
  expect(f.activity.release).not.toHaveBeenCalled();
  expect(f.setup.release).toHaveBeenCalledTimes(1);
  f.setupRelease.resolve();
  await Promise.all([first, second, third]);
  expect(f.setup.release).toHaveBeenCalledTimes(1);
  expect(f.activity.release).toHaveBeenCalledTimes(1);
  expect(f.operations.qualifier).toHaveBeenCalledTimes(1);
  expect(f.rebind).toHaveBeenCalledTimes(1);
});

it("concurrent explicit retries recover one retained settlement and return the same qualified object", async () => {
  const f = fixture();
  f.state.setupFailure = Error("RELEASE_UNKNOWN");
  const first = f.qualify();
  await f.qualifierStarted.promise;
  f.child.resolve();
  await expect(first).rejects.toThrow("RELEASE_UNKNOWN");
  f.state.setupFailure = undefined;
  f.state.deferSetupRelease = true;
  const second = f.qualify(),
    third = f.qualify();
  await vi.waitFor(() => expect(f.setup.release).toHaveBeenCalledTimes(2));
  expect(f.activity.release).not.toHaveBeenCalled();
  f.setupRelease.resolve();
  const [a, b] = await Promise.all([second, third]);
  expect(a).toBe(b);
  expect(f.setup.release).toHaveBeenCalledTimes(2);
  expect(f.activity.release).toHaveBeenCalledTimes(1);
  expect(f.operations.qualifier).toHaveBeenCalledTimes(1);
  expect(f.maintenance.finish).toHaveBeenCalledTimes(1);
});

it("rejects foreign retained enrollment before retrying cleanup or acquiring another qualifier", async () => {
  const f = fixture();
  f.state.setupFailure = Error("RELEASE_UNKNOWN");
  const first = f.qualify();
  await f.qualifierStarted.promise;
  f.child.resolve();
  await expect(first).rejects.toThrow("RELEASE_UNKNOWN");
  for (const foreign of [
    { ...f.enrollment, ownerUid: "another-synthetic-owner" },
    { ...f.enrollment, installationCredential: "z".repeat(43) },
    { ...f.enrollment, workerId: "bbb8d67e-76ae-4dc8-b7ae-903e33f487a0" },
    {
      ...f.enrollment,
      prepared: { ...f.enrollment.prepared, archiveDigest: "a".repeat(64) },
    } as unknown as FleetEnrollmentRecord,
  ])
    await expect(f.qualify(foreign)).rejects.toThrow();
  expect(f.setup.release).toHaveBeenCalledTimes(1);
  expect(f.operations.lockImpl).toHaveBeenCalledTimes(1);
  expect(f.operations.qualifier).toHaveBeenCalledTimes(1);
  expect(f.coordinator.qualificationActive()).toBe(true);
  f.state.setupFailure = undefined;
  await f.qualify();
});

it("recovers child cleanup under the retained drain/setup before any lease release", async () => {
  const f = fixture(),
    childError = Error("CHILD_CLEANUP_UNKNOWN");
  f.operations.pending = true;
  f.maintenance.pending = true;
  const first = f.qualify();
  await f.qualifierStarted.promise;
  f.child.reject(childError);
  await expect(first).rejects.toBe(childError);
  expect(f.events.slice(5)).toEqual([
    "recover_mutation",
    "operation_cleanup",
    "maintenance_cleanup",
    "setup_release_attempt",
    "setup_released",
    "activity_release_attempt",
    "activity_released",
    "settle",
    "rebind",
    "settled",
  ]);
  expect(f.coordinator.qualificationActive()).toBe(false);
});

it("retains uncertain child cleanup and retries it before releasing any original lease", async () => {
  const f = fixture(),
    taskError = Error("CHILD_FAILED"),
    cleanupError = Error("NATIVE_CHILD_STILL_OWNED");
  f.operations.pending = true;
  f.operations.recover.mockRejectedValueOnce(cleanupError);
  const first = f.qualify().catch((error: unknown) => error);
  await f.qualifierStarted.promise;
  f.child.reject(taskError);
  const failure = await first;
  expect((failure as AggregateError).errors).toEqual([taskError, cleanupError]);
  expect(f.setup.release).not.toHaveBeenCalled();
  expect(f.activity.release).not.toHaveBeenCalled();
  expect(f.rebind).not.toHaveBeenCalled();
  expect(f.coordinator.qualificationActive()).toBe(true);
  await expect(f.qualify()).rejects.toBe(taskError);
  expect(f.operations.recover).toHaveBeenCalledTimes(2);
  expect(f.operations.qualifier).toHaveBeenCalledTimes(1);
  expect(f.setup.release).toHaveBeenCalledTimes(1);
  expect(f.activity.release).toHaveBeenCalledTimes(1);
});

it("does not qualify or release an unacquired lease when the original setup mutex is busy", async () => {
  const f = fixture();
  f.operations.lockImpl.mockResolvedValue(null);
  await expect(f.qualify()).rejects.toThrow("FLEET_PREPARE_BUSY");
  expect(f.maintenance.begin).not.toHaveBeenCalled();
  expect(f.operations.qualifier).not.toHaveBeenCalled();
  expect(f.setup.release).not.toHaveBeenCalled();
  expect(f.activity.release).not.toHaveBeenCalled();
  expect(f.coordinator.qualificationActive()).toBe(false);
});

it("requires original maintenance/rebind owners and uses the branded activity observation", () => {
  const f = fixture(),
    operations = f.operations as unknown as StorePreparationOperations;
  expect(() => StoreFleetPreparation.open(f.host, operations)).toThrow(
    "FLEET_PREPARE_REQUIRED",
  );
  expect(() =>
    StoreFleetPreparation.open(f.host, operations, {
      maintenance: f.maintenance as unknown as StorePrepareMaintenance,
    }),
  ).toThrow("FLEET_PREPARE_REQUIRED");
  expect(() =>
    StoreFleetPreparation.open({ ...f.host } as HostContext, operations, {
      maintenance: f.maintenance as unknown as StorePrepareMaintenance,
      rebind: f.rebind,
    }),
  ).toThrow("OPERATIONS_OWNER_DENIED");
  expect(() =>
    StoreFleetPreparation.prototype.qualificationActive.call(
      Object.create(StoreFleetPreparation.prototype),
    ),
  ).toThrow();
  expect(() =>
    Reflect.apply(f.coordinator.qualificationActive, f.coordinator, [true]),
  ).toThrow("FLEET_PREPARE_REQUIRED");
  f.maintenance.alive = false;
  expect(() => f.coordinator.qualificationActive()).toThrow(
    "MAINTENANCE_OWNER_DENIED",
  );
  expect(f.operations.lockImpl).not.toHaveBeenCalled();
  expect(f.operations.qualifier).not.toHaveBeenCalled();
});
