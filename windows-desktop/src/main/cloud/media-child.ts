import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";
import { isCurrentUserSid } from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import { writePrivateAtomic } from "../prepare/private-files.js";
const execute = promisify(execFile),
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu,
  SHA = /^[a-f0-9]{64}$/u;
export interface CloudMediaChildConfig {
  version: 1;
  operation: "cloud_prepare" | "cloud_probe";
  requestId: string;
  executionId: string;
  release: string;
  sid: string;
  manifestSha256: string;
  helperSha256: string;
  inputBytes: number;
}
export interface CloudMediaChildResult {
  version: 1;
  operation: CloudMediaChildConfig["operation"];
  requestId: string;
  executionId: string;
  source: "audio_file" | "video_file";
  bytes: number;
  durationSeconds: number;
  sha256: string;
  codec: "aac" | "mp3";
}
export function isCloudMediaOperation(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ["cloud_prepare", "cloud_probe"].includes(
      String((value as Record<string, unknown>).operation),
    )
  );
}
export function parseCloudMediaChildConfig(
  value: unknown,
): CloudMediaChildConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CLOUD_INPUT_INVALID");
  const row = value as Record<string, unknown>;
  const keys = [
    "version",
    "operation",
    "requestId",
    "executionId",
    "release",
    "sid",
    "manifestSha256",
    "helperSha256",
    "inputBytes",
  ];
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key)) ||
    row.version !== 1 ||
    !["cloud_prepare", "cloud_probe"].includes(String(row.operation)) ||
    typeof row.requestId !== "string" ||
    !UUID.test(row.requestId) ||
    typeof row.executionId !== "string" ||
    !UUID.test(row.executionId) ||
    !isCurrentUserSid(row.sid) ||
    [row.release, row.manifestSha256, row.helperSha256].some(
      (v) => typeof v !== "string" || !SHA.test(v),
    ) ||
    !Number.isSafeInteger(row.inputBytes) ||
    (row.inputBytes as number) < 1 ||
    (row.inputBytes as number) > 256 * 1024 ** 2
  )
    throw new Error("CLOUD_INPUT_INVALID");
  return structuredClone(row) as unknown as CloudMediaChildConfig;
}
export function parseCloudProbe(
  value: unknown,
  output?: "aac" | "mp3",
): { duration: number; source: "audio_file" | "video_file" } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("CLOUD_INPUT_INVALID");
  const row = value as { streams?: unknown; format?: { duration?: unknown } };
  const duration = Number(row.format?.duration);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 1200 ||
    !Array.isArray(row.streams) ||
    row.streams.length < 1 ||
    row.streams.length > 16
  )
    throw new Error("CLOUD_INPUT_INVALID");
  const streams = row.streams as {
      codec_type?: unknown;
      codec_name?: unknown;
      profile?: unknown;
      sample_rate?: unknown;
      channels?: unknown;
    }[],
    audio = streams.filter((s) => s.codec_type === "audio");
  if (audio.length < 1) throw new Error("CLOUD_INPUT_INVALID");
  if (
    output &&
    (audio.length !== 1 ||
      streams.some((s) => s.codec_type !== "audio") ||
      audio[0]!.codec_name !== output ||
      (output === "aac" &&
        (audio[0]!.profile !== "LC" ||
          Number(audio[0]!.sample_rate) !== 44100 ||
          audio[0]!.channels !== 2)))
  )
    throw new Error("CLOUD_INPUT_INVALID");
  return {
    duration,
    source: streams.some((s) => s.codec_type === "video")
      ? "video_file"
      : "audio_file",
  };
}
/** Invoked only after the fixed owned Prepare entry validates SID/Node/release/helper inventory. CPU audio preparation only. */
export async function runCloudMediaChild(
  host: HostContext,
  config: CloudMediaChildConfig,
  releaseRoot: string,
): Promise<void> {
  const work = `cloud\\work\\${config.requestId}`,
    inputRelative = `${work}\\${config.operation === "cloud_prepare" ? "original-media.bin" : "result.mp3"}`;
  await host.native.validatePath("personal", work, "directory");
  await host.native.validatePath("personal", inputRelative, "file");
  const inputPath = win32.join(host.personalRoot, inputRelative),
    stat = await lstat(inputPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size !== config.inputBytes
  )
    throw new Error("CLOUD_INPUT_INVALID");
  const signal = AbortSignal.timeout(5 * 60000),
    environment: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  environment.TEMP = win32.join(host.personalRoot, work);
  environment.TMP = environment.TEMP;
  environment.PATH = win32.join(releaseRoot, "runtime", "bin");
  const run = async (name: "ffmpeg" | "ffprobe", args: string[]) =>
    await execute(
      win32.join(releaseRoot, "runtime", "bin", `${name}.exe`),
      args,
      {
        cwd: win32.join(host.personalRoot, work),
        windowsHide: true,
        env: environment,
        maxBuffer: 65536,
        timeout: 180000,
        signal,
      },
    );
  const probe = async (path: string, output?: "aac" | "mp3") =>
    parseCloudProbe(
      JSON.parse(
        (
          await run("ffprobe", [
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            output === "mp3" ? "mp3" : "mov,mp3,matroska,webm,ogg,aac,wav,flac",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name,profile,sample_rate,channels",
            "-of",
            "json",
            path,
          ])
        ).stdout,
      ),
      output,
    );
  const original = await probe(
    inputPath,
    config.operation === "cloud_probe" ? "mp3" : undefined,
  );
  let path = inputPath,
    info = original;
  if (config.operation === "cloud_prepare") {
    const outputRelative = `${work}\\source.m4a`;
    await host.native.validatePath("personal", outputRelative, "absent");
    path = win32.join(host.personalRoot, outputRelative);
    await run("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "mov,mp3,matroska,webm,ogg,aac,wav,flac",
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-b:a",
      "160k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      "-n",
      path,
    ]);
    await host.native.validatePath("personal", outputRelative, "file");
    info = await probe(path, "aac");
    if (Math.abs(info.duration - original.duration) > 0.25)
      throw new Error("CLOUD_INPUT_INVALID");
  }
  const file = await open(path, "r");
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > 100000000n
    )
      throw new Error("CLOUD_INPUT_INVALID");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({
      autoClose: false,
      signal,
    }))
      hash.update(chunk);
    const after = await file.stat({ bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error("CLOUD_INPUT_INVALID");
    const result: CloudMediaChildResult = {
      version: 1,
      operation: config.operation,
      requestId: config.requestId,
      executionId: config.executionId,
      source: original.source,
      bytes: Number(before.size),
      durationSeconds: info.duration,
      sha256: hash.digest("base64"),
      codec: config.operation === "cloud_prepare" ? "aac" : "mp3",
    };
    await writePrivateAtomic(
      host,
      `${work}\\media-result.json`,
      Buffer.from(JSON.stringify(result)),
    );
  } finally {
    await file.close();
  }
}
