import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, win32 } from "node:path";
import { parseStrictJson } from "../../chrome-extension/src/shared/strict-json.js";
import { parseConsumerGpu } from "../../worker/src/platform/windows/consumer-native-gpu.js";
import { sanitizeDiagnostic } from "../../worker/src/agent/diagnostic-redaction.js";
import { ACCEPTANCE_CASES } from "./manifest.js";
import {
  parseCompilerTelemetryPolicy,
  NativeToolGuardFailure,
  runGuardedNativeTool,
  type CompilerTelemetryPolicy,
  type NativeToolGuardDiagnostic,
  type NativeToolStep,
} from "./native-tool-guard.js";
import {
  caseDigest,
  isIsolatedNativeAcceptanceCase,
  parseAcceptanceTarget,
  targetDigest,
  type AcceptanceEvidence,
  type AcceptanceTarget,
} from "./plan.js";
interface Tool {
  path: string;
  sha256: string;
}
export const nativeAcceptanceTimeouts = Object.freeze({
  configure: 120000,
  compile: 300000,
  describe: 10000,
  ctest: 300000,
});
export function acceptanceLogExcerpt(
  bytes: Buffer,
  repository: string,
  profile: string | undefined,
): string {
  let text = new TextDecoder().decode(bytes);
  for (const [value, replacement] of [
    [repository, "[REPOSITORY]"],
    [profile, "[USERPROFILE]"],
  ] as const)
    if (value) {
      text = text
        .replaceAll(value, replacement)
        .replaceAll(value.replaceAll("\\", "/"), replacement);
    }
  return sanitizeDiagnostic(text)
    .replace(/\p{Cc}/gu, (character) =>
      ["\n", "\r", "\t"].includes(character) ? character : "",
    )
    .replace(/\bS-1-\d+(?:-\d+){1,15}\b/gu, "[REDACTED_SID]")
    .slice(-65536);
}
interface NativeToolsFields {
  cmake: Tool;
  ctest: Tool;
  guard: Tool;
}
export type AcceptanceNativeTools = NativeToolsFields &
  ({ version: 2 } | { version: 3; compilerTelemetry: CompilerTelemetryPolicy });
export function parseAcceptanceNativeTools(
  value: unknown,
): AcceptanceNativeTools {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (d) => !("value" in d),
    )
  )
    throw new Error("ACCEPTANCE_TOOL_INVALID");
  const row = value as AcceptanceNativeTools;
  if (
    ![2, 3].includes(row.version) ||
    Object.keys(value).sort().join() !==
      (row.version === 3
        ? "cmake,compilerTelemetry,ctest,guard,version"
        : "cmake,ctest,guard,version")
  )
    throw new Error("ACCEPTANCE_TOOL_INVALID");
  for (const [name, tool] of [
    ["cmake", row.cmake],
    ["ctest", row.ctest],
    ["consumer-native-qa-tool-guard", row.guard],
  ] as const)
    if (
      !tool ||
      Object.getPrototypeOf(tool) !== Object.prototype ||
      Reflect.ownKeys(tool).some((key) => typeof key !== "string") ||
      Object.values(Object.getOwnPropertyDescriptors(tool)).some(
        (d) => !("value" in d),
      ) ||
      Object.keys(tool).sort().join() !== "path,sha256" ||
      typeof tool.path !== "string" ||
      typeof tool.sha256 !== "string" ||
      !(row.version === 3
        ? win32.isAbsolute(tool.path)
        : isAbsolute(tool.path)) ||
      tool.path.length > 4096 ||
      /[\p{Cc}\p{Cf}]/u.test(tool.path) ||
      (row.version === 3
        ? win32.basename(tool.path)
        : basename(tool.path)
      ).toLowerCase() !== `${name}.exe` ||
      !/^[a-f0-9]{64}$/u.test(tool.sha256)
    )
      throw new Error("ACCEPTANCE_TOOL_INVALID");
  if (row.version === 3) {
    parseCompilerTelemetryPolicy(row.compilerTelemetry);
    const marker = row.compilerTelemetry.path
      .toLowerCase()
      .lastIndexOf("\\vc\\tools\\msvc\\");
    const instance = row.compilerTelemetry.path.slice(0, marker);
    for (const [name, tool] of [
      ["cmake", row.cmake],
      ["ctest", row.ctest],
    ] as const)
      if (
        tool.path.toLowerCase() !==
        `${instance}\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\${name}.exe`.toLowerCase()
      )
        throw new Error("ACCEPTANCE_TOOL_INVALID");
  }
  return row;
}
async function checkedFile(path: string, max: number): Promise<Buffer> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > max
  )
    throw new Error("ACCEPTANCE_FILE_INVALID");
  const bytes = await readFile(path);
  if (bytes.length !== stat.size) throw new Error("ACCEPTANCE_FILE_INVALID");
  return bytes;
}
async function checkTool(tool: Tool) {
  const bytes = await checkedFile(tool.path, 256 * 1024 ** 2);
  if (createHash("sha256").update(bytes).digest("hex") !== tool.sha256)
    throw new Error("ACCEPTANCE_TOOL_INVALID");
}
export async function nativeAcceptanceSourceDigest(
  repository: string,
): Promise<string> {
  const directory = join(repository, "worker/native/windows-consumer"),
    all = await readdir(directory),
    names = all.filter((name) => name !== "README.md").sort(),
    hash = createHash("sha256");
  if (
    names.some(
      (name) =>
        !/^(?:CMakeLists\.txt|app\.manifest|[A-Za-z0-9._-]+\.(?:cpp|hpp))$/u.test(
          name,
        ),
    ) ||
    !names.includes("native_tests.cpp") ||
    !names.includes("main.cpp") ||
    names.length > 128
  )
    throw new Error("ACCEPTANCE_SOURCE_INVALID");
  for (const name of names) {
    hash.update(name);
    hash.update("\0");
    hash.update(await checkedFile(join(directory, name), 2 * 1024 ** 2));
    hash.update("\0");
  }
  return hash.digest("hex");
}
/** No inherited CMake/toolchain, compiler, linker or executable search injection. */
export function nativeAcceptanceEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (!source.SystemRoot || !win32.isAbsolute(source.SystemRoot))
    throw new Error("ACCEPTANCE_TOOL_INVALID");
  const root = win32.parse(source.SystemRoot).root;
  if (!/^[A-Za-z]:\\$/u.test(root)) throw new Error("ACCEPTANCE_TOOL_INVALID");
  const env: NodeJS.ProcessEnv = {
    SystemDrive: root.slice(0, -1),
    PROCESSOR_ARCHITECTURE: "AMD64",
  };
  for (const name of [
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "ProgramData",
    "ALLUSERSPROFILE",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
  ])
    if (source[name]) env[name] = source[name];
  env.PATH = `${win32.join(source.SystemRoot, "System32")};${source.SystemRoot}`;
  return env;
}
export function assertNativeAcceptanceTarget(
  target: AcceptanceTarget,
  value: unknown,
): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !==
      "build,edition,gpus,major,nativeArch,processArch,version"
  )
    throw new Error("ACCEPTANCE_TARGET_MISMATCH");
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    row.nativeArch !== "x64" ||
    row.processArch !== "x64" ||
    row.major !== 10 ||
    row.edition !== "workstation" ||
    row.build !== target.os.build ||
    !Array.isArray(row.gpus) ||
    row.gpus.length > 16
  )
    throw new Error("ACCEPTANCE_TARGET_MISMATCH");
  const gpus = row.gpus.map(parseConsumerGpu);
  if (
    target.gpu &&
    !gpus.some((gpu) => JSON.stringify(gpu) === JSON.stringify(target.gpu))
  )
    throw new Error("ACCEPTANCE_TARGET_MISMATCH");
}
/** Only isolated build/CTest execution; manual app/account/GPU/install actions
 * are deliberately absent. This never instantiates production mocked authority. */
export async function runNativeAcceptance(options: {
  repository: string;
  outputRoot: string;
  target: unknown;
  tools: unknown;
  cases: readonly string[];
  acknowledgeWindowsPhase: boolean;
}): Promise<AcceptanceEvidence[]> {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    !options.acknowledgeWindowsPhase
  )
    throw new Error("ACCEPTANCE_WINDOWS_PHASE_REQUIRED");
  if (
    !isAbsolute(options.repository) ||
    !isAbsolute(options.outputRoot) ||
    options.outputRoot.length > 4096 ||
    options.cases.length < 1 ||
    options.cases.some(
      (id) => id !== "native-build" && id !== "native-security-fixtures",
    ) ||
    new Set(options.cases).size !== options.cases.length
  )
    throw new Error("ACCEPTANCE_ACTION_DENIED");
  const target = parseAcceptanceTarget(options.target),
    tools = parseAcceptanceNativeTools(options.tools);
  if (
    options.cases.some(
      (id) =>
        !isIsolatedNativeAcceptanceCase(
          ACCEPTANCE_CASES.find((definition) => definition.id === id)!,
        ),
    )
  )
    throw new Error("ACCEPTANCE_ACTION_DENIED");
  if (
    (await nativeAcceptanceSourceDigest(options.repository)) !==
    target.sourceSha256
  )
    throw new Error("ACCEPTANCE_SOURCE_MISMATCH");
  await Promise.all([
    checkTool(tools.cmake),
    checkTool(tools.ctest),
    checkTool(tools.guard),
  ]);
  if (tools.version === 3) {
    const bytes = await checkedFile(
      tools.compilerTelemetry.path,
      16 * 1024 ** 2,
    );
    if (
      bytes.length !== tools.compilerTelemetry.bytes ||
      createHash("sha256").update(bytes).digest("hex") !==
        tools.compilerTelemetry.sha256
    )
      throw new Error("ACCEPTANCE_TOOL_INVALID");
  }
  const root = resolve(
    options.outputRoot,
    `MusicMuteAcceptance-${randomUUID()}`,
  );
  await mkdir(root);
  const build = join(root, "native-build");
  const logs: Array<{
      step: string;
      exitCode: number;
      toolExitCode: number;
      terminationReason: "completed" | "timeout" | "overflow";
      bytes: number;
      sha256: string;
      sanitizedOutput: string;
    }> = [],
    evidence: AcceptanceEvidence[] = [];
  let cleanupConfirmed = false;
  const failedToolDiagnostics: Array<{
    step: NativeToolStep;
    diagnostic: NativeToolGuardDiagnostic;
  }> = [];
  const run = async (step: NativeToolStep, tool: Tool, timeout: number) => {
    cleanupConfirmed = false;
    await checkTool(tools.guard);
    const result = await runGuardedNativeTool({
      guard: tools.guard.path,
      step,
      tool,
      repository: options.repository,
      build,
      timeout,
      environment: nativeAcceptanceEnvironment(process.env),
      ...(tools.version === 3 && (step === "configure" || step === "compile")
        ? { compilerTelemetry: tools.compilerTelemetry }
        : {}),
    }).catch((error: unknown) => {
      if (error instanceof NativeToolGuardFailure && error.diagnostic)
        failedToolDiagnostics.push({ step, diagnostic: error.diagnostic });
      throw error;
    });
    cleanupConfirmed = true;
    logs.push({
      step,
      exitCode: result.code,
      toolExitCode: result.toolExitCode,
      terminationReason: result.reason,
      bytes: result.bytes.length,
      sha256: createHash("sha256").update(result.bytes).digest("hex"),
      sanitizedOutput: acceptanceLogExcerpt(
        result.bytes,
        options.repository,
        process.env.USERPROFILE,
      ),
    });
    if (result.code !== 0) throw new Error("ACCEPTANCE_COMMAND_FAILED");
    return result.bytes;
  };
  try {
    await run("configure", tools.cmake, nativeAcceptanceTimeouts.configure);
    await run("compile", tools.cmake, nativeAcceptanceTimeouts.compile);
    const descriptorPath = join(build, "Release/consumer-native-self-test.exe"),
      descriptorBytes = await checkedFile(descriptorPath, 256 * 1024 ** 2);
    const description = await run(
      "describe",
      {
        path: descriptorPath,
        sha256: createHash("sha256").update(descriptorBytes).digest("hex"),
      },
      nativeAcceptanceTimeouts.describe,
    );
    assertNativeAcceptanceTarget(
      target,
      parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(description),
        65536,
      ),
    );
    if (
      (await nativeAcceptanceSourceDigest(options.repository)) !==
      target.sourceSha256
    )
      throw new Error("ACCEPTANCE_SOURCE_MISMATCH");
    for (const id of options.cases) {
      if (id === "native-security-fixtures")
        await run("ctest", tools.ctest, nativeAcceptanceTimeouts.ctest);
      if (
        (await nativeAcceptanceSourceDigest(options.repository)) !==
        target.sourceSha256
      )
        throw new Error("ACCEPTANCE_SOURCE_MISMATCH");
      const definition = ACCEPTANCE_CASES.find((row) => row.id === id)!;
      evidence.push({
        version: 1,
        caseId: id,
        caseSha256: caseDigest(definition),
        targetSha256: targetDigest(target),
        source: "native",
        state: "passed",
        at: new Date().toISOString(),
        observation:
          id === "native-build"
            ? "CMake x64 compile/link and actual target identity succeeded; no signed installer or inference was tested."
            : "Actual isolated CTest suite passed; installed application and physical model inference remain unverified.",
        artifact: "native-run.json",
        artifactSha256: null,
        cleanup: "confirmed",
      });
    }
  } catch (error) {
    const definition = ACCEPTANCE_CASES.find(
      (row) => row.id === options.cases[evidence.length],
    )!;
    evidence.push({
      version: 1,
      caseId: definition.id,
      caseSha256: caseDigest(definition),
      targetSha256: targetDigest(target),
      source: "native",
      state: "failed",
      at: new Date().toISOString(),
      observation:
        error instanceof Error && /^ACCEPTANCE_[A-Z_]+$/u.test(error.message)
          ? error.message
          : "ACCEPTANCE_COMMAND_FAILED",
      artifact: "native-run.json",
      artifactSha256: null,
      cleanup: cleanupConfirmed ? "confirmed" : "unconfirmed",
    });
  }
  // No raw compiler/test logs, paths, SID, tokens or media. On ambiguous tool
  // exit keep the owned run folder; never delete while descendants may be live.
  const observation = Buffer.from(
    JSON.stringify({
      version: 1,
      target,
      logs,
      failedToolDiagnostics,
      installedAppActionsExecuted: false,
    }) + "\n",
  );
  await writeFile(join(root, "native-observation.json"), observation, {
    flag: "wx",
  });
  const artifactSha256 = createHash("sha256").update(observation).digest("hex");
  for (const row of evidence) {
    row.artifact = "native-observation.json";
    row.artifactSha256 = artifactSha256;
  }
  await writeFile(
    join(root, "evidence-ledger.json"),
    JSON.stringify(evidence) + "\n",
    { flag: "wx" },
  );
  return evidence;
}
