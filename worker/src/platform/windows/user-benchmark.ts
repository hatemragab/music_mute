import { readWindowsActiveVersion } from "./active-release.js";
import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, win32 } from "node:path";
import {
  WORKER_RECIPE_IDS,
  type WorkerRecipeId,
} from "../../../protocol/v1/protocol.js";
import {
  parseStoredRepeatedBenchmarkReport,
  sha256,
} from "../shared/file-benchmark.js";
import { parseCapacityBenchmarkReport } from "../shared/capacity-benchmark.js";
import { executeWindowsServiceManager } from "./cli.js";
import {
  WindowsServiceController,
  type WindowsServiceActions,
} from "./native-service.js";
import { verifyWindowsRelease } from "./release-manifest.js";
import {
  createWindowsReleaseLayout,
  type WindowsServiceLayout,
} from "./service-definition.js";

export type WindowsFileBenchmarkRequest = {
  inputPath: string;
  warmupRuns: number;
  measuredRuns: number;
  outputReportPath?: string;
  releaseVersion?: string;
} & (
  { workers?: 1; recipeId: WorkerRecipeId } | { workers: 2; recipeId?: never }
);

export function assertWindowsBenchmarkReportDestination(
  layout: WindowsServiceLayout,
  reportPath: string,
): void {
  if (
    !/^[A-Za-z]:\\/u.test(reportPath) ||
    win32.normalize(reportPath) !== reportPath ||
    reportPath.slice(2).includes(":") ||
    !reportPath.endsWith(".json")
  )
    throw new TypeError(
      "Benchmark report must use a normalized local .json path",
    );
  const inside = win32.relative(layout.installRoot, reportPath);
  if (
    inside === "" ||
    (!inside.startsWith("..\\") && inside !== ".." && !win32.isAbsolute(inside))
  ) {
    if (
      win32.dirname(reportPath).toLowerCase() !==
        layout.stateRoot.toLowerCase() ||
      !/^benchmark-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/u.test(
        win32.basename(reportPath),
      )
    )
      throw new TypeError("Benchmark report cannot modify installation files");
  }
}

export async function benchmarkWindowsFile(
  options: WindowsFileBenchmarkRequest & {
    layout: WindowsServiceLayout;
    service?: WindowsServiceActions;
  },
) {
  const { layout } = options;
  const service = options.service ?? new WindowsServiceController(layout);
  await service.assertPrivateInstallation();
  const native = await service.inspect();
  if (native.state !== "stopped" && native.state !== "absent")
    throw new Error("Drain and stop the Windows worker before benchmarking");
  if (
    (options.workers !== 2 && !WORKER_RECIPE_IDS.includes(options.recipeId)) ||
    !Number.isSafeInteger(options.warmupRuns) ||
    options.warmupRuns < (options.workers === 2 ? 1 : 0) ||
    options.warmupRuns > 2 ||
    !Number.isSafeInteger(options.measuredRuns) ||
    options.measuredRuns < 3 ||
    options.measuredRuns > 10
  )
    throw new TypeError("Windows benchmark settings are invalid");
  const inputPath = resolve(options.inputPath);
  if (inputPath !== options.inputPath)
    throw new TypeError("Benchmark input must be an absolute normalized path");
  const input = await lstat(inputPath);
  if (
    !input.isFile() ||
    input.isSymbolicLink() ||
    input.size < 1 ||
    input.size > 512 * 1024 * 1024
  )
    throw new TypeError(
      "Benchmark input must be a regular file within the input size limit",
    );
  const version =
    options.releaseVersion ?? (await readWindowsActiveVersion(layout));
  const release = createWindowsReleaseLayout(layout, version);
  await verifyWindowsRelease(release.releaseRoot);
  const reportPath =
    options.outputReportPath ??
    join(layout.stateRoot, `benchmark-${randomUUID()}.json`);
  assertWindowsBenchmarkReportDestination(layout, reportPath);
  if (
    resolve(reportPath) !== reportPath ||
    !/^[A-Za-z]:\\/u.test(reportPath) ||
    !reportPath.endsWith(".json") ||
    (await realpath(dirname(reportPath))).toLowerCase() !==
      dirname(reportPath).toLowerCase()
  )
    throw new TypeError(
      "Benchmark report must use a local absolute .json path without directory links",
    );
  if (
    await lstat(reportPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    })
  )
    throw new TypeError("Benchmark report already exists");
  const fixtureSha256 = await sha256(inputPath);
  const manager = join(
    release.releaseRoot,
    "installer",
    "manage-windows-service.ps1",
  );
  try {
    // The manager owns the same lock as ordinary CLI mutations and performs a
    // durable service transaction. Do not acquire the lock twice in this process.
    await executeWindowsServiceManager(manager, [
      "-Action",
      "Benchmark",
      "-InstallRoot",
      layout.installRoot,
      "-Release",
      release.releaseRoot,
      "-FixtureSource",
      inputPath,
      "-FixtureSha256",
      fixtureSha256,
      ...(options.workers === 2
        ? ["-BenchmarkWorkers", "2"]
        : ["-BenchmarkRecipe", options.recipeId]),
      "-WarmupRuns",
      String(options.warmupRuns),
      "-MeasuredRuns",
      String(options.measuredRuns),
      "-QualificationOutput",
      reportPath,
    ]);
  } catch (error) {
    await executeWindowsServiceManager(manager, [
      "-Action",
      "Recover",
      "-InstallRoot",
      layout.installRoot,
    ]).catch(() => undefined);
    throw error;
  }
  const info = await lstat(reportPath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 4 * 1024 * 1024
  )
    throw new TypeError("Windows benchmark result is unsafe");
  const raw = JSON.parse(await readFile(reportPath, "utf8"));
  if (options.workers === 2) {
    const capacity = parseCapacityBenchmarkReport(raw, {
      provider: "directml",
      fixtureDigest: fixtureSha256,
      warmupRuns: options.warmupRuns,
      measuredRuns: options.measuredRuns,
      stored: true,
    });
    return { ...capacity, reportPath };
  }
  const report = parseStoredRepeatedBenchmarkReport(raw);
  if (
    report.provider !== "directml" ||
    report.serviceIdentity !== "S-1-5-19" ||
    report.fixtureDigest !== fixtureSha256 ||
    report.recipeId !== options.recipeId
  )
    throw new TypeError(
      "Windows benchmark result identity does not match this run",
    );
  return { ...report, reportPath };
}
