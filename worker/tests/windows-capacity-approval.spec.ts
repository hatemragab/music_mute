import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { approveWindowsCapacity } from "../src/platform/windows/capacity-approval.js";
import {
  createWindowsReleaseLayout,
  createWindowsServiceLayout,
} from "../src/platform/windows/service-definition.js";
import { parseCapacityBenchmarkReport } from "../src/platform/shared/capacity-benchmark.js";
import {
  installedCapacityIdentity,
  stableCapacityGpuIdentity,
} from "../src/runtime/capacity-identity.js";
import { writeCapacityEvidence } from "../src/platform/shared/capacity-storage.js";
import { capacityReport } from "./fixtures/capacity-benchmark.js";

const mocks = vi.hoisted(() => ({
  state: "stopped",
  context: {},
  identity: {},
}));
vi.mock("../src/platform/windows/native-service.js", () => ({
  WindowsServiceController: class {
    async assertPrivateInstallation() {}
    async inspect() {
      return { state: mocks.state };
    }
  },
}));
vi.mock("../src/platform/windows/private-data.js", () => ({
  assertWindowsPrivateDataFile: vi.fn(async () => undefined),
}));
vi.mock("../src/runtime/runtime-config.js", () => ({
  readCapacityQualificationContext: vi.fn(async () => mocks.context),
}));
vi.mock("../src/runtime/capacity-identity.js", async (original) => ({
  ...(await original<typeof import("../src/runtime/capacity-identity.js")>()),
  installedCapacityIdentity: vi.fn(async () => mocks.identity),
}));
vi.mock("../src/platform/shared/capacity-storage.js", () => ({
  writeCapacityEvidence: vi.fn(async () => undefined),
}));
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const stateRoot = await mkdtemp(join(tmpdir(), "windows-approval-"));
  roots.push(stateRoot);
  const layout = {
    ...createWindowsServiceLayout("C:\\MusicMuteApprovalFixture"),
    stateRoot,
    configPath: join(stateRoot, "runtime.json"),
  };
  const releaseVersion = "0.1.0-fixture";
  const release = createWindowsReleaseLayout(layout, releaseVersion);
  const bytes = Buffer.from("synthetic qualification audio");
  const fixtureDigest = createHash("sha256").update(bytes).digest("hex");
  const fixturePath = join(
    stateRoot,
    `qualification-fixture-${fixtureDigest}.wav`,
  );
  await writeFile(fixturePath, bytes);
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
  const raw = capacityReport({ fixtureDigest });
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
  const report = parseCapacityBenchmarkReport(raw, {
    provider: "directml",
    fixtureDigest,
    warmupRuns: 1,
    measuredRuns: 3,
  });
  const reportPath = join(stateRoot, "measurement.json");
  await writeFile(reportPath, JSON.stringify(report));
  mocks.state = "stopped";
  mocks.context = {
    machineId: "00000000-0000-4000-8000-000000000010",
    ...release,
    modelCacheRoot: join(stateRoot, "models"),
  };
  mocks.identity = {
    provider: "directml",
    gpuIdentity: stableCapacityGpuIdentity(gpu),
    fixtureDigest,
    modelDigest: report.modelDigest,
    releaseManifestDigest: report.releaseManifestDigest,
    hostDigest: "a".repeat(64),
  };
  return { layout, releaseVersion, reportPath, fixturePath };
}

it("uses the Windows installer's content-addressed qualification fixture when approving", async () => {
  const setup = await fixture();
  expect(await approveWindowsCapacity(setup)).toMatchObject({ approved: true });
  expect(installedCapacityIdentity).toHaveBeenCalledWith(
    expect.objectContaining({ fixturePath: setup.fixturePath }),
  );
  expect(writeCapacityEvidence).toHaveBeenCalledWith(
    join(setup.layout.stateRoot, "capacity-validation.json"),
    expect.objectContaining({ schemaVersion: 3, status: "PASS" }),
  );
});

it("keeps absent services, other releases and unknown qualification fixtures measurement-only", async () => {
  const setup = await fixture();
  mocks.state = "absent";
  expect(await approveWindowsCapacity(setup)).toMatchObject({
    approved: false,
  });
  mocks.state = "stopped";
  expect(
    await approveWindowsCapacity({ ...setup, releaseVersion: "0.1.0-other" }),
  ).toMatchObject({ approved: false });
  await rm(setup.fixturePath);
  expect(await approveWindowsCapacity(setup)).toMatchObject({
    approved: false,
  });
  expect(writeCapacityEvidence).not.toHaveBeenCalled();
});

it("rejects altered installed fixture bytes without writing approval", async () => {
  const setup = await fixture();
  await writeFile(setup.fixturePath, "changed");
  await expect(approveWindowsCapacity(setup)).rejects.toThrow(
    "fixture is unsafe or changed",
  );
  expect(writeCapacityEvidence).not.toHaveBeenCalled();
});
