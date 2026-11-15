import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";
import { MODEL } from "../../../../../chrome-extension/src/shared/local-model.js";
import {
  parseConsumerGpu,
  isCurrentUserSid,
  type ConsumerGpuIdentity,
} from "../../../../../worker/src/platform/windows/consumer-native.js";
import { resolveQualifiedGpuIdentity } from "../../../../../worker/src/enrollment/report-builder.js";
import {
  summarizeRepeatedBenchmarkReport,
  parseStoredRepeatedBenchmarkReport,
} from "../../../../../worker/src/platform/shared/file-benchmark.js";
import { parseCapacityBenchmarkReport } from "../../../../../worker/src/platform/shared/capacity-benchmark.js";
import {
  hashPrivateFile,
  readPrivateBytes,
  writePrivateAtomic,
} from "../../prepare/private-files.js";
import type { HostContext } from "../../host-context.js";
import {
  verifyAdvancedCandidate,
  type AdvancedCandidateIdentity,
} from "./candidate.js";
export interface AdvancedBenchmarkConfiguration {
  bootIdentity: string;
  version: 1;
  operation: "benchmark_file" | "benchmark_capacity";
  requestId: string;
  release: string;
  sid: string;
  manifestSha256: string;
  helperSha256: string;
  gpu: ConsumerGpuIdentity;
  fixture: { relativePath: string; bytes: number; sha256: string };
  recipe: "kim-vocals-v2" | "kim-vocals-v2-trim";
  warmupRuns: number;
  measuredRuns: number;
  groupSize?: 1;
  candidate?: AdvancedCandidateIdentity;
  saveAudio?: boolean;
}
const SHA = /^[a-f0-9]{64}$/u,
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export function isAdvancedBenchmarkOperation(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    "operation" in value &&
    ["benchmark_file", "benchmark_capacity"].includes(String(value.operation))
  );
}
export function parseAdvancedBenchmarkConfiguration(
  value: unknown,
): AdvancedBenchmarkConfiguration {
  const v = value as AdvancedBenchmarkConfiguration;
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v)
      .filter((key) => !["groupSize", "candidate", "saveAudio"].includes(key))
      .sort()
      .join() !==
      "bootIdentity,fixture,gpu,helperSha256,manifestSha256,measuredRuns,operation,recipe,release,requestId,sid,version,warmupRuns" ||
    v.version !== 1 ||
    !isAdvancedBenchmarkOperation(v) ||
    !UUID.test(v.requestId) ||
    !isCurrentUserSid(v.sid) ||
    [v.bootIdentity, v.release, v.manifestSha256, v.helperSha256].some(
      (text) => !SHA.test(text),
    ) ||
    !["kim-vocals-v2", "kim-vocals-v2-trim"].includes(v.recipe) ||
    !Number.isInteger(v.warmupRuns) ||
    v.warmupRuns < (v.operation === "benchmark_capacity" ? 1 : 0) ||
    v.warmupRuns > 2 ||
    !Number.isInteger(v.measuredRuns) ||
    v.measuredRuns < 3 ||
    v.measuredRuns > 10 ||
    !v.fixture ||
    Object.keys(v.fixture).sort().join() !== "bytes,relativePath,sha256" ||
    !SHA.test(v.fixture.sha256) ||
    !Number.isSafeInteger(v.fixture.bytes) ||
    v.fixture.bytes < 44 ||
    v.fixture.bytes > 256 * 1024 ** 2 ||
    v.fixture.relativePath !==
      (v.operation === "benchmark_capacity"
        ? `prepare\\approved\\${v.fixture.sha256}.wav`
        : `prepare\\work\\${v.requestId}\\source.wav`) ||
    (v.operation === "benchmark_capacity" &&
      (v.recipe !== "kim-vocals-v2" || v.fixture.bytes > 64 * 1024 ** 2))
  )
    throw new Error("ADVANCED_BENCHMARK_CONFIG_INVALID");
  if (
    (v.groupSize !== undefined && v.groupSize !== 1) ||
    (v.saveAudio !== undefined && typeof v.saveAudio !== "boolean") ||
    (v.candidate !== undefined &&
      (!v.candidate ||
        Object.keys(v.candidate).sort().join() !==
          "engineDigest,manifestSha256,release" ||
        [
          v.candidate.release,
          v.candidate.manifestSha256,
          v.candidate.engineDigest,
        ].some((value) => !SHA.test(value)))) ||
    (v.operation === "benchmark_capacity" &&
      (v.candidate !== undefined || v.saveAudio === true))
  )
    throw new Error("ADVANCED_BENCHMARK_CONFIG_INVALID");
  parseConsumerGpu(v.gpu);
  return structuredClone(v);
}
export function validateAdvancedBenchmarkReport(
  raw: unknown,
  config: AdvancedBenchmarkConfiguration,
  wallSeconds?: number,
  stored = false,
) {
  const report =
    config.operation === "benchmark_capacity"
      ? parseCapacityBenchmarkReport(raw, {
          provider: "directml",
          fixtureDigest: config.fixture.sha256,
          warmupRuns: config.warmupRuns,
          measuredRuns: config.measuredRuns,
          stored,
          expectedUserSid: config.sid,
        })
      : stored
        ? parseStoredRepeatedBenchmarkReport(raw, {
            expectedUserSid: config.sid,
          })
        : summarizeRepeatedBenchmarkReport(raw, {
            provider: "directml",
            groupSize: 1,
            warmupRuns: config.warmupRuns,
            measuredRuns: config.measuredRuns,
            processWallSeconds: wallSeconds!,
            expectedUserSid: config.sid,
          });
  if (
    report.status !== "PASS" ||
    report.releaseManifestDigest !== config.manifestSha256 ||
    report.fixtureDigest !== config.fixture.sha256 ||
    report.modelDigest !== MODEL.sha256 ||
    report.provider !== "directml" ||
    report.serviceIdentity !== config.sid ||
    !report.gpuIdentity
  )
    throw new Error("ADVANCED_BENCHMARK_INVALID");
  if (
    resolveQualifiedGpuIdentity(config.gpu, [report.gpuIdentity])
      .deviceIndex !== config.gpu.deviceIndex
  )
    throw new Error("ADVANCED_BENCHMARK_INVALID");
  if (config.operation === "benchmark_file") {
    const file = report as ReturnType<
      typeof parseStoredRepeatedBenchmarkReport
    >;
    if (
      file.recipeId !== config.recipe ||
      file.warmupRuns !== config.warmupRuns ||
      file.measuredRuns !== config.measuredRuns ||
      file.source.bytes !== config.fixture.bytes ||
      file.sourceMode !==
        (config.candidate ? "candidate-engine" : "installed-engine") ||
      file.audioSettings.groupSize !== 1 ||
      file.savedAudio !== (config.saveAudio === true) ||
      (config.candidate && file.engineDigest !== config.candidate.engineDigest)
    )
      throw new Error("ADVANCED_BENCHMARK_INVALID");
  }
  return report;
}
/** Called only after the shared Prepare entry has checked owned SID/role/Node/release/helper. */
export async function runAdvancedBenchmarkChild(
  host: HostContext,
  value: AdvancedBenchmarkConfiguration,
  releaseRoot: string,
): Promise<void> {
  const config = parseAdvancedBenchmarkConfiguration(value),
    signal = AbortSignal.timeout(119 * 60_000);
  if ((await host.native.bootIdentity()) !== config.bootIdentity)
    throw new Error("ADVANCED_GPU_REQUALIFICATION_REQUIRED");
  resolveQualifiedGpuIdentity(config.gpu, await host.native.enumerateGpus());
  let engineRoot = win32.join(releaseRoot, "app", "engine");
  if (config.candidate) {
    const current = await verifyAdvancedCandidate(
      host,
      config.candidate.release,
      signal,
    );
    if (
      current.manifestSha256 !== config.candidate.manifestSha256 ||
      current.engineDigest !== config.candidate.engineDigest
    )
      throw new Error("ADVANCED_CANDIDATE_INVALID");
    engineRoot = win32.join(
      host.personalRoot,
      "runtime",
      "releases",
      current.release,
      "app",
      "engine",
    );
  }
  if (
    (await hashPrivateFile(
      host,
      `models\\${MODEL.filename}`,
      MODEL.bytes,
      signal,
    )) !== MODEL.sha256 ||
    (await hashPrivateFile(
      host,
      config.fixture.relativePath,
      config.fixture.bytes,
      signal,
    )) !== config.fixture.sha256
  )
    throw new Error("ADVANCED_BENCHMARK_INVALID");
  const workRoot = await host.directory(
    `prepare\\work\\${config.requestId}\\engine`,
  );
  await host.directory("prepare\\results");
  const rawRelative = `prepare\\results\\${config.requestId}.benchmark.raw.json`,
    resultRelative = `prepare\\results\\${config.requestId}.benchmark.json`;
  await host.native.validatePath("personal", rawRelative, "absent");
  await host.native.validatePath("personal", resultRelative, "absent");
  const args = [
    "-I",
    "-c",
    `import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('musicmute_engine.${config.operation === "benchmark_capacity" ? "capacity_benchmark" : "benchmark_file"}',run_name='__main__')`,
    engineRoot,
    "--provider",
    "directml",
    "--fixture",
    win32.join(host.personalRoot, config.fixture.relativePath),
    "--fixture-sha256",
    config.fixture.sha256,
    "--work-root",
    workRoot,
    "--release-root",
    releaseRoot,
    "--model-cache",
    win32.join(host.personalRoot, "models"),
    "--ffmpeg",
    win32.join(releaseRoot, "runtime", "bin", "ffmpeg.exe"),
    "--ffprobe",
    win32.join(releaseRoot, "runtime", "bin", "ffprobe.exe"),
    "--runtime-profile",
    "windows-user",
    "--expected-user-sid",
    host.identity.sid,
    "--directml-device-id",
    String(config.gpu.deviceIndex),
    "--warmup-runs",
    String(config.warmupRuns),
    "--measured-runs",
    String(config.measuredRuns),
    "--group-size",
    "1",
    "--report",
    win32.join(host.personalRoot, rawRelative),
  ];
  if (config.operation === "benchmark_file")
    args.push("--recipe-id", config.recipe);
  if (config.candidate) args.push("--candidate-engine-root", engineRoot);
  if (config.saveAudio) {
    const relative = `prepare\\work\\${config.requestId}\\saved-audio`;
    await host.native.validatePath("personal", relative, "absent");
    args.push("--save-audio-dir", win32.join(host.personalRoot, relative));
  }
  const started = process.hrtime.bigint();
  await promisify(execFile)(
    win32.join(releaseRoot, "runtime", "python", "python.exe"),
    args,
    {
      windowsHide: true,
      cwd: workRoot,
      timeout: 119 * 60_000,
      maxBuffer: 512 * 1024,
      signal,
    },
  );
  const wall = Number(process.hrtime.bigint() - started) / 1e9;
  const raw = JSON.parse(
    (await readPrivateBytes(host, rawRelative, 8 * 1024 ** 2)).toString("utf8"),
  ) as unknown;
  const report = validateAdvancedBenchmarkReport(raw, config, wall);
  await writePrivateAtomic(
    host,
    resultRelative,
    Buffer.from(JSON.stringify(report)),
  );
}
