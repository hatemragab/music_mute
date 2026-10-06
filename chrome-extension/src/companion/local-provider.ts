import { assertYouTubeSetupReady } from "./app-setup.js";
import { runLocalEngine, supportsLocalEngine } from "./local-engine.js";
import {
  rememberTransferredAudio,
  verifyPrivateAudio,
} from "./audio-integrity.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
} from "node:path";
import { performance } from "node:perf_hooks";
import {
  canonicalYouTubeUrl,
  isVideoId,
  MVP_MAX_DURATION_SECONDS,
  sanitizeSourceTitle,
  type LocalAudioArtifact,
  type LocalAudioSource,
  type PipelineHooks,
  type PreparedAudio,
  type ProcessingProvider,
  type StartPayload,
} from "../shared/protocol.js";
import { localToolEnvironment, type LocalConfig } from "./config.js";
import { downloaderToolArguments } from "./downloader-bundle.js";
import { beginSample } from "./resource-monitor.js";
import {
  AcquisitionGate,
  AcquisitionGateError,
  type AcquisitionBlockReason,
} from "./acquisition-gate.js";
import {
  RuntimeResourceGate,
  RuntimeResourceLimitError,
} from "../../../worker/src/runtime/resource-limits.js";

export const MODEL_SHA256 =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const FORMAT =
  "bestaudio[protocol=https]/bestaudio[protocol=http_dash_segments]";
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_ACQUISITION_STDERR_BYTES = 128 * 1024;
const ACQUISITION_INPUT_FORMATS = "mov,mp3,matroska,webm,ogg";
const ACQUISITION_TYPES: Readonly<Record<string, string>> = {
  m4a: "audio/mp4",
  webm: "audio/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
};
const ACQUISITION_CONTAINERS: Readonly<Record<string, string>> = {
  m4a: "mov",
  webm: "webm",
  mp3: "mp3",
  ogg: "ogg",
  opus: "ogg",
};
const DOWNLOAD_METADATA =
  "after_move:%(.{id,duration,extractor_key,is_live,live_status,format_id,vcodec,acodec,language,language_preference,musicmute_audio_track_id,musicmute_audio_is_default,ext,filepath})j";
const SOURCE_METADATA =
  "%(.{_type,id,title,duration,extractor_key,is_live,live_status,format_id,url,ext,protocol,acodec,vcodec,language,language_preference,musicmute_audio_track_id,musicmute_audio_is_default,format_note,container,asr,audio_channels,filesize,filesize_approx,tbr,abr,quality,preference,source_preference,has_drm,available_at,extra_param_to_segment_url,http_headers,fragment_base_url,is_dash_periods,downloader_options})j";
const SOURCE_FRAGMENTS = "%(fragments.:.{url,path,duration,fragment_count})j";
const SOURCE_FORMAT_PROFILES =
  "%(formats.:.{format_id,vcodec,acodec,ext,language,language_preference,musicmute_audio_track_id,musicmute_audio_is_default})j";

export type AcquisitionStderrKind =
  "empty" | "terminal_error" | "python_traceback" | "unclassified";

export interface AcquisitionFailureDetails {
  exit_code?: number;
  http_status?: number;
  stage?: "metadata" | "download";
  refusal_code?: "SOURCE_BOT_CHALLENGE" | "ACQUISITION_RATE_LIMITED";
  block_reason?: AcquisitionBlockReason;
  stderr_kind?: AcquisitionStderrKind;
  /** Bounded bytes retained at the subprocess boundary, never its content. */
  stderr_bytes?: number;
  retry_at?: number;
}

export class LocalProcessingError extends Error {
  constructor(
    readonly code: string,
    readonly acquisition_failure?: AcquisitionFailureDetails,
  ) {
    super(code);
    this.name = "LocalProcessingError";
  }
}
export interface AcquiredYouTubeAudio {
  original: LocalAudioArtifact;
  source: LocalAudioSource;
  timings_ms: Record<string, number>;
  source_title?: string;
}

export interface ToolOptions {
  signal: AbortSignal;
  timeout_ms: number;
  max_output_bytes?: number;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  on_stdout_line?: (line: string) => void;
  owned_download_root?: string;
  on_spawn?: (pid: number) => (() => void) | void;
  context?: "acquisition";
  acquisition_stage?: "metadata" | "download";
  /** Bounded ephemeral metadata; never written to a file or diagnostics. */
  stdin?: string;
}

function acquisitionStderrLines(stderr: string): string[] {
  return (
    stderr
      // ANSI color controls must not conceal a terminal ERROR prefix.
      // oxlint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
  );
}
function nonfatalAcquisitionLine(line: string): boolean {
  return /^(?:(?:WARNING|DEBUG|INFO):|\[(?:debug|info)\])/i.test(line);
}
function acquisitionStderrKind(stderr: string): AcquisitionStderrKind {
  const lines = acquisitionStderrLines(stderr);
  if (lines.every((line) => !line)) return "empty";
  if (lines.some((line) => /^(?:ERROR:|yt-dlp:\s*error:)/i.test(line)))
    return "terminal_error";
  if (lines.some((line) => /^Traceback \(most recent call last\):$/.test(line)))
    return "python_traceback";
  return "unclassified";
}
function fixedAcquisitionBootstrapCode(stderr: string): string | undefined {
  const lines = acquisitionStderrLines(stderr);
  const errors = lines.filter((line) =>
    /^(?:ERROR:|yt-dlp:\s*error:)/i.test(line),
  );
  const terminal =
    errors.at(-1) ??
    lines.filter((line) => line && !nonfatalAcquisitionLine(line)).at(-1);
  return terminal?.match(
    /^(?:ERROR:\s*)?(DOWNLOADER_ARGUMENTS_INVALID|DOWNLOADER_ISOLATION_REQUIRED|SOURCE_TOKEN_REQUIRED|PO_TOKEN_PROVIDER_INVALID|DENO_MISSING|YT_DLP_EJS_MISSING)$/,
  )?.[1];
}

/** Terminal errors take precedence over nonfatal warnings and generic help. */
function acquisitionFailureText(stderr: string): string {
  const lines = acquisitionStderrLines(stderr);
  const errors = lines.filter((line) =>
    /^(?:ERROR:|yt-dlp:\s*error:)/i.test(line),
  );
  const primary =
    errors.at(-1) ??
    lines.filter((line) => !nonfatalAcquisitionLine(line)).join("\n");
  return primary
    .replace(/https?:\/\/[^\s]+/gi, "")
    .replace(
      /\b(?:use|try|please use)\s+--cookies(?:-from-browser)?\b[^\r\n]*/gi,
      "",
    )
    .replace(
      /\b(?:also )?see\s+[^\r\n]*(?:cookies|authentication)[^\r\n]*/gi,
      "",
    );
}

function acquisitionHttpStatus(primary: string): number | undefined {
  const matches = [
    ...primary.matchAll(
      /\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:(?:Error|status(?:\s+code)?)\s*:?\s*)?([45]\d\d)\b/gi,
    ),
  ];
  const status = matches.at(-1)?.[1];
  return status === undefined ? undefined : Number(status);
}

/** Pattern-based evidence only; no raw error text escapes the subprocess boundary. */
export function classifyAcquisitionFailure(stderr: string): string {
  if (/^DOWNLOADER_IDENTITY_INVALID\r?$/m.test(stderr))
    return "YT_DLP_IDENTITY_INVALID";
  if (/^YT_DLP_EJS_MISSING\r?$/m.test(stderr)) return "YT_DLP_EJS_MISSING";
  const bootstrapCode = fixedAcquisitionBootstrapCode(stderr);
  if (bootstrapCode) return bootstrapCode;
  const primary = acquisitionFailureText(stderr);
  const httpStatus = acquisitionHttpStatus(primary);
  if (
    /no such option:|unrecognized arguments:|ambiguous option:/i.test(primary)
  )
    return "CLI_OPTION_UNSUPPORTED";
  if (
    httpStatus === 429 ||
    /too many requests|rate[ -]?limit(?:ed|ing)?/i.test(primary)
  )
    return "ACQUISITION_RATE_LIMITED";
  if (
    /(?:confirm|verify|prove)(?: that)? you(?:['’]re| are)? (?:not a bot|human)|captcha|unusual traffic|automated (?:queries|traffic)|bot (?:check|challenge|detection)/i.test(
      primary,
    )
  )
    return "SOURCE_BOT_CHALLENGE";
  if (
    /age[ -]?restricted|confirm your age|age verification|inappropriate for some users/i.test(
      primary,
    )
  )
    return "SOURCE_AGE_RESTRICTED";
  if (
    /private video|video (?:is )?private|members[- ]only|only available to (?:channel )?members|join this channel to (?:get|gain) access/i.test(
      primary,
    )
  )
    return "SOURCE_ACCESS_RESTRICTED";
  if (
    /(?:PO[ -]?Token|proof[ -]of[ -]origin token)(?:\s+(?:which|that))?(?:\s+(?:is|was|has been))?\s+(?:missing|required|not provided|invalid|rejected|expired|must be provided|needs? to be provided)\b|(?<!\bnot )\b(?:missing|required|invalid|rejected|expired)\s+(?:(?:a|the|GVS|player|web)\s+){0,3}(?:PO[ -]?Token|proof[ -]of[ -]origin token)\b/i.test(
      primary,
    )
  )
    return "SOURCE_TOKEN_REQUIRED";
  if (httpStatus === 401) return "SOURCE_HTTP_UNAUTHORIZED";
  if (httpStatus === 403) return "SOURCE_HTTP_FORBIDDEN";
  if (
    /video (?:is )?unavailable|has been (?:removed|deleted)|not available in your country|copyright (?:claim|restriction)/i.test(
      primary,
    )
  )
    return "SOURCE_UNAVAILABLE";
  if (
    /\bsign[ -]?in\b|\blog[ -]?in\b|authentication (?:is )?required/i.test(
      primary,
    )
  )
    return "SOURCE_AUTH_REQUIRED";
  if (
    /signature (?:extraction|deciphering) failed|(?:n|javascript) challenge (?:solving )?failed|challenge solver|no supported javascript runtime|(?:EJS|external javascript)[^\r\n]{0,100}(?:missing|unavailable|not found)/i.test(
      primary,
    )
  )
    return "SOURCE_CHALLENGE_FAILED";
  if (
    /requested format (?:is )?not available|no (?:video|audio) formats? found|only images are available/i.test(
      primary,
    )
  )
    return "SOURCE_AUDIO_FORMAT_UNAVAILABLE";
  if (/\bPostprocessing:/i.test(primary)) return "SOURCE_POSTPROCESSING_FAILED";
  if (
    /\bDownloaded \d+ bytes, expected \d+ bytes\b|\bcontent too short \(expected \d+ bytes and served \d+\)/i.test(
      primary,
    )
  )
    return "SOURCE_TRANSFER_INCOMPLETE";
  if (
    /\bDid not get any data blocks\b|\bThe downloaded file is empty\b/i.test(
      primary,
    )
  )
    return "SOURCE_TRANSFER_EMPTY";
  if (
    /CERTIFICATE_VERIFY_FAILED|certificate verify failed|SSLCertVerificationError|TLS handshake failed/i.test(
      primary,
    )
  )
    return "SOURCE_TLS_FAILED";
  if (
    /\bunable to (?:open for writing|write data|rename file):|\bNo space left on device\b|\bRead-only file system\b/i.test(
      primary,
    )
  )
    return "ACQUISITION_STORAGE_FAILED";
  if (
    (httpStatus !== undefined && httpStatus >= 500) ||
    /timed? out|connection (?:refused|reset|aborted)|network is unreachable|name or service not known|temporary failure in name resolution|nodename nor servname provided, or not known|getaddrinfo failed|NameResolutionError|unable to download (?:webpage|api page)|remote end closed connection/i.test(
      primary,
    )
  )
    return "ACQUISITION_NETWORK_FAILED";
  return "TOOL_FAILED";
}

/** Shell-free execution. Nothing from tool output is persisted as diagnostics. */
export function runBounded(
  executable: string,
  args: string[],
  options: ToolOptions,
): Promise<{ stdout: string }> {
  if (options.signal.aborted)
    return Promise.reject(new LocalProcessingError("CANCELLED"));
  if (
    options.stdin !== undefined &&
    Buffer.byteLength(options.stdin) > MAX_METADATA_BYTES
  )
    return Promise.reject(new LocalProcessingError("TOOL_INPUT_LIMIT"));
  return new Promise((resolve, reject) => {
    const resources = options.env?.MUSICMUTE_LOCAL_APP_RESOURCES;
    const leasePython = options.env?.MUSICMUTE_LOCAL_UPDATE_PYTHON;
    const guarded = Boolean(resources && leasePython);
    const child = spawn(
      guarded ? leasePython! : executable,
      guarded
        ? [
            "-I",
            "-B",
            "-S",
            join(resources!, "scripts/update-lock.py"),
            "--run",
            executable,
            ...args,
          ]
        : args,
      {
        shell: false,
        detached: process.platform !== "win32",
        env: options.env,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let failure: LocalProcessingError | undefined;
    let stdout = "";
    let lineBuffer = "";
    let outputBytes = 0;
    let stderrBytes = 0;
    const acquisitionStderr: Buffer[] = [];
    let escalation: NodeJS.Timeout | undefined;
    let monitor: NodeJS.Timeout | undefined;
    let monitorRunning = false;
    let closed = false;
    let stopSample: (() => void) | undefined;
    if (child.pid && options.on_spawn) {
      try {
        stopSample = options.on_spawn(child.pid) ?? undefined;
      } catch {
        /* Sampling never prevents owned cleanup. */
      }
    }
    function kill(signal: NodeJS.Signals): void {
      if (closed || child.pid === undefined) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* The owned process already exited. */
      }
    }
    function fail(code: string): void {
      if (failure || closed) return;
      failure = new LocalProcessingError(
        code,
        options.context === "acquisition" && code !== "CANCELLED"
          ? options.acquisition_stage === undefined
            ? {}
            : { stage: options.acquisition_stage }
          : undefined,
      );
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 500);
    }
    const deadline = setTimeout(() => fail("TOOL_TIMEOUT"), options.timeout_ms);
    const abort = (): void => fail("CANCELLED");
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    if (child.stdin) {
      child.stdin.on("error", () => {
        // A failed downloader can close its input before reporting a safe code.
        // The close handler owns that outcome; EPIPE must not escape Node.
      });
      child.stdin.end(options.stdin);
    }
    if (options.owned_download_root) {
      monitor = setInterval(() => {
        if (monitorRunning || closed) return;
        monitorRunning = true;
        void (async () => {
          const files = await readdir(options.owned_download_root!);
          if (files.length > 40) {
            fail("DOWNLOAD_LIMIT_EXCEEDED");
            return;
          }
          let total = 0;
          for (const file of files) {
            const item = await lstat(join(options.owned_download_root!, file));
            if (item.isSymbolicLink()) {
              fail("DOWNLOAD_INVALID");
              return;
            }
            if (item.isFile()) total += item.size;
          }
          if (total > MAX_SOURCE_BYTES) fail("DOWNLOAD_LIMIT_EXCEEDED");
        })()
          .catch(() => fail("DOWNLOAD_INVALID"))
          .finally(() => {
            monitorRunning = false;
          });
      }, 250);
    }
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > (options.max_output_bytes ?? 4 * 1024 * 1024)) {
        fail("TOOL_OUTPUT_LIMIT");
        return;
      }
      const content = chunk.toString("utf8");
      stdout += content;
      if (options.on_stdout_line) {
        lineBuffer += content;
        let boundary: number;
        while ((boundary = lineBuffer.indexOf("\n")) >= 0) {
          const line = lineBuffer.slice(0, boundary);
          lineBuffer = lineBuffer.slice(boundary + 1);
          try {
            options.on_stdout_line(line);
          } catch {
            fail("ENGINE_PROTOCOL_INVALID");
          }
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = MAX_ACQUISITION_STDERR_BYTES - stderrBytes;
      if (options.context === "acquisition" && remaining > 0)
        acquisitionStderr.push(chunk.subarray(0, remaining));
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_ACQUISITION_STDERR_BYTES) fail("TOOL_OUTPUT_LIMIT");
    });
    child.on("error", () => fail("TOOL_UNAVAILABLE"));
    child.on("close", (code) => {
      closed = true;
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      if (monitor) clearInterval(monitor);
      options.signal.removeEventListener("abort", abort);
      stopSample?.();
      if (failure) {
        if (failure.acquisition_failure) {
          failure.acquisition_failure.stderr_kind = acquisitionStderrKind(
            Buffer.concat(acquisitionStderr).toString("utf8"),
          );
          failure.acquisition_failure.stderr_bytes = Math.min(
            stderrBytes,
            MAX_ACQUISITION_STDERR_BYTES,
          );
        }
        acquisitionStderr.length = 0;
        reject(failure);
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(acquisitionStderr).toString("utf8");
        const failureCode =
          guarded && code === 75
            ? "LOCAL_UPDATE_IN_PROGRESS"
            : guarded && code === 76
              ? "LOCAL_DIRECTORY_NOT_PRIVATE"
              : options.context === "acquisition"
                ? classifyAcquisitionFailure(stderr)
                : "TOOL_FAILED";
        let details: AcquisitionFailureDetails | undefined;
        if (options.context === "acquisition") {
          const httpStatus = acquisitionHttpStatus(
            acquisitionFailureText(stderr),
          );
          details = {
            stderr_kind: acquisitionStderrKind(stderr),
            stderr_bytes: stderrBytes,
            ...(code !== null &&
            Number.isInteger(code) &&
            code >= 0 &&
            code <= 255
              ? { exit_code: code }
              : {}),
            ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
            ...(options.acquisition_stage === undefined
              ? {}
              : { stage: options.acquisition_stage }),
          };
        }
        acquisitionStderr.length = 0;
        reject(new LocalProcessingError(failureCode, details));
        return;
      }
      if (lineBuffer && options.on_stdout_line) {
        try {
          options.on_stdout_line(lineBuffer);
        } catch {
          reject(new LocalProcessingError("ENGINE_PROTOCOL_INVALID"));
          return;
        }
      }
      resolve({ stdout });
    });
  });
}

interface AudioIdentity {
  language: string | null;
  language_preference: number | null;
  musicmute_audio_track_id: string | null;
  musicmute_audio_is_default: boolean | null;
  acodec: string;
  ext: string;
}
interface SourceMetadata {
  id: string;
  duration: number;
  format_id: string;
  identity: AudioIdentity;
  download_info: Record<string, unknown>;
  source_title?: string;
}

/** Parse the exact three-line yt-dlp projection; unrelated extractor data never crosses the cap. */
export function parseSourceMetadataProjection(output: string): unknown {
  const lines = output.trimEnd().split(/\r?\n/);
  if (lines.length !== 3 || lines.some((line) => line.length === 0))
    throw new LocalProcessingError("SOURCE_METADATA_INVALID");
  let selected: unknown;
  let fragments: unknown;
  let formats: unknown;
  try {
    [selected, fragments, formats] = lines.map((line) => JSON.parse(line));
  } catch {
    throw new LocalProcessingError("SOURCE_METADATA_INVALID");
  }
  if (
    !selected ||
    typeof selected !== "object" ||
    Array.isArray(selected) ||
    !Array.isArray(fragments) ||
    !Array.isArray(formats)
  )
    throw new LocalProcessingError("SOURCE_METADATA_INVALID");
  return {
    ...(selected as Record<string, unknown>),
    ...(fragments.length === 0 ? {} : { fragments }),
    formats,
  };
}

function audioTrackEvidence(
  info: Record<string, unknown>,
): Pick<
  AudioIdentity,
  "musicmute_audio_track_id" | "musicmute_audio_is_default"
> {
  if (
    (info.musicmute_audio_track_id != null &&
      (typeof info.musicmute_audio_track_id !== "string" ||
        info.musicmute_audio_track_id.length === 0 ||
        info.musicmute_audio_track_id.length > 128 ||
        /[^A-Za-z0-9_.-]/.test(info.musicmute_audio_track_id))) ||
    (info.musicmute_audio_is_default != null &&
      typeof info.musicmute_audio_is_default !== "boolean")
  )
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_UNVERIFIED");
  return {
    musicmute_audio_track_id:
      (info.musicmute_audio_track_id as string | null | undefined) ?? null,
    musicmute_audio_is_default:
      (info.musicmute_audio_is_default as boolean | null | undefined) ?? null,
  };
}

function audioProfile(
  info: Record<string, unknown>,
): Pick<AudioIdentity, "language" | "language_preference"> {
  if (
    (info.language != null &&
      (typeof info.language !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(info.language))) ||
    (info.language_preference != null &&
      (typeof info.language_preference !== "number" ||
        !Number.isFinite(info.language_preference) ||
        ![-10, -1, 5, 10].includes(info.language_preference)))
  )
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_UNVERIFIED");
  return {
    language: (info.language as string | null | undefined) ?? null,
    language_preference:
      (info.language_preference as number | null | undefined) ?? -1,
  };
}

function audioIdentity(info: Record<string, unknown>): AudioIdentity {
  if (
    info.vcodec !== "none" ||
    typeof info.acodec !== "string" ||
    !/^[A-Za-z0-9_.-]{1,80}$/.test(info.acodec) ||
    info.acodec === "none" ||
    typeof info.ext !== "string" ||
    !/^(m4a|webm|mp3|ogg|opus)$/.test(info.ext)
  )
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_UNVERIFIED");
  return {
    ...audioProfile(info),
    ...audioTrackEvidence(info),
    acodec: info.acodec,
    ext: info.ext,
  };
}

function sourceMediaUrl(value: unknown, base?: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16 * 1024
  )
    throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname === "googlevideo.com" ||
      url.hostname.endsWith(".googlevideo.com")
    )
  )
    throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
  return url.href;
}

/** Keep only one accepted transfer; omit fields that can trigger re-extraction. */
function replayFormat(
  format: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !["https", "http_dash_segments"].includes(String(format.protocol)) ||
    format.has_drm === true
  )
    throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_UNAVAILABLE");
  sourceMediaUrl(format.url);
  const fields = [
    "format_id",
    "url",
    "ext",
    "protocol",
    "acodec",
    "vcodec",
    "language",
    "language_preference",
    "musicmute_audio_track_id",
    "musicmute_audio_is_default",
    "format_note",
    "container",
    "asr",
    "audio_channels",
    "filesize",
    "filesize_approx",
    "tbr",
    "abr",
    "quality",
    "preference",
    "source_preference",
    "has_drm",
    "available_at",
    "extra_param_to_segment_url",
  ];
  const replay = Object.fromEntries(
    fields
      .filter((key) => format[key] !== undefined)
      .map((key) => [key, format[key]]),
  );
  if (format.http_headers !== undefined) {
    if (
      !format.http_headers ||
      typeof format.http_headers !== "object" ||
      Array.isArray(format.http_headers)
    )
      throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(format.http_headers)) {
      if (
        ![
          "user-agent",
          "accept",
          "accept-language",
          "referer",
          "origin",
        ].includes(name.toLowerCase())
      )
        continue;
      if (
        typeof value !== "string" ||
        value.length > 4096 ||
        /[\r\n]/.test(value)
      )
        throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
      headers[name] = value;
    }
    replay.http_headers = headers;
  }
  const fragmentBase =
    format.fragment_base_url === undefined
      ? undefined
      : sourceMediaUrl(format.fragment_base_url);
  if (fragmentBase) replay.fragment_base_url = fragmentBase;
  if (format.is_dash_periods !== undefined) {
    if (typeof format.is_dash_periods !== "boolean")
      throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
    replay.is_dash_periods = format.is_dash_periods;
  }
  if (
    format.protocol === "http_dash_segments" &&
    (!Array.isArray(format.fragments) || format.fragments.length === 0)
  )
    throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_UNAVAILABLE");
  if (format.fragments !== undefined) {
    if (!Array.isArray(format.fragments) || format.fragments.length > 20_000)
      throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_UNAVAILABLE");
    replay.fragments = format.fragments.map((fragment: unknown) => {
      if (!fragment || typeof fragment !== "object" || Array.isArray(fragment))
        throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
      const entry = fragment as Record<string, unknown>;
      if (entry.url !== undefined) sourceMediaUrl(entry.url);
      else if (fragmentBase) sourceMediaUrl(entry.path, fragmentBase);
      else throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
      return Object.fromEntries(
        ["url", "path", "duration", "fragment_count"]
          .filter((key) => entry[key] !== undefined)
          .map((key) => [key, entry[key]]),
      );
    });
  }
  if (
    format.downloader_options &&
    typeof format.downloader_options === "object"
  ) {
    const chunk = (format.downloader_options as Record<string, unknown>)
      .http_chunk_size;
    if (chunk !== undefined) {
      if (
        !Number.isSafeInteger(chunk) ||
        Number(chunk) <= 0 ||
        Number(chunk) > 16 * 1024 * 1024
      )
        throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
      replay.downloader_options = { http_chunk_size: chunk };
    }
  }
  return replay;
}
export function validateSourceMetadata(
  value: unknown,
  request: StartPayload,
): SourceMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LocalProcessingError("SOURCE_METADATA_INVALID");
  const info = value as Record<string, unknown>;
  if (info.id !== request.video_id || info.extractor_key !== "Youtube")
    throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
  if (info._type !== undefined && info._type !== "video")
    throw new LocalProcessingError("SOURCE_METADATA_INVALID");
  if (
    info.is_live === true ||
    info.live_status === "is_live" ||
    info.live_status === "is_upcoming" ||
    info.live_status === "post_live"
  ) {
    throw new LocalProcessingError("LIVE_NOT_SUPPORTED");
  }
  if (
    typeof info.duration !== "number" ||
    !Number.isFinite(info.duration) ||
    info.duration <= 0
  )
    throw new LocalProcessingError("SOURCE_DURATION_INVALID");
  if (info.duration > MVP_MAX_DURATION_SECONDS)
    throw new LocalProcessingError("DURATION_LIMIT_EXCEEDED");
  if (Math.abs(info.duration - request.duration_seconds) > 3)
    throw new LocalProcessingError("SOURCE_DURATION_MISMATCH");
  if (
    typeof info.format_id !== "string" ||
    !/^[A-Za-z0-9_.-]{1,80}$/.test(info.format_id) ||
    info.vcodec !== "none" ||
    typeof info.acodec !== "string" ||
    info.acodec === "none"
  ) {
    throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
  }
  if (
    !Array.isArray(info.formats) ||
    info.formats.length === 0 ||
    info.formats.length > 2048
  )
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_UNVERIFIED");
  const audioFormats = info.formats.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).vcodec === "none" &&
        (entry as Record<string, unknown>).acodec !== "none",
      ),
  );
  const selected = audioFormats.filter(
    (entry) => entry.format_id === info.format_id,
  );
  if (selected.length !== 1)
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_UNVERIFIED");
  const identity = audioIdentity(info);
  const selectedIdentity = audioIdentity(selected[0]!);
  if (JSON.stringify(identity) !== JSON.stringify(selectedIdentity))
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_MISMATCH");
  const profiles = new Set(
    audioFormats.map((entry) => {
      const profile = audioProfile(entry);
      return JSON.stringify([profile.language, profile.language_preference]);
    }),
  );
  const trackIds = new Set(
    audioFormats
      .map((entry) => audioTrackEvidence(entry).musicmute_audio_track_id)
      .filter((id) => id !== null),
  );
  if (
    profiles.size !== 1 ||
    trackIds.size > 1 ||
    identity.language_preference === -10
  )
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_UNSUPPORTED");
  const title = sanitizeSourceTitle(info.title);
  return {
    id: request.video_id,
    duration: info.duration,
    format_id: info.format_id,
    identity,
    ...(title ? { source_title: title } : {}),
    download_info: {
      _type: "video",
      id: info.id,
      title: "MusicMute local source",
      duration: info.duration,
      extractor: "youtube",
      extractor_key: "Youtube",
      is_live: false,
      live_status: "not_live",
      formats: [
        replayFormat(selected[0]!.url === undefined ? info : selected[0]!),
      ],
    },
  };
}

export function validateDownloadedMetadata(
  value: unknown,
  source: SourceMetadata,
): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
  const info = value as Record<string, unknown>;
  if (
    info.id !== source.id ||
    info.extractor_key !== "Youtube" ||
    info.format_id !== source.format_id ||
    info.duration !== source.duration ||
    info.is_live === true ||
    info.live_status !== "not_live" ||
    typeof info.filepath !== "string"
  )
    throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
  if (JSON.stringify(audioIdentity(info)) !== JSON.stringify(source.identity))
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_MISMATCH");
  return info.filepath;
}

function validateRequest(request: StartPayload): void {
  if (
    !isVideoId(request.video_id) ||
    request.provider !== "LOCAL_MACOS" ||
    !Number.isFinite(request.duration_seconds) ||
    request.duration_seconds <= 0
  ) {
    throw new LocalProcessingError("INVALID_REQUEST");
  }
  if (request.duration_seconds > MVP_MAX_DURATION_SECONDS)
    throw new LocalProcessingError("DURATION_LIMIT_EXCEEDED");
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("base64");
}

async function assertOwnedFile(root: string, path: unknown): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new LocalProcessingError("OUTPUT_INVALID");
  const resolved = await realpath(path);
  const difference = relative(await realpath(root), resolved);
  if (
    !difference ||
    difference.startsWith("..") ||
    isAbsolute(difference) ||
    (await lstat(path)).isSymbolicLink()
  )
    throw new LocalProcessingError("OUTPUT_INVALID");
  if (!(await stat(resolved)).isFile())
    throw new LocalProcessingError("OUTPUT_INVALID");
  return resolved;
}

export class LocalMacProvider implements ProcessingProvider {
  readonly id = "LOCAL_MACOS" as const;
  constructor(
    private readonly config: LocalConfig,
    private readonly acquisitionGate = new AcquisitionGate(config.root),
  ) {}

  private async withAcquisition<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    await assertYouTubeSetupReady(this.config);
    try {
      return await this.acquisitionGate.run(signal, operation);
    } catch (error) {
      if (error instanceof AcquisitionGateError) {
        const original = error.original_refusal;
        const refusalDetails =
          original instanceof LocalProcessingError &&
          (original.code === "SOURCE_BOT_CHALLENGE" ||
            original.code === "ACQUISITION_RATE_LIMITED")
            ? {
                ...original.acquisition_failure,
                refusal_code: original.code as
                  "SOURCE_BOT_CHALLENGE" | "ACQUISITION_RATE_LIMITED",
              }
            : undefined;
        throw new LocalProcessingError(
          error.code,
          refusalDetails || error.block_reason || error.retry_at
            ? {
                ...refusalDetails,
                ...(error.retry_at ? { retry_at: error.retry_at } : {}),
                ...(error.block_reason
                  ? { block_reason: error.block_reason }
                  : {}),
              }
            : undefined,
        );
      }
      throw error;
    }
  }

  private acquisitionArguments(): string[] {
    return [
      "--ignore-config",
      "--no-plugin-dirs",
      "--no-cookies",
      "--no-cookies-from-browser",
      "--no-playlist",
      "--no-warnings",
      "--no-cache-dir",
      "--no-remote-components",
      "--no-js-runtimes",
      "--socket-timeout",
      "20",
      "--retries",
      "0",
      "--fragment-retries",
      "0",
      "--extractor-retries",
      "0",
      "--sleep-requests",
      "1",
      "--sleep-interval",
      "5",
      "--js-runtimes",
      `${this.config.js_runtime_kind ?? "node"}:${this.config.js_runtime_path}`,
      "--ffmpeg-location",
      this.config.ffmpeg_path,
    ];
  }

  async inspectYouTube(
    videoId: string,
    hooks: Pick<PipelineHooks, "signal" | "onProgress">,
  ): Promise<{ duration_seconds: number; source_title?: string }> {
    if (!isVideoId(videoId)) throw new LocalProcessingError("INVALID_VIDEO_ID");
    return this.withAcquisition(hooks.signal, async () => {
      hooks.onProgress("metadata");
      const result = await runBounded(
        this.config.python_path,
        downloaderToolArguments(this.config, [
          ...this.acquisitionArguments(),
          "--skip-download",
          "--quiet",
          "-f",
          FORMAT,
          "--print",
          SOURCE_METADATA,
          "--print",
          SOURCE_FRAGMENTS,
          "--print",
          SOURCE_FORMAT_PROFILES,
          "--",
          canonicalYouTubeUrl(videoId),
        ]),
        {
          signal: hooks.signal,
          context: "acquisition",
          acquisition_stage: "metadata",
          timeout_ms: 120_000,
          env: localToolEnvironment(this.config),
          cwd: this.config.root,
        },
      );
      let raw: Record<string, unknown>;
      try {
        raw = parseSourceMetadataProjection(result.stdout) as Record<
          string,
          unknown
        >;
      } catch {
        throw new LocalProcessingError("SOURCE_METADATA_INVALID");
      }
      const source = validateSourceMetadata(raw, {
        video_id: videoId,
        duration_seconds: typeof raw?.duration === "number" ? raw.duration : 0,
        provider: this.id,
      });
      return {
        duration_seconds: source.duration,
        ...(source.source_title ? { source_title: source.source_title } : {}),
      };
    });
  }

  async prepare(
    request: StartPayload,
    workRoot: string,
    hooks: PipelineHooks,
  ): Promise<PreparedAudio> {
    const start = performance.now();
    const acquired = await this.acquireYouTube(request, workRoot, hooks, {
      decode: false,
    });
    return this.processOwnedAudio(
      acquired.original.path,
      acquired.original.duration_seconds,
      workRoot,
      hooks,
      start,
      acquired.timings_ms,
      acquired.source,
      acquired.source_title,
      acquired.original,
    );
  }

  async prepareSharedOriginal(
    request: StartPayload,
    workRoot: string,
    hooks: PipelineHooks,
    original: LocalAudioArtifact,
  ): Promise<PreparedAudio> {
    if (
      dirname(original.path) !== workRoot ||
      Math.abs(original.duration_seconds - request.duration_seconds) > 2 ||
      !(await verifyPrivateAudio(
        original.path,
        original.bytes,
        original.sha256,
      ))
    )
      throw new LocalProcessingError("DOWNLOAD_INVALID");
    return this.processOwnedAudio(
      original.path,
      original.duration_seconds,
      workRoot,
      hooks,
      performance.now(),
      {},
      {
        kind: "youtube",
        video_id: request.video_id,
        format_id: "shared-original",
        audio_track_id: null,
        audio_is_default: null,
        language: null,
      },
      undefined,
      original,
    );
  }

  /** Recover exact original bytes for account saving without loading the voice model. */
  async acquireYouTube(
    request: StartPayload,
    workRoot: string,
    hooks: PipelineHooks,
    options: { decode?: boolean } = {},
  ): Promise<AcquiredYouTubeAudio> {
    validateRequest(request);
    if (!isAbsolute(workRoot) || !/^[0-9a-f-]{36}$/.test(basename(workRoot)))
      throw new LocalProcessingError("INVALID_WORK_ROOT");
    const workInformation = await lstat(workRoot).catch(() => {
      throw new LocalProcessingError("INVALID_WORK_ROOT");
    });
    if (
      !workInformation.isDirectory() ||
      workInformation.isSymbolicLink() ||
      workInformation.mode & 0o077 ||
      workInformation.uid !== process.getuid?.()
    )
      throw new LocalProcessingError("INVALID_WORK_ROOT");
    try {
      await new RuntimeResourceGate(workRoot).assertAvailable(MAX_SOURCE_BYTES);
    } catch (error) {
      throw new LocalProcessingError(
        error instanceof RuntimeResourceLimitError && error.resource === "disk"
          ? "DISK_SPACE_LOW"
          : "MEMORY_LOW",
      );
    }
    return this.withAcquisition(hooks.signal, async () => {
      const start = performance.now();
      const timings: Record<string, number> = {};
      const common = this.acquisitionArguments();
      const url = canonicalYouTubeUrl(request.video_id);
      const env = localToolEnvironment(this.config, workRoot);
      hooks.onProgress("metadata");
      const metadataStart = performance.now();
      const metadataOutput = await runBounded(
        this.config.python_path,
        downloaderToolArguments(this.config, [
          ...common,
          "--skip-download",
          "--quiet",
          "-f",
          FORMAT,
          "--print",
          SOURCE_METADATA,
          "--print",
          SOURCE_FRAGMENTS,
          "--print",
          SOURCE_FORMAT_PROFILES,
          "--",
          url,
        ]),
        {
          signal: hooks.signal,
          context: "acquisition",
          acquisition_stage: "metadata",
          timeout_ms: 120_000,
          env,
          cwd: workRoot,
        },
      );
      let metadata: unknown;
      try {
        metadata = parseSourceMetadataProjection(metadataOutput.stdout);
      } catch {
        throw new LocalProcessingError("SOURCE_METADATA_INVALID");
      }
      const source = validateSourceMetadata(metadata, request);
      timings.metadata = performance.now() - metadataStart;
      hooks.onProgress("downloading");
      const downloadStart = performance.now();
      const download = await runBounded(
        this.config.python_path,
        downloaderToolArguments(this.config, [
          ...common,
          "--no-progress",
          "--max-filesize",
          "256M",
          "--concurrent-fragments",
          "1",
          "-f",
          source.format_id,
          "-o",
          join(workRoot, "source.%(ext)s"),
          "--print",
          DOWNLOAD_METADATA,
          "--load-info-json",
          "-",
        ]),
        {
          signal: hooks.signal,
          context: "acquisition",
          acquisition_stage: "download",
          timeout_ms: 600_000,
          env,
          cwd: workRoot,
          max_output_bytes: 64 * 1024,
          owned_download_root: workRoot,
          stdin: JSON.stringify(source.download_info),
        },
      );
      let downloadedMetadata: unknown;
      try {
        downloadedMetadata = JSON.parse(download.stdout.trim());
      } catch {
        throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
      }
      const input = await assertOwnedFile(
        workRoot,
        validateDownloadedMetadata(downloadedMetadata, source),
      );
      if (
        !/\.(m4a|webm|mp3|ogg|opus)$/i.test(input) ||
        (await stat(input)).size > MAX_SOURCE_BYTES
      )
        throw new LocalProcessingError("DOWNLOAD_INVALID");
      timings.download = performance.now() - downloadStart;
      const validationStart = performance.now();
      hooks.onProgress("input_validation");
      const original = await this.validateAcquiredOriginal(
        input,
        source,
        workRoot,
        hooks,
        options.decode !== false,
      );
      timings.input_validation = performance.now() - validationStart;
      timings.acquisition = performance.now() - start;
      return {
        original,
        ...(source.source_title ? { source_title: source.source_title } : {}),
        source: {
          kind: "youtube",
          video_id: request.video_id,
          format_id: source.format_id,
          audio_track_id: source.identity.musicmute_audio_track_id,
          audio_is_default: source.identity.musicmute_audio_is_default,
          language: source.identity.language,
        },
        timings_ms: timings,
      };
    });
  }

  private async validateAcquiredOriginal(
    input: string,
    source: SourceMetadata,
    workRoot: string,
    hooks: PipelineHooks,
    decode: boolean,
  ): Promise<LocalAudioArtifact> {
    const extension = extname(input).slice(1).toLowerCase();
    if (
      extension !== source.identity.ext ||
      basename(input) !== `source.${extension}` ||
      !Object.hasOwn(ACQUISITION_TYPES, extension)
    )
      throw new LocalProcessingError("DOWNLOAD_INVALID");
    const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.uid !== process.getuid?.() ||
        before.mode & 0o077 ||
        before.size <= 0 ||
        before.size > MAX_SOURCE_BYTES
      )
        throw new LocalProcessingError("DOWNLOAD_INVALID");
      const probe = await runBounded(
        this.config.ffprobe_path,
        [
          "-v",
          "error",
          "-protocol_whitelist",
          "file",
          "-format_whitelist",
          ACQUISITION_INPUT_FORMATS,
          "-show_entries",
          "format=duration,format_name:stream=codec_type",
          "-of",
          "json",
          input,
        ],
        {
          signal: hooks.signal,
          timeout_ms: 30_000,
          max_output_bytes: 64 * 1024,
          env: localToolEnvironment(this.config, workRoot),
          cwd: workRoot,
        },
      );
      let measured: {
        format?: { duration?: string; format_name?: string };
        streams?: { codec_type?: string }[];
      };
      try {
        measured = JSON.parse(probe.stdout) as typeof measured;
      } catch {
        throw new LocalProcessingError("SOURCE_AUDIO_INVALID");
      }
      const durationText = measured?.format?.duration;
      const duration =
        typeof durationText === "string" &&
        /^[0-9]{1,4}(?:\.[0-9]{1,12})?$/.test(durationText)
          ? Number(durationText)
          : NaN;
      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > MVP_MAX_DURATION_SECONDS + 0.25 ||
        Math.abs(duration - source.duration) > 1 ||
        typeof measured?.format?.format_name !== "string" ||
        !measured.format.format_name
          .split(",")
          .includes(ACQUISITION_CONTAINERS[extension]!) ||
        !Array.isArray(measured.streams) ||
        measured.streams.length !== 1 ||
        measured.streams[0]?.codec_type !== "audio"
      )
        throw new LocalProcessingError("SOURCE_AUDIO_INVALID");
      if (decode)
        await runBounded(
          this.config.ffmpeg_path,
          [
            "-nostdin",
            "-v",
            "error",
            "-xerror",
            "-err_detect",
            "explode",
            "-protocol_whitelist",
            "file",
            "-format_whitelist",
            ACQUISITION_INPUT_FORMATS,
            "-i",
            input,
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-f",
            "null",
            "-",
          ],
          {
            signal: hooks.signal,
            timeout_ms: 120_000,
            max_output_bytes: 64 * 1024,
            env: localToolEnvironment(this.config, workRoot),
            cwd: workRoot,
          },
        );
      const digest = createHash("sha256");
      let bytes = 0;
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        if (hooks.signal.aborted) throw new LocalProcessingError("CANCELLED");
        bytes += chunk.length;
        if (bytes > before.size)
          throw new LocalProcessingError("DOWNLOAD_INVALID");
        digest.update(chunk);
      }
      const after = await file.stat();
      const named = await lstat(input);
      if (
        hooks.signal.aborted ||
        bytes !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        named.isSymbolicLink() ||
        named.nlink !== 1 ||
        named.uid !== before.uid ||
        named.mode !== before.mode ||
        named.ino !== before.ino ||
        named.dev !== before.dev ||
        named.size !== after.size ||
        named.mtimeMs !== after.mtimeMs ||
        named.ctimeMs !== after.ctimeMs
      )
        throw new LocalProcessingError(
          hooks.signal.aborted ? "CANCELLED" : "SOURCE_IDENTITY_MISMATCH",
        );
      const sha256 = digest.digest("hex");
      await rememberTransferredAudio(file, input, bytes, sha256);
      return {
        path: input,
        extension,
        content_type: ACQUISITION_TYPES[extension]!,
        duration_seconds: duration,
        bytes,
        sha256,
      };
    } finally {
      await file.close();
    }
  }

  /** Native file entry shares the same model, MPS pipeline and timeline validation. */
  async prepareOwnedAudio(
    inputPath: string,
    sourceDuration: number,
    workRoot: string,
    hooks: PipelineHooks,
  ): Promise<PreparedAudio> {
    if (!isAbsolute(workRoot) || !/^[0-9a-f-]{36}$/.test(basename(workRoot)))
      throw new LocalProcessingError("INVALID_WORK_ROOT");
    const work = await lstat(workRoot);
    if (
      !work.isDirectory() ||
      work.isSymbolicLink() ||
      work.mode & 0o077 ||
      work.uid !== process.getuid?.()
    )
      throw new LocalProcessingError("INVALID_WORK_ROOT");
    if (
      !Number.isFinite(sourceDuration) ||
      sourceDuration <= 0 ||
      sourceDuration > MVP_MAX_DURATION_SECONDS
    )
      throw new LocalProcessingError("SOURCE_DURATION_INVALID");
    const input = await assertOwnedFile(workRoot, inputPath);
    const info = await lstat(input);
    if (
      !/\.(m4a|mp4|webm|mp3|ogg|opus|aac|wav|flac)$/i.test(input) ||
      info.size <= 0 ||
      info.size > MAX_SOURCE_BYTES ||
      info.nlink !== 1 ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.()
    )
      throw new LocalProcessingError("DOWNLOAD_INVALID");
    try {
      await new RuntimeResourceGate(workRoot).assertAvailable(MAX_SOURCE_BYTES);
    } catch (error) {
      throw new LocalProcessingError(
        error instanceof RuntimeResourceLimitError && error.resource === "disk"
          ? "DISK_SPACE_LOW"
          : "MEMORY_LOW",
      );
    }
    return this.processOwnedAudio(
      input,
      sourceDuration,
      workRoot,
      hooks,
      performance.now(),
      {},
    );
  }

  private async processOwnedAudio(
    input: string,
    expectedDuration: number,
    workRoot: string,
    hooks: PipelineHooks,
    start: number,
    timings: Record<string, number>,
    source?: PreparedAudio["source"],
    sourceTitle?: string,
    verifiedOriginal?: LocalAudioArtifact,
  ): Promise<PreparedAudio> {
    const env = localToolEnvironment(this.config, workRoot);
    const inputInformation = await lstat(input);
    if (
      !inputInformation.isFile() ||
      inputInformation.isSymbolicLink() ||
      inputInformation.nlink !== 1 ||
      inputInformation.mode & 0o077 ||
      inputInformation.uid !== process.getuid?.()
    )
      throw new LocalProcessingError("DOWNLOAD_INVALID");
    if (
      verifiedOriginal &&
      !(await verifyPrivateAudio(
        input,
        verifiedOriginal.bytes,
        verifiedOriginal.sha256,
      ))
    )
      throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
    const inputDigest = verifiedOriginal
      ? Buffer.from(verifiedOriginal.sha256, "hex").toString("base64")
      : await sha256(input);
    hooks.onProgress("processing");
    let engineResult: Record<string, unknown> | undefined;
    let engineError: string | undefined;
    const engineStart = performance.now();
    try {
      if (await supportsLocalEngine(this.config)) {
        engineResult = await runLocalEngine(
          this.config,
          input,
          workRoot,
          inputDigest,
          {
            signal: hooks.signal,
            onSpawn: (pid) => beginSample(pid, hooks.onDiagnostic),
            onEvent: (event) => {
              if (typeof event.stage !== "string")
                throw new Error("ENGINE_PROTOCOL_INVALID");
              if (
                typeof event.completed === "number" &&
                typeof event.total === "number"
              )
                hooks.onProgress(event.stage, event.completed, event.total);
              else hooks.onProgress(event.stage);
            },
          },
        );
      } else
        await runBounded(
          this.config.python_path,
          [
            this.config.runner_path,
            "--input",
            input,
            "--input-sha256",
            inputDigest,
            "--work-root",
            workRoot,
            "--model-cache",
            this.config.models_root,
            "--ffmpeg",
            this.config.ffmpeg_path,
            "--ffprobe",
            this.config.ffprobe_path,
          ],
          {
            signal: hooks.signal,
            timeout_ms: 900_000,
            env,
            cwd: workRoot,
            max_output_bytes: 4 * 1024 * 1024,
            on_spawn: (pid) => beginSample(pid, hooks.onDiagnostic),
            on_stdout_line: (line) => {
              const event = JSON.parse(line) as Record<string, unknown>;
              if (
                event.type === "progress" &&
                typeof event.stage === "string"
              ) {
                if (
                  typeof event.completed === "number" &&
                  typeof event.total === "number"
                )
                  hooks.onProgress(event.stage, event.completed, event.total);
                else hooks.onProgress(event.stage);
              } else if (
                event.type === "result" &&
                typeof event.result === "object" &&
                event.result !== null
              )
                engineResult = event.result as Record<string, unknown>;
              else if (
                event.type === "error" &&
                typeof event.code === "string" &&
                /^[A-Z_]{1,60}$/.test(event.code)
              )
                engineError = event.code;
              else throw new LocalProcessingError("ENGINE_PROTOCOL_INVALID");
            },
          },
        );
    } catch (error) {
      if (
        engineError &&
        error instanceof LocalProcessingError &&
        error.code === "TOOL_FAILED"
      )
        throw new LocalProcessingError(engineError);
      throw error;
    }
    timings.processing = performance.now() - engineStart;
    hooks.onProgress("validating");
    if (
      !engineResult ||
      engineResult.trimEnabled !== false ||
      engineResult.removedSamples !== 0 ||
      engineResult.modelDigest !== MODEL_SHA256 ||
      engineResult.sourceSamples !== engineResult.outputSamples
    )
      throw new LocalProcessingError("TIMELINE_NOT_PRESERVED");
    const sourceDuration = engineResult.sourceDurationSeconds;
    const duration = engineResult.measuredOutputDurationSeconds;
    if (
      typeof sourceDuration !== "number" ||
      typeof duration !== "number" ||
      !Number.isFinite(sourceDuration) ||
      !Number.isFinite(duration) ||
      Math.abs(sourceDuration - expectedDuration) > 1 ||
      Math.abs(duration - sourceDuration) > 0.5
    )
      throw new LocalProcessingError("OUTPUT_DURATION_MISMATCH");
    const output = await assertOwnedFile(workRoot, engineResult.outputPath);
    const size = (await stat(output)).size;
    const digest =
      typeof engineResult.sha256 === "string" ? engineResult.sha256 : "";
    if (hooks.signal.aborted) throw new LocalProcessingError("CANCELLED");
    if (
      size <= 0 ||
      size !== engineResult.bytes ||
      !/^[A-Za-z0-9+/]{43}=$/.test(digest) ||
      !(await verifyPrivateAudio(
        output,
        size,
        Buffer.from(digest, "base64").toString("hex"),
      ))
    )
      throw new LocalProcessingError("OUTPUT_CHECKSUM_MISMATCH");
    const inputAfter = await lstat(input);
    if (
      inputAfter.dev !== inputInformation.dev ||
      inputAfter.ino !== inputInformation.ino ||
      inputAfter.size !== inputInformation.size ||
      inputAfter.mtimeMs !== inputInformation.mtimeMs ||
      inputAfter.isSymbolicLink() ||
      inputAfter.ctimeMs !== inputInformation.ctimeMs ||
      inputAfter.mode !== inputInformation.mode ||
      inputAfter.nlink !== 1
    )
      throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
    timings.total = performance.now() - start;
    // Engine stage times are seconds, and separate from broad processing time.
    for (const [group, value] of [
      ["engine", engineResult.stageTimings],
      ["separator", engineResult.separationTimings],
    ] as const) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [stage, duration] of Object.entries(value)) {
          if (
            /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(stage) &&
            typeof duration === "number" &&
            Number.isFinite(duration) &&
            duration >= 0
          )
            timings[`${group}_${stage}`] = duration * 1000;
        }
      }
    }
    hooks.onDiagnostic(
      {
        component: "companion",
        severity: "info",
        event: "local_pipeline_completed",
        metrics: {
          source_duration_seconds: sourceDuration,
          source_audio_track_id_known: source?.audio_track_id != null,
          ...(source?.audio_is_default == null
            ? {}
            : {
                source_audio_is_default: source.audio_is_default,
              }),
          output_duration_seconds: duration,
          output_bytes: size,
          ...(timings.metadata === undefined
            ? {}
            : { metadata_ms: timings.metadata }),
          ...(timings.download === undefined
            ? {}
            : { download_ms: timings.download }),
          ...(typeof engineResult.localEngineWarm === "boolean"
            ? { local_engine_warm: engineResult.localEngineWarm }
            : {}),
          processing_ms: timings.processing!,
          total_ms: timings.total!,
          ...(typeof engineResult.enginePeakRssBytes === "number"
            ? { engine_peak_rss_bytes: engineResult.enginePeakRssBytes }
            : {}),
          ...(typeof engineResult.engineMpsAllocatedBytes === "number"
            ? {
                engine_mps_allocated_bytes:
                  engineResult.engineMpsAllocatedBytes,
              }
            : {}),
          ...(typeof engineResult.engineMpsDriverAllocatedBytes === "number"
            ? {
                engine_mps_driver_allocated_bytes:
                  engineResult.engineMpsDriverAllocatedBytes,
              }
            : {}),
        },
      },
      MODEL_SHA256,
    );
    return {
      output_path: output,
      original: {
        path: input,
        extension: extname(input).slice(1).toLowerCase(),
        duration_seconds: sourceDuration,
        bytes: inputInformation.size,
        sha256: Buffer.from(inputDigest, "base64").toString("hex"),
        content_type: {
          m4a: "audio/mp4",
          mp4: "audio/mp4",
          aac: "audio/aac",
          webm: "audio/webm",
          mp3: "audio/mpeg",
          ogg: "audio/ogg",
          opus: "audio/ogg",
          wav: "audio/wav",
          flac: "audio/flac",
        }[extname(input).slice(1).toLowerCase()]!,
      },
      ...(source ? { source } : {}),
      ...(sourceTitle ? { source_title: sourceTitle } : {}),
      source_duration_seconds: sourceDuration,
      duration_seconds: duration,
      bytes: size,
      sha256: Buffer.from(digest, "base64").toString("hex"),
      model_id: MODEL_SHA256,
      trim_enabled: false,
      timings_ms: timings,
    };
  }
}
