import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { rememberTransferredAudio } from "./audio-integrity.js";
import {
  type LocalAudioArtifact,
  type PipelineHooks,
  type PreparedAudio,
  type ProcessingProvider,
  type StartPayload,
} from "../shared/protocol.js";
import { DesktopApiError } from "./account-api.js";
import { type LocalConfig } from "./config.js";
import { MODEL_SHA256 } from "./local-provider.js";
import {
  type CommunityArtifact,
  type CommunityDelivery,
  YouTubeCommunityClient,
} from "./youtube-community-client.js";
import { YouTubeCommunityOutbox } from "./youtube-community-outbox.js";

export type CommunityMediaValidator = (
  path: string,
  artifact: CommunityArtifact,
  signal: AbortSignal,
) => Promise<void>;
export interface SharedYouTubeProviderOptions {
  /** Delay model readiness until neither local nor shared vocals can be reused. */
  beforeLocalPrepare?: () => Promise<void>;
  /** Chrome releases durable publication after its first validated playback acknowledgement. */
  deferPublication?: boolean;
  /** Wake a native publisher; its network work must not be returned or awaited here. */
  onStaged?: () => void;
}

/** Shared reuse is an optimization; it is never authorization for local compute. */
function sharedServiceUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (
    new Set([
      "APP_RESOURCES_REQUIRED",
      "ACCOUNT_NOT_CONFIGURED",
      "ACCOUNT_CONFIG_INVALID",
      "INVALID_API_ORIGIN",
      "GUEST_CREDENTIALS_UNAVAILABLE",
      "COMMUNITY_SESSION_UNAVAILABLE",
      "COMMUNITY_UNAVAILABLE",
      "COMMUNITY_AUTH_REQUIRED",
      "COMMUNITY_WAIT_TIMEOUT",
      "COMMUNITY_PRODUCER_UNAVAILABLE",
    ]).has(error.message)
  )
    return true;
  return (
    error instanceof DesktopApiError &&
    ([401, 403, 404, 408, 429].includes(error.status) || error.status >= 500)
  );
}
/** YouTube intake only. Generic native file processing never constructs this provider. */
export class SharedYouTubeProvider implements ProcessingProvider {
  readonly id = "LOCAL_MACOS";
  private clientPromise: Promise<YouTubeCommunityClient> | undefined;
  private readonly outbox: YouTubeCommunityOutbox;
  private initial: CommunityDelivery | undefined;
  private sharedUnavailable = false;
  constructor(
    private readonly config: LocalConfig,
    private readonly local: ProcessingProvider,
    private readonly makeClient: () => Promise<YouTubeCommunityClient>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly validateMedia: CommunityMediaValidator = (
      path,
      artifact,
      signal,
    ) => this.validate(path, artifact, signal),
    private readonly options: SharedYouTubeProviderOptions = {},
  ) {
    this.outbox = new YouTubeCommunityOutbox(
      join(config.root, "youtube-community-outbox"),
      fetcher,
    );
  }
  private client(): Promise<YouTubeCommunityClient> {
    this.clientPromise ??= this.makeClient().catch((error: unknown) => {
      this.clientPromise = undefined;
      throw error;
    });
    return this.clientPromise;
  }
  private wakePublication(): void {
    try {
      this.options.onStaged?.();
    } catch {
      /* Durable publication can recover if the local wake observer is unavailable. */
    }
  }
  /** Native URL intake has no page duration. A hit supplies it without consulting YouTube. */
  async sharedDuration(
    videoId: string,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    if (signal.aborted) throw new DesktopApiError("CANCELLED");
    const pending = (await this.outbox.records()).find(
      (record) =>
        record.video_id === videoId &&
        record.state === "pending" &&
        Date.parse(record.expires_at) > Date.now(),
    );
    if (signal.aborted) throw new DesktopApiError("CANCELLED");
    if (pending) return pending.original.duration_seconds;
    if (this.sharedUnavailable) return undefined;
    try {
      const client = await this.client();
      const delivery = await client.lookup(videoId, undefined, signal);
      if (!delivery) return undefined;
      this.initial = delivery;
      return delivery.original.declaration.duration_seconds;
    } catch (error) {
      if (signal.aborted) throw new DesktopApiError("CANCELLED");
      if (!sharedServiceUnavailable(error)) throw error;
      this.sharedUnavailable = true;
      return undefined;
    }
  }
  async recover(signal?: AbortSignal): Promise<void> {
    await this.outbox.drain(await this.client(), signal);
  }
  async prepare(
    request: StartPayload,
    workRoot: string,
    hooks: PipelineHooks,
  ): Promise<PreparedAudio> {
    let localStarted = false;
    try {
      return await this.prepareShared(request, workRoot, hooks, () => {
        localStarted = true;
      });
    } catch (error) {
      if (hooks.signal.aborted) throw new DesktopApiError("CANCELLED");
      // Never repeat acquisition/inference after it started, nor downgrade a
      // corrupt artifact, invalid timeline, cancellation or local setup failure.
      if (localStarted || !sharedServiceUnavailable(error)) throw error;
      this.sharedUnavailable = true;
      hooks.onDiagnostic({
        component: "companion",
        severity: "warning",
        event: "diagnostic_error",
        code: "COMMUNITY_UNAVAILABLE",
      });
      await this.options.beforeLocalPrepare?.();
      if (hooks.signal.aborted) throw new DesktopApiError("CANCELLED");
      return this.local.prepare(request, workRoot, hooks);
    }
  }
  private async prepareShared(
    request: StartPayload,
    workRoot: string,
    hooks: PipelineHooks,
    localStarting: () => void,
  ): Promise<PreparedAudio> {
    if (hooks.signal.aborted) throw new DesktopApiError("CANCELLED");
    const pending = await this.outbox.restorePending(
      request.video_id,
      request.duration_seconds,
      workRoot,
      hooks.signal,
    );
    if (hooks.signal.aborted) throw new DesktopApiError("CANCELLED");
    if (pending) {
      if (!this.options.deferPublication)
        await this.outbox.release(request.video_id, pending.vocals.sha256);
      if (hooks.signal.aborted) throw new DesktopApiError("CANCELLED");
      this.wakePublication();
      return {
        output_path: pending.vocals.path,
        source_duration_seconds: pending.original.duration_seconds,
        duration_seconds: pending.vocals.duration_seconds,
        bytes: pending.vocals.bytes,
        sha256: pending.vocals.sha256,
        model_id: MODEL_SHA256,
        trim_enabled: false,
        timings_ms: {},
        original_declaration: pending.original,
        shared_youtube_profile: "kim-vocal-2-full-timeline-v1",
        ...(this.options.deferPublication ? { publication_pending: true } : {}),
        source: {
          kind: "youtube",
          video_id: request.video_id,
          format_id: "pending-local",
          audio_track_id: null,
          audio_is_default: null,
          language: null,
        },
      };
    }
    if (this.sharedUnavailable)
      throw new DesktopApiError("COMMUNITY_UNAVAILABLE");
    const lookupStarted = performance.now();
    const timings: Record<string, number> = {};
    const client = await this.client();
    hooks.onProgress("shared-cache-lookup");
    let delivery =
      this.initial?.video_id === request.video_id
        ? this.initial
        : await client.lookup(
            request.video_id,
            request.duration_seconds,
            hooks.signal,
          );
    this.initial = undefined;
    if (
      delivery &&
      Math.abs(
        delivery.original.declaration.duration_seconds -
          request.duration_seconds,
      ) > 2
    )
      throw new DesktopApiError("TIMELINE_MISMATCH");
    // Freeze prior exact-byte declarations to release acquisition admission, without transferring media.
    if (!delivery) await this.outbox.declarePending(client, hooks.signal);
    // A miss reserves one global producer before either source acquisition or inference.
    for (let attempts = 0; !delivery && attempts < 5; attempts++) {
      const reservation = await client.reserve(request.video_id, hooks.signal);
      if (reservation.state === "ready") {
        delivery = await client.lookup(
          request.video_id,
          request.duration_seconds,
          hooks.signal,
        );
        if (!delivery) throw new DesktopApiError("COMMUNITY_REPLY_INVALID");
        break;
      }
      if (!reservation.producer) {
        hooks.onProgress("shared-cache-waiting");
        if ((await client.wait(request.video_id, hooks.signal)) === "ready") {
          delivery = await client.lookup(
            request.video_id,
            request.duration_seconds,
            hooks.signal,
          );
          if (!delivery) throw new DesktopApiError("COMMUNITY_REPLY_INVALID");
        }
        continue;
      }
      if (reservation.state !== "preparing" || !reservation.contribution_id)
        throw new DesktopApiError("COMMUNITY_LEASE_INVALID");
      const controller = new AbortController();
      const signal = AbortSignal.any([hooks.signal, controller.signal]);
      let leaseError: unknown,
        renewing = false;
      const heartbeat = setInterval(() => {
        if (renewing || signal.aborted) return;
        renewing = true;
        void client
          .renew(reservation, signal)
          .catch((error: unknown) => {
            leaseError = error;
            controller.abort();
          })
          .finally(() => {
            renewing = false;
          });
      }, 3 * 60_000);
      try {
        await this.outbox.assertAdmission();
        localStarting();
        await this.options.beforeLocalPrepare?.();
        const reusable = this.local as ProcessingProvider & {
          prepareSharedOriginal?: (
            request: StartPayload,
            workRoot: string,
            hooks: PipelineHooks,
            original: LocalAudioArtifact,
          ) => Promise<PreparedAudio>;
        };
        const original = reusable.prepareSharedOriginal
          ? await client.lookupOriginal(
              reservation,
              request.duration_seconds,
              signal,
            )
          : null;
        let audio: PreparedAudio;
        if (original && reusable.prepareSharedOriginal) {
          hooks.onProgress("shared-original-download");
          await mkdir(workRoot, { recursive: true, mode: 0o700 });
          const path = join(
            workRoot,
            `source.${original.declaration.extension}`,
          );
          await this.download(path, original, signal);
          audio = await reusable.prepareSharedOriginal(
            request,
            workRoot,
            { ...hooks, signal },
            { ...original.declaration, path },
          );
        } else
          audio = await this.local.prepare(request, workRoot, {
            ...hooks,
            signal,
          });
        if (leaseError) throw leaseError;
        if (signal.aborted) throw new DesktopApiError("CANCELLED");
        if (
          !audio.original ||
          audio.source?.kind !== "youtube" ||
          audio.source.video_id !== request.video_id ||
          audio.model_id !== MODEL_SHA256 ||
          audio.trim_enabled !== false ||
          Math.abs(audio.source_duration_seconds - audio.duration_seconds) >
            0.25
        )
          throw new DesktopApiError("COMMUNITY_SOURCE_INVALID");
        clearInterval(heartbeat);
        const stageStarted = performance.now();
        await this.outbox.stage(
          reservation,
          audio.original,
          {
            path: audio.output_path,
            extension: "mp3",
            content_type: "audio/mpeg",
            duration_seconds: audio.duration_seconds,
            sha256: audio.sha256,
            bytes: audio.bytes,
          },
          { defer_publication: this.options.deferPublication === true },
        );
        // Durable bytes survive JobManager's scratch finalizer; publication never gates playback.
        this.wakePublication();
        return {
          ...audio,
          timings_ms: {
            ...audio.timings_ms,
            "durable-stage": performance.now() - stageStarted,
          },
          shared_youtube_profile: "kim-vocal-2-full-timeline-v1",
          ...(this.options.deferPublication
            ? { publication_pending: true }
            : {}),
        };
      } catch (error) {
        await client.fail(reservation).catch(() => {});
        throw leaseError ?? error;
      } finally {
        clearInterval(heartbeat);
        controller.abort();
      }
    }
    if (!delivery) throw new DesktopApiError("COMMUNITY_PRODUCER_UNAVAILABLE");
    timings["shared-cache-lookup"] = performance.now() - lookupStarted;
    const downloadStarted = performance.now();
    hooks.onProgress("shared-cache-download");
    await mkdir(workRoot, { recursive: true, mode: 0o700 });
    const vocalPath = join(workRoot, "shared-vocals.mp3");
    try {
      await this.download(vocalPath, delivery.vocals, hooks.signal);
      timings["shared-cache-download"] = performance.now() - downloadStarted;
      const validationStarted = performance.now();
      await this.validateMedia(vocalPath, delivery.vocals, hooks.signal);
      timings["shared-cache-validation"] =
        performance.now() - validationStarted;
    } catch (error) {
      await rm(vocalPath, { force: true });
      throw error;
    }
    return {
      output_path: vocalPath,
      source_duration_seconds: delivery.original.declaration.duration_seconds,
      duration_seconds: delivery.vocals.declaration.duration_seconds,
      bytes: delivery.vocals.declaration.bytes,
      sha256: delivery.vocals.declaration.sha256,
      model_id: MODEL_SHA256,
      trim_enabled: false,
      timings_ms: timings,
      shared_youtube_profile: "kim-vocal-2-full-timeline-v1",
      original_declaration: { ...delivery.original.declaration },
      source: {
        kind: "youtube",
        video_id: request.video_id,
        format_id: "shared-cache",
        audio_track_id: null,
        audio_is_default: null,
        language: null,
      },
    };
  }
  private async download(
    path: string,
    artifact: CommunityArtifact,
    signal: AbortSignal,
  ): Promise<void> {
    const file = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const reply = await this.fetcher(artifact.grant.url, {
        method: "GET",
        headers: {
          Accept: artifact.declaration.content_type,
          "Accept-Encoding": "identity",
        },
        redirect: "error",
        signal,
      });
      if (
        !reply.ok ||
        reply.status !== 200 ||
        reply.redirected ||
        !reply.body ||
        reply.headers
          .get("content-type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== artifact.declaration.content_type ||
        ![null, "identity"].includes(reply.headers.get("content-encoding"))
      ) {
        await reply.body?.cancel();
        throw new DesktopApiError("COMMUNITY_DOWNLOAD_INVALID");
      }
      const length = reply.headers.get("content-length");
      if (
        length !== null &&
        (!/^\d{1,10}$/.test(length) ||
          Number(length) !== artifact.declaration.bytes)
      ) {
        await reply.body.cancel();
        throw new DesktopApiError("COMMUNITY_DOWNLOAD_INVALID");
      }
      reader = reply.body.getReader();
      const hash = createHash("sha256");
      let bytes = 0;
      while (true) {
        if (signal.aborted) throw new DesktopApiError("CANCELLED");
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > artifact.declaration.bytes)
          throw new DesktopApiError("COMMUNITY_DOWNLOAD_INVALID");
        hash.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.length) {
          const written = await file.write(
            chunk.value,
            offset,
            chunk.value.length - offset,
          );
          if (!written.bytesWritten)
            throw new DesktopApiError("COMMUNITY_CACHE_FAILED");
          offset += written.bytesWritten;
        }
      }
      if (
        bytes !== artifact.declaration.bytes ||
        hash.digest("hex") !== artifact.declaration.sha256
      )
        throw new DesktopApiError("COMMUNITY_CHECKSUM_MISMATCH");
      await file.sync();
      await rememberTransferredAudio(
        file,
        path,
        bytes,
        artifact.declaration.sha256,
      );
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      await file.close();
    }
  }
  private async validate(
    _path: string,
    artifact: CommunityArtifact,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new DesktopApiError("CANCELLED");
    // The catalog publishes only server-decoded media. The download verifies its
    // immutable SHA-256; playback performs the one required browser decode.
    if (
      artifact.declaration.extension !== "mp3" ||
      artifact.declaration.content_type !== "audio/mpeg"
    )
      throw new DesktopApiError("COMMUNITY_AUDIO_INVALID");
  }
}
