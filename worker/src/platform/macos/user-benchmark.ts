import { writeCapacityEvidence } from "../shared/capacity-storage.js";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { join, sep } from "node:path";
import { parseQualificationEvidence } from "../../enrollment/report-builder.js";
import { loadLocalLifecycle } from "../../runtime/local-lifecycle.js";
import {
  MacLaunchAgentController,
  writeLaunchAgentPlist,
} from "./launch-agent.js";
import { qualifyMacUserRelease } from "./user-installer.js";
import type { MacUserLayout } from "./user-paths.js";
import { readBenchmarkMachineIdentity } from "../../runtime/runtime-config.js";
import { installedCapacityIdentity } from "../../runtime/capacity-identity.js";
import {
  benchmarkWorkerFile,
  runFileBenchmarkProcess,
  sha256,
  type FileBenchmarkOptions,
} from "../shared/file-benchmark.js";
import { parseCapacityBenchmarkReport } from "../shared/capacity-benchmark.js";
import { createCapacityReceipt } from "../../runtime/capacity-receipt.js";

export interface MacUserFileBenchmarkOptions extends Omit<
  FileBenchmarkOptions,
  "layout" | "provider" | "requireStoppedRuntime" | "environment" | "runProcess"
> {
  layout: MacUserLayout;
  uid: number;
  launchAgent?: Pick<MacLaunchAgentController, "status">;
}

export async function benchmarkMacUserFile(
  options: MacUserFileBenchmarkOptions,
) {
  return await benchmarkWorkerFile({
    ...options,
    layout: { ...options.layout, outputRoot: options.layout.homeRoot },
    provider: "mps",
    environment: benchmarkEnvironment(options.layout),
    requireStoppedRuntime: () =>
      requireStoppedBenchmarkRuntime(
        options.layout,
        options.launchAgent ?? new MacLaunchAgentController(options.uid),
      ),
  });
}

export async function benchmarkMacUserWorker(options: {
  layout: MacUserLayout;
  uid: number;
  launchAgent?: Pick<
    MacLaunchAgentController,
    "bootstrap" | "bootout" | "status"
  >;
  qualify?: typeof qualifyMacUserRelease;
  workers?: 1 | 2;
  capacityBenchmark?: typeof runTwoWorkerCapacityBenchmark;
}) {
  const launchAgent =
    options.launchAgent ?? new MacLaunchAgentController(options.uid);
  const releaseRoot = await requireStoppedBenchmarkRuntime(
    options.layout,
    launchAgent,
  );
  if (options.workers === 2) await invalidateCapacityEvidence(options.layout);
  const fixturePath = join(options.layout.stateRoot, "qualification.wav");
  const fixtureSha256 = await sha256(fixturePath);
  const qualify = options.qualify ?? qualifyMacUserRelease;
  try {
    const warmupReportPath = await qualify(
      options.layout,
      releaseRoot,
      fixturePath,
      fixtureSha256,
      launchAgent,
      false,
    );
    const rawWarmup = JSON.parse(
      await readFile(warmupReportPath, "utf8"),
    ) as unknown;
    const warmup = parseQualificationEvidence(rawWarmup);
    if ((options.workers ?? 1) === 1) return warmup;
    const capacity = await (
      options.capacityBenchmark ?? runTwoWorkerCapacityBenchmark
    )({
      layout: options.layout,
      machineId: await readBenchmarkMachineIdentity(options.layout.configPath),
      releaseRoot,
      fixturePath,
      fixtureSha256,
      baseline: rawWarmup,
    });
    return { baseline: warmup, capacity };
  } finally {
    await writeLaunchAgentPlist(options.layout);
  }
}

export async function runTwoWorkerCapacityBenchmark(options: {
  layout: MacUserLayout;
  machineId: string;
  releaseRoot: string;
  fixturePath: string;
  fixtureSha256: string;
  baseline: unknown;
}) {
  await invalidateCapacityEvidence(options.layout);
  const baselineEvidence = parseQualificationEvidence(options.baseline);
  const root = await mkdtemp(join(options.layout.temporaryRoot, "capacity-"));
  await chmod(root, 0o700);
  try {
    const reportPath = join(root, "capacity.json");
    let processError: unknown;
    try {
      await runFileBenchmarkProcess(
        options.layout.pythonPath,
        [
          "-m",
          "musicmute_engine.capacity_benchmark",
          "--watch-parent",
          "--provider",
          "mps",
          "--fixture",
          options.fixturePath,
          "--fixture-sha256",
          options.fixtureSha256,
          "--work-root",
          root,
          "--release-root",
          options.releaseRoot,
          "--model-cache",
          options.layout.modelRoot,
          "--ffmpeg",
          options.layout.ffmpegPath,
          "--ffprobe",
          options.layout.ffprobePath,
          "--warmup-runs",
          "1",
          "--measured-runs",
          "3",
          "--group-size",
          "2",
          "--report",
          reportPath,
        ],
        {
          cwd: options.layout.engineRoot,
          env: benchmarkEnvironment(options.layout),
        },
      );
    } catch (error) {
      processError = error;
    }
    const info = await lstat(reportPath).catch((error: unknown) => {
      throw processError ?? error;
    });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 2 ||
      info.size > 4 * 1024 * 1024
    )
      throw new TypeError("Capacity report is unsafe");
    const raw = await readFile(reportPath, "utf8");
    const measurements = parseCapacityBenchmarkReport(JSON.parse(raw), {
      provider: "mps",
      fixtureDigest: options.fixtureSha256,
      warmupRuns: 1,
      measuredRuns: 3,
    });
    await writeCapacityEvidence(
      join(options.layout.stateRoot, "capacity-measurements.json"),
      measurements,
    );
    if (processError !== undefined || measurements.status !== "PASS")
      throw (
        processError ??
        new Error(
          "Two-worker capacity did not meet every recipe's speed and output-quality gate",
        )
      );
    for (const key of [
      "releaseManifestDigest",
      "modelDigest",
      "fixtureDigest",
    ] as const) {
      if (measurements[key] !== baselineEvidence[key])
        throw new TypeError("Capacity benchmark runtime identity changed");
    }
    const identity = await installedCapacityIdentity({
      pythonPath: options.layout.pythonPath,
      ffmpegPath: options.layout.ffmpegPath,
      ffprobePath: options.layout.ffprobePath,
      engineRoot: options.layout.engineRoot,
      modelCacheRoot: options.layout.modelRoot,
      fixturePath: options.fixturePath,
      modelDigest: baselineEvidence.modelDigest,
    });
    for (const key of [
      "releaseManifestDigest",
      "modelDigest",
      "fixtureDigest",
    ] as const) {
      if (identity[key] !== baselineEvidence[key])
        throw new TypeError(
          "Capacity evidence does not match the installed runtime",
        );
    }
    const result = createCapacityReceipt({
      machineId: options.machineId,
      identity,
      measurements,
    });
    await writeCapacityEvidence(options.layout.capacityValidationPath, result);
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function invalidateCapacityEvidence(
  layout: MacUserLayout,
): Promise<void> {
  await writeCapacityEvidence(layout.capacityValidationPath, {
    schemaVersion: 1,
    status: "IN_PROGRESS",
    startedAt: new Date().toISOString(),
  });
}

async function requireStoppedBenchmarkRuntime(
  layout: MacUserLayout,
  launchAgent: Pick<MacLaunchAgentController, "status">,
): Promise<string> {
  const lifecycle = await loadLocalLifecycle(layout.lifecyclePath);
  const service = await launchAgent.status();
  if (lifecycle.intent !== "draining" || service.loaded)
    throw new Error(
      "Benchmark requires an already-drained and stopped worker; run drain, wait for jobs, then stop",
    );
  const releaseRoot = await realpath(layout.currentLink);
  const trustedRoot = await realpath(layout.releasesRoot);
  if (!releaseRoot.startsWith(`${trustedRoot}${sep}`))
    throw new TypeError("Active release is outside the trusted runtime root");
  return releaseRoot;
}

function benchmarkEnvironment(layout: MacUserLayout): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MPLCONFIGDIR: join(layout.cacheRoot, "matplotlib"),
    NUMBA_CACHE_DIR: join(layout.cacheRoot, "numba"),
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: join(layout.cacheRoot, "python"),
    PYTHONUNBUFFERED: "1",
    XDG_CACHE_HOME: layout.cacheRoot,
  };
}
