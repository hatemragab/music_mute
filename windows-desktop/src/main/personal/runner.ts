import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rm } from "node:fs/promises";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChildProcessOptions } from "../../../../worker/src/agent/child-process.js";
import type { ChildProgress } from "../../../../worker/src/agent/ipc/child-progress.js";
import type { ChildResponse } from "../../../../worker/src/agent/ipc/child-protocol.js";
import {
  resolveQualifiedGpuIdentity,
  type DirectmlGpuIdentity,
} from "../../../../worker/src/enrollment/report-builder.js";
import {
  FORMAT,
  DOWNLOAD_METADATA,
  SOURCE_METADATA,
  SOURCE_FRAGMENTS,
  SOURCE_FORMAT_PROFILES,
  parseSourceMetadataProjection,
  validateSourceMetadata,
  validateDownloadedMetadata,
  classifyAcquisitionFailure,
} from "../../../../chrome-extension/src/companion/source-validation.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
import {
  PERSONAL_MAX_BYTES,
  PERSONAL_UUID,
  type PersonalStage,
  type PersonalWaitReason,
} from "../../shared/personal-contracts.js";
import type { HostContext } from "../host-context.js";
import {
  privateFingerprint,
  readPrivateBytes,
  writePrivateAtomic,
} from "../prepare/private-files.js";
import {
  parsePersonalAgentConfiguration,
  type PersonalAgentConfiguration,
} from "./configuration.js";
import {
  PersonalFailure,
  type PersonalRunContext,
  type PersonalRunnerPort,
  type PersonalStoredInput,
} from "./controller.js";
import { PrivateAcquisitionGate } from "./acquisition-gate.js";
import {
  StorePersonalRuntime,
  type StorePersonalRunConfiguration,
} from "./store-runtime.js";
import {
  parseEngineStartupTimings,
  type LocalStartupMeasurements,
} from "../prepare/startup-measurements.js";

export interface PersonalGpuAdmission {
  acquire(
    request: {
      jobId: string;
      ownerId: string;
      release: string;
      gpu: DirectmlGpuIdentity;
    },
    signal: AbortSignal,
    onWait?: (reason: PersonalWaitReason) => void,
  ): Promise<{ releaseAfterExit(): Promise<void> }>;
  releasePendingAfterCleanup?(jobId: string): Promise<void>;
}
export interface PersonalChildPort {
  start(): Promise<ChildResponse>;
  request(
    command: "process",
    payload: Record<string, unknown>,
    timeoutMs?: number,
    onProgress?: (progress: ChildProgress) => void,
  ): Promise<ChildResponse>;
  stop(): Promise<void>;
  getPid?(): number | undefined;
}
interface Engine {
  child: PersonalChildPort;
  stop: Promise<void> | undefined;
  lease: { releaseAfterExit(): Promise<void> } | undefined;
  sessionId?: string | undefined;
  token?: string | undefined;
  workspace?:
    { cleanup(): Promise<void>; release(): Promise<void> } | undefined;
  gpu?: DirectmlGpuIdentity;
  retireWhenCleaned?: boolean;
  retirement?: Promise<void> | undefined;
}
interface Active extends Engine {
  engine?: Engine;
  detached?: boolean;
  removeAbort?: (() => void) | undefined;
}
export class DirectmlPersonalRunner implements PersonalRunnerPort {
  #storeRuntime: StorePersonalRuntime | undefined;
  private get storeRuntime(): StorePersonalRuntime {
    if (!this.#storeRuntime) throw new PersonalFailure("PREPARE_REQUIRED");
    return this.#storeRuntime;
  }
  private readonly active = new Map<string, Active>();
  private retained: Engine | undefined;
  private disposed = false;
  private pendingWorkspace: Engine["workspace"];
  private readonly configurationSnapshot: string;
  constructor(
    private readonly options: {
      host: HostContext;
      configuration: PersonalAgentConfiguration | StorePersonalRunConfiguration;
      storeRuntime?: StorePersonalRuntime;
      hardware(): Promise<DirectmlGpuIdentity[]>;
      admission: PersonalGpuAdmission;
      child?(options: ChildProcessOptions): PersonalChildPort;
      measurements?: LocalStartupMeasurements;
      /** Explicit compatibility mode for a trusted legacy runtime/test; production defaults to retained v2. */
      retainModel?: boolean;
      workspace?(
        relative: string,
      ): Promise<{ cleanup(): Promise<void>; release(): Promise<void> }>;
    },
  ) {
    if ("distribution" in options.configuration) {
      if (
        !options.storeRuntime ||
        options.child ||
        options.retainModel === false
      )
        throw new PersonalFailure("PREPARE_REQUIRED");
      StorePersonalRuntime.prototype.assertConfiguration.call(
        options.storeRuntime,
        options.host,
        options.configuration,
      );
      this.#storeRuntime = options.storeRuntime;
    } else if (options.storeRuntime) {
      throw new PersonalFailure("PREPARE_REQUIRED");
    }
    this.configurationSnapshot = JSON.stringify(options.configuration);
  }
  async acquireYouTube(
    videoId: string,
    context: PersonalRunContext,
  ): Promise<PersonalStoredInput> {
    return new PrivateAcquisitionGate(this.options.host).run(
      context.signal,
      async () => {
        let result: PersonalStoredInput | undefined, error: unknown;
        try {
          result = await this.acquireYouTubeOnce(videoId, context);
        } catch (failure) {
          error = failure;
          if (
            failure &&
            typeof failure === "object" &&
            "code" in failure &&
            failure.code === "SOURCE_UNAVAILABLE"
          ) {
            const code = classifyAcquisitionFailure(
              "summary" in failure && typeof failure.summary === "string"
                ? failure.summary
                : "",
            );
            error = new PersonalFailure(
              code === "SOURCE_BOT_CHALLENGE" ||
                code === "ACQUISITION_RATE_LIMITED"
                ? code
                : "SOURCE_UNAVAILABLE",
            );
          }
        }
        // End the entire acquisition tree before releasing the shared source lock.
        if (error || !this.retained) {
          await this.stop(context.jobId);
          await this.releaseAfterCleanup(context.jobId);
        } else await this.finish(context.jobId);
        for (const name of [
          "metadata.jsonl",
          "download.json",
          "source-info.json",
        ]) {
          const relative = `personal\\jobs\\${context.jobId}\\${name}`;
          try {
            const path = win32.join(
              this.options.configuration.personalRoot,
              relative,
            );
            await lstat(path);
            await this.options.host.native.validatePath(
              "personal",
              relative,
              "file",
            );
            await rm(path);
          } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code !== "ENOENT")
              throw failure;
          }
        }
        if (error) throw error;
        if (!result) throw new PersonalFailure("SOURCE_UNAVAILABLE");
        return result;
      },
    );
  }
  private async acquireYouTubeOnce(
    videoId: string,
    context: PersonalRunContext,
  ): Promise<PersonalStoredInput> {
    const active = await this.engine(context),
      configuration = this.options.configuration;
    const args = [
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
      `deno:${win32.join(configuration.releaseRoot, "tools", "youtube", "bin", "deno.exe")}`,
      "--ffmpeg-location",
      win32.join(configuration.releaseRoot, "runtime", "bin", "ffmpeg.exe"),
    ];
    context.progress("metadata");
    await this.request(
      active,
      context,
      {
        operation: "downloader",
        arguments: [
          ...args,
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
          `https://www.youtube.com/watch?v=${videoId}`,
        ],
        output: "metadata.jsonl",
        timeout: 120,
        maximum: 4 * 1024 ** 2,
      },
      125000,
    );
    context.signal.throwIfAborted();
    const raw = parseSourceMetadataProjection(
      (
        await readPrivateBytes(
          this.options.host,
          `personal\\jobs\\${context.jobId}\\metadata.jsonl`,
          4 * 1024 ** 2,
        )
      ).toString("utf8"),
    ) as Record<string, unknown>;
    const source = validateSourceMetadata(raw, {
      provider: "LOCAL_WINDOWS",
      video_id: videoId,
      duration_seconds: typeof raw.duration === "number" ? raw.duration : 0,
    });
    await writePrivateAtomic(
      this.options.host,
      `personal\\jobs\\${context.jobId}\\source-info.json`,
      Buffer.from(JSON.stringify(source.download_info)),
    );
    context.progress("downloading");
    await this.request(
      active,
      context,
      {
        operation: "downloader",
        arguments: [
          ...args,
          "--no-progress",
          "--max-filesize",
          "256M",
          "--concurrent-fragments",
          "1",
          "-f",
          source.format_id,
          "-o",
          win32.join(context.workDirectory, "source.%(ext)s"),
          "--print",
          DOWNLOAD_METADATA,
          "--load-info-json",
          win32.join(context.workDirectory, "source-info.json"),
        ],
        output: "download.json",
        timeout: 600,
        maximum: 65536,
      },
      605000,
    );
    context.signal.throwIfAborted();
    const path = validateDownloadedMetadata(
      JSON.parse(
        (
          await readPrivateBytes(
            this.options.host,
            `personal\\jobs\\${context.jobId}\\download.json`,
            65536,
          )
        ).toString("utf8"),
      ),
      source,
    );
    if (
      win32.dirname(path).toLowerCase() !==
        context.workDirectory.toLowerCase() ||
      !/^source\.(m4a|webm|mp3|ogg|opus)$/.test(win32.basename(path))
    )
      throw new PersonalFailure("SOURCE_UNAVAILABLE");
    const relative = win32.relative(configuration.personalRoot, path);
    await this.options.host.native.validatePath("personal", relative, "file");
    const file = await open(path, "r");
    try {
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size < 1n ||
        before.size > BigInt(PERSONAL_MAX_BYTES)
      )
        throw new PersonalFailure("INPUT_LIMIT");
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({
        autoClose: false,
        signal: context.signal,
      }))
        hash.update(chunk);
      const after = await file.stat({ bigint: true });
      if (
        before.size !== after.size ||
        before.ino !== after.ino ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new PersonalFailure("INPUT_CHANGED");
      const sha256 = hash.digest("hex");
      return {
        path,
        name: source.source_title ?? "YouTube",
        bytes: Number(before.size),
        sha256,
        sourceIdentity: {
          kind: "youtube",
          videoId: source.id,
          formatId: source.format_id,
          audioTrackId: source.identity.musicmute_audio_track_id,
          audioIsDefault: source.identity.musicmute_audio_is_default,
          language: source.identity.language,
          inputSha256: sha256,
          inputBytes: Number(before.size),
        },
      };
    } finally {
      await file.close();
    }
  }
  async process(
    input: PersonalStoredInput,
    context: PersonalRunContext,
  ): Promise<Record<string, unknown>> {
    let primary: unknown;
    let result: Record<string, unknown> | undefined;
    try {
      const active = await this.engine(context);
      await this.verifyModel();
      context.signal.throwIfAborted();
      const gpu = resolveQualifiedGpuIdentity(
        (await this.configurationEvidence(context.signal)).gpuIdentity!,
        await this.options.hardware(),
      );
      const engine = active.engine ?? active;
      engine.lease ??= await this.options.admission.acquire(
        {
          jobId: engine.sessionId ?? context.jobId,
          ownerId: context.ownerId,
          release: this.options.configuration.release,
          gpu,
        },
        context.signal,
        (reason) => {
          if (!context.signal.aborted)
            context.progress("preparation", undefined, reason);
        },
      );
      context.signal.throwIfAborted();
      context.progress("preparation");
      const response = await this.request(
        active,
        context,
        {
          operation: "process",
          input: {
            path: input.path,
            bytes: input.bytes,
            sha256: Buffer.from(input.sha256, "hex").toString("base64"),
          },
          recipeId: context.recipeId,
        },
        60 * 60_000,
        (progress) => {
          if (!context.signal.aborted) {
            const stage = progress.stage as PersonalStage;
            if (
              [
                "input-validation",
                "preparation",
                "model-load",
                "separation",
                "encoding",
                "output-validation",
              ].includes(stage)
            )
              context.progress(
                stage,
                progress.work
                  ? progress.work.completed / progress.work.total
                  : undefined,
              );
          }
        },
      );
      context.signal.throwIfAborted();
      await this.verifyModel();
      resolveQualifiedGpuIdentity(gpu, await this.options.hardware());
      if (
        response.payload.recipeId !== context.recipeId ||
        response.payload.recipeRevision !== 6
      )
        throw new PersonalFailure("OUTPUT_INVALID");
      const { sessionCompletion: _completion, ...media } = response.payload;
      result = media;
    } catch (error) {
      primary = error;
      if (error instanceof PersonalFailure) primary = error;
      else if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        primary = new PersonalFailure(
          code === "DURATION_LIMIT"
            ? "DURATION_LIMIT"
            : code === "INPUT_LIMIT"
              ? "INPUT_LIMIT"
              : code === "GPU_UNSUPPORTED" || code === "GPU_OOM"
                ? "GPU_UNSUPPORTED"
                : code === "SOURCE_UNAVAILABLE"
                  ? "SOURCE_UNAVAILABLE"
                  : "PROCESSING_FAILED",
        );
      } else primary = new PersonalFailure("PROCESSING_FAILED");
    } finally {
      try {
        if (primary && this.retained && !this.active.size)
          await this.retireEngine(this.retained);
        else if (primary || !this.retained) await this.stop(context.jobId);
        else await this.finish(context.jobId);
      } catch {
        primary = new PersonalFailure("STOP_UNCONFIRMED");
      }
    }
    if (primary) throw primary;
    if (!result) throw new PersonalFailure("PROCESSING_FAILED");
    try {
      const timings = parseEngineStartupTimings(result.startupTimings);
      if (timings && this.options.measurements) {
        const identity = {
          releaseSha256: this.options.configuration.manifestSha256,
          modelSha256: MODEL.sha256,
        };
        this.options.measurements.recordDuration(
          "model-load",
          timings.modelLoadSeconds * 1000,
          "completed",
          "engine",
          identity,
        );
        this.options.measurements.recordDuration(
          "first-inference",
          timings.firstInferenceSeconds * 1000,
          "completed",
          "engine",
          identity,
        );
        await this.options.measurements.flush();
      }
    } catch {
      /* Diagnostic persistence cannot authorize or reject a valid media result. */
    }
    return result;
  }
  async finish(jobId: string): Promise<void> {
    const active = this.active.get(jobId);
    if (!active) return;
    if (!active.engine) return this.stop(jobId);
    if (
      !active.detached ||
      !active.engine.token ||
      active.engine.stop ||
      !(await this.options.host.native.retainedEngineIdle?.(
        active.engine.token,
      ))
    )
      throw new PersonalFailure("STOP_UNCONFIRMED");
    active.removeAbort?.();
    active.removeAbort = undefined;
  }
  async stop(jobId: string): Promise<void> {
    const active = this.active.get(jobId);
    if (!active) return;
    await this.stopEngine(active.engine ?? active);
    active.removeAbort?.();
    active.removeAbort = undefined;
  }
  private async stopEngine(engine: Engine): Promise<void> {
    engine.stop ??= engine.child.stop();
    try {
      await engine.stop;
    } catch {
      /* Exact named Job proof remains mandatory after a lost stop ACK. */
    }
    try {
      if (
        !this.options.host.native.inferenceIdle ||
        !(await this.options.host.native.inferenceIdle())
      )
        throw new Error("STOP_UNCONFIRMED");
      if (engine.token) {
        if (!this.options.host.native.forgetRetainedEngine)
          throw new Error("STOP_UNCONFIRMED");
        await this.options.host.native.forgetRetainedEngine(engine.token);
        engine.token = undefined;
      }
    } catch {
      throw new PersonalFailure("STOP_UNCONFIRMED");
    }
  }
  async releaseAfterCleanup(jobId: string): Promise<void> {
    const active = this.active.get(jobId);
    if (!active) return;
    const engine = active.engine ?? active;
    if (active.engine && !engine.stop) {
      await this.finish(jobId);
      this.active.delete(jobId);
      if (engine.retireWhenCleaned) await this.retireEngine(engine);
      return;
    }
    await this.stopEngine(engine);
    if (active.engine) await this.retireEngine(engine);
    else if (engine.lease) await engine.lease.releaseAfterExit();
    else await this.options.admission.releasePendingAfterCleanup?.(jobId);
    this.active.delete(jobId);
  }
  private async retireEngine(engine: Engine): Promise<void> {
    if (engine.retirement) return engine.retirement;
    const retirement = (async () => {
      await this.stopEngine(engine);
      await engine.workspace?.cleanup();
      await engine.workspace?.release();
      if (engine.lease) await engine.lease.releaseAfterExit();
      else
        await this.options.admission.releasePendingAfterCleanup?.(
          engine.sessionId!,
        );
      if (this.retained === engine) this.retained = undefined;
    })();
    engine.retirement = retirement;
    try {
      await retirement;
    } finally {
      engine.retirement = undefined;
    }
  }
  async yieldIdle(): Promise<boolean> {
    const engine = this.retained;
    if (!engine) return true;
    engine.retireWhenCleaned = true;
    if (this.active.size) return false;
    await this.retireEngine(engine);
    return true;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.active.size) throw new PersonalFailure("STOP_UNCONFIRMED");
    if (this.retained) await this.retireEngine(this.retained);
    if (this.pendingWorkspace) {
      await this.pendingWorkspace.cleanup();
      await this.pendingWorkspace.release();
      this.pendingWorkspace = undefined;
    }
  }
  private async request(
    active: Active,
    context: PersonalRunContext,
    payload: Record<string, unknown>,
    timeoutMs?: number,
    onProgress?: (progress: ChildProgress) => void,
  ): Promise<ChildResponse> {
    const engine = active.engine;
    if (engine) {
      if (!engine.token || engine.stop)
        throw new PersonalFailure("STOP_UNCONFIRMED");
      active.detached = false;
      await this.options.host.native.beginRetainedEngine!(
        engine.token,
        context.jobId,
      );
    }
    const response = await active.child.request(
      "process",
      {
        ...payload,
        ...(engine ? { jobId: context.jobId } : {}),
      },
      timeoutMs,
      onProgress,
    );
    context.signal.throwIfAborted();
    if (engine) {
      const completion = response.payload.sessionCompletion;
      if (
        !completion ||
        typeof completion !== "object" ||
        Array.isArray(completion)
      )
        throw new PersonalFailure("OUTPUT_INVALID");
      const row = completion as Record<string, unknown>;
      if (
        Object.keys(row).sort().join() !==
          "detached,jobId,modelReused,sessionId" ||
        row.sessionId !== engine.sessionId ||
        row.jobId !== context.jobId ||
        row.detached !== true ||
        typeof row.modelReused !== "boolean"
      )
        throw new PersonalFailure("OUTPUT_INVALID");
      await this.options.host.native.completeRetainedEngine!(
        engine.token!,
        context.jobId,
      );
      if (!(await this.options.host.native.retainedEngineIdle!(engine.token!)))
        throw new PersonalFailure("STOP_UNCONFIRMED");
      active.detached = true;
    }
    return response;
  }
  private async verifyModel(): Promise<void> {
    if (
      this.disposed ||
      JSON.stringify(this.options.configuration) !== this.configurationSnapshot
    )
      throw new PersonalFailure("PREPARE_REQUIRED");
    const host = this.options.host;
    if ("distribution" in this.options.configuration) {
      StorePersonalRuntime.prototype.assertConfiguration.call(
        this.storeRuntime,
        this.options.host,
        this.options.configuration,
      );
      await StorePersonalRuntime.prototype.assertCurrent.call(
        this.storeRuntime,
        new AbortController().signal,
      );
      return;
    }
    if (this.options.retainModel !== false) {
      const identity = await host.native.identity();
      if (
        identity.sid !== this.options.configuration.sid ||
        identity.sessionId !== this.options.configuration.controlPeer.sessionId
      )
        throw new PersonalFailure("PREPARE_REQUIRED");
    }
    if (
      (await this.options.host.native.bootIdentity()) !==
      this.options.configuration.bootIdentity
    )
      throw new PersonalFailure("PREPARE_REQUIRED");
    const current = await privateFingerprint(
      this.options.host,
      `models\\${MODEL.filename}`,
    );
    if (
      JSON.stringify(current) !==
      JSON.stringify(this.options.configuration.modelFingerprint)
    )
      throw new PersonalFailure("PREPARE_REQUIRED");
  }
  private async configurationEvidence(signal: AbortSignal) {
    if ("distribution" in this.options.configuration)
      return StorePersonalRuntime.prototype.assertCurrent.call(
        this.storeRuntime,
        signal,
      );
    return parsePersonalAgentConfiguration(this.options.configuration).evidence;
  }
  private async engine(context: PersonalRunContext): Promise<Active> {
    context.signal.throwIfAborted();
    const existing = this.active.get(context.jobId);
    if (existing && !(existing.engine ?? existing).stop) {
      if (!existing.removeAbort) this.bindActive(existing, context);
      return existing;
    }
    if (this.active.size || this.pendingWorkspace)
      throw new PersonalFailure("STOP_UNCONFIRMED");
    const { configuration, host } = this.options;
    await this.verifyModel();
    const evidence = await this.configurationEvidence(context.signal),
      gpu = resolveQualifiedGpuIdentity(
        evidence.gpuIdentity!,
        await this.options.hardware(),
      );
    if (!PERSONAL_UUID.test(context.jobId))
      throw new PersonalFailure("INVALID_REQUEST");
    if (this.retained?.retirement) {
      try {
        await this.retained.retirement;
      } catch {
        throw new PersonalFailure("STOP_UNCONFIRMED");
      }
      context.signal.throwIfAborted();
    }
    let engine = this.retained;
    if (engine) {
      if (
        engine.stop ||
        engine.retireWhenCleaned ||
        !engine.token ||
        !(await host.native.retainedEngineIdle?.(engine.token))
      )
        throw new PersonalFailure("STOP_UNCONFIRMED");
      resolveQualifiedGpuIdentity(engine.gpu!, [gpu]);
    } else {
      const retained =
        this.#storeRuntime !== undefined || this.options.retainModel !== false;
      if (
        retained &&
        (!host.native.registerRetainedEngine ||
          !host.native.beginRetainedEngine ||
          !host.native.completeRetainedEngine ||
          !host.native.retainedEngineIdle ||
          !host.native.forgetRetainedEngine ||
          !host.native.processIdentity ||
          !this.options.workspace)
      )
        throw new PersonalFailure("PREPARE_REQUIRED");
      const sessionId = retained ? randomUUID() : undefined,
        relative = retained
          ? `personal\\engine-session\\${sessionId}`
          : `personal\\jobs\\${context.jobId}`;
      const workspace = retained
        ? await this.options.workspace!(relative)
        : undefined;
      this.pendingWorkspace = workspace;
      const configRelative = `${relative}\\engine-config.json`;
      await writePrivateAtomic(
        host,
        configRelative,
        Buffer.from(
          JSON.stringify(
            retained
              ? {
                  version: 2,
                  sessionId,
                  sessionRoot: win32.join(configuration.personalRoot, relative),
                  jobsRoot: win32.join(
                    configuration.personalRoot,
                    "personal",
                    "jobs",
                  ),
                  releaseRoot: configuration.releaseRoot,
                  modelPath: win32.join(
                    configuration.personalRoot,
                    "models",
                    MODEL.filename,
                  ),
                  sid: configuration.sid,
                  gpuIdentity: gpu,
                }
              : {
                  version: 1,
                  jobId: context.jobId,
                  workRoot: context.workDirectory,
                  releaseRoot: configuration.releaseRoot,
                  modelPath: win32.join(
                    configuration.personalRoot,
                    "models",
                    MODEL.filename,
                  ),
                  sid: configuration.sid,
                  gpuIdentity: gpu,
                },
          ),
        ),
      );
      const options = {
        command: win32.join(
          configuration.releaseRoot,
          "runtime",
          "python",
          "python.exe",
        ),
        args: [
          "-I",
          "-c",
          "import runpy,sys;sys.path.insert(0,sys.argv.pop(1));runpy.run_module('musicmute_engine.consumer_personal',run_name='__main__')",
          win32.join(configuration.releaseRoot, "app", "engine"),
          "--consumer-config",
          win32.join(configuration.personalRoot, configRelative),
        ],
        cwd: win32.join(configuration.releaseRoot, "app", "engine"),
        trustedExecutableDirectory: win32.join(
          configuration.releaseRoot,
          "runtime",
          "bin",
        ),
        env: { MUSICMUTE_SENTRY_ENGINE_ENABLED: "0" },
        windowsJobObject: true,
        ...(retained ? { windowsDetachedConsole: true as const } : {}),
        windowsEngineModuleRoot: win32.join(
          configuration.releaseRoot,
          "app",
          "engine",
        ),
        startTimeoutMs: 60000,
        stopTimeoutMs: 1000,
      };
      const child =
        "distribution" in configuration
          ? await StorePersonalRuntime.prototype.createEngine.call(
              this.storeRuntime,
              configRelative,
            )
          : (this.options.child?.(options) ??
            (new (
              await import(
                /* @vite-ignore */ pathToFileURL(
                  win32.join(
                    configuration.releaseRoot,
                    "app",
                    "dist",
                    "src",
                    "agent",
                    "child-process.js",
                  ),
                ).href
              )
            ).WorkerChildProcess(options) as PersonalChildPort));
      engine = {
        child,
        stop: undefined,
        lease: undefined,
        ...(retained ? { sessionId, workspace, gpu } : {}),
      };
      if (retained) this.retained = engine;
      this.pendingWorkspace = undefined;
      const created = engine;
      const active: Active = retained
        ? { ...created, engine: created }
        : created;
      this.bindActive(active, context);
      try {
        if (retained) {
          created.lease = await this.options.admission.acquire(
            {
              jobId: sessionId!,
              ownerId: context.ownerId,
              release: configuration.release,
              gpu,
            },
            context.signal,
            (reason) => {
              if (!context.signal.aborted)
                context.progress("preparation", undefined, reason);
            },
          );
          context.signal.throwIfAborted();
        }
        const ready = await child.start();
        context.signal.throwIfAborted();
        if (retained) {
          const row = ready.payload.sessionEngine;
          if (!row || typeof row !== "object" || Array.isArray(row))
            throw new PersonalFailure("OUTPUT_INVALID");
          const identity = row as Record<string, unknown>;
          const guardianPid = child.getPid?.();
          if (
            Object.keys(identity).sort().join() !== "processId,sessionId" ||
            identity.sessionId !== sessionId ||
            !Number.isSafeInteger(identity.processId) ||
            Number(identity.processId) <= 0 ||
            !guardianPid
          )
            throw new PersonalFailure("OUTPUT_INVALID");
          const guardian = await host.native.processIdentity!(guardianPid),
            process = await host.native.processIdentity!(
              Number(identity.processId),
            );
          if (!guardian || !process)
            throw new PersonalFailure("STOP_UNCONFIRMED");
          const registered = await host.native.registerRetainedEngine!(
            guardian,
            process,
          );
          created.token = registered.token;
          active.detached = true;
        }
        return active;
      } catch (error) {
        await this.stop(context.jobId);
        throw error;
      }
    }
    const active: Active = { ...engine, engine, detached: true };
    this.bindActive(active, context);
    return active;
  }
  private bindActive(active: Active, context: PersonalRunContext): void {
    this.active.set(context.jobId, active);
    const abort = () => {
      // The listener is owned by this exact active job, never a later reused engine job.
      if (this.active.get(context.jobId) === active)
        void this.stop(context.jobId).catch(() => {});
    };
    context.signal.addEventListener("abort", abort, { once: true });
    active.removeAbort = () =>
      context.signal.removeEventListener("abort", abort);
  }
}
