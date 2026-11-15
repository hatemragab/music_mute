import { execFile, spawn } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { isCurrentUserSid } from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import {
  hashPrivateFile,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import {
  analyzeFloatPcm,
  SILENCE_ANALYSIS_VERSION,
  validateSilenceRanges,
  type SilenceRange,
} from "./silence-analysis.js";
const execute = promisify(execFile),
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu,
  SHA = /^[a-f0-9]{64}$/u;
export interface SilenceChildConfig {
  version: 1;
  operation: "silence_analyze";
  requestId: string;
  executionId: string;
  release: string;
  sid: string;
  manifestSha256: string;
  helperSha256: string;
  inputBytes: number;
  inputSha256: string;
  durationSeconds: number;
}
export interface SilenceChildResult {
  version: 1;
  operation: "silence_analyze";
  requestId: string;
  executionId: string;
  analysisVersion: string;
  inputSha256: string;
  durationSeconds: number;
  ranges: SilenceRange[];
}
export function isSilenceOperation(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).operation === "silence_analyze"
  );
}
export function parseSilenceChildConfig(value: unknown): SilenceChildConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SILENCE_UNAVAILABLE");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join() !==
      "durationSeconds,executionId,helperSha256,inputBytes,inputSha256,manifestSha256,operation,release,requestId,sid,version" ||
    row.version !== 1 ||
    row.operation !== "silence_analyze" ||
    typeof row.requestId !== "string" ||
    !UUID.test(row.requestId) ||
    typeof row.executionId !== "string" ||
    !UUID.test(row.executionId) ||
    !isCurrentUserSid(row.sid) ||
    [row.release, row.manifestSha256, row.helperSha256, row.inputSha256].some(
      (value) => typeof value !== "string" || !SHA.test(value),
    ) ||
    !Number.isSafeInteger(row.inputBytes) ||
    Number(row.inputBytes) < 1 ||
    Number(row.inputBytes) > 256 * 1024 ** 2 ||
    typeof row.durationSeconds !== "number" ||
    !Number.isFinite(row.durationSeconds) ||
    row.durationSeconds <= 0 ||
    row.durationSeconds > 7200
  )
    throw new Error("SILENCE_UNAVAILABLE");
  return structuredClone(row) as unknown as SilenceChildConfig;
}
export function parseSilenceChildResult(
  value: unknown,
  config: SilenceChildConfig,
): SilenceChildResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SILENCE_UNAVAILABLE");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join() !==
      "analysisVersion,durationSeconds,executionId,inputSha256,operation,ranges,requestId,version" ||
    row.version !== 1 ||
    row.operation !== config.operation ||
    row.requestId !== config.requestId ||
    row.executionId !== config.executionId ||
    row.inputSha256 !== config.inputSha256 ||
    row.analysisVersion !== SILENCE_ANALYSIS_VERSION ||
    typeof row.durationSeconds !== "number" ||
    !Number.isFinite(row.durationSeconds) ||
    Math.abs(row.durationSeconds - config.durationSeconds) >
      Math.max(0.25, config.durationSeconds * 0.0001)
  )
    throw new Error("SILENCE_UNAVAILABLE");
  return {
    ...row,
    ranges: validateSilenceRanges(row.ranges, row.durationSeconds),
  } as unknown as SilenceChildResult;
}
export function parseSilenceProbe(value: unknown, expected: number): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SILENCE_UNAVAILABLE");
  const row = value as { format?: { duration?: unknown }; streams?: unknown };
  const duration = Number(row.format?.duration);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 7200 ||
    Math.abs(duration - expected) > Math.max(0.25, expected * 0.0001) ||
    !Array.isArray(row.streams) ||
    row.streams.length !== 1
  )
    throw new Error("SILENCE_UNAVAILABLE");
  const stream = row.streams[0] as {
    codec_type?: unknown;
    sample_rate?: unknown;
    channels?: unknown;
  };
  if (
    stream.codec_type !== "audio" ||
    ![1, 2].includes(Number(stream.channels)) ||
    !Number.isSafeInteger(Number(stream.sample_rate)) ||
    Number(stream.sample_rate) < 8000 ||
    Number(stream.sample_rate) > 192000
  )
    throw new Error("SILENCE_UNAVAILABLE");
}
/** Common fixed Prepare entry has already verified the whole signed release, current SID and role paths. */
export async function runSilenceChild(
  host: HostContext,
  config: SilenceChildConfig,
  releaseRoot: string,
): Promise<void> {
  const work = `prepare\\work\\${config.requestId}`,
    relative = `${work}\\voice.bin`,
    input = win32.join(host.personalRoot, relative),
    signal = AbortSignal.timeout(5 * 60000);
  await host.native.validatePath("personal", work, "directory");
  if (
    (await hashPrivateFile(host, relative, config.inputBytes, signal)) !==
    config.inputSha256
  )
    throw new Error("SILENCE_UNAVAILABLE");
  const environment: NodeJS.ProcessEnv = {
    TEMP: win32.join(host.personalRoot, work),
    TMP: win32.join(host.personalRoot, work),
    PATH: win32.join(releaseRoot, "runtime", "bin"),
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"])
    if (process.env[key]) environment[key] = process.env[key];
  const formats = "mov,mp3,matroska,webm,ogg,aac,wav,flac";
  const probe = await execute(
    win32.join(releaseRoot, "runtime", "bin", "ffprobe.exe"),
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      formats,
      "-show_entries",
      "format=duration:stream=codec_type,sample_rate,channels",
      "-of",
      "json",
      input,
    ],
    {
      cwd: win32.join(host.personalRoot, work),
      env: environment,
      windowsHide: true,
      maxBuffer: 16384,
      signal,
    },
  );
  parseSilenceProbe(JSON.parse(probe.stdout), config.durationSeconds);
  const child = spawn(
    win32.join(releaseRoot, "runtime", "bin", "ffmpeg.exe"),
    [
      "-nostdin",
      "-v",
      "error",
      "-threads",
      "2",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      formats,
      "-i",
      input,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-f",
      "f32le",
      "pipe:1",
    ],
    {
      cwd: win32.join(host.personalRoot, work),
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    },
  );
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 65536) child.kill();
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("SILENCE_UNAVAILABLE")));
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("SILENCE_UNAVAILABLE")),
    );
  });
  void exited.catch(() => {});
  try {
    const result = await analyzeFloatPcm(
      child.stdout,
      { sampleRate: 44100, channels: 2 },
      signal,
    );
    await exited;
    if (
      Math.abs(result.duration - config.durationSeconds) >
        Math.max(0.25, config.durationSeconds * 0.0001) ||
      (await hashPrivateFile(host, relative, config.inputBytes, signal)) !==
        config.inputSha256
    )
      throw new Error("SILENCE_UNAVAILABLE");
    const output: SilenceChildResult = {
      version: 1,
      operation: config.operation,
      requestId: config.requestId,
      executionId: config.executionId,
      analysisVersion: SILENCE_ANALYSIS_VERSION,
      inputSha256: config.inputSha256,
      durationSeconds: result.duration,
      ranges: result.ranges,
    };
    await writePrivateAtomic(
      host,
      `${work}\\silence-map.json`,
      Buffer.from(JSON.stringify(output)),
    );
  } finally {
    if (child.exitCode === null) child.kill();
  }
}
