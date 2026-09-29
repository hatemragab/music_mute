import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { installedCapacityIdentity } from "../../runtime/capacity-identity.js";
import { createCapacityReceipt } from "../../runtime/capacity-receipt.js";
import { readCapacityQualificationContext } from "../../runtime/runtime-config.js";
import { parseCapacityBenchmarkReport } from "../shared/capacity-benchmark.js";
import { writeCapacityEvidence } from "../shared/capacity-storage.js";
import { sha256 } from "../shared/file-benchmark.js";
import { assertWindowsPrivateDataFile } from "./private-data.js";
import { WindowsServiceController } from "./native-service.js";
import {
  createWindowsReleaseLayout,
  type WindowsServiceLayout,
} from "./service-definition.js";

/** Called by the service manager under its operator lock after service restoration. */
export async function approveWindowsCapacity(options: {
  layout: WindowsServiceLayout;
  releaseVersion: string;
  reportPath: string;
}) {
  const { layout } = options;
  const service = new WindowsServiceController(layout);
  await service.assertPrivateInstallation();
  if ((await service.inspect()).state !== "stopped")
    return { approved: false, reason: "installed-stopped-service-required" };
  await assertWindowsPrivateDataFile(layout.configPath);
  const context = await readCapacityQualificationContext(layout.configPath);
  const release = createWindowsReleaseLayout(layout, options.releaseVersion);
  if (context.engineRoot.toLowerCase() !== release.engineRoot.toLowerCase())
    return { approved: false, reason: "benchmark-release-is-not-active" };
  const info = await lstat(options.reportPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 4 * 1024 * 1024
  )
    throw new TypeError("Capacity report is unsafe");
  await assertWindowsPrivateDataFile(options.reportPath);
  const raw = JSON.parse(await readFile(options.reportPath, "utf8"));
  const measurements = parseCapacityBenchmarkReport(raw, {
    provider: "directml",
    fixtureDigest: raw.fixtureDigest,
    warmupRuns: raw.warmupRuns,
    measuredRuns: raw.measuredRuns,
    stored: true,
  });
  const fixturePath = join(
    layout.stateRoot,
    `qualification-fixture-${measurements.fixtureDigest}.wav`,
  );
  const fixtureInfo = await lstat(fixturePath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  if (fixtureInfo === null)
    return {
      approved: false,
      reason: "benchmark-input-is-not-installed-qualification-fixture",
    };
  if (
    !fixtureInfo.isFile() ||
    fixtureInfo.isSymbolicLink() ||
    (await sha256(fixturePath)) !== measurements.fixtureDigest
  )
    throw new TypeError("Installed qualification fixture is unsafe or changed");
  const identity = await installedCapacityIdentity({
    ...context,
    fixturePath,
    modelDigest: measurements.modelDigest,
  });
  const receipt = createCapacityReceipt({
    machineId: context.machineId,
    identity,
    measurements,
  });
  const receiptPath = join(layout.stateRoot, "capacity-validation.json");
  await writeCapacityEvidence(receiptPath, receipt);
  return { approved: true, receiptPath };
}
