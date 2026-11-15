import { expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import {
  createNativeToolGuardRequest,
  parseCompilerTelemetryPolicy,
  parseNativeToolGuardResult,
  parseNativeToolGuardDiagnostic,
  NativeToolGuardFailure,
  runGuardedNativeTool,
} from "../acceptance/native-tool-guard.js";
import {
  nativeAcceptanceTimeouts,
  parseAcceptanceNativeTools,
} from "../acceptance/native-run.js";
it("bounds the complete installed-package fixture suite while preserving other tool deadlines", () => {
  expect(nativeAcceptanceTimeouts).toEqual({
    configure: 120000,
    compile: 300000,
    describe: 10000,
    ctest: 300000,
  });
  expect(Object.isFrozen(nativeAcceptanceTimeouts)).toBe(true);
});
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
const failureDiagnostic = (phase = "policy-trust") =>
  `ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED\nQA tool failure phase: phase=${phase}; job_created=0; child_created=0; trust_observed=1; trust_result=2148081683\n`;
it("only bounded fixed failure metadata is retained; it cannot authorize cleanup", () => {
  const text = failureDiagnostic();
  const expected = {
    phase: "policy-trust",
    jobCreated: false,
    childCreated: false,
    trustObserved: true,
    trustResult: 2148081683,
  };
  expect(parseNativeToolGuardDiagnostic(Buffer.from(text))).toEqual(expected);
  for (const phase of [
    "identity-token",
    "identity-user",
    "identity-sid-copy",
    "identity-session",
    "identity-elevation",
    "identity-complete",
    "owner-nonadmin",
    "owner-session",
    "child-native",
    "child-nonadmin",
    "child-session",
    "child-user",
  ])
    expect(
      parseNativeToolGuardDiagnostic(Buffer.from(failureDiagnostic(phase))),
    ).toMatchObject({ phase, jobCreated: false, childCreated: false });
  expect(
    parseNativeToolGuardDiagnostic(Buffer.from(text.replaceAll("\n", "\r\n"))),
  ).toEqual(expected);
  expect(
    parseNativeToolGuardDiagnostic(
      Buffer.from(
        failureDiagnostic("child-resume")
          .replace(
            "job_created=0; child_created=0",
            "job_created=1; child_created=1",
          )
          .replace("2148081683", "0"),
      ),
    ),
  ).toMatchObject({ childCreated: true, trustResult: 0 });
  for (const value of [
    "",
    "ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED\n",
    `${text}private-song.mp3`,
    text + text,
    text.replace("policy-trust", "unknown"),
    text.replace("policy-trust", "C:\\private"),
    text.replace("child_created=0", "child_created=1"),
    text.replace("job_created=0", "job_created=2"),
    text.replace("trust_observed=1", "trust_observed=0"),
    text.replace("2148081683", "4294967296"),
    text.replace("2148081683", "02148081683"),
    text.replace("2148081683", "-1"),
    text.replace("2148081683", "1.5"),
    text.replace("phase=", "phase=\0"),
    text.replace("\n", "\r\n"),
    text.replace("\n", "\r"),
    "a".repeat(1025),
  ])
    expect(parseNativeToolGuardDiagnostic(Buffer.from(value))).toBeNull();
  expect(parseNativeToolGuardDiagnostic(Buffer.from([0xff]))).toBeNull();
  expect(
    parseNativeToolGuardDiagnostic(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]),
    ),
  ).toBeNull();
  expect(() => parseNativeToolGuardResult(expected, request)).toThrow(
    "ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED",
  );
});
it("guard failures remain rejected with cleanup unconfirmed, and arbitrary stderr is discarded", async () => {
  vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
  try {
    for (const [text, code, diagnosticExpected] of [
      [failureDiagnostic(), 2, true],
      ["private song and path\n", 2, false],
      [failureDiagnostic(), 0, false],
      [failureDiagnostic(), 1, false],
      [failureDiagnostic() + "x".repeat(1025), 2, false],
    ] as const) {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      vi.mocked(spawn).mockImplementationOnce(() => {
        queueMicrotask(() => {
          child.stderr.write(text);
          child.emit("close", code);
        });
        return child as unknown as ReturnType<typeof spawn>;
      });
      const error = await runGuardedNativeTool({
        guard: "C:\\QA\\consumer-native-qa-tool-guard.exe",
        step: "configure",
        tool: { path: cmake, sha256: "a".repeat(64) },
        repository: "C:\\QA\\source",
        build: "C:\\QA\\native-build",
        timeout: 1000,
        environment: {},
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(NativeToolGuardFailure);
      expect(error).toMatchObject({
        message: "ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED",
        diagnostic: diagnosticExpected
          ? parseNativeToolGuardDiagnostic(Buffer.from(text))
          : null,
      });
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
const request = { request_id: "a".repeat(64), step: "compile" as const };
const receipt = () => ({
  version: 1,
  ...request,
  exit_code: 0,
  active_processes: 0,
  cleanup: "confirmed",
  reason: "completed",
  output_base64: Buffer.from("bounded compiler log").toString("base64"),
});
const instance = "C:\\MusicMuteBuild\\VisualStudio2022BuildTools";
const telemetry = {
  kind: "msvc-vctip" as const,
  path: `${instance}\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\VCTIP.exe`,
  sha256: "d".repeat(64),
  bytes: 335288,
};
const cmake = `${instance}\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe`;
it("explicit compiler cleanup authority is versioned, closed and tied to the same x64 MSVC instance", () => {
  const tools = {
    version: 3,
    cmake: { path: cmake, sha256: "a".repeat(64) },
    ctest: {
      path: cmake.replace(/cmake\.exe$/u, "ctest.exe"),
      sha256: "b".repeat(64),
    },
    guard: {
      path: "C:\\QA\\consumer-native-qa-tool-guard.exe",
      sha256: "c".repeat(64),
    },
    compilerTelemetry: telemetry,
  };
  expect(parseAcceptanceNativeTools(tools)).toEqual(tools);
  const { compilerTelemetry: _policy, ...withoutPolicy } = tools;
  for (const value of [
    withoutPolicy,
    { ...tools, version: 2 },
    { ...tools, compilerTelemetry: null },
    { ...tools, arbitraryCommand: "ignored" },
    {
      ...tools,
      cmake: {
        ...tools.cmake,
        path: cmake.replace("MusicMuteBuild", "Foreign"),
      },
    },
    {
      ...tools,
      ctest: {
        ...tools.ctest,
        path: tools.ctest.path.replace("MusicMuteBuild", "Foreign"),
      },
    },
  ])
    expect(() => parseAcceptanceNativeTools(value)).toThrow(
      "ACCEPTANCE_TOOL_INVALID",
    );
  const accessor = vi.fn(() => telemetry);
  const forged = { ...tools };
  Object.defineProperty(forged, "compilerTelemetry", { get: accessor });
  expect(() => parseAcceptanceNativeTools(forged)).toThrow(
    "ACCEPTANCE_TOOL_INVALID",
  );
  expect(accessor).not.toHaveBeenCalled();
});
it("malformed telemetry metadata cannot grant helper retirement", () => {
  expect(parseCompilerTelemetryPolicy(telemetry)).toEqual(telemetry);
  for (const value of [
    null,
    { ...telemetry, kind: "any-process" },
    { ...telemetry, sha256: "D".repeat(64) },
    { ...telemetry, bytes: "335288" },
    { ...telemetry, bytes: 1023 },
    { ...telemetry, bytes: 16 * 1024 ** 2 + 1 },
    { ...telemetry, bytes: 335288.5 },
    { ...telemetry, path: "VCTIP.exe" },
    { ...telemetry, path: telemetry.path.replace("Hostx64", "Hostx86") },
    { ...telemetry, path: telemetry.path.replace("\\x64\\", "\\arm64\\") },
    {
      ...telemetry,
      path: telemetry.path.replace("14.44.35207", "14.43.35207"),
    },
    { ...telemetry, path: telemetry.path.replace("\\VC\\", "\\..\\VC\\") },
    { ...telemetry, path: `${telemetry.path}:payload` },
    { ...telemetry, path: telemetry.path.replaceAll("\\", "/") },
    { ...telemetry, extra: true },
    { ...telemetry, [Symbol("hidden")]: true },
  ])
    expect(() => parseCompilerTelemetryPolicy(value)).toThrow(
      "ACCEPTANCE_TOOL_INVALID",
    );
  const accessor = vi.fn(() => telemetry.path);
  const forged = { ...telemetry };
  Object.defineProperty(forged, "path", { get: accessor });
  expect(() => parseCompilerTelemetryPolicy(forged)).toThrow(
    "ACCEPTANCE_TOOL_INVALID",
  );
  expect(accessor).not.toHaveBeenCalled();
});
it("only explicit configure/compile requests carry pinned telemetry authority; original requests stay unchanged", () => {
  const fields = {
    request_id: "a".repeat(64),
    step: "configure" as const,
    executable: cmake,
    sha256: "b".repeat(64),
    repository: "C:\\QA\\source",
    build: "C:\\QA\\native-build",
    timeout_ms: 120000,
  };
  expect(createNativeToolGuardRequest(fields)).toEqual({
    version: 1,
    ...fields,
  });
  for (const step of ["configure", "compile"] as const)
    expect(
      createNativeToolGuardRequest({ ...fields, step }, telemetry),
    ).toEqual({
      version: 2,
      ...fields,
      step,
      compiler_telemetry: telemetry,
    });
  for (const step of ["ctest", "describe"] as const)
    expect(() =>
      createNativeToolGuardRequest({ ...fields, step }, telemetry),
    ).toThrow("ACCEPTANCE_TOOL_INVALID");
  expect(() =>
    createNativeToolGuardRequest(
      { ...fields, executable: cmake.replace("MusicMuteBuild", "Foreign") },
      telemetry,
    ),
  ).toThrow("ACCEPTANCE_TOOL_INVALID");
});
it("a successful parent exit without an exact request-bound whole-Job-zero receipt cannot pass cleanup", () => {
  for (const value of [
    null,
    { exit_code: 0 },
    { ...receipt(), active_processes: 1 },
    { ...receipt(), cleanup: "not-applicable" },
    { ...receipt(), step: "ctest" },
    { ...receipt(), request_id: "b".repeat(64) },
    { ...receipt(), active_processes: "0" },
    { ...receipt(), private_path: "secret" },
  ])
    expect(() => parseNativeToolGuardResult(value, request)).toThrow(
      "ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED",
    );
  expect(parseNativeToolGuardResult(receipt(), request)).toEqual({
    code: 0,
    toolExitCode: 0,
    reason: "completed",
    bytes: Buffer.from("bounded compiler log"),
  });
});
it("actual Job-zero after timeout/overflow is cleanup proof but never a successful command", () => {
  for (const reason of ["timeout", "overflow"])
    expect(
      parseNativeToolGuardResult({ ...receipt(), reason }, request),
    ).toEqual({
      code: 2,
      toolExitCode: 0,
      reason,
      bytes: Buffer.from("bounded compiler log"),
    });
  expect(
    parseNativeToolGuardResult({ ...receipt(), exit_code: 123 }, request),
  ).toMatchObject({ code: 123, toolExitCode: 123, reason: "completed" });
  const maximum = Buffer.alloc(1024 * 1024, 1);
  expect(
    parseNativeToolGuardResult(
      { ...receipt(), output_base64: maximum.toString("base64") },
      request,
    ).bytes,
  ).toEqual(maximum);
  for (const output_base64 of [
    "abc",
    "AB==",
    Buffer.alloc(1024 * 1024 + 1).toString("base64"),
  ])
    expect(() =>
      parseNativeToolGuardResult({ ...receipt(), output_base64 }, request),
    ).toThrow("ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED");
});
it("requires an independently approved named QA bootstrap input and never invokes object coercion/accessors", () => {
  const tools = {
    version: 2,
    cmake: { path: resolve("cmake.exe"), sha256: "a".repeat(64) },
    ctest: { path: resolve("ctest.exe"), sha256: "b".repeat(64) },
    guard: {
      path: resolve("consumer-native-qa-tool-guard.exe"),
      sha256: "c".repeat(64),
    },
  };
  expect(parseAcceptanceNativeTools(tools)).toEqual(tools);
  expect(() =>
    parseAcceptanceNativeTools({ ...tools, version: 1, guard: undefined }),
  ).toThrow("ACCEPTANCE_TOOL_INVALID");
  expect(() =>
    parseAcceptanceNativeTools({
      ...tools,
      guard: { ...tools.guard, path: resolve("powershell.exe") },
    }),
  ).toThrow("ACCEPTANCE_TOOL_INVALID");
  const accessor = vi.fn(() => "private");
  const forged = { ...receipt() };
  Object.defineProperty(forged, "cleanup", { get: accessor });
  expect(() => parseNativeToolGuardResult(forged, request)).toThrow(
    "ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED",
  );
  const badTools = { ...tools };
  Object.defineProperty(badTools, "guard", { get: accessor });
  expect(() => parseAcceptanceNativeTools(badTools)).toThrow(
    "ACCEPTANCE_TOOL_INVALID",
  );
  expect(accessor).not.toHaveBeenCalled();
});
it("the native execution adapter refuses Mac source checks before spawning any Windows tool", async () => {
  if (process.platform === "win32") return;
  await expect(
    runGuardedNativeTool({
      guard: "/not-executed/consumer-native-qa-tool-guard.exe",
      step: "compile",
      tool: { path: "/not-executed/cmake.exe", sha256: "a".repeat(64) },
      repository: "/not-executed",
      build: "/not-executed/native-build",
      timeout: 300000,
      environment: {},
    }),
  ).rejects.toThrow("ACCEPTANCE_WINDOWS_PHASE_REQUIRED");
});
