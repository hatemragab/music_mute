import { beforeEach, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import {
  PreparationQualificationRunner,
  selectTrustedPreparationGpu,
  QualificationCleanupUnconfirmed,
} from "../src/main/prepare/qualification-runner.js";
import { gpu, receipt, sid, bootIdentity } from "./fixtures/prepare.js";
import { processIdentityToWire } from "../../worker/src/platform/windows/consumer-native-policy.js";

const state = vi.hoisted(() => ({
  events: [] as string[],
  configuration: {} as Record<string, any>,
  listeners: new Set<(event: any) => void>(),
  closed: new Set<() => void>(),
  adapters: [] as any[],
  busy: false,
  fastExit: true,
  report: undefined as unknown,
  stopFailure: false,
  releaseFailure: false,
  closeFailure: false,
  boots: [] as string[],
  launchFailure: false,
  latestOwner: null as Buffer | null,
  certified: false,
  releaseFirstOnly: false,
  instances: 0,
  abandoned: false,
}));
const identity = {
  sid,
  sessionId: 1,
  pid: 123,
  creationTime: "133000000000000000",
};
const owner = { role: "prepare", nonce: "a".repeat(64), identity };
vi.mock("../../worker/src/platform/windows/consumer-native.js", () => ({
  createConsumerNativeTransport: vi.fn(async () => ({})),
  sameConsumerProcess: (a: any, b: any) =>
    JSON.stringify(a) === JSON.stringify(b),
  WindowsConsumerNative: class {
    private readonly instance = ++state.instances;
    async identity() {
      return identity;
    }
    async bootIdentity() {
      return state.boots.shift() ?? bootIdentity;
    }
    async legacyWorkerConflict() {
      return false;
    }
    async enumerateGpus() {
      return [...state.adapters];
    }
    async acquireGpuGuard(value: any) {
      state.events.push(`guard:${value.deviceIndex}`);
      return state.busy
        ? null
        : { nonce: "b".repeat(64), gpu: value, abandoned: state.abandoned };
    }
    async releaseGpuGuard() {
      state.events.push("release");
      if (
        state.releaseFailure ||
        (state.releaseFirstOnly && this.instance === 1)
      )
        throw new Error("GPU_RELEASE_UNCONFIRMED");
    }
    onEvent(listener: (event: any) => void) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    }
    onClosed(listener: () => void) {
      state.closed.add(listener);
      return () => state.closed.delete(listener);
    }
    async launchOwned() {
      state.events.push("launch");
      state.latestOwner = Buffer.from(
        JSON.stringify({
          version: 1,
          owner: { ...owner, identity: processIdentityToWire(owner.identity) },
          controller: processIdentityToWire(identity),
          guardian: processIdentityToWire({ ...identity, pid: 456 }),
        }),
      );
      if (state.launchFailure) throw new Error("LAUNCH_ACK_LOST");
      if (state.fastExit)
        for (const listener of state.listeners)
          listener({ kind: "child_exit", owner });
      return owner;
    }
    async stopOwned() {
      state.events.push("stop-tree");
      if (state.stopFailure) throw new Error("TREE_STILL_LIVE");
    }
    async close() {
      state.events.push("close");
      if (state.closeFailure) throw new Error("HELPER_CLOSE_UNCONFIRMED");
    }
  },
}));
vi.mock("../src/main/prepare/private-files.js", () => ({
  writePrivateAtomic: async (_host: unknown, _path: string, bytes: Buffer) => {
    state.events.push("config");
    state.configuration = JSON.parse(bytes.toString());
  },
  readPrivateBytes: async () => {
    state.events.push("report");
    if (state.report === undefined) throw new Error("ENOENT");
    return Buffer.from(JSON.stringify(state.report));
  },
}));
function fixture() {
  const host = {
    identity,
    personalRoot: "C:\\Users\\Fixture\\AppData\\Local\\MusicMuteLocal",
    directory: async () => "owned",
    native: {
      validatePath: async () => {},
      vaultRead: async () =>
        state.latestOwner ? Buffer.from(state.latestOwner) : null,
      ownedTreeExited: async () => state.certified,
    },
  } as unknown as HostContext;
  return new PreparationQualificationRunner(host, async () => ({
    manifestSha256: "b".repeat(64),
    helperSha256: "c".repeat(64),
  }));
}
beforeEach(() => {
  state.events = [];
  state.configuration = {};
  state.listeners.clear();
  state.closed.clear();
  state.adapters = [{ ...gpu }];
  state.busy = false;
  state.fastExit = true;
  state.stopFailure = false;
  state.releaseFailure = false;
  state.closeFailure = false;
  state.boots = [];
  state.launchFailure = false;
  state.latestOwner = null;
  state.certified = false;
  state.releaseFirstOnly = false;
  state.instances = 0;
  state.abandoned = false;
  state.report = receipt().qualification;
});
it("holds the selected GPU from before launch through verified report and whole-tree teardown", async () => {
  await expect(
    fixture().run("a".repeat(64), new AbortController().signal),
  ).resolves.toMatchObject({
    evidence: { provider: "directml", directmlDeviceId: 3 },
  });
  expect(state.events).toEqual([
    "guard:3",
    "config",
    "launch",
    "report",
    "stop-tree",
    "release",
    "close",
  ]);
  expect(state.configuration.gpu).toEqual(gpu);
  expect(state.listeners.size).toBe(0);
});
it("never returns a qualification result across a changed volatile boot witness, even with unchanged GPU evidence", async () => {
  state.boots = [bootIdentity, "f".repeat(64)];
  await expect(
    fixture().run("a".repeat(64), new AbortController().signal),
  ).rejects.toThrow("GPU_UNSUPPORTED");
  expect(state.events).toContain("stop-tree");
  expect(state.events).toContain("release");
});
it("returns GPU busy without launching an unguarded child", async () => {
  state.busy = true;
  await expect(
    fixture().run("a".repeat(64), new AbortController().signal),
  ).rejects.toThrow("BUSY");
  expect(state.events).toEqual(["guard:3", "close"]);
});
it("an abandoned physical guard never launches a model or produces qualification even when hardware metadata matches", async () => {
  state.abandoned = true;
  const runner = fixture();
  await expect(
    runner.run("a".repeat(64), new AbortController().signal),
  ).rejects.toThrow("GPU_UNSUPPORTED");
  expect(state.events).not.toContain("launch");
  expect(state.events).not.toContain("report");
  expect(state.events.slice(-2)).toEqual(["release", "close"]);
});
it("does not convert missing reports or CPU placement into readiness", async () => {
  for (const value of [
    undefined,
    {
      ...receipt().qualification,
      providerDispatch: {
        ...receipt().qualification.providerDispatch,
        cpuNodeEvents: 1,
      },
    },
  ]) {
    state.report = value;
    await expect(
      fixture().run("a".repeat(64), new AbortController().signal),
    ).rejects.toThrow("GPU_UNSUPPORTED");
  }
});
it("cancels only the owned child and waits for teardown before releasing the GPU", async () => {
  state.fastExit = false;
  const abort = new AbortController(),
    runner = fixture();
  const result = runner.run("a".repeat(64), abort.signal);
  await vi.waitFor(() => expect(state.events).toContain("launch"));
  abort.abort();
  await runner.cancel();
  await expect(result).rejects.toThrow("PREPARE_INTERRUPTED");
  expect(state.events.filter((value) => value === "stop-tree")).toHaveLength(1);
  expect(state.events.indexOf("release")).toBeGreaterThan(
    state.events.indexOf("stop-tree"),
  );
});
it("ignores a reused PID with another creation time and rejects a concurrent qualification", async () => {
  state.fastExit = false;
  const runner = fixture(),
    abort = new AbortController();
  const result = runner.run("a".repeat(64), abort.signal);
  await vi.waitFor(() => expect(state.events).toContain("launch"));
  await expect(runner.run("a".repeat(64), abort.signal)).rejects.toThrow(
    "BUSY",
  );
  for (const listener of state.listeners)
    listener({
      kind: "child_exit",
      owner: {
        ...owner,
        identity: { ...identity, creationTime: "133000000000000001" },
      },
    });
  expect(state.events).not.toContain("report");
  abort.abort();
  await expect(result).rejects.toThrow("PREPARE_INTERRUPTED");
});
it("cannot return successful qualification when owned-tree termination fails", async () => {
  state.stopFailure = true;
  const runner = fixture();
  await expect(
    runner.run("a".repeat(64), new AbortController().signal),
  ).rejects.toBeInstanceOf(QualificationCleanupUnconfirmed);
  expect(state.events.at(-1)).toBe("stop-tree");
  expect(state.events).not.toContain("release");
  expect(state.events).not.toContain("close");
  expect(runner.cleanupPending()).toBe(true);
  await expect(
    runner.run("a".repeat(64), new AbortController().signal),
  ).rejects.toThrow("BUSY");
  await expect(runner.recoverCleanup()).rejects.toBeInstanceOf(
    QualificationCleanupUnconfirmed,
  );
  expect(runner.cleanupPending()).toBe(true);
  state.stopFailure = false;
  await runner.recoverCleanup();
  expect(runner.cleanupPending()).toBe(false);
  expect(state.events.slice(-3)).toEqual(["stop-tree", "release", "close"]);
});

function approvedFixture() {
  const r = receipt();
  return {
    relativePath: `prepare\\approved\\${r.fixtureSha256}.wav`,
    sha256: r.fixtureSha256,
    bytes: 100,
  };
}
it("targets the immutable approved secondary adapter instead of a larger personal-ranked primary", async () => {
  const primary = {
    ...gpu,
    deviceIndex: 0,
    luid: "0000000000000001",
    deviceId: 9999,
    dedicatedVideoMemoryBytes: 16 * 1024 ** 3,
  };
  state.adapters = [primary, { ...gpu, deviceIndex: 7 }];
  state.report = {
    ...receipt().qualification,
    directmlDeviceId: 7,
    gpuIdentity: { ...gpu, deviceIndex: 7 },
  };
  const result = await fixture().run(
    "a".repeat(64),
    new AbortController().signal,
    approvedFixture(),
    {
      approvedGpu: { ...gpu, deviceIndex: 1 },
      expectedBootIdentity: bootIdentity,
      allowLuidRebind: false,
    },
  );
  expect(result.evidence.directmlDeviceId).toBe(7);
  expect(state.events).toContain("guard:7");
  expect(state.events).not.toContain("guard:0");
  expect(state.configuration.gpu.luid).toBe(gpu.luid);
});
it("ordinary requalification first tries the current exact qualified preference, but changed driver and trusted fleet selection never inherit it", async () => {
  const primary = {
    ...gpu,
    luid: "0000000000000043",
    deviceIndex: 1,
    dedicatedVideoMemoryBytes: 16000000000,
  };
  state.adapters = [primary, { ...gpu }];
  await fixture().run(
    "a".repeat(64),
    new AbortController().signal,
    undefined,
    undefined,
    gpu,
  );
  expect(state.events[0]).toBe("guard:3");
  state.events = [];
  state.report = {
    ...receipt().qualification,
    gpuIdentity: primary,
    directmlDeviceId: 1,
    gpuId: `dxgi-${primary.luid}`,
    resourceObservations: {
      ...receipt().qualification.resourceObservations,
      dedicatedVideoMemoryLimitBytes: primary.dedicatedVideoMemoryBytes,
    },
  };
  await fixture().run(
    "a".repeat(64),
    new AbortController().signal,
    undefined,
    undefined,
    { ...gpu, driverVersion: "old-driver" },
  );
  expect(state.events[0]).toBe("guard:1");
  state.events = [];
  await fixture().run(
    "a".repeat(64),
    new AbortController().signal,
    undefined,
    {
      approvedGpu: primary,
      expectedBootIdentity: bootIdentity,
      allowLuidRebind: false,
    },
    gpu,
  );
  expect(state.events[0]).toBe("guard:1");
});
it("zero, ambiguous, hardware-changed, wrong-witness or same-witness new-LUID candidates cannot launch a GPU child", async () => {
  const selection = {
    approvedGpu: gpu,
    expectedBootIdentity: bootIdentity,
    allowLuidRebind: false,
  };
  for (const [adapters, choice] of [
    [[{ ...gpu, deviceId: 9999 }], selection],
    [[{ ...gpu, luid: "0000000000000001" }], selection],
    [[gpu], { ...selection, expectedBootIdentity: "f".repeat(64) }],
    [
      [gpu, { ...gpu, deviceIndex: 5, luid: "0000000000000001" }],
      { ...selection, allowLuidRebind: true },
    ],
  ] as const) {
    state.events = [];
    state.adapters = [...adapters];
    await expect(
      fixture().run(
        "a".repeat(64),
        new AbortController().signal,
        approvedFixture(),
        choice,
      ),
    ).rejects.toThrow("GPU_UNSUPPORTED");
    expect(state.events).toEqual(["close"]);
  }
});
it("explicit fresh cross-witness selection rebinds only one exact stable descriptor and actual current ordinal", () => {
  const moved = {
    ...gpu,
    luid: "0000000000000001",
    deviceIndex: 5,
    driverVersion: "32.0.9.9",
  };
  expect(
    selectTrustedPreparationGpu(
      {
        approvedGpu: gpu,
        expectedBootIdentity: "f".repeat(64),
        allowLuidRebind: true,
      },
      "f".repeat(64),
      [moved],
    ),
  ).toEqual(moved);
  expect(() =>
    selectTrustedPreparationGpu(
      {
        approvedGpu: gpu,
        expectedBootIdentity: "f".repeat(64),
        allowLuidRebind: true,
      },
      "f".repeat(64),
      [{ ...moved, subsystemId: 1 }],
    ),
  ).toThrow("GPU_UNSUPPORTED");
});

it("guard-release or helper-close uncertainty cannot become a qualification receipt", async () => {
  state.releaseFailure = true;
  await expect(
    fixture().run("a".repeat(64), new AbortController().signal),
  ).rejects.toBeInstanceOf(QualificationCleanupUnconfirmed);
  state.releaseFailure = false;
  state.closeFailure = true;
  await expect(
    fixture().run("a".repeat(64), new AbortController().signal),
  ).rejects.toBeInstanceOf(QualificationCleanupUnconfirmed);
});
it("helper loss during active qualification retains exclusion until positive owned-tree teardown; a late success never launches another candidate", async () => {
  state.fastExit = false;
  state.stopFailure = true;
  state.adapters = [gpu, { ...gpu, deviceIndex: 1, luid: "0000000000000099" }];
  const runner = fixture(),
    running = runner.run("a".repeat(64), new AbortController().signal);
  const rejected = expect(running).rejects.toBeInstanceOf(
    QualificationCleanupUnconfirmed,
  );
  await vi.waitFor(() => expect(state.events).toContain("launch"));
  for (const close of state.closed) close();
  await rejected;
  for (const listener of state.listeners)
    listener({ kind: "child_exit", owner });
  expect(runner.cleanupPending()).toBe(true);
  expect(state.events).not.toContain("release");
  expect(state.events.filter((event) => event === "launch")).toHaveLength(1);
  await expect(
    runner.run("a".repeat(64), new AbortController().signal),
  ).rejects.toThrow("BUSY");
  state.stopFailure = false;
  await runner.recoverCleanup();
  expect(runner.cleanupPending()).toBe(false);
  expect(state.events.filter((event) => event === "launch")).toHaveLength(1);
});
it("a lost launch ACK keeps exclusion until the actual controller-bound protected owner is recovered and stopped", async () => {
  state.launchFailure = true;
  const runner = fixture();
  await expect(
    runner.run("a".repeat(64), new AbortController().signal),
  ).rejects.toBeInstanceOf(QualificationCleanupUnconfirmed);
  expect(runner.cleanupPending()).toBe(true);
  expect(state.events).not.toContain("release");
  const proper = state.latestOwner!;
  const foreign = JSON.parse(proper.toString());
  foreign.controller.creation_time = "different";
  state.latestOwner = Buffer.from(JSON.stringify(foreign));
  await expect(runner.recoverCleanup()).rejects.toBeInstanceOf(
    QualificationCleanupUnconfirmed,
  );
  expect(state.events).not.toContain("stop-tree");
  state.latestOwner = proper;
  await runner.recoverCleanup();
  expect(state.events.slice(-3)).toEqual(["stop-tree", "release", "close"]);
  expect(state.events.filter((event) => event === "launch")).toHaveLength(1);
  expect(runner.cleanupPending()).toBe(false);
});
it("fresh-helper physical recovery requires positive exact Job proof and actual current gate acquisition, never a new model launch", async () => {
  state.stopFailure = true;
  state.releaseFirstOnly = true;
  const runner = fixture();
  await expect(
    runner.run("a".repeat(64), new AbortController().signal),
  ).rejects.toBeInstanceOf(QualificationCleanupUnconfirmed);
  await expect(runner.recoverCleanup()).rejects.toBeInstanceOf(
    QualificationCleanupUnconfirmed,
  );
  expect(state.instances).toBe(1);
  state.certified = true;
  state.busy = true;
  await expect(runner.recoverCleanup()).rejects.toBeInstanceOf(
    QualificationCleanupUnconfirmed,
  );
  expect(runner.cleanupPending()).toBe(true);
  expect(state.events.filter((event) => event === "launch")).toHaveLength(1);
  state.busy = false;
  state.abandoned = true;
  await expect(runner.recoverCleanup()).rejects.toBeInstanceOf(
    QualificationCleanupUnconfirmed,
  );
  expect(runner.cleanupPending()).toBe(true);
  state.abandoned = false;
  await runner.recoverCleanup();
  expect(runner.cleanupPending()).toBe(false);
  expect(state.events.filter((event) => event === "launch")).toHaveLength(1);
  expect(state.events.slice(-4)).toEqual([
    "guard:3",
    "release",
    "close",
    "close",
  ]);
});
