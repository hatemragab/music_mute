import { readFile, lstat, mkdir, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { parseStrictJson } from "../../../chrome-extension/src/shared/strict-json.js";
import {
  nativeAcceptanceEnvironment,
  parseAcceptanceNativeTools,
} from "../native-run.js";
import {
  NativeToolGuardFailure,
  runGuardedNativeTool,
} from "../native-tool-guard.js";
import {
  parsePrototypeIdentity,
  prototypeBuildRelativeDirectory,
  sha256,
} from "./contract.js";

const leaves = [
  "CMakeLists.txt",
  "probe.cpp",
  "protocol.hpp",
  "protocol.test.cpp",
  "app.manifest",
  "json.hpp",
  "qa-config.hpp",
];
async function checked(path: string, max: number): Promise<Buffer> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > max
  )
    throw new Error("MSIX_QA_FILE_INVALID");
  return readFile(path);
}
/** Reuses the original whole-Job-zero native guard. Its fixed configure source
 * geometry is recreated only inside this plan's exclusive disposable repository.
 * No production-output descriptor assertions and no raw tool fallback. */
export async function runPrototypeNativeBuild(options: {
  planRoot: string;
  toolsFile: string;
  expectedPlanSha256: string;
  expectedToolsSha256: string;
}): Promise<void> {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("ACCEPTANCE_WINDOWS_PHASE_REQUIRED");
  if (
    ![options.planRoot, options.toolsFile].every(
      (path) =>
        isAbsolute(path) &&
        path.length <= 4096 &&
        !/[\p{Cc}\p{Cf}]/u.test(path),
    ) ||
    ![options.expectedPlanSha256, options.expectedToolsSha256].every((hash) =>
      /^[a-f0-9]{64}$/u.test(hash),
    )
  )
    throw new Error("MSIX_QA_ARGUMENT_INVALID");
  const planBytes = await checked(join(options.planRoot, "plan.json"), 65536),
    toolsBytes = await checked(options.toolsFile, 65536);
  if (
    sha256(planBytes) !== options.expectedPlanSha256 ||
    sha256(toolsBytes) !== options.expectedToolsSha256
  )
    throw new Error("MSIX_QA_INPUT_CHANGED");
  const raw = parseStrictJson(planBytes.toString("utf8"), 65536) as {
    identity: unknown;
    buildRelativeDirectory: string;
    sourceFiles: Array<{ path: string; bytes: number; sha256: string }>;
  };
  const identity = parsePrototypeIdentity(raw.identity);
  const buildRelativeDirectory = prototypeBuildRelativeDirectory(identity);
  if (raw.buildRelativeDirectory !== buildRelativeDirectory)
    throw new Error("MSIX_QA_BUILD_GEOMETRY_INVALID");
  if (
    !Array.isArray(raw.sourceFiles) ||
    raw.sourceFiles.length !== leaves.length ||
    new Set(raw.sourceFiles.map((row) => row.path)).size !== leaves.length ||
    raw.sourceFiles.some((row) => !leaves.includes(row.path))
  )
    throw new Error("MSIX_QA_PLAN_INVALID");
  const tools = parseAcceptanceNativeTools(
    parseStrictJson(toolsBytes.toString("utf8"), 65536),
  );
  const makeAppxPath =
    "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\MakeAppx.exe";
  const makeAppx = await checked(makeAppxPath, 16 * 1024 ** 2);
  if (
    makeAppx.length !== 584024 ||
    sha256(makeAppx) !==
      "00fff202b71c1266b8c3899701e42b5468ea153b2b33a0a47215fe27695f16d0"
  )
    throw new Error("ACCEPTANCE_TOOL_CHANGED");
  for (const tool of [tools.guard, tools.cmake, tools.ctest])
    if (sha256(await checked(tool.path, 256 * 1024 ** 2)) !== tool.sha256)
      throw new Error("ACCEPTANCE_TOOL_CHANGED");
  const copies: Array<{ path: string; bytes: Buffer }> = [];
  for (const row of raw.sourceFiles) {
    const bytes = await checked(
      join(options.planRoot, "native", row.path),
      16 * 1024 ** 2,
    );
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256)
      throw new Error("MSIX_QA_SOURCE_CHANGED");
    copies.push({ path: row.path, bytes });
  }
  const repository = join(options.planRoot, "repository"),
    native = join(repository, "worker/native/windows-consumer"),
    buildParent = join(options.planRoot, buildRelativeDirectory.split("/")[0]),
    build = join(buildParent, "native-build");
  await mkdir(repository);
  await mkdir(native, { recursive: true });
  await mkdir(buildParent);
  await mkdir(build);
  for (const file of copies)
    await writeFile(join(native, file.path), file.bytes, { flag: "wx" });
  const environment = nativeAcceptanceEnvironment(process.env);
  const steps: unknown[] = [];
  let activeStep: "configure" | "compile" | "ctest" | null = null;
  try {
    for (const step of ["configure", "compile", "ctest"] as const) {
      activeStep = step;
      const result = await runGuardedNativeTool({
        guard: tools.guard.path,
        step,
        tool: step === "ctest" ? tools.ctest : tools.cmake,
        repository,
        build,
        timeout: step === "compile" ? 300000 : 120000,
        environment,
        ...(tools.version === 3 && step !== "ctest"
          ? { compilerTelemetry: tools.compilerTelemetry }
          : {}),
      });
      const log = `${step}-${randomUUID()}.log`;
      await writeFile(join(options.planRoot, log), result.bytes, {
        flag: "wx",
      });
      steps.push({
        step,
        code: result.code,
        toolExitCode: result.toolExitCode,
        reason: result.reason,
        wholeJobZero: true,
        log,
        logSha256: sha256(result.bytes),
      });
      if (
        result.code !== 0 ||
        result.toolExitCode !== 0 ||
        result.reason !== "completed"
      )
        throw new Error("MSIX_QA_NATIVE_BUILD_FAILED");
      activeStep = null;
    }
    const binaries = [];
    for (const leaf of [
      identity.executable,
      identity.hostExecutable,
      "MusicMuteMsixProtocolTest.exe",
    ]) {
      const bytes = await checked(join(build, "Release", leaf), 16 * 1024 ** 2);
      binaries.push({ path: leaf, bytes: bytes.length, sha256: sha256(bytes) });
    }
    for (const file of copies)
      if (
        !(await checked(join(native, file.path), 16 * 1024 ** 2)).equals(
          file.bytes,
        )
      )
        throw new Error("MSIX_QA_SOURCE_CHANGED");
    const archive = await checked(
      join(options.planRoot, "MusicMute-S03-QA.msix"),
      64 * 1024 ** 2,
    );
    await writeFile(
      join(options.planRoot, "native-build-receipt.json"),
      JSON.stringify(
        {
          version: 1,
          identity,
          expectedPlanSha256: options.expectedPlanSha256,
          expectedToolsSha256: options.expectedToolsSha256,
          buildRelativeDirectory,
          makeAppx: {
            path: makeAppxPath,
            bytes: makeAppx.length,
            sha256: sha256(makeAppx),
          },
          steps,
          binaries,
          package: { bytes: archive.length, sha256: sha256(archive) },
          signed: false,
          installed: false,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  } catch (error) {
    await writeFile(
      join(options.planRoot, "native-build-failed.json"),
      JSON.stringify(
        {
          version: 1,
          identity,
          steps,
          failure:
            error instanceof Error &&
            /^(MSIX_QA|ACCEPTANCE)_[A-Z_]+$/u.test(error.message)
              ? error.message
              : "MSIX_QA_NATIVE_BUILD_FAILED",
          cleanupConfirmedForDeliveredStepsOnly: true,
          guardDiagnostic:
            error instanceof NativeToolGuardFailure ? error.diagnostic : null,
          undeliveredStep:
            error instanceof NativeToolGuardFailure ? activeStep : null,
          undeliveredStepCleanup:
            error instanceof NativeToolGuardFailure ? "unconfirmed" : null,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    throw error;
  }
}
