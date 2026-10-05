import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  validateDesktopSession,
  type DesktopSession,
} from "../shared/desktop-protocol.js";
import {
  canonicalYouTubeUrl,
  isVideoId,
  MVP_MAX_DURATION_SECONDS,
  sanitizeSourceTitle,
  type PipelineHooks,
  type PreparedAudio,
  type ProcessingProvider,
  type StartPayload,
} from "../shared/protocol.js";
import { rememberTransferredAudio } from "./audio-integrity.js";
import { cacheAccountResult } from "./account-cache.js";
import {
  AccountApiClient,
  DesktopApiError,
  sameAccountScope,
  type AccountScope,
} from "./account-api.js";
import { CloudProcessingProvider, fullTimeline } from "./cloud-provider.js";
import type { LocalConfig } from "./config.js";
import { publicApiOrigin } from "./desktop-service.js";
import { MODEL_SHA256 } from "./local-provider.js";

export interface BrowserCloudOptions {
  /** App-owned authorization only. This session never reaches the browser. */
  session: (signal?: AbortSignal) => Promise<DesktopSession>;
  verifyCurrent: (scope: AccountScope) => Promise<boolean | void>;
  fetcher?: typeof fetch;
  pinnedCacheKeys?: () => Promise<ReadonlySet<string>>;
  onCloudJob?: (scope: AccountScope, jobId: string) => void;
}

/** Backend-owned URL import under the calling JobManager's native cache lease. */
export class BrowserCloudProvider implements ProcessingProvider {
  readonly id = "ONLINE_MUSICMUTE" as const;
  constructor(
    private readonly config: LocalConfig,
    private readonly options: BrowserCloudOptions,
  ) {}

  async prepare(
    request: StartPayload,
    workRoot: string,
    hooks: PipelineHooks,
  ): Promise<PreparedAudio> {
    if (
      request.provider !== this.id ||
      !isVideoId(request.video_id) ||
      !Number.isFinite(request.duration_seconds) ||
      request.duration_seconds <= 0 ||
      request.duration_seconds > MVP_MAX_DURATION_SECONDS ||
      !/^[a-f0-9-]{36}$/.test(basename(workRoot))
    )
      throw new DesktopApiError("INVALID_CLOUD_REQUEST");
    if (hooks.signal.aborted) throw new DesktopApiError("CANCELLED");
    const accepted = validateDesktopSession(
      await this.options.session(hooks.signal),
      true,
    );
    const scope: AccountScope = {
      firebase_uid: accepted.firebase_uid,
      session_generation: accepted.session_generation,
    };
    let valid = true;
    let cancellationSignal: AbortSignal | undefined;
    const verify = async (honorAbort = true) => {
      if (honorAbort && hooks.signal.aborted)
        throw new DesktopApiError("CANCELLED");
      if (!valid) throw new DesktopApiError("ACCOUNT_CHANGED");
      try {
        if ((await this.options.verifyCurrent(scope)) === false)
          throw new DesktopApiError("ACCOUNT_CHANGED");
      } catch {
        valid = false;
        throw new DesktopApiError("ACCOUNT_CHANGED");
      }
      if (honorAbort && hooks.signal.aborted)
        throw new DesktopApiError("CANCELLED");
    };
    await verify();
    const api = new AccountApiClient(
      await publicApiOrigin(this.config),
      async () => {
        // Cancellation uses its own bounded command after the work signal aborts.
        await verify(false);
        const next = validateDesktopSession(
          await this.options.session(cancellationSignal ?? hooks.signal),
          true,
        );
        if (
          !sameAccountScope(scope, next) ||
          next.installation_id !== accepted.installation_id
        ) {
          valid = false;
          throw new DesktopApiError("ACCOUNT_CHANGED");
        }
        await verify(false);
        return next;
      },
      (candidate) => valid && sameAccountScope(scope, candidate),
      this.options.fetcher,
    );
    const cloud = new CloudProcessingProvider({
      api,
      scope,
      signal: hooks.signal,
      onProgress: (value) => {
        if (valid && !hooks.signal.aborted)
          hooks.onProgress(`cloud_${value.phase}_${value.status ?? ""}`);
      },
    });
    let cancellation: Promise<void> | undefined;
    const cancel = () => {
      cancellation ??= (async () => {
        await verify(false);
        cancellationSignal = AbortSignal.timeout(15_000);
        await cloud.cancel(cancellationSignal);
      })().catch(() => {
        // Cancellation failure is bounded and cannot expose private API prose.
        try {
          hooks.onDiagnostic({
            component: "companion",
            severity: "warning",
            event: "diagnostic_error",
            code: "CLOUD_CANCELLATION_UNAVAILABLE",
          });
        } catch {
          /* A local observer cannot prevent remote/session cleanup. */
        }
      });
    };
    hooks.signal.addEventListener("abort", cancel, { once: true });
    let output: string | undefined;
    let finished = false;
    try {
      await verify();
      const processingStarted = performance.now();
      const url = canonicalYouTubeUrl(request.video_id);
      const result = await cloud.startYouTube({
        request_id: basename(workRoot),
        url,
      });
      await verify();
      if (!fullTimeline(result.job) || !result.download_grant)
        throw new DesktopApiError("TIMELINE_INCOMPATIBLE");
      if (result.job.source_kind !== "url" || result.job.source_url !== url)
        throw new DesktopApiError("SOURCE_IDENTITY_MISMATCH");
      const sourceDuration = result.job.input.duration_seconds;
      if (Math.abs(sourceDuration - request.duration_seconds) > 2)
        throw new DesktopApiError("TIMELINE_MISMATCH");
      const title =
        sanitizeSourceTitle(result.job.display_name) ??
        sanitizeSourceTitle(result.job.source_title);
      const validationStarted = performance.now();
      const cached = await cacheAccountResult(
        this.config,
        scope,
        result.job,
        result.download_grant,
        {
          signal: hooks.signal,
          validation: "server",
          isCurrent: async () => verify(),
          // JobManager owns this lease across provider preparation/publication.
          withCacheMutation: async (operation) => operation(),
          ...(this.options.pinnedCacheKeys
            ? { pinnedCacheKeys: this.options.pinnedCacheKeys }
            : {}),
          ...(this.options.fetcher ? { fetcher: this.options.fetcher } : {}),
        },
      );
      await verify();
      if (
        cached.trim_enabled !== false ||
        Math.abs(cached.duration_seconds - sourceDuration) > 0.25 ||
        Math.abs(cached.source_duration_seconds - sourceDuration) > 0.25
      )
        throw new DesktopApiError("TIMELINE_MISMATCH");
      const target = join(workRoot, "vocals.mp3");
      await copyValidatedVocals(
        cached.vocal_path,
        target,
        cached.bytes,
        cached.sha256,
        verify,
      );
      output = target;
      await verify();
      this.options.onCloudJob?.({ ...scope }, result.job.id);
      finished = true;
      return {
        output_path: output,
        source_duration_seconds: sourceDuration,
        duration_seconds: cached.duration_seconds,
        bytes: cached.bytes,
        sha256: cached.sha256,
        model_id: MODEL_SHA256,
        trim_enabled: false,
        source: {
          kind: "youtube",
          video_id: request.video_id,
          format_id: "cloud-import",
          audio_track_id: null,
          audio_is_default: null,
          language: null,
        },
        ...(title ? { source_title: title } : {}),
        timings_ms: {
          cloud_processing: validationStarted - processingStarted,
          cloud_download_validation: performance.now() - validationStarted,
        },
      };
    } finally {
      hooks.signal.removeEventListener("abort", cancel);
      if (!finished || hooks.signal.aborted) cancel();
      await cancellation;
      cloud.close();
      if (!finished && output) await rm(output, { force: true });
    }
  }
}

async function copyValidatedVocals(
  source: string,
  target: string,
  bytes: number,
  sha256: string,
  verify: () => Promise<void>,
): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  let copiedSuccessfully = false;
  try {
    const before = await input.stat(),
      named = await lstat(source);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      before.size !== bytes ||
      named.isSymbolicLink() ||
      named.ino !== before.ino ||
      named.dev !== before.dev
    )
      throw new DesktopApiError("SOURCE_IDENTITY_MISMATCH");
    output = await open(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash("sha256");
    let copied = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      await verify();
      const buffer = Buffer.from(chunk);
      copied += buffer.length;
      if (copied > bytes) throw new DesktopApiError("SOURCE_IDENTITY_MISMATCH");
      hash.update(buffer);
      let offset = 0;
      while (offset < buffer.length) {
        const written = await output.write(buffer, offset);
        if (written.bytesWritten < 1)
          throw new DesktopApiError("CLOUD_RESULT_UNAVAILABLE");
        offset += written.bytesWritten;
      }
    }
    const after = await input.stat(),
      current = await lstat(source);
    if (
      copied !== bytes ||
      hash.digest("hex") !== sha256 ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      current.isSymbolicLink() ||
      current.ino !== before.ino ||
      current.dev !== before.dev
    )
      throw new DesktopApiError("SOURCE_IDENTITY_MISMATCH");
    await output.sync();
    await rememberTransferredAudio(output, target, bytes, sha256);
    await verify();
    copiedSuccessfully = true;
  } finally {
    await input.close();
    if (output) {
      const opened = await output.stat();
      await output.close();
      if (!copiedSuccessfully) {
        const named = await lstat(target).catch(() => undefined);
        if (
          named?.ino === opened.ino &&
          named.dev === opened.dev &&
          !named.isSymbolicLink()
        )
          await rm(target);
      }
    }
  }
}
