import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";
import { isCurrentUserSid } from "../../../../worker/src/platform/windows/consumer-native.js";
import { DIAGNOSTIC_UUID } from "../../shared/diagnostics-contracts.js";
import type { HostContext } from "../host-context.js";
import { writePrivateAtomic } from "../prepare/private-files.js";
const execute = promisify(execFile),
  SHA = /^[a-f0-9]{64}$/u;
export interface DiagnosticDoctorConfiguration {
  version: 1;
  operation: "diagnostics_doctor";
  requestId: string;
  executionId: string;
  release: string;
  sid: string;
  manifestSha256: string;
  helperSha256: string;
}
export interface DiagnosticDoctorResult {
  version: 1;
  operation: "diagnostics_doctor";
  requestId: string;
  executionId: string;
  release: string;
  manifestSha256: string;
  sid: string;
  nodeAccepted: boolean;
  pythonAccepted: boolean;
  directmlAvailable: boolean;
  engineProtocolAccepted: boolean;
  mediaToolsAccepted: boolean;
  gpuCount: number;
  inferencePerformed: false;
  networkRequests: 0;
}
export function isDiagnosticDoctorOperation(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { operation?: unknown }).operation === "diagnostics_doctor"
  );
}
export function parseDiagnosticDoctorConfiguration(
  value: unknown,
): DiagnosticDoctorConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("DIAGNOSTICS_CONFIG_INVALID");
  const v = value as DiagnosticDoctorConfiguration;
  if (
    Object.keys(v).sort().join() !==
      "executionId,helperSha256,manifestSha256,operation,release,requestId,sid,version" ||
    v.version !== 1 ||
    v.operation !== "diagnostics_doctor" ||
    !DIAGNOSTIC_UUID.test(v.requestId) ||
    !DIAGNOSTIC_UUID.test(v.executionId) ||
    !isCurrentUserSid(v.sid) ||
    [v.release, v.manifestSha256, v.helperSha256].some(
      (s) => typeof s !== "string" || !SHA.test(s),
    )
  )
    throw new Error("DIAGNOSTICS_CONFIG_INVALID");
  return structuredClone(v);
}
export function parseDiagnosticDoctorResult(
  value: unknown,
  c: DiagnosticDoctorConfiguration,
): DiagnosticDoctorResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("DIAGNOSTICS_DOCTOR_INVALID");
  const v = value as DiagnosticDoctorResult;
  if (
    Object.keys(v).sort().join() !==
      "directmlAvailable,engineProtocolAccepted,executionId,gpuCount,inferencePerformed,manifestSha256,mediaToolsAccepted,networkRequests,nodeAccepted,operation,pythonAccepted,release,requestId,sid,version" ||
    v.version !== 1 ||
    v.operation !== c.operation ||
    v.requestId !== c.requestId ||
    v.executionId !== c.executionId ||
    v.release !== c.release ||
    v.manifestSha256 !== c.manifestSha256 ||
    v.sid !== c.sid ||
    v.inferencePerformed !== false ||
    v.networkRequests !== 0 ||
    !Number.isSafeInteger(v.gpuCount) ||
    v.gpuCount < 0 ||
    v.gpuCount > 32 ||
    [
      v.nodeAccepted,
      v.pythonAccepted,
      v.directmlAvailable,
      v.engineProtocolAccepted,
      v.mediaToolsAccepted,
    ].some((b) => typeof b !== "boolean")
  )
    throw new Error("DIAGNOSTICS_DOCTOR_INVALID");
  return structuredClone(v);
}
export type DoctorExecute = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    windowsHide: true;
    maxBuffer: number;
    timeout: number;
    signal: AbortSignal;
  },
) => Promise<{ stdout: string }>;
/** Fixed offline metadata/tool inspection inside the already validated Prepare Job. Never constructs an inference session. */
export async function runDiagnosticDoctorChild(
  host: HostContext,
  config: DiagnosticDoctorConfiguration,
  releaseRoot: string,
  run: DoctorExecute = execute,
): Promise<void> {
  const relative = `cloud\\work\\${config.requestId}`,
    work = win32.join(host.personalRoot, relative);
  if (host.identity.sid !== config.sid)
    throw new Error("DIAGNOSTICS_CONTEXT_INVALID");
  await host.native.validatePath("personal", relative, "directory");
  const env: NodeJS.ProcessEnv = {
    TEMP: work,
    TMP: work,
    PATH: win32.join(releaseRoot, "runtime", "bin"),
  };
  for (const k of ["SystemRoot", "SYSTEMROOT", "WINDIR"])
    if (process.env[k]) env[k] = process.env[k];
  const signal = AbortSignal.timeout(60000);
  let pythonAccepted = false,
    directmlAvailable = false,
    engineProtocolAccepted = false,
    mediaToolsAccepted = false;
  try {
    const { stdout } = await run(
      win32.join(releaseRoot, "runtime", "python", "python.exe"),
      [
        "-I",
        "-c",
        "import json,sys,importlib.metadata as m;sys.path.insert(0,sys.argv[1]);from musicmute_engine import CHILD_PROTOCOL_VERSION;import onnxruntime as ort;print(json.dumps({'pythonAccepted':sys.version_info[:2]==(3,12) and m.version('onnxruntime-directml')=='1.24.4' and m.version('audio-separator')=='0.47.0','directmlAvailable':'DmlExecutionProvider' in ort.get_available_providers(),'engineProtocolAccepted':CHILD_PROTOCOL_VERSION==1}))",
        win32.join(releaseRoot, "app", "engine"),
      ],
      {
        cwd: work,
        env,
        windowsHide: true,
        maxBuffer: 4096,
        timeout: 20000,
        signal,
      },
    );
    const row = JSON.parse(stdout) as Record<string, unknown>;
    if (
      Object.keys(row).sort().join() !==
        "directmlAvailable,engineProtocolAccepted,pythonAccepted" ||
      Object.values(row).some((v) => typeof v !== "boolean")
    )
      throw new Error("DIAGNOSTICS_DOCTOR_INVALID");
    pythonAccepted = row.pythonAccepted as boolean;
    directmlAvailable = row.directmlAvailable as boolean;
    engineProtocolAccepted = row.engineProtocolAccepted as boolean;
  } catch {
    /* Raw stdout/stderr/errors never enter the result or journal. */
  }
  try {
    const { stdout } = await run(
      win32.join(releaseRoot, "runtime", "python", "python.exe"),
      [
        "-I",
        "-c",
        "import json,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from musicmute_engine.service_doctor import validate_media_runtime;validate_media_runtime(Path(sys.argv[2]),Path(sys.argv[3]));print(json.dumps({'mediaToolsAccepted':True}))",
        win32.join(releaseRoot, "app", "engine"),
        win32.join(releaseRoot, "runtime", "bin", "ffmpeg.exe"),
        win32.join(releaseRoot, "runtime", "bin", "ffprobe.exe"),
      ],
      {
        cwd: work,
        env,
        windowsHide: true,
        maxBuffer: 4096,
        timeout: 35000,
        signal,
      },
    );
    const row = JSON.parse(stdout) as Record<string, unknown>;
    mediaToolsAccepted =
      Object.keys(row).join() === "mediaToolsAccepted" &&
      row.mediaToolsAccepted === true;
  } catch {
    /* Bounded failed check; no network probe or model load fallback. */
  }
  const gpus = await host.native.enumerateGpus();
  const result: DiagnosticDoctorResult = {
    version: 1,
    operation: config.operation,
    requestId: config.requestId,
    executionId: config.executionId,
    release: config.release,
    manifestSha256: config.manifestSha256,
    sid: config.sid,
    nodeAccepted: process.version.startsWith("v24.18."),
    pythonAccepted,
    directmlAvailable,
    engineProtocolAccepted,
    mediaToolsAccepted,
    gpuCount: gpus.length,
    inferencePerformed: false,
    networkRequests: 0,
  };
  await writePrivateAtomic(
    host,
    `${relative}\\doctor-result.json`,
    Buffer.from(JSON.stringify(parseDiagnosticDoctorResult(result, config))),
  );
}
