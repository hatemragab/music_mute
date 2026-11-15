import { beforeEach, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import type { StorePreparationOperations } from "../src/main/prepare/store-operations.js";
import type { StorePrepareMaintenance } from "../src/main/prepare/store-maintenance.js";
import type { StoreDesktopConnection } from "../src/main/session/store-desktop-client.js";
import type { StoreBenchmarkRequest } from "../src/shared/store-benchmark-contracts.js";
// Synthetic module boundaries test the actual private strategy owner. These
// fixtures are not Store package/process/GPU/native cleanup authority.
const boundary = vi.hoisted(() => {
  const benchmark = {
    events: [] as string[],
    launch: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    recover: vi.fn(async () => {}),
    raw: vi.fn<() => Promise<Buffer>>(),
    write: vi.fn(async (_path: string, _bytes: Buffer) => {}),
    wall: 800,
  };
  class Execution {
    #host: object;
    constructor(host: object) {
      this.#host = host;
    }
    assertHost(host: object) {
      if (host !== this.#host) throw Error("FOREIGN_EXECUTION");
    }
    async launch() {
      benchmark.events.push("launch");
      await benchmark.launch();
    }
    async run() {
      benchmark.events.push("run");
      await benchmark.run();
    }
    resultObservation() {
      return { wallSeconds: benchmark.wall };
    }
    readResult() {
      return benchmark.raw();
    }
    async close() {
      benchmark.events.push("close");
      await benchmark.close();
    }
    async recoverClose() {
      benchmark.events.push("recover-close");
      await benchmark.recover();
    }
  }
  class Operations {
    #host: unknown;
    controlImpl = vi.fn();
    heldImpl = vi.fn<(...args: unknown[]) => Promise<void>>(
      async () => undefined,
    );
    targetImpl = vi.fn();
    lockImpl = vi.fn();
    readyImpl = vi.fn();
    viewImpl = vi.fn();
    recover = vi.fn();
    pending = false;
    constructor(host: unknown) {
      this.#host = host;
    }
    assertHost(host: unknown) {
      if (host !== this.#host) throw Error("FOREIGN_HOST");
    }
    controlSession(...args: unknown[]) {
      return this.controlImpl(...args);
    }
    maintenanceSession(...args: unknown[]) {
      return this.controlImpl(...args);
    }
    assertHeldMutation(...args: unknown[]) {
      return this.heldImpl(...args);
    }
    target(...args: unknown[]) {
      return this.targetImpl(...args);
    }
    lock(...args: unknown[]) {
      return this.lockImpl(...args);
    }
    snapshotStoreReady(...args: unknown[]) {
      return this.readyImpl(...args);
    }
    mediaCodeView(...args: unknown[]) {
      return this.viewImpl(...args);
    }
    cleanupPending() {
      return this.pending;
    }
    recoverCleanup() {
      return this.recover();
    }
  }
  class Session {
    #host: object;
    owner = vi.fn();
    peer = vi.fn();
    view = vi.fn();
    opening = vi.fn(async (_request: StoreBenchmarkRequest) => {});
    original: StoreBenchmarkRequest | undefined;
    close = vi.fn();
    constructor(host: object) {
      this.#host = host;
    }
    currentFleetOwner() {
      if (!this.#host) throw Error("FOREIGN_SESSION");
      return this.owner();
    }
    inspectFleetPeer(...args: unknown[]) {
      if (!this.#host) throw Error("FOREIGN_SESSION");
      return this.peer(...args);
    }
    benchmarkCodeView() {
      return this.view();
    }
    async openBenchmark(request: StoreBenchmarkRequest) {
      this.original = request;
      benchmark.events.push("factory");
      await this.opening(request);
      return new Execution(this.#host);
    }
  }
  class Connection {
    #host: unknown;
    #operations: unknown;
    constructor(host: unknown, operations: unknown) {
      this.#host = host;
      this.#operations = operations;
    }
    assertHost(host: unknown, operations: unknown) {
      if (host !== this.#host || operations !== this.#operations)
        throw Error("FOREIGN_CONNECTION");
    }
  }
  class Maintenance {
    #host: unknown;
    begin = vi.fn();
    finish = vi.fn();
    recover = vi.fn();
    recoverMutationImpl = vi.fn();
    pending = false;
    constructor(host: unknown) {
      this.#host = host;
    }
    assertHost(host: unknown) {
      if (host !== this.#host) throw Error("FOREIGN_MAINTENANCE");
    }
    beforeForcedMutation(...args: unknown[]) {
      return this.begin(...args);
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
    Connection,
    Maintenance,
    Session,
    Execution,
    benchmark,
    files: vi.fn(),
    active: vi.fn(),
  };
});
vi.mock("../src/main/prepare/store-operations.js", () => ({
  StorePreparationOperations: boundary.Operations,
}));
vi.mock("../src/main/session/store-session-client.js", () => ({
  StoreSessionClient: boundary.Session,
}));
vi.mock("../src/main/session/store-benchmark-execution.js", () => ({
  StoreBenchmarkExecution: boundary.Execution,
}));
vi.mock("../src/main/prepare/private-files.js", () => ({
  writePrivateAtomic: async (_host: object, path: string, bytes: Buffer) => {
    boundary.benchmark.events.push("write-result");
    await boundary.benchmark.write(path, bytes);
  },
}));
vi.mock("../src/main/fleet/advanced/inspection.js", () => ({
  createFleetPrivateFiles: () => ({ read: boundary.files }),
}));
vi.mock("../src/main/session/store-desktop-client.js", () => ({
  StoreDesktopConnection: boundary.Connection,
}));
vi.mock("../src/main/prepare/store-maintenance.js", () => ({
  StorePrepareMaintenance: boundary.Maintenance,
}));
vi.mock("../src/main/fleet/store-active-runtime.js", () => ({
  readStoreFleetRuntimeIdentityForGui: boundary.active,
}));
import { StoreFleetAdvancedRuntime } from "../src/main/fleet/advanced/store-runtime.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import {
  advancedGpu,
  advancedRequest,
  advancedTransaction,
  benchmarkConfig,
  consumerCapacityRaw,
  consumerRepeatedRaw,
  processIdentity,
} from "./fleet-advanced-fixtures.js";
beforeEach(() => {
  vi.clearAllMocks();
  boundary.benchmark.events.length = 0;
  for (const operation of [
    boundary.benchmark.launch,
    boundary.benchmark.run,
    boundary.benchmark.close,
    boundary.benchmark.recover,
    boundary.benchmark.write,
  ])
    operation.mockResolvedValue(undefined);
  boundary.benchmark.raw.mockImplementation(async () =>
    Buffer.from(JSON.stringify(consumerRepeatedRaw())),
  );
  boundary.benchmark.wall = 800;
});
function fixture() {
  const product = STORE_PRODUCTS.worker,
    fullName = `${product.identityName}_0.1.3.2_x64__${product.publisherId}`;
  const host = {
      native: { enumerateGpus: vi.fn(async () => [advancedGpu]) },
      identity: { ...processIdentity },
    } as unknown as HostContext,
    operations = new boundary.Operations(host),
    connection = new boundary.Connection(host, operations),
    maintenance = new boundary.Maintenance(host),
    events: string[] = [],
    rebind = vi.fn(async () => {
      events.push("rebind");
    }),
    setup = vi.fn(async () => {
      events.push("setup-release");
    }),
    activity = vi.fn(async () => {
      events.push("activity-release");
    }),
    binding = {
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
      sid: host.identity.sid,
      inventorySha256: "a".repeat(64),
      runtimeManifestSha256: "b".repeat(64),
      bootIdentity: "e".repeat(64),
      recipeDigests: {
        "kim-vocals-v2": "c".repeat(64),
        "kim-vocals-v2-trim": "d".repeat(64),
      },
    };
  operations.readyImpl.mockResolvedValue({
    binding,
    evidence: { gpuIdentity: advancedGpu },
  });
  operations.viewImpl.mockResolvedValue({
    binding,
    workerRoot: "C:\\Program Files\\WindowsApps\\Fixture\\worker",
    manifest: {
      releaseVersion: "0.1.3",
      entries: [
        {
          kind: "file",
          path: "runtime/native/musicmute-native.exe",
          sha256: "d".repeat(64),
        },
      ],
    },
  });
  const session = new boundary.Session(host);
  session.owner.mockResolvedValue(null);
  session.peer.mockResolvedValue(true);
  session.view.mockResolvedValue({
    binding,
    helperSha256: "d".repeat(64),
    engineDigest: "f".repeat(64),
  });
  operations.controlImpl.mockResolvedValue(session);
  operations.targetImpl.mockResolvedValue({
    sid: host.identity.sid,
    identity: "a".repeat(64),
  });
  operations.lockImpl.mockResolvedValue({ release: setup });
  maintenance.begin.mockResolvedValue({ release: activity });
  maintenance.finish.mockImplementation(
    async (task: Promise<void>, bind: () => Promise<void>) => {
      await task.catch(() => {});
      events.push("end-resume");
      await bind();
    },
  );
  const runtime = StoreFleetAdvancedRuntime.open(
    host,
    operations as unknown as StorePreparationOperations,
    connection as unknown as StoreDesktopConnection,
    maintenance as unknown as StorePrepareMaintenance,
    rebind,
  );
  return {
    host,
    operations,
    connection,
    session,
    maintenance,
    runtime,
    rebind,
    setup,
    activity,
    events,
    binding,
  };
}
it("uses explicit actual-bound Store observations with no legacy archive", async () => {
  const f = fixture(),
    ready = await f.runtime.ready(new AbortController().signal);
  expect(ready.distribution).toBe("microsoft-store");
  expect(ready.archiveSha256).toBeNull();
  expect(ready.release).toBe(f.binding.inventorySha256);
  expect(ready.storeBinding).toEqual(f.binding);
  f.operations.viewImpl.mockResolvedValue({
    binding: { ...f.binding, bootIdentity: "e".repeat(64) },
    manifest: { entries: [] },
  });
  await expect(f.runtime.ready(new AbortController().signal)).rejects.toThrow(
    "STORE_FLEET_ADVANCED_REQUIRED",
  );
});
it("retains the same Prepare/maintenance owner after lost end ACK and retries only its release", async () => {
  const f = fixture(),
    transaction = "ab9c4c74-7e0d-4cbd-9f04-2d5ce37019a7",
    port = f.runtime.maintenancePort();
  const lease = await port.acquire(transaction, new AbortController().signal);
  f.maintenance.finish.mockRejectedValueOnce(Error("LOST_END_ACK"));
  await expect(lease.release()).rejects.toThrow("LOST_END_ACK");
  expect(f.runtime.mutationActive()).toBe(true);
  await expect(f.runtime.close()).rejects.toThrow("ADVANCED_RECOVERY_REQUIRED");
  await expect(
    port.cancel(
      "cb9c4c74-7e0d-4cbd-9f04-2d5ce37019a7",
      new AbortController().signal,
    ),
  ).rejects.toThrow("ADVANCED_RECOVERY_REQUIRED");
  await port.cancel(transaction, new AbortController().signal);
  expect(f.maintenance.finish).toHaveBeenCalledTimes(2);
  expect(f.operations.lockImpl).toHaveBeenCalledOnce();
  expect(f.maintenance.begin).toHaveBeenCalledOnce();
  expect(f.setup).toHaveBeenCalledOnce();
  expect(f.activity).toHaveBeenCalledOnce();
  expect(f.events).toEqual([
    "setup-release",
    "activity-release",
    "end-resume",
    "rebind",
  ]);
  expect(f.runtime.mutationActive()).toBe(false);
});
it("authorizes only its own in-progress actual rebind and denies forged/foreign owners", async () => {
  const f = fixture(),
    port = f.runtime.maintenancePort();
  expect(f.runtime.authorizesRebind()).toBe(false);
  f.rebind.mockImplementation(async () => {
    expect(f.runtime.authorizesRebind()).toBe(true);
  });
  const lease = await port.acquire(
    "ab9c4c74-7e0d-4cbd-9f04-2d5ce37019a7",
    new AbortController().signal,
  );
  await lease.release();
  expect(f.runtime.authorizesRebind()).toBe(false);
  expect(() =>
    StoreFleetAdvancedRuntime.prototype.mutationActive.call(
      Object.create(StoreFleetAdvancedRuntime.prototype),
    ),
  ).toThrow();
  expect(() => f.runtime.assertHost({} as HostContext)).toThrow();
});
it("does not promote runtime JSON or a legacy benchmark owner into a Store process/child authority", async () => {
  const f = fixture();
  await expect(f.runtime.current({ processId: 42 } as never)).resolves.toBe(
    false,
  );
  await expect(
    f.runtime.assertAvailable("benchmark_file"),
  ).resolves.toBeUndefined();
  await expect(
    f.runtime.recoverBenchmark("ab9c4c74-7e0d-4cbd-9f04-2d5ce37019a7"),
  ).rejects.toThrow("ADVANCED_RECOVERY_REQUIRED");
  expect(f.operations.lockImpl).not.toHaveBeenCalled();
});

it("explicitly settles a failed original admission without replaying its permanently rejected opening", async () => {
  const f = fixture(),
    transaction = "ab9c4c74-7e0d-4cbd-9f04-2d5ce37019a7",
    original = Error("BEGIN_ACK_LOST"),
    port = f.runtime.maintenancePort();
  f.maintenance.begin.mockRejectedValueOnce(original);
  await expect(
    port.acquire(transaction, new AbortController().signal),
  ).rejects.toBe(original);
  expect(f.runtime.mutationActive()).toBe(true);
  await f.runtime.recoverAcquisition(transaction);
  expect(f.maintenance.begin).toHaveBeenCalledOnce();
  expect(f.operations.lockImpl).toHaveBeenCalledOnce();
  expect(f.setup).toHaveBeenCalledOnce();
  expect(f.maintenance.finish).toHaveBeenCalledOnce();
  expect(f.runtime.mutationActive()).toBe(false);
});
it("same-transaction forced recovery joins the admitted original Holding and rechecks its actual mutation lease", async () => {
  const f = fixture(),
    transaction = "ab9c4c74-7e0d-4cbd-9f04-2d5ce37019a7",
    signal = new AbortController().signal;
  await f.runtime.adoptForced(transaction, signal);
  await expect(
    f.runtime.recoverForcedAdmission(transaction, signal),
  ).resolves.toBe("ready");
  await f.runtime.adoptForced(transaction, signal);
  expect(f.operations.lockImpl).toHaveBeenCalledOnce();
  expect(f.maintenance.begin).toHaveBeenCalledOnce();
  expect(f.operations.heldImpl).toHaveBeenCalledTimes(2);
  await expect(
    f.runtime.adoptForced("cb9c4c74-7e0d-4cbd-9f04-2d5ce37019a7", signal),
  ).rejects.toThrow("ADVANCED_BUSY");
  await f.runtime.maintenancePort().cancel(transaction, signal);
});
it("failed forced admission recovers original cleanup without replaying force or claiming a backend effect", async () => {
  const f = fixture(),
    transaction = "ab9c4c74-7e0d-4cbd-9f04-2d5ce37019a7",
    signal = new AbortController().signal;
  f.maintenance.begin.mockRejectedValueOnce(Error("FORCED_BEGIN_ACK_LOST"));
  await expect(f.runtime.adoptForced(transaction, signal)).rejects.toThrow(
    "FORCED_BEGIN_ACK_LOST",
  );
  await expect(
    f.runtime.recoverForcedAdmission(transaction, signal),
  ).resolves.toBe("interrupted");
  expect(f.maintenance.begin).toHaveBeenCalledOnce();
  expect(f.operations.lockImpl).toHaveBeenCalledOnce();
  expect(f.runtime.mutationActive()).toBe(false);
});

it("binds current runtime observations to the actual original Fleet owner before and after the fixed status read", async () => {
  const f = fixture(),
    owner = {
      role: "fleet",
      nonce: "1".repeat(64),
      identity: {
        sid: f.host.identity.sid,
        sessionId: 1,
        pid: 42,
        creationTime: "1337133713371337",
      },
    },
    status = {
      schemaVersion: 1,
      activeAttemptIds: [],
      processId: 42,
      updatedAt: new Date().toISOString(),
    } as const;
  Object.assign(f.host.native, {
    ensurePrivateDirectory: vi.fn(async () => "fixed-fleet-root"),
  });
  f.session.owner.mockResolvedValue(owner);
  boundary.files.mockResolvedValue(Buffer.from(JSON.stringify(status)));
  await expect(
    f.runtime.current({ ...status, activeAttemptIds: [] }),
  ).resolves.toBe(true);
  expect(boundary.files).toHaveBeenCalledWith(
    "state\\runtime-status.json",
    16384,
  );
  expect(f.session.owner).toHaveBeenCalledTimes(2);
  expect(f.session.peer).toHaveBeenCalledWith(owner, owner.identity);
});
it("hides current attempts for replaced births/nonces, stale status or a denied actual peer", async () => {
  for (const cause of ["birth", "nonce", "status", "peer"]) {
    const f = fixture(),
      owner = {
        role: "fleet",
        nonce: "1".repeat(64),
        identity: {
          sid: f.host.identity.sid,
          sessionId: 1,
          pid: 42,
          creationTime: "1337133713371337",
        },
      },
      status = {
        schemaVersion: 1 as const,
        activeAttemptIds: [],
        processId: 42,
        updatedAt: new Date().toISOString(),
      };
    Object.assign(f.host.native, {
      ensurePrivateDirectory: vi.fn(async () => "fixed-fleet-root"),
    });
    f.session.owner.mockResolvedValue(owner);
    boundary.files.mockResolvedValue(Buffer.from(JSON.stringify(status)));
    if (cause === "birth")
      f.session.owner.mockResolvedValueOnce(owner).mockResolvedValueOnce({
        ...owner,
        identity: { ...owner.identity, creationTime: "1337133713371338" },
      });
    if (cause === "nonce")
      f.session.owner
        .mockResolvedValueOnce(owner)
        .mockResolvedValueOnce({ ...owner, nonce: "2".repeat(64) });
    if (cause === "status")
      boundary.files.mockResolvedValue(
        Buffer.from(JSON.stringify({ ...status, childState: "ready" })),
      );
    if (cause === "peer") f.session.peer.mockResolvedValue(false);
    await expect(f.runtime.current(status)).resolves.toBe(false);
  }
});

function benchmarkInput(
  operation: "benchmark_file" | "benchmark_capacity" = "benchmark_file",
) {
  const config = benchmarkConfig(operation);
  return {
    requestId: config.requestId,
    operation: config.operation,
    fixture: config.fixture,
    recipe: config.recipe,
    warmupRuns: config.warmupRuns,
    measuredRuns: config.measuredRuns,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("uses the original Store code/qualification and stores a real validated report only after exact execution cleanup", async () => {
  const f = fixture(),
    signal = new AbortController().signal,
    lease = await f.runtime
      .maintenancePort()
      .acquire(advancedTransaction, signal);
  f.runtime.stageBenchmark(advancedTransaction, advancedRequest);
  const output = await f.runtime.runBenchmark(
    advancedTransaction,
    benchmarkInput(),
    signal,
  );
  expect(output.report).toMatchObject({
    status: "PASS",
    sourceMode: "installed-engine",
    audioSettings: { groupSize: 1 },
  });
  expect(output.relativePath).toBe(
    `prepare\\results\\${advancedRequest}.benchmark.json`,
  );
  expect(f.session.original?.binding).toEqual(f.binding);
  expect(f.session.original?.configuration).toMatchObject({
    helperSha256: "d".repeat(64),
    gpu: advancedGpu,
    recipe: "kim-vocals-v2",
  });
  expect(boundary.benchmark.events).toEqual([
    "factory",
    "launch",
    "run",
    "close",
    "write-result",
  ]);
  // The caller wipes its temporary metadata bytes after the actual writer
  // settles; the receiving writer observes the JSON while it owns the bytes.
  expect(boundary.benchmark.write).toHaveBeenCalledOnce();
  expect(f.operations.lockImpl).toHaveBeenCalledOnce();
  expect(f.maintenance.begin).toHaveBeenCalledOnce();
  expect(f.session.close).not.toHaveBeenCalled();
  await lease.release();
  expect(f.runtime.mutationActive()).toBe(false);
});
it("uses the unchanged capacity validator and the original Prepare owner without a second setup lease", async () => {
  const f = fixture(),
    signal = new AbortController().signal,
    lease = await f.runtime
      .maintenancePort()
      .acquire(advancedTransaction, signal);
  boundary.benchmark.raw.mockImplementation(async () =>
    Buffer.from(JSON.stringify(consumerCapacityRaw())),
  );
  const output = await f.runtime.runBenchmark(
    advancedTransaction,
    benchmarkInput("benchmark_capacity"),
    signal,
  );
  expect(output.report).toMatchObject({
    status: "PASS",
    kind: "two-worker-capacity",
  });
  expect(f.session.original?.configuration).toMatchObject({
    warmupRuns: 1,
    measuredRuns: 3,
    recipe: "kim-vocals-v2",
  });
  expect(f.operations.lockImpl).toHaveBeenCalledOnce();
  await lease.release();
});
it("rejects a benchmark before any factory IO when its real maintenance owner is absent or foreign", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  await expect(
    f.runtime.runBenchmark(advancedTransaction, benchmarkInput(), signal),
  ).rejects.toThrow("ADVANCED_RECOVERY_REQUIRED");
  await f.runtime.maintenancePort().acquire(advancedTransaction, signal);
  await expect(
    f.runtime.runBenchmark(
      "eb9c4c74-7e0d-4cbd-9f04-2d5ce37019a7",
      benchmarkInput(),
      signal,
    ),
  ).rejects.toThrow("ADVANCED_RECOVERY_REQUIRED");
  expect(f.session.opening).not.toHaveBeenCalled();
});
it("selects only the current protected Store engine candidate and compares its exact digest again before launch", async () => {
  const f = fixture(),
    signal = new AbortController().signal,
    lease = await f.runtime
      .maintenancePort()
      .acquire(advancedTransaction, signal);
  const candidate = await f.runtime.currentCandidate(
    f.binding.inventorySha256,
    signal,
  );
  expect(candidate).toEqual({
    release: f.binding.inventorySha256,
    manifestSha256: f.binding.runtimeManifestSha256,
    engineDigest: "f".repeat(64),
  });
  await expect(
    f.runtime.currentCandidate("9".repeat(64), signal),
  ).rejects.toThrow("ADVANCED_CANDIDATE_UNAVAILABLE");
  await expect(
    f.runtime.runBenchmark(
      advancedTransaction,
      {
        ...benchmarkInput(),
        candidate: { ...candidate, engineDigest: "0".repeat(64) },
      },
      signal,
    ),
  ).rejects.toThrow("ADVANCED_CANDIDATE_INVALID");
  expect(f.session.opening).not.toHaveBeenCalled();
  await f.runtime.recoverBenchmark(advancedTransaction);
  await lease.release();
});
it("retains the original failed launch/close and retries only that execution while maintenance stays fenced", async () => {
  const f = fixture(),
    signal = new AbortController().signal,
    lease = await f.runtime
      .maintenancePort()
      .acquire(advancedTransaction, signal),
    launchError = Error("LOST_LAUNCH_ACK"),
    closeError = Error("GPU_CLOSE_UNKNOWN");
  boundary.benchmark.launch.mockRejectedValueOnce(launchError);
  boundary.benchmark.close.mockRejectedValueOnce(closeError);
  const original = f.runtime.runBenchmark(
    advancedTransaction,
    benchmarkInput(),
    signal,
  );
  await expect(original).rejects.toMatchObject({
    message: "ADVANCED_BENCHMARK_CLEANUP_UNCONFIRMED",
    errors: [launchError, closeError],
  });
  await expect(lease.release()).rejects.toThrow(
    "ADVANCED_BENCHMARK_TREE_UNCERTAIN",
  );
  expect(f.setup).not.toHaveBeenCalled();
  expect(boundary.benchmark.write).not.toHaveBeenCalled();
  await f.runtime.recoverBenchmark(advancedTransaction);
  expect(boundary.benchmark.recover).toHaveBeenCalledOnce();
  expect(f.session.opening).toHaveBeenCalledOnce();
  expect(boundary.benchmark.launch).toHaveBeenCalledOnce();
  await expect(original).rejects.toMatchObject({
    errors: [launchError, closeError],
  });
  await lease.release();
  expect(f.runtime.mutationActive()).toBe(false);
});
it("joins an in-construction original execution on recovery and prevents its later launch", async () => {
  const f = fixture(),
    signal = new AbortController().signal,
    lease = await f.runtime
      .maintenancePort()
      .acquire(advancedTransaction, signal),
    opening = deferred<void>();
  f.session.opening.mockImplementationOnce(() => opening.promise);
  const task = f.runtime.runBenchmark(
    advancedTransaction,
    benchmarkInput(),
    signal,
  );
  await vi.waitFor(() => expect(f.session.opening).toHaveBeenCalledOnce());
  let settled = false;
  const recovery = f.runtime.recoverBenchmark(advancedTransaction).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  opening.resolve();
  await expect(task).rejects.toThrow("ADVANCED_CANCELLED");
  await recovery;
  expect(boundary.benchmark.launch).not.toHaveBeenCalled();
  expect(boundary.benchmark.close).toHaveBeenCalledOnce();
  await lease.release();
});
it("captures plain input descriptors before any await and never invokes caller serialization/getters", async () => {
  const f = fixture(),
    signal = new AbortController().signal,
    lease = await f.runtime
      .maintenancePort()
      .acquire(advancedTransaction, signal),
    input = benchmarkInput();
  const task = f.runtime.runBenchmark(advancedTransaction, input, signal);
  input.fixture.sha256 = "9".repeat(64);
  await task;
  expect(f.session.original?.configuration.fixture.sha256).toBe("c".repeat(64));
  await lease.release();
  const g = fixture(),
    held = await g.runtime
      .maintenancePort()
      .acquire(advancedTransaction, signal),
    getter = vi.fn();
  const malformed = Object.defineProperty(benchmarkInput(), "fixture", {
    enumerable: true,
    get: getter,
  });
  await expect(
    g.runtime.runBenchmark(advancedTransaction, malformed, signal),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(g.session.opening).not.toHaveBeenCalled();
  await held.release();
});
it("withholds summaries on generation change after cleanup and does not replay the closed benchmark during recovery", async () => {
  const f = fixture(),
    signal = new AbortController().signal,
    lease = await f.runtime
      .maintenancePort()
      .acquire(advancedTransaction, signal);
  f.operations.readyImpl
    .mockResolvedValueOnce({
      binding: f.binding,
      evidence: { gpuIdentity: advancedGpu },
    })
    .mockResolvedValueOnce({
      binding: {
        ...f.binding,
        package: { ...f.binding.package, fullName: "changed-generation" },
      },
      evidence: { gpuIdentity: advancedGpu },
    });
  const view = await f.operations.viewImpl();
  f.operations.viewImpl.mockResolvedValueOnce(view).mockResolvedValueOnce({
    ...view,
    binding: {
      ...f.binding,
      package: { ...f.binding.package, fullName: "changed-generation" },
    },
  });
  await expect(
    f.runtime.runBenchmark(advancedTransaction, benchmarkInput(), signal),
  ).rejects.toThrow("ADVANCED_RUNTIME_CHANGED");
  expect(boundary.benchmark.close).toHaveBeenCalledOnce();
  expect(boundary.benchmark.write).not.toHaveBeenCalled();
  await f.runtime.recoverBenchmark(advancedTransaction);
  expect(boundary.benchmark.recover).not.toHaveBeenCalled();
  expect(f.session.opening).toHaveBeenCalledOnce();
  await lease.release();
});
it("retains original cleanup after a summary publication failure and rejects imported owner journals", async () => {
  const f = fixture(),
    signal = new AbortController().signal,
    lease = await f.runtime
      .maintenancePort()
      .acquire(advancedTransaction, signal),
    error = Error("SUMMARY_ACK_LOST");
  boundary.benchmark.write.mockRejectedValueOnce(error);
  const original = f.runtime.runBenchmark(
    advancedTransaction,
    benchmarkInput(),
    signal,
  );
  await expect(original).rejects.toBe(error);
  await f.runtime.recoverBenchmark(advancedTransaction);
  expect(boundary.benchmark.close).toHaveBeenCalledOnce();
  expect(boundary.benchmark.recover).not.toHaveBeenCalled();
  await lease.release();
  const g = fixture();
  await g.runtime.maintenancePort().acquire(advancedTransaction, signal);
  await expect(g.runtime.recoverBenchmark(advancedTransaction)).rejects.toThrow(
    "ADVANCED_BENCHMARK_TREE_UNCERTAIN",
  );
  expect(g.session.opening).not.toHaveBeenCalled();
});
it("recovers a retained pre-launch staging owner without inventing a Prepare process", async () => {
  const f = fixture(),
    signal = new AbortController().signal,
    lease = await f.runtime
      .maintenancePort()
      .acquire(advancedTransaction, signal);
  f.runtime.stageBenchmark(advancedTransaction, advancedRequest);
  await f.runtime.recoverBenchmark(advancedTransaction);
  expect(f.session.opening).not.toHaveBeenCalled();
  expect(boundary.benchmark.close).not.toHaveBeenCalled();
  await lease.release();
});
