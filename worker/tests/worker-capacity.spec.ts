import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureWorkerCapacity } from "../src/platform/shared/worker-capacity.js";
import { parseCapacityBenchmarkReport } from "../src/platform/shared/capacity-benchmark.js";
import { createCapacityReceipt } from "../src/runtime/capacity-receipt.js";
import { installedCapacityIdentity } from "../src/runtime/capacity-identity.js";
import { capacityReport } from "./fixtures/capacity-benchmark.js";

const identity = vi.hoisted(() => ({
  provider:
    process.platform === "win32" ? ("directml" as const) : ("mps" as const),
  gpuIdentity: null as Record<string, unknown> | null,
  releaseManifestDigest: "b".repeat(64),
  modelDigest: "d".repeat(64),
  fixtureDigest: "c".repeat(64),
  hostDigest: "a".repeat(64),
}));
vi.mock("../src/runtime/capacity-identity.js", async (original) => ({
  ...(await original<typeof import("../src/runtime/capacity-identity.js")>()),
  installedCapacityIdentity: vi.fn(async () => identity),
}));
// ACL enforcement has independent native tests. These fixtures exercise the
// complete shared config/receipt parser without altering the test user's ACLs.
vi.mock("../src/platform/windows/private-data.js", () => ({
  assertWindowsPrivateDataFile: vi.fn(async () => undefined),
}));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-capacity-"));
  roots.push(root);
  const configPath = join(root, "runtime.json");
  const receiptPath = join(root, "capacity-validation.json");
  const machineId = "00000000-0000-4000-8000-000000000010";
  const firstId = "00000000-0000-4000-8000-000000000011";
  await writeFile(join(root, "credential"), "a".repeat(43), { mode: 0o600 });
  const document = {
    schemaVersion: 1,
    backendBaseUrl: "https://api.musicmute.test",
    machineId,
    credentialFile: join(root, "credential"),
    workRoot: join(root, "attempts"),
    modelCacheRoot: join(root, "models"),
    engineRoot: join(root, "engine"),
    pythonPath: join(root, "python"),
    ffmpegPath: join(root, "ffmpeg"),
    ffprobePath: join(root, "ffprobe"),
    validatedMaxWorkersPerGpu: 1,
    slots: [
      {
        workerId: firstId,
        gpuId: "gpu0",
        slotIndex: 0,
        recipeIds: ["kim-vocals-v2", "kim-vocals-v2-trim"],
        provider: identity.provider,
        ...(identity.provider === "directml" ? { directmlDeviceId: 0 } : {}),
      },
    ],
  };
  const raw = capacityReport();
  if (identity.provider === "directml") {
    const gpu = {
      source: "DXGI EnumAdapters1/GetDesc1",
      deviceIndex: 0,
      name: "Radeon RX 580",
      luid: "0000000000000001",
      driverVersion: "31.0.21925.1001",
      vendorId: 4098,
      deviceId: 26591,
      subsystemId: 1,
      revision: 1,
      dedicatedVideoMemoryBytes: 8 * 1024 ** 3,
      sharedSystemMemoryLimitBytes: 12 * 1024 ** 3,
    };
    const { stableCapacityGpuIdentity } =
      await import("../src/runtime/capacity-identity.js");
    identity.gpuIdentity = stableCapacityGpuIdentity(gpu);
    Object.assign(raw, {
      provider: "directml",
      gpuIdentity: gpu,
      serviceIdentity: "S-1-5-19",
    });
    for (const recipe of raw.recipes)
      for (const worker of recipe.workerReports.flat())
        Object.assign(worker, {
          provider: "directml",
          gpuIdentity: gpu,
          serviceIdentity: "S-1-5-19",
          gpuModel: gpu.name,
          fallbackDisabled: false,
        });
  }
  const measurements = parseCapacityBenchmarkReport(raw, {
    provider: identity.provider,
    fixtureDigest: raw.fixtureDigest,
    warmupRuns: 1,
    measuredRuns: 3,
  });
  const receipt = createCapacityReceipt({ machineId, identity, measurements });
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(document), { mode: 0o600 });
  return {
    root,
    configPath,
    receiptPath,
    receipt,
    firstId,
    requireStopped: vi.fn(async () => undefined),
  };
}

describe("shared operational worker capacity", () => {
  it("preserves backend slot identity through two-to-one-to-two transitions", async () => {
    const setup = await fixture();
    const two = await configureWorkerCapacity({ ...setup, workers: 2 });
    await configureWorkerCapacity({ ...setup, workers: 1 });
    const reduced = JSON.parse(await readFile(setup.configPath, "utf8"));
    expect(reduced.slots).toHaveLength(1);
    expect(
      reduced.inactiveSlots.map((slot: { workerId: string }) => slot.workerId),
    ).toEqual([two.workerIds[1]]);
    const restored = await configureWorkerCapacity({ ...setup, workers: 2 });
    expect(restored.workerIds).toEqual(two.workerIds);
    expect(
      JSON.parse(await readFile(setup.configPath, "utf8")).inactiveSlots,
    ).toEqual([]);
  });

  it("rejects duplicate inactive identities without modifying configuration", async () => {
    const setup = await fixture();
    const config = JSON.parse(await readFile(setup.configPath, "utf8"));
    config.inactiveSlots = [config.slots[0]];
    const before = JSON.stringify(config);
    await writeFile(setup.configPath, before);
    await expect(
      configureWorkerCapacity({ ...setup, workers: 1 }),
    ).rejects.toThrow("unique");
    expect(await readFile(setup.configPath, "utf8")).toBe(before);
  });

  it("enables two slots, preserves identities on repeat, and can recover to one after expiry", async () => {
    const setup = await fixture();
    const first = await configureWorkerCapacity({ ...setup, workers: 2 });
    expect(first.workers).toBe(2);
    expect(first.workerIds[0]).toBe(setup.firstId);
    expect(new Set(first.workerIds).size).toBe(2);
    expect(first.serviceStarted).toBe(false);
    expect(installedCapacityIdentity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fixturePath: join(
          setup.root,
          process.platform === "win32"
            ? `qualification-fixture-${setup.receipt.measurements.fixtureDigest}.wav`
            : "qualification.wav",
        ),
      }),
    );
    const second = await configureWorkerCapacity({ ...setup, workers: 2 });
    expect(second.workerIds).toEqual(first.workerIds);
    setup.receipt.expiresAt = new Date(Date.now() - 1).toISOString();
    await writeFile(setup.receiptPath, JSON.stringify(setup.receipt));
    await expect(
      configureWorkerCapacity({ ...setup, workers: 2 }),
    ).rejects.toThrow("expired");
    const one = await configureWorkerCapacity({ ...setup, workers: 1 });
    expect(one.workerIds).toEqual([setup.firstId]);
    expect(JSON.stringify(one)).not.toContain("credential");
  });

  it("preserves the config and cleans temporary files when qualification or stop checks fail", async () => {
    const setup = await fixture();
    const before = await readFile(setup.configPath, "utf8");
    setup.receipt.measurements.recipes[0]!.quality.pop();
    await writeFile(setup.receiptPath, JSON.stringify(setup.receipt));
    await expect(
      configureWorkerCapacity({ ...setup, workers: 2 }),
    ).rejects.toThrow();
    expect(await readFile(setup.configPath, "utf8")).toBe(before);
    const requireStopped = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("service started"));
    await expect(
      configureWorkerCapacity({ ...setup, workers: 1, requireStopped }),
    ).rejects.toThrow("service started");
    expect(await readFile(setup.configPath, "utf8")).toBe(before);
    expect(
      (await readdir(setup.root)).filter((path) => path.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("does not overwrite an intervening config edit", async () => {
    const setup = await fixture();
    let calls = 0;
    const requireStopped = async () => {
      if (++calls === 2)
        await writeFile(setup.configPath, "other operator edit");
    };
    await expect(
      configureWorkerCapacity({ ...setup, workers: 1, requireStopped }),
    ).rejects.toThrow("configuration changed");
    expect(await readFile(setup.configPath, "utf8")).toBe(
      "other operator edit",
    );
  });
});
