import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  isLocalAudioDeclaration,
  MVP_MAX_DURATION_SECONDS,
  type PipelineHooks,
  type PreparedAudio,
  type StartPayload,
} from "../shared/protocol.js";
import { assertCacheDirectory } from "./cache-budget.js";
import { withCacheMutation } from "./cache-mutator.js";
import type { LocalConfig } from "./config.js";
import { localCacheKey } from "./jobs.js";
import { LocalMacProvider, MODEL_SHA256 } from "./local-provider.js";
import { LocalSyncCaptureQueue } from "./local-sync-capture.js";
import { LocalSyncOutbox, type LocalLibraryOwner } from "./sync-outbox.js";

export interface CaptureOutcome {
  request_id: string;
  cache_key: string;
  state: "deferred" | "rejected";
  error_code: string;
}

async function privateFile(path: string, maximum: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size <= 0 ||
      info.size > maximum
    )
      throw new Error("CACHE_UNSAFE");
    return { file, info };
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Requires the cache lease. A capture ticket never authorizes an arbitrary file. */
async function retainedYouTube(
  config: LocalConfig,
  cacheKey: string,
  videoId: string,
  signal: AbortSignal,
): Promise<PreparedAudio> {
  const root = join(config.cache_root, "vocals", cacheKey);
  if (!(await assertCacheDirectory(config.cache_root, root)))
    throw new Error("CAPTURE_SOURCE_UNAVAILABLE");
  const metadata = await privateFile(join(root, "result.json"), 16_384);
  let audio: PreparedAudio;
  try {
    audio = JSON.parse(await metadata.file.readFile("utf8")) as PreparedAudio;
  } finally {
    await metadata.file.close();
  }
  const path = join(root, "vocals.mp3");
  if (
    !audio ||
    audio.output_path !== path ||
    audio.model_id !== MODEL_SHA256 ||
    audio.trim_enabled !== false ||
    !Number.isFinite(audio.source_duration_seconds) ||
    audio.source_duration_seconds <= 0 ||
    audio.source_duration_seconds > MVP_MAX_DURATION_SECONDS ||
    !Number.isFinite(audio.duration_seconds) ||
    Math.abs(audio.duration_seconds - audio.source_duration_seconds) > 0.25 ||
    !/^[a-f0-9]{64}$/.test(audio.sha256) ||
    !isLocalAudioDeclaration(
      audio.original_declaration,
      audio.source_duration_seconds,
    ) ||
    audio.source?.kind !== "youtube" ||
    audio.source.video_id !== videoId ||
    typeof audio.source.format_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(audio.source.format_id) ||
    localCacheKey({
      video_id: videoId,
      provider: "LOCAL_MACOS",
      duration_seconds: audio.source_duration_seconds,
    }) !== cacheKey
  )
    throw new Error("CAPTURE_SOURCE_UNAVAILABLE");
  const media = await privateFile(path, 30 * 1024 ** 2);
  try {
    if (media.info.size !== audio.bytes)
      throw new Error("CAPTURE_SOURCE_UNAVAILABLE");
    const hash = createHash("sha256");
    for await (const chunk of media.file.createReadStream({
      autoClose: false,
    })) {
      if (signal.aborted) throw new Error("CANCELLED");
      hash.update(chunk);
    }
    const after = await media.file.stat();
    if (
      hash.digest("hex") !== audio.sha256 ||
      after.size !== media.info.size ||
      after.mtimeMs !== media.info.mtimeMs
    )
      throw new Error("CAPTURE_SOURCE_UNAVAILABLE");
    return audio;
  } finally {
    await media.file.close();
  }
}

export interface WarmCaptureDependencies {
  verifyCurrent: () => Promise<void>;
  hooks: PipelineHooks;
  acquire?: LocalMacProvider["acquireYouTube"];
}

/** One background acquisition: cached vocals are already playing and inference is never repeated. */
export async function prepareOneWarmCapture(
  config: LocalConfig,
  owner: LocalLibraryOwner,
  queue: LocalSyncCaptureQueue,
  outbox: LocalSyncOutbox,
  dependencies: WarmCaptureDependencies,
): Promise<CaptureOutcome[]> {
  await dependencies.verifyCurrent();
  const candidates = (await queue.list(owner)).filter((item) =>
    ["pending", "deferred"].includes(item.state),
  );
  const candidate =
    candidates.find((item) => item.state === "pending") ?? candidates[0];
  if (!candidate) return [];
  const attempt = await queue.beginAttempt(owner, candidate.request_id);
  try {
    const alreadyStaged = (await outbox.list(owner)).find(
      (record) =>
        record.request_id === attempt.request_id &&
        record.cache_key === attempt.cache_key,
    );
    if (alreadyStaged) {
      await queue.completeAttempt(
        owner,
        attempt.request_id,
        attempt.attempt_id,
      );
      return [];
    }
    const audio = await withCacheMutation(config.cache_root, () =>
      retainedYouTube(
        config,
        attempt.cache_key,
        attempt.video_id,
        dependencies.hooks.signal,
      ),
    );
    await outbox.assertAdmission(audio.original_declaration!.bytes);
    await dependencies.verifyCurrent();
    const request: StartPayload = {
      video_id: attempt.video_id,
      provider: "LOCAL_MACOS",
      duration_seconds: audio.source_duration_seconds,
    };
    const local = new LocalMacProvider(config);
    const acquire = dependencies.acquire ?? local.acquireYouTube.bind(local);
    const acquired = await acquire(
      request,
      queue.attemptRoot(attempt),
      dependencies.hooks,
    );
    const expected = audio.original_declaration!;
    const profile = (source: NonNullable<PreparedAudio["source"]>) => [
      source.kind,
      source.video_id,
      source.format_id,
      source.audio_track_id,
      source.audio_is_default,
      source.language,
    ];
    if (
      acquired.original.sha256 !== expected.sha256 ||
      acquired.original.bytes !== expected.bytes ||
      acquired.original.extension !== expected.extension ||
      acquired.original.content_type !== expected.content_type ||
      Math.abs(acquired.original.duration_seconds - expected.duration_seconds) >
        0.25 ||
      JSON.stringify(profile(acquired.source)) !==
        JSON.stringify(profile(audio.source!))
    )
      throw new Error("CAPTURE_SOURCE_CHANGED");
    await withCacheMutation(config.cache_root, async () => {
      await dependencies.verifyCurrent();
      const current = await retainedYouTube(
        config,
        attempt.cache_key,
        attempt.video_id,
        dependencies.hooks.signal,
      );
      if (
        current.sha256 !== audio.sha256 ||
        current.original_declaration?.sha256 !== expected.sha256
      )
        throw new Error("CAPTURE_SOURCE_CHANGED");
      await outbox.stage({
        owner,
        request_id: attempt.request_id,
        cache_key: attempt.cache_key,
        original: acquired.original,
        vocals: {
          path: current.output_path,
          extension: "mp3",
          content_type: "audio/mpeg",
          duration_seconds: current.duration_seconds,
          bytes: current.bytes,
          sha256: current.sha256,
        },
        source: acquired.source,
      });
      await queue.completeAttempt(
        owner,
        attempt.request_id,
        attempt.attempt_id,
      );
    });
    return [];
  } catch (error) {
    const raw = error instanceof Error ? error.message : "CAPTURE_FAILED";
    const code = /^[A-Z][A-Z0-9_]{2,63}$/.test(raw) ? raw : "CAPTURE_FAILED";
    const permanent = [
      "CAPTURE_SOURCE_UNAVAILABLE",
      "CAPTURE_SOURCE_CHANGED",
      "CACHE_UNSAFE",
    ].includes(code);
    await queue.failAttempt(
      owner,
      attempt.request_id,
      code,
      attempt.attempt_id,
      permanent,
    );
    return [
      {
        request_id: attempt.request_id,
        cache_key: attempt.cache_key,
        state: permanent ? "rejected" : "deferred",
        error_code: code,
      },
    ];
  }
}
