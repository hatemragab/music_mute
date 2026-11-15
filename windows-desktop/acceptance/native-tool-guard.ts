import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { parseStrictJson } from "../../chrome-extension/src/shared/strict-json.js";
export type NativeToolStep = "configure" | "compile" | "describe" | "ctest";
export type NativeToolGuardReason = "completed" | "timeout" | "overflow";
export interface NativeToolGuardResult {
  code: number;
  toolExitCode: number;
  reason: NativeToolGuardReason;
  bytes: Buffer;
}
export interface CompilerTelemetryPolicy {
  kind: "msvc-vctip";
  path: string;
  sha256: string;
  bytes: number;
}
const FAILURE_PHASES = [
  "target",
  "request-input",
  "request-policy",
  "paths",
  "tool-parents",
  "tool-image",
  "tool-hash",
  "policy-parents",
  "policy-image",
  "policy-size",
  "policy-hash",
  "policy-pe",
  "policy-trust",
  "policy-publisher",
  "policy-stable",
  "current-identity",
  "identity-token",
  "identity-user",
  "identity-sid-copy",
  "identity-session",
  "identity-elevation",
  "identity-complete",
  "owner-nonadmin",
  "owner-session",
  "isolated-build",
  "job-create",
  "pipe-create",
  "attribute-list",
  "child-create",
  "job-assign",
  "child-identity",
  "child-native",
  "child-nonadmin",
  "child-session",
  "child-user",
  "child-resume",
  "output-loop",
  "job-zero",
  "receipt-write",
  "self-test",
] as const;
export interface NativeToolGuardDiagnostic {
  phase: (typeof FAILURE_PHASES)[number];
  jobCreated: boolean;
  childCreated: boolean;
  trustObserved: boolean;
  trustResult: number;
}
/** Fixed failure metadata only. Historical creation flags never establish
 * process retirement, actual Job zero or a successful tool invocation. */
export function parseNativeToolGuardDiagnostic(
  bytes: Buffer,
): NativeToolGuardDiagnostic | null {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
  const match =
    /^ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED(\r?\n)QA tool failure phase: phase=([a-z-]{3,32}); job_created=([01]); child_created=([01]); trust_observed=([01]); trust_result=(0|[1-9][0-9]{0,9})\1$/u.exec(
      text,
    );
  if (
    !match ||
    !FAILURE_PHASES.includes(match[2] as NativeToolGuardDiagnostic["phase"])
  )
    return null;
  const trustResult = Number(match[6]);
  if (
    trustResult > 0xffffffff ||
    (match[3] === "0" && match[4] === "1") ||
    (match[5] === "0" && trustResult !== 0)
  )
    return null;
  return {
    phase: match[2] as NativeToolGuardDiagnostic["phase"],
    jobCreated: match[3] === "1",
    childCreated: match[4] === "1",
    trustObserved: match[5] === "1",
    trustResult,
  };
}
export class NativeToolGuardFailure extends Error {
  constructor(readonly diagnostic: NativeToolGuardDiagnostic | null) {
    super("ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED");
    this.name = "NativeToolGuardFailure";
  }
}
interface NativeToolGuardRequestFields {
  request_id: string;
  step: NativeToolStep;
  executable: string;
  sha256: string;
  repository: string;
  build: string;
  timeout_ms: number;
}
export type NativeToolGuardRequest = NativeToolGuardRequestFields &
  (
    { version: 1 } | { version: 2; compiler_telemetry: CompilerTelemetryPolicy }
  );
/** Explicit QA authority only; the native guard must independently prove the
 * pinned image, Microsoft trust and membership of every retained process. */
export function parseCompilerTelemetryPolicy(
  value: unknown,
): CompilerTelemetryPolicy {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string") ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !("value" in descriptor),
    ) ||
    Object.keys(value).sort().join() !== "bytes,kind,path,sha256"
  )
    throw new Error("ACCEPTANCE_TOOL_INVALID");
  const row = value as CompilerTelemetryPolicy;
  if (
    row.kind !== "msvc-vctip" ||
    typeof row.path !== "string" ||
    row.path.length > 4096 ||
    /[\p{Cc}\p{Cf}"/]/u.test(row.path) ||
    !/^[A-Za-z]:\\/u.test(row.path) ||
    row.path.indexOf(":", 2) !== -1 ||
    row.path
      .slice(3)
      .split("\\")
      .some(
        (part) => !part || part === "." || part === ".." || /[. ]$/u.test(part),
      ) ||
    !/\\VC\\Tools\\MSVC\\14\.44\.[0-9]{5}\\bin\\Hostx64\\x64\\VCTIP\.exe$/iu.test(
      row.path,
    ) ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.sha256) ||
    !Number.isInteger(row.bytes) ||
    row.bytes < 1024 ||
    row.bytes > 16 * 1024 * 1024
  )
    throw new Error("ACCEPTANCE_TOOL_INVALID");
  return row;
}
export function createNativeToolGuardRequest(
  fields: NativeToolGuardRequestFields,
  compilerTelemetry?: CompilerTelemetryPolicy,
): NativeToolGuardRequest {
  if (compilerTelemetry === undefined) return { version: 1, ...fields };
  if (fields.step !== "configure" && fields.step !== "compile")
    throw new Error("ACCEPTANCE_TOOL_INVALID");
  const policy = parseCompilerTelemetryPolicy(compilerTelemetry);
  const marker = policy.path.toLowerCase().lastIndexOf("\\vc\\tools\\msvc\\");
  const instance = policy.path.slice(0, marker);
  const expectedTool = `${instance}\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake.exe`;
  if (fields.executable.toLowerCase() !== expectedTool.toLowerCase())
    throw new Error("ACCEPTANCE_TOOL_INVALID");
  return { version: 2, ...fields, compiler_telemetry: policy };
}
function invalid(): never {
  throw new Error("ACCEPTANCE_TOOL_CLEANUP_UNCONFIRMED");
}
/** Parent close is insufficient: only an approved guard's request-bound positive
 * whole-Job-zero certificate authorizes native cleanup evidence. */
export function parseNativeToolGuardResult(
  value: unknown,
  request: Pick<NativeToolGuardRequest, "request_id" | "step">,
): NativeToolGuardResult {
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
    return invalid();
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join() !==
      "active_processes,cleanup,exit_code,output_base64,reason,request_id,step,version" ||
    row.version !== 1 ||
    row.request_id !== request.request_id ||
    row.step !== request.step ||
    row.cleanup !== "confirmed" ||
    row.active_processes !== 0 ||
    !Number.isInteger(row.exit_code) ||
    (row.exit_code as number) < 0 ||
    (row.exit_code as number) > 0xffffffff ||
    !["completed", "timeout", "overflow"].includes(row.reason as string) ||
    typeof row.output_base64 !== "string" ||
    row.output_base64.length > 1398104 ||
    row.output_base64.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/u.test(row.output_base64)
  )
    return invalid();
  const bytes = Buffer.from(row.output_base64, "base64");
  if (
    bytes.length > 1024 * 1024 ||
    bytes.toString("base64") !== row.output_base64
  )
    return invalid();
  return {
    code: row.reason === "completed" ? (row.exit_code as number) : 2,
    toolExitCode: row.exit_code as number,
    reason: row.reason as NativeToolGuardReason,
    bytes,
  };
}
/** This separately approved QA bootstrap is not a production native helper. */
export function runGuardedNativeTool(options: {
  guard: string;
  step: NativeToolStep;
  tool: { path: string; sha256: string };
  repository: string;
  build: string;
  timeout: number;
  environment: NodeJS.ProcessEnv;
  compilerTelemetry?: CompilerTelemetryPolicy;
}): Promise<NativeToolGuardResult> {
  if (process.platform !== "win32" || process.arch !== "x64")
    return Promise.reject(new Error("ACCEPTANCE_WINDOWS_PHASE_REQUIRED"));
  const request = createNativeToolGuardRequest(
    {
      request_id: randomBytes(32).toString("hex"),
      step: options.step,
      executable: options.tool.path,
      sha256: options.tool.sha256,
      repository: options.repository,
      build: options.build,
      timeout_ms: options.timeout,
    },
    options.compilerTelemetry,
  );
  return new Promise((accept, reject) => {
    const child = spawn(options.guard, ["--qa-tool"], {
      cwd: options.repository,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: options.environment,
    });
    const frames: Buffer[] = [];
    const diagnosticFrames: Buffer[] = [];
    let size = 0,
      stderr = false,
      diagnosticSize = 0,
      failed = false;
    const fail = (diagnostic: NativeToolGuardDiagnostic | null = null) => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      child.kill();
      reject(new NativeToolGuardFailure(diagnostic));
    };
    const timer = setTimeout(fail, options.timeout + 15000);
    child.stdout.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > 2 * 1024 * 1024) fail();
      else frames.push(bytes);
    });
    child.stderr.on("data", (bytes: Buffer) => {
      stderr = true;
      diagnosticSize += bytes.length;
      if (diagnosticSize <= 1024) diagnosticFrames.push(bytes);
    });
    child.stdin.on("error", () => fail());
    child.on("error", () => fail());
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0 || stderr) {
        fail(
          code === 2 && diagnosticSize <= 1024
            ? parseNativeToolGuardDiagnostic(Buffer.concat(diagnosticFrames))
            : null,
        );
        return;
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(frames),
        );
        if (!text.endsWith("\n") || text.slice(0, -1).includes("\n"))
          return fail();
        accept(
          parseNativeToolGuardResult(
            parseStrictJson(text.trimEnd(), 2 * 1024 * 1024),
            request,
          ),
        );
      } catch {
        fail();
      }
    });
    child.stdin.end(JSON.stringify(request) + "\n");
  });
}
