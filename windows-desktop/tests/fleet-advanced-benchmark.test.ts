import { describe, it, expect, vi } from "vitest";
import {
  WindowsAdvancedBenchmarkRunner,
  type AdvancedBenchmarkGuardian,
  type BenchmarkOwnershipJournal,
} from "../src/main/fleet/advanced/benchmark-runner.js";
import {
  parseAdvancedBenchmarkConfiguration,
  validateAdvancedBenchmarkReport,
} from "../src/main/fleet/advanced/benchmark-child.js";
import type { HostContext } from "../src/main/host-context.js";
import type { ConsumerNativeEvent } from "../../worker/src/platform/windows/consumer-native.js";
import {
  advancedGpu,
  advancedRequest,
  advancedTransaction,
  benchmarkConfig,
  consumerRepeatedRaw,
  consumerRepeatedStored,
  consumerCapacityRaw,
  processIdentity,
  readySnapshot,
} from "./fleet-advanced-fixtures.js";
function fixture() {
  const order: string[] = [],
    owner = {
      role: "prepare" as const,
      nonce: "a".repeat(64),
      identity: { ...processIdentity, pid: 12346 },
    };
  let event: (v: ConsumerNativeEvent) => void = () => {},
    receipt: BenchmarkOwnershipJournal | null = null;
  const guardian: AdvancedBenchmarkGuardian = {
    bootIdentity: async () => "e".repeat(64),
    identity: vi.fn(async () => ({
      ...processIdentity,
      logonSid: "S-1-5-5-1-2",
      nativeArch: "x64" as const,
      processArch: "x64" as const,
      osMajor: 10 as const,
      osBuild: 19045,
      localAppData: "C:\\Users\\fixture\\AppData\\Local",
    })),
    legacyWorkerConflict: vi.fn(async () => false),
    enumerateGpus: vi.fn(async () => [{ ...advancedGpu }]),
    acquireGpuGuard: vi.fn(async () => {
      order.push("guard-acquire");
      return {
        luid: advancedGpu.luid,
        nonce: "b".repeat(64),
        gpu: advancedGpu,
        identity: processIdentity,
        abandoned: false,
      };
    }),
    releaseGpuGuard: vi.fn(async () => {
      order.push("guard-release");
    }),
    launchOwned: vi.fn(async () => {
      order.push("launch");
      event({ sequence: 1, kind: "child_exit", owner });
      return owner;
    }),
    stopOwned: vi.fn(async () => {
      order.push("tree-stop");
    }),
    onEvent: vi.fn((listener) => {
      event = listener;
      return () => {};
    }),
    onClosed: vi.fn(() => () => {}),
    close: vi.fn(async () => {
      order.push("close");
    }),
  };
  const host = {
    identity: processIdentity,
    personalRoot: "C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal",
    prepareLease: vi.fn(async () => {
      order.push("prepare-lock");
      return {
        release: async () => {
          order.push("prepare-unlock");
        },
      };
    }),
    ownedTreeExited: vi.fn(async () => true),
  } as unknown as HostContext;
  const options = {
    host,
    ready: vi.fn(async () => readySnapshot()),
    ownership: {
      read: vi.fn(async () => receipt),
      write: vi.fn(async (value: BenchmarkOwnershipJournal) => {
        receipt = structuredClone(value);
        order.push(value.phase);
      }),
    },
    guardian: vi.fn(async () => guardian),
    result: vi.fn(async () => consumerRepeatedStored()),
    publishConfiguration: vi.fn(async () => {
      order.push("config");
    }),
    checkStorage: vi.fn(async () => {}),
    timeoutMs: 1000,
  };
  const runner = new WindowsAdvancedBenchmarkRunner(options),
    config = benchmarkConfig();
  return {
    runner,
    options,
    guardian,
    host,
    order,
    owner,
    receipt: () => receipt,
    emit: (v: ConsumerNativeEvent) => event(v),
    input: {
      operation: config.operation,
      requestId: advancedRequest,
      fixture: config.fixture,
      recipe: config.recipe,
      warmupRuns: config.warmupRuns,
      measuredRuns: config.measuredRuns,
    },
  };
}
describe("fixed consumer benchmark config and evidence", () => {
  it("accepts only fixed private sources with explicit current SID/GPU bounds", () => {
    const config = benchmarkConfig();
    expect(parseAdvancedBenchmarkConfiguration(config)).toEqual(config);
    expect(
      parseAdvancedBenchmarkConfiguration(benchmarkConfig("benchmark_capacity"))
        .operation,
    ).toBe("benchmark_capacity");
    for (const changed of [
      { ...config, command: "powershell" },
      { ...config, sid: "S-1-5-19" },
      { ...config, measuredRuns: 11 },
      {
        ...config,
        fixture: { ...config.fixture, relativePath: "C:\\source.wav" },
      },
      { ...config, gpu: { ...config.gpu, deviceIndex: 16 } },
      { ...benchmarkConfig("benchmark_capacity"), warmupRuns: 0 },
      { ...benchmarkConfig("benchmark_capacity"), fixture: config.fixture },
    ])
      expect(() => parseAdvancedBenchmarkConfiguration(changed)).toThrow();
  });
  it("revalidates report measurements plus current SID, ordinal, model, fixture and installed release", () => {
    const config = benchmarkConfig();
    expect(
      validateAdvancedBenchmarkReport(consumerRepeatedRaw(), config, 800)
        .provider,
    ).toBe("directml");
    expect(
      validateAdvancedBenchmarkReport(
        consumerCapacityRaw(),
        benchmarkConfig("benchmark_capacity"),
      ).status,
    ).toBe("PASS");
    for (const changed of [
      { ...consumerRepeatedRaw(), fallbackDisabled: false },
      { ...consumerRepeatedRaw(), serviceIdentity: "S-1-5-19" },
      { ...consumerRepeatedRaw(), releaseManifestDigest: "e".repeat(64) },
      { ...consumerRepeatedRaw(), fixtureDigest: "e".repeat(64) },
      { ...consumerRepeatedRaw(), modelDigest: "e".repeat(64) },
      {
        ...consumerRepeatedRaw(),
        gpuIdentity: { ...advancedGpu, deviceIndex: 0 },
      },
      { ...consumerRepeatedRaw(), sourceMode: "candidate-engine" },
    ])
      expect(() =>
        validateAdvancedBenchmarkReport(changed, config, 800),
      ).toThrow();
  });
});
describe("physical guard and exact tree cleanup", () => {
  it("refuses a stale boot before physical guard or launch despite identical GPU identity", async () => {
    const f = fixture();
    f.guardian.bootIdentity = vi.fn(async () => "f".repeat(64));
    await expect(
      f.runner.run(advancedTransaction, f.input, new AbortController().signal),
    ).rejects.toThrow("ADVANCED_GPU_REQUALIFICATION_REQUIRED");
    expect(f.guardian.acquireGpuGuard).not.toHaveBeenCalled();
    expect(f.guardian.launchOwned).not.toHaveBeenCalled();
  });
  it("hands off Node-only staging before launch and binds workspace retention to the exact native owner", async () => {
    const f = fixture(),
      release = vi.fn(async () => {
        f.order.push("workspace-release");
      });
    const runner = new WindowsAdvancedBenchmarkRunner({
      ...f.options,
      beforeLaunch: async () => {
        f.order.push("writer-handoff");
      },
      trackWorkspace: async (_config, owner) => {
        expect(owner).toEqual(f.owner);
        f.order.push("workspace-owned");
        return { release };
      },
    });
    await runner.run(
      advancedTransaction,
      f.input,
      new AbortController().signal,
    );
    expect(f.order.indexOf("writer-handoff")).toBeLessThan(
      f.order.indexOf("launch"),
    );
    expect(f.order.indexOf("workspace-owned")).toBeGreaterThan(
      f.order.indexOf("owned"),
    );
    expect(f.order.indexOf("workspace-release")).toBeGreaterThan(
      f.order.indexOf("tree-stop"),
    );
    expect(release).toHaveBeenCalledOnce();
  });
  it("does not drop native workspace protection on uncertain child shutdown", async () => {
    const f = fixture(),
      release = vi.fn(async () => {});
    vi.mocked(f.guardian.stopOwned).mockRejectedValueOnce(
      new Error("DESCENDANT_ALIVE"),
    );
    const runner = new WindowsAdvancedBenchmarkRunner({
      ...f.options,
      trackWorkspace: async () => ({ release }),
    });
    await expect(
      runner.run(advancedTransaction, f.input, new AbortController().signal),
    ).rejects.toThrow("ADVANCED_BENCHMARK_TREE_UNCERTAIN");
    expect(release).not.toHaveBeenCalled();
  });
  it("rejects storage admission before acquiring the GPU or launching an engine", async () => {
    const f = fixture();
    vi.mocked(f.options.checkStorage).mockRejectedValueOnce(
      new Error("DISK_SPACE_LOW"),
    );
    await expect(
      f.runner.run(advancedTransaction, f.input, new AbortController().signal),
    ).rejects.toThrow("DISK_SPACE_LOW");
    expect(f.guardian.acquireGpuGuard).not.toHaveBeenCalled();
    expect(f.guardian.launchOwned).not.toHaveBeenCalled();
  });
  it("acquires before launch, handles early exit and releases only after whole-tree stop", async () => {
    const f = fixture();
    await f.runner.run(
      advancedTransaction,
      f.input,
      new AbortController().signal,
    );
    expect(f.order).toEqual([
      "prepare-lock",
      "guard-acquire",
      "config",
      "launching",
      "launch",
      "owned",
      "tree-stop",
      "exited",
      "guard-release",
      "close",
      "prepare-unlock",
    ]);
    expect(f.receipt()?.phase).toBe("exited");
  });
  it("does not launch on guard contention, abandoned GPU lease or changed driver", async () => {
    const busy = fixture();
    vi.mocked(busy.guardian.acquireGpuGuard).mockResolvedValueOnce(null);
    await expect(
      busy.runner.run(
        advancedTransaction,
        busy.input,
        new AbortController().signal,
      ),
    ).rejects.toThrow("ADVANCED_GPU_BUSY");
    expect(busy.guardian.launchOwned).not.toHaveBeenCalled();
    const abandoned = fixture(),
      guard = await abandoned.guardian.acquireGpuGuard(advancedGpu);
    vi.mocked(abandoned.guardian.acquireGpuGuard).mockResolvedValueOnce({
      ...guard!,
      abandoned: true,
    });
    await expect(
      abandoned.runner.run(
        advancedTransaction,
        abandoned.input,
        new AbortController().signal,
      ),
    ).rejects.toThrow("ADVANCED_GPU_REQUALIFICATION_REQUIRED");
    expect(abandoned.guardian.launchOwned).not.toHaveBeenCalled();
    expect(abandoned.guardian.releaseGpuGuard).toHaveBeenCalledOnce();
    const driver = fixture();
    vi.mocked(driver.guardian.enumerateGpus).mockResolvedValueOnce([
      { ...advancedGpu, driverVersion: "new-driver" },
    ]);
    await expect(
      driver.runner.run(
        advancedTransaction,
        driver.input,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(driver.guardian.acquireGpuGuard).not.toHaveBeenCalled();
  });
  it("closes an ambiguous launch without early GPU release or a fabricated tree proof", async () => {
    const f = fixture();
    vi.mocked(f.guardian.launchOwned).mockRejectedValueOnce(
      new Error("ACK_LOST"),
    );
    await expect(
      f.runner.run(advancedTransaction, f.input, new AbortController().signal),
    ).rejects.toThrow("ADVANCED_BENCHMARK_TREE_UNCERTAIN");
    expect(f.guardian.releaseGpuGuard).not.toHaveBeenCalled();
    expect(f.guardian.close).toHaveBeenCalledOnce();
    expect(f.receipt()?.phase).toBe("launching");
    await expect(f.runner.recover(advancedTransaction)).rejects.toThrow(
      "ADVANCED_BENCHMARK_TREE_UNCERTAIN",
    );
  });
  it("never releases the guard when any descendant stop is uncertain", async () => {
    const f = fixture();
    vi.mocked(f.guardian.stopOwned).mockRejectedValueOnce(
      new Error("PYTHON_GRANDCHILD_ACTIVE"),
    );
    await expect(
      f.runner.run(advancedTransaction, f.input, new AbortController().signal),
    ).rejects.toThrow("ADVANCED_BENCHMARK_TREE_UNCERTAIN");
    expect(f.guardian.releaseGpuGuard).not.toHaveBeenCalled();
    expect(f.receipt()?.phase).toBe("owned");
    expect(f.guardian.close).toHaveBeenCalledOnce();
  });
  it("cancels only its exact owned tree, rejects a wrong exit nonce, and awaits native cleanup", async () => {
    const f = fixture(),
      abort = new AbortController();
    let launched!: () => void;
    const ready = new Promise<void>((resolve) => {
      launched = resolve;
    });
    vi.mocked(f.guardian.launchOwned).mockImplementationOnce(async () => {
      queueMicrotask(launched);
      return f.owner;
    });
    const run = f.runner.run(advancedTransaction, f.input, abort.signal);
    await ready;
    f.emit({
      sequence: 1,
      kind: "child_exit",
      owner: { ...f.owner, nonce: "f".repeat(64) },
    });
    abort.abort();
    await expect(run).rejects.toThrow("ADVANCED_CANCELLED");
    expect(f.guardian.stopOwned).toHaveBeenCalledWith(f.owner);
    expect(f.order.indexOf("tree-stop")).toBeLessThan(
      f.order.indexOf("guard-release"),
    );
  });
  it("requires native birth/nonce certificate for restart recovery even for a recorded exited phase", async () => {
    const f = fixture();
    await f.runner.run(
      advancedTransaction,
      f.input,
      new AbortController().signal,
    );
    vi.mocked(f.host.ownedTreeExited).mockResolvedValueOnce(false);
    await expect(f.runner.recover(advancedTransaction)).rejects.toThrow(
      "ADVANCED_BENCHMARK_TREE_UNCERTAIN",
    );
    await f.runner.recover(advancedTransaction);
    expect(f.host.ownedTreeExited).toHaveBeenLastCalledWith(f.owner);
  });
  it("holds the physical tree to completion even when ownership journal acknowledgement fails", async () => {
    const f = fixture(),
      write = f.options.ownership.write;
    vi.mocked(write).mockImplementation(async (value) => {
      if (value.phase === "owned") throw new Error("DISK_FAILED");
    });
    await expect(
      f.runner.run(advancedTransaction, f.input, new AbortController().signal),
    ).rejects.toThrow("DISK_FAILED");
    expect(f.guardian.stopOwned).toHaveBeenCalledWith(f.owner);
    expect(f.order.indexOf("tree-stop")).toBeLessThan(
      f.order.indexOf("guard-release"),
    );
  });
});
