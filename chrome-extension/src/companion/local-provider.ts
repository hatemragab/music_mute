import {
  FORMAT,
  DOWNLOAD_METADATA,
  SOURCE_METADATA,
  SOURCE_FRAGMENTS,
  SOURCE_FORMAT_PROFILES,
  LocalProcessingError,
  classifyAcquisitionFailure,
  acquisitionStderrKind,
  acquisitionFailureText,
  acquisitionHttpStatus,
  parseSourceMetadataProjection,
  validateSourceMetadata,
  validateDownloadedMetadata,
  type SourceMetadata,
  type AcquisitionFailureDetails,
} from "./source-validation.js";
export {
  FORMAT,
  DOWNLOAD_METADATA,
  SOURCE_METADATA,
  SOURCE_FRAGMENTS,
  SOURCE_FORMAT_PROFILES,
  LocalProcessingError,
  classifyAcquisitionFailure,
  parseSourceMetadataProjection,
  validateSourceMetadata,
  validateDownloadedMetadata,
} from "./source-validation.js";
export type {
  AcquisitionStderrKind,
  AcquisitionFailureDetails,
} from "./source-validation.js";
import { assertYouTubeSetupReady } from "./app-setup.js";
import {
  retireLocalEngine,
  runLocalEngine,
  supportsLocalEngine,
} from "./local-engine.js";
import { acquireWorkerAdmission } from "./worker-admission.js";
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
import { AcquisitionGate, AcquisitionGateError } from "./acquisition-gate.js";
import {
  RuntimeResourceGate,
  RuntimeResourceLimitError,
} from "../../../worker/src/runtime/resource-limits.js";

export const MODEL_SHA256 =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
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
function localEngineFailure(error: unknown): unknown {
  if (error instanceof LocalProcessingError) return error;
  return error instanceof Error && /^[A-Z_]{1,60}$/.test(error.message)
    ? new LocalProcessingError(error.message)
    : error;
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
    const admissionStart = performance.now();
    const admission = this.config.app_resources
      ? await acquireWorkerAdmission({
          signal: hooks.signal,
          workerRoot: join(dirname(this.config.root), "MusicMuteWorker"),
          onWaiting: () => hooks.onProgress("waiting-for-worker"),
        }).catch((error: unknown) => {
          throw localEngineFailure(error);
        })
      : null;
    if (admission) timings.worker_wait = performance.now() - admissionStart;
    hooks.onProgress("processing");
    const processingSignal = admission
      ? AbortSignal.any([hooks.signal, admission.signal])
      : hooks.signal;
    let admittedEnginePid: number | undefined;
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
            signal: processingSignal,
            ...(admission
              ? {
                  beforeProcess: async (pid, endpoint) => {
                    admittedEnginePid = pid;
                    await admission.registerEngine(pid, endpoint);
                  },
                }
              : {}),
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
      } else {
        // One-shot Python starts loading immediately; it cannot await durable
        // registration before inference. Packaged apps require the resident
        // service contract. Custom developer fixtures retain their one-shot path.
        if (this.config.app_resources)
          throw new LocalProcessingError("ENGINE_SERVICE_REQUIRED");
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
            signal: processingSignal,
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
      }
    } catch (error) {
      if (
        engineError &&
        error instanceof LocalProcessingError &&
        error.code === "TOOL_FAILED"
      )
        throw new LocalProcessingError(engineError);
      throw localEngineFailure(error);
    } finally {
      if (admission) {
        let parked = false;
        try {
          if (
            admission.keepWarmWhenIdle &&
            !processingSignal.aborted &&
            engineResult?.trimEnabled === false &&
            engineResult.removedSamples === 0 &&
            engineResult.modelDigest === MODEL_SHA256 &&
            engineResult.sourceSamples === engineResult.outputSamples
          ) {
            await admission.markIdle().catch((error: unknown) => {
              throw localEngineFailure(error);
            });
            parked = true;
          }
        } finally {
          try {
            if (!parked && admittedEnginePid !== undefined)
              await retireLocalEngine(this.config, admittedEnginePid).catch(
                (error: unknown) => {
                  throw localEngineFailure(error);
                },
              );
          } finally {
            await admission.release().catch((error: unknown) => {
              throw localEngineFailure(error);
            });
          }
        }
      }
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
