import { win32 } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MODEL } from "../../chrome-extension/src/shared/local-model.js";
import type { PersonalAdmission } from "../../worker/src/runtime/personal-admission.js";
import { createStoreFleetWorkerRuntime } from "../src/main/fleet/store-worker-runtime.js";
import { StoreFleetChildContext } from "../src/main/session/store-fleet-child-context.js";
import { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";
import { StoreFleetMachineSupervisor } from "../src/main/fleet/store-machine-supervisor.js";
import { StoreFleetTransfers } from "../src/main/fleet/store-transfers.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import { record } from "./fleet-fixtures.js";

// Explicit synthetic private module boundaries. These exercise composition and
// failure retention only; no Store package, native actor, GPU or file exists.
const boundary = vi.hoisted(() => ({
  current: vi.fn(),
  active: vi.fn(),
  gpu: vi.fn(),
  removed: vi.fn(),
  capacity: vi.fn(),
  supervisorOpen: vi.fn(),
  supervisorStop: vi.fn(),
  transferOpen: vi.fn(),
  transferClose: vi.fn(),
  workspaceOpen: vi.fn(),
  runtime: vi.fn(),
  hint: vi.fn(),
  control: vi.fn(),
  lstat: vi.fn(),
  loadLifecycle: vi.fn(),
  initializeLifecycle: vi.fn(),
  setIntent: vi.fn(),
}));
vi.mock("../src/main/session/store-fleet-child-context.js", () => ({
  StoreFleetChildContext: class {
    #live = true;
    constructor(fields: object) {
      Object.assign(this, fields);
    }
    assertAssociation() {
      if (!this.#live) throw Error("FOREIGN_CONTEXT");
    }
    async assertCurrent() {
      this.assertAssociation();
      return boundary.current();
    }
  },
}));
vi.mock("../src/main/session/store-node-issuer.js", () => ({
  StoreNodeIssuer: class {
    #native: object;
    inventorySha256 = "a".repeat(64);
    workerRoot = "C:\\Program Files\\WindowsApps\\fixture\\worker";
    constructor(native: object) {
      this.#native = native;
    }
    assertNative(native: object) {
      if (native !== this.#native) throw Error("FOREIGN_NATIVE");
    }
  },
}));
vi.mock("../src/main/fleet/store-machine-supervisor.js", () => ({
  StoreFleetMachineSupervisor: class {
    #owned = true;
    static open(...args: unknown[]) {
      return boundary.supervisorOpen(...args);
    }
    stop() {
      if (!this.#owned) throw Error("FOREIGN_SUPERVISOR");
      return boundary.supervisorStop(this);
    }
  },
}));
vi.mock("../src/main/fleet/store-transfers.js", () => ({
  StoreFleetTransfers: class {
    #owned = true;
    static open(...args: unknown[]) {
      return boundary.transferOpen(...args);
    }
    close() {
      if (!this.#owned) throw Error("FOREIGN_TRANSFERS");
      return boundary.transferClose(this);
    }
  },
}));
vi.mock("../src/main/fleet/store-workspace.js", () => ({
  StoreFleetWorkspace: class {
    static open(...args: unknown[]) {
      return boundary.workspaceOpen(...args);
    }
  },
}));
vi.mock("../src/main/fleet/store-active-runtime.js", () => ({
  readStoreFleetRuntimeIdentity: (...args: unknown[]) =>
    boundary.active(...args),
}));
vi.mock("../src/main/admission/current-gpu.js", () => ({
  readCurrentFleetGpu: (...args: unknown[]) => boundary.gpu(...args),
}));
vi.mock("../src/main/fleet/advanced/removal-marker.js", () => ({
  consumerFleetRemoved: (...args: unknown[]) => boundary.removed(...args),
}));
vi.mock("../src/main/fleet/advanced/capacity.js", async (original) => ({
  ...(await original<
    typeof import("../src/main/fleet/advanced/capacity.js")
  >()),
  consumerFleetRuntimeSlots: (...args: unknown[]) => boundary.capacity(...args),
}));
vi.mock("../../worker/src/runtime/worker-runtime.js", () => ({
  WorkerRuntime: class {
    constructor(...args: unknown[]) {
      boundary.runtime(...args);
    }
  },
}));
vi.mock("../../worker/src/runtime/control-plane-client.js", () => ({
  WorkerControlPlaneClient: class {
    constructor(options: unknown) {
      boundary.control(options);
    }
  },
}));
vi.mock("../../worker/src/runtime/worker-hint-client.js", () => ({
  WorkerHintClient: class {
    constructor(...args: unknown[]) {
      boundary.hint(...args);
    }
  },
}));
vi.mock("../../worker/src/runtime/local-lifecycle.js", () => ({
  loadLocalLifecycle: (...args: unknown[]) => boundary.loadLifecycle(...args),
  initializeLocalLifecycle: (...args: unknown[]) =>
    boundary.initializeLifecycle(...args),
  setLocalLifecycleIntent: (...args: unknown[]) => boundary.setIntent(...args),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  lstat: (...args: unknown[]) => boundary.lstat(...args),
}));
beforeEach(() => {
  for (const spy of Object.values(boundary)) spy.mockReset();
  boundary.removed.mockResolvedValue(false);
  boundary.supervisorStop.mockResolvedValue(undefined);
  boundary.transferClose.mockResolvedValue(undefined);
  boundary.initializeLifecycle.mockResolvedValue(undefined);
  boundary.loadLifecycle.mockResolvedValue(undefined);
  boundary.setIntent.mockResolvedValue(undefined);
  boundary.lstat.mockRejectedValue(
    Object.assign(Error("missing"), { code: "ENOENT" }),
  );
  vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
});
afterEach(() => vi.unstubAllGlobals());
function fixture(workers: 1 | 2 = 1) {
  const input = record();
  input.prepared.modelDigest = MODEL.sha256;
  input.prepared.report.runtime.modelDigest = MODEL.sha256;
  const saved = structuredClone(input),
    identity = {
      sid: input.sid,
      sessionId: 1,
      pid: 123,
      creationTime: "132000000000000001",
      localAppData: "C:\\Users\\fixture\\AppData\\Local",
      logonSid: "S-1-5-5-1-1",
      nativeArch: "x64",
      processArch: "x64",
      osMajor: 10,
      osBuild: 19045,
    },
    native = {
      identity: vi.fn(async () => identity),
      bootIdentity: vi.fn(async () => "e".repeat(64)),
      vaultRead: vi.fn(async (_namespace: string, key: string) =>
        key === "enrollment" ? Buffer.from(JSON.stringify(saved)) : null,
      ),
      ensurePrivateDirectory: vi.fn(
        async (_namespace: string, relative: string) =>
          win32.join(identity.localAppData, "MusicMuteWorker", relative),
      ),
      validatePath: vi.fn(async () => {}),
      inferenceIdle: vi.fn(async () => true),
    },
    host = {
      native,
      identity,
      personalRoot: win32.join(identity.localAppData, "MusicMuteLocal"),
    },
    issuer = Reflect.construct(StoreNodeIssuer, [native]) as StoreNodeIssuer,
    context = Reflect.construct(StoreFleetChildContext, [
      {
        host,
        native,
        storeIssuer: issuer,
        role: "fleet",
        ownerIdentity: identity,
        personalRoot: host.personalRoot,
        fleetRoot: win32.join(identity.localAppData, "MusicMuteWorker"),
        releaseRoot: issuer.workerRoot,
      },
    ]) as StoreFleetChildContext,
    product = STORE_PRODUCTS.worker,
    fullName = `${product.identityName}_0.1.3.1_x64__${product.publisherId}`,
    binding = {
      package: {
        ...product,
        fullName,
        packageVersion: "0.1.3.1",
        architecture: "x64",
        signatureKind: 3,
        healthy: true,
        current: true,
        installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
      },
      inventorySha256: "a".repeat(64),
      runtimeManifestSha256: "b".repeat(64),
      sid: input.sid,
      bootIdentity: "e".repeat(64),
      recipeDigests: {
        "kim-vocals-v2": "0".repeat(64),
        "kim-vocals-v2-trim": "1".repeat(64),
      },
    },
    active = {
      gpu: input.prepared.gpu,
      release: binding.inventorySha256,
      manifestDigest: binding.runtimeManifestSha256,
      modelDigest: String(MODEL.sha256),
      bootIdentity: binding.bootIdentity,
      storeBinding: structuredClone(binding),
      fixtureDigest: input.prepared.fixtureDigest,
    },
    supervisor = Reflect.construct(
      StoreFleetMachineSupervisor,
      [],
    ) as StoreFleetMachineSupervisor,
    transfers = Reflect.construct(
      StoreFleetTransfers,
      [],
    ) as StoreFleetTransfers,
    workspace = { initialize: vi.fn(), create: vi.fn(), cleanup: vi.fn() },
    admission: PersonalAdmission = {
      start: vi.fn(async () => {}),
      pending: vi.fn(() => false),
      grant: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
  boundary.current.mockImplementation(async () => ({
    binding: structuredClone(binding),
  }));
  boundary.active.mockResolvedValue(active);
  boundary.gpu.mockResolvedValue(input.prepared.gpu);
  boundary.capacity.mockResolvedValue({
    workerIds:
      workers === 1
        ? [input.workerId]
        : [input.workerId, "51234567-1234-4234-8234-123456789012"],
    validatedMaxWorkersPerGpu: workers,
  });
  boundary.supervisorOpen.mockResolvedValue(supervisor);
  boundary.transferOpen.mockResolvedValue(transfers);
  boundary.workspaceOpen.mockResolvedValue(workspace);
  return {
    input,
    saved,
    identity,
    native,
    host,
    issuer,
    context,
    binding,
    active,
    supervisor,
    transfers,
    workspace,
    admission,
  };
}
it.each([1, 2] as const)(
  "composes %i currently validated GPU slots with the original Store owners and paused lifecycle",
  async (workers) => {
    const f = fixture(workers),
      result = await createStoreFleetWorkerRuntime(
        f.context,
        f.input,
        f.admission,
      ),
      [options, control, transfers, inference] =
        boundary.runtime.mock.calls[0]!;
    expect(options.slots).toHaveLength(workers);
    expect(
      options.slots.every(
        (slot: { provider: string; directmlDeviceId: number }) =>
          slot.provider === "directml" &&
          slot.directmlDeviceId === f.input.prepared.gpu.deviceIndex,
      ),
    ).toBe(true);
    expect(options.workspace).toBe(f.workspace);
    expect(options.validatedMaxWorkersPerGpu).toBe(workers);
    expect(options.workRoot).toBe(win32.join(f.context.fleetRoot, "work"));
    expect(options.modelCacheRoot).toBe(
      win32.join(f.context.personalRoot, "models"),
    );
    expect(transfers).toBe(f.transfers);
    expect(result.transfers).toBe(f.transfers);
    expect(result.inference).toBe(inference);
    expect(result.inference.idle()).toBe(true);
    expect(boundary.gpu).toHaveBeenCalledWith(
      f.native,
      f.binding.inventorySha256,
      f.issuer,
    );
    expect(boundary.control).toHaveBeenCalledWith({
      baseUrl: f.input.backendOrigin,
      credential: f.input.machineCredential,
    });
    expect(boundary.supervisorOpen.mock.calls[0]![3]).toBe(workers);
    expect(boundary.initializeLifecycle).toHaveBeenCalledOnce();
    expect(boundary.setIntent).toHaveBeenCalledWith(
      options.localLifecyclePath,
      "paused",
    );
    const hint = vi.fn();
    options.hintClientFactory(hint);
    expect(boundary.hint).toHaveBeenCalledWith(control, hint);
    expect(boundary.supervisorStop).not.toHaveBeenCalled();
    expect(boundary.transferClose).not.toHaveBeenCalled();
  },
);
it("requires the real context private brand before reading caller host getters", async () => {
  const f = fixture(),
    getHost = vi.fn(),
    forged = Object.create(StoreFleetChildContext.prototype);
  Object.defineProperty(forged, "host", { get: getHost });
  await expect(
    createStoreFleetWorkerRuntime(forged, f.input, f.admission),
  ).rejects.toThrow();
  expect(getHost).not.toHaveBeenCalled();
  expect(boundary.current).not.toHaveBeenCalled();
});
it("rejects admission accessors before invoking them or performing GPU/filesystem operations", async () => {
  const f = fixture(),
    getter = vi.fn(),
    admission = { ...f.admission };
  Object.defineProperty(admission, "pending", { get: getter });
  await expect(
    createStoreFleetWorkerRuntime(f.context, f.input, admission),
  ).rejects.toThrow("FLEET_ADMISSION_UNAVAILABLE");
  expect(getter).not.toHaveBeenCalled();
  expect(boundary.active).not.toHaveBeenCalled();
  expect(f.native.ensurePrivateDirectory).not.toHaveBeenCalled();
});
it("keeps captured enrollment credentials and admission methods when the caller changes them during a read", async () => {
  const f = fixture();
  let resume!: () => void;
  boundary.active.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      resume = resolve;
    });
    return f.active;
  });
  const pending = createStoreFleetWorkerRuntime(
      f.context,
      f.input,
      f.admission,
    ),
    original = f.admission.pending;
  await vi.waitFor(() => expect(boundary.active).toHaveBeenCalledOnce());
  f.input.machineCredential = "z".repeat(43);
  f.admission.pending = vi.fn(() => true);
  resume();
  await pending;
  expect(boundary.control.mock.calls[0]![0].credential).toBe(
    f.saved.machineCredential,
  );
  expect(boundary.runtime.mock.calls[0]![0].personalAdmission.pending()).toBe(
    false,
  );
  expect(original).toHaveBeenCalledOnce();
  expect(f.admission.pending).not.toHaveBeenCalled();
});
it("captures original invocation inputs before the first asynchronous code check", async () => {
  const f = fixture();
  let resume!: () => void;
  boundary.current.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      resume = resolve;
    });
    return { binding: structuredClone(f.binding) };
  });
  const original = f.admission.pending,
    pending = createStoreFleetWorkerRuntime(f.context, f.input, f.admission);
  await vi.waitFor(() => expect(boundary.current).toHaveBeenCalledOnce());
  f.input.machineCredential = "z".repeat(43);
  f.admission.pending = vi.fn(() => true);
  resume();
  await pending;
  expect(boundary.control.mock.calls[0]![0].credential).toBe(
    f.saved.machineCredential,
  );
  expect(boundary.runtime.mock.calls[0]![0].personalAdmission.pending()).toBe(
    false,
  );
  expect(original).toHaveBeenCalledOnce();
  expect(f.admission.pending).not.toHaveBeenCalled();
});
it("rejects changed actual enrollment before creating work/state/log directories", async () => {
  const f = fixture();
  boundary.capacity.mockImplementationOnce(async () => {
    f.saved.machineCredential = "z".repeat(43);
    return { workerIds: [f.saved.workerId], validatedMaxWorkersPerGpu: 1 };
  });
  await expect(
    createStoreFleetWorkerRuntime(f.context, f.input, f.admission),
  ).rejects.toThrow("FLEET_CONTEXT_INVALID");
  expect(f.native.ensurePrivateDirectory).not.toHaveBeenCalled();
  expect(boundary.supervisorOpen).not.toHaveBeenCalled();
});
it.each(["removed", "unsupported-build", "wrong-root", "changed-model"])(
  "denies %s without constructing a runtime",
  async (kind) => {
    const f = fixture();
    if (kind === "removed") boundary.removed.mockResolvedValue(true);
    if (kind === "unsupported-build") f.identity.osBuild = 19044;
    if (kind === "wrong-root")
      Object.assign(f.context, { fleetRoot: "C:\\foreign" });
    if (kind === "changed-model") f.active.modelDigest = "9".repeat(64);
    await expect(
      createStoreFleetWorkerRuntime(f.context, f.input, f.admission),
    ).rejects.toThrow("FLEET_CONTEXT_INVALID");
    expect(boundary.runtime).not.toHaveBeenCalled();
    expect(boundary.supervisorOpen).not.toHaveBeenCalled();
  },
);
it("does not initialize over a denied existing lifecycle file", async () => {
  const f = fixture();
  boundary.lstat.mockRejectedValueOnce(
    Object.assign(Error("denied"), { code: "EACCES" }),
  );
  await expect(
    createStoreFleetWorkerRuntime(f.context, f.input, f.admission),
  ).rejects.toThrow("denied");
  expect(boundary.initializeLifecycle).not.toHaveBeenCalled();
  expect(boundary.setIntent).not.toHaveBeenCalled();
});
it("retains the real context and attempts both original actor cleanups when initial native inference idleness fails", async () => {
  const f = fixture();
  f.native.inferenceIdle.mockResolvedValue(false);
  await expect(
    createStoreFleetWorkerRuntime(f.context, f.input, f.admission),
  ).rejects.toThrow("FLEET_STOP_UNCONFIRMED");
  expect(boundary.runtime).not.toHaveBeenCalled();
  expect(boundary.supervisorStop).toHaveBeenCalledWith(f.supervisor);
  expect(boundary.transferClose).toHaveBeenCalledWith(f.transfers);
});
it("attempts both cleanup owners and retains both failures when current code changes during construction", async () => {
  const f = fixture(),
    supervisorFailure = Error("ORIGINAL_ENGINE_CLOSE_PENDING"),
    transferFailure = Error("ORIGINAL_TRANSFER_CLOSE_PENDING");
  boundary.workspaceOpen.mockImplementationOnce(async () => {
    f.binding.inventorySha256 = "9".repeat(64);
    return f.workspace;
  });
  boundary.supervisorStop.mockImplementationOnce(() => {
    throw supervisorFailure;
  });
  boundary.transferClose.mockRejectedValueOnce(transferFailure);
  const error = await createStoreFleetWorkerRuntime(
    f.context,
    f.input,
    f.admission,
  ).catch((error) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.message).toBe("CHILD_SHUTDOWN_PENDING");
  expect(error.errors).toHaveLength(3);
  expect(error.errors).toContain(supervisorFailure);
  expect(error.errors).toContain(transferFailure);
  expect(boundary.transferClose).toHaveBeenCalledOnce();
  expect(boundary.supervisorStop).toHaveBeenCalledOnce();
  expect(boundary.runtime).not.toHaveBeenCalled();
});
