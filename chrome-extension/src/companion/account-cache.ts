import {
  verifyPrivateAudio,
  rememberTransferredAudio,
} from "./audio-integrity.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
  statfs,
  utimes,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { desktopRecord, desktopUuid } from "../shared/desktop-protocol.js";
import {
  parseYouTubeVideoId,
  canonicalYouTubeUrl,
  isVideoId,
  MVP_MAX_DURATION_SECONDS,
  sanitizeSourceTitle,
  type PreparedAudio,
  type StartPayload,
} from "../shared/protocol.js";
import { DesktopApiError, type AccountScope } from "./account-api.js";
import {
  parseDownloadGrant,
  parseJobMetadata,
  FULL_TIMELINE_RECIPE_DIGEST,
  fullTimeline,
  type DownloadGrant,
  type JobMetadata,
} from "./cloud-provider.js";
import {
  assertCacheDirectory,
  cacheFileBytes,
  makeOfflineSpace,
} from "./cache-budget.js";
import {
  pinPlaybackHandoff,
  readPlaybackPins,
  withCacheMutation,
} from "./cache-mutator.js";
import { localToolEnvironment, type LocalConfig } from "./config.js";
import {
  MODEL_SHA256,
  LocalProcessingError,
  runBounded,
} from "./local-provider.js";
import { DesktopCatalog, type DesktopCatalogEntry } from "./desktop-catalog.js";
import type { LocalLibraryOwner } from "./sync-outbox.js";

export const ACCOUNT_CACHE_MAX_BYTES = 60 * 1024 ** 2;
export interface AccountCacheResult {
  vocal_path: string;
  duration_seconds: number;
  source_duration_seconds: number;
  cache_key: string;
  bytes: number;
  sha256: string;
  trim_enabled: boolean;
  job_id: string;
  cache_hit: boolean;
}
export interface AccountCacheOptions {
  signal: AbortSignal;
  /** Authenticated ready, full-timeline results need transfer integrity, not another decoder pass. */
  validation?: "local" | "server";
  /** Captured native generation must still belong to the active account. Void means assertion succeeded. */
  isCurrent: (scope: AccountScope) => boolean | void | Promise<boolean | void>;
  pinnedCacheKeys?: ReadonlySet<string> | (() => Promise<ReadonlySet<string>>);
  fetcher?: typeof fetch;
  catalog?: Pick<DesktopCatalog, "remember"> &
    Partial<Pick<DesktopCatalog, "discard">>;
  offline_bytes_limit?: number;
  /** Native callers already holding the cache lease may reuse that ownership. */
  withCacheMutation?: <T>(operation: () => Promise<T>) => Promise<T>;
}
interface StoredAccountAudio {
  output_path: string;
  duration_seconds: number;
  source_duration_seconds: number;
  bytes: number;
  sha256: string;
  model_id: string;
  trim_enabled: boolean;
  timings_ms: Record<string, number>;
  owner_uid: string;
  account_job_id: string;
  recipe_digest: string | null;
  validation_version: 1 | 2;
  source?: { kind: "youtube"; video_id: string };
  source_title?: string;
}

export function accountCacheKey(scope: AccountScope, job: JobMetadata): string {
  if (!job.output) throw new DesktopApiError("CLOUD_RESULT_UNAVAILABLE");
  return accountOutputCacheKey(
    scope.firebase_uid,
    job.id,
    job.output.sha256,
    job.recipe_digest,
  );
}
function accountOutputCacheKey(
  ownerUid: string,
  jobId: string,
  outputSha256: string,
  recipeDigest: string | null,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        owner_uid: ownerUid,
        job_id: jobId,
        output_sha256: outputSha256,
        recipe_digest: recipeDigest,
      }),
    )
    .digest("hex");
}

export interface ResidentAccountOptions {
  signal: AbortSignal;
  isCurrent: (
    owner: LocalLibraryOwner,
  ) => boolean | void | Promise<boolean | void>;
}
export interface ResidentAccountAudio extends PreparedAudio {
  owner_uid: string;
  account_job_id: string;
  recipe_digest: typeof FULL_TIMELINE_RECIPE_DIGEST;
  validation_version: 1 | 2;
}
function residentFence(
  owner: LocalLibraryOwner,
  options: ResidentAccountOptions,
): () => Promise<void> {
  if (
    !/^[A-Za-z0-9_.:@+-]{1,128}$/.test(owner.uid) ||
    !desktopUuid(owner.session_generation)
  )
    throw new DesktopApiError("ACCOUNT_SCOPE_INVALID");
  return async () => {
    if (options.signal.aborted) throw new DesktopApiError("CANCELLED");
    try {
      if ((await options.isCurrent({ ...owner })) === false)
        throw new DesktopApiError("ACCOUNT_CHANGED");
    } catch {
      throw new DesktopApiError("ACCOUNT_CHANGED");
    }
    if (options.signal.aborted) throw new DesktopApiError("CANCELLED");
  };
}

/** Cache-only validation. The publication caller must hold the cache lease; this function never reacquires it. */
export async function readResidentAccountYouTube(
  cacheRoot: string,
  owner: LocalLibraryOwner,
  request: Pick<StartPayload, "video_id" | "duration_seconds">,
  cacheKey: string,
  options: ResidentAccountOptions,
): Promise<ResidentAccountAudio | null> {
  request = { ...request };
  const acceptedOwner = { ...owner };
  const current = residentFence(acceptedOwner, options);
  if (
    !isVideoId(request.video_id) ||
    !Number.isFinite(request.duration_seconds) ||
    request.duration_seconds <= 0 ||
    request.duration_seconds > MVP_MAX_DURATION_SECONDS
  )
    throw new DesktopApiError("UNSUPPORTED_VIDEO");
  if (!/^[a-f0-9]{64}$/.test(cacheKey))
    throw new DesktopApiError("CACHE_UNSAFE");
  await current();
  const root = join(cacheRoot, "vocals", cacheKey);
  if (
    !(await assertCacheDirectory(cacheRoot, cacheRoot)) ||
    !(await assertCacheDirectory(cacheRoot, join(cacheRoot, "vocals"))) ||
    !(await assertCacheDirectory(cacheRoot, root))
  )
    return null;
  await assertOwnedContents(cacheRoot, root);
  let metadata: unknown;
  try {
    const file = await privateFile(join(root, "result.json"), 16 * 1024);
    try {
      metadata = JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    )
      return null;
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new DesktopApiError("CACHE_UNSAFE");
    throw error;
  }
  const path = join(root, "vocals.mp3");
  if (
    !desktopRecord(metadata) ||
    metadata.output_path !== path ||
    metadata.owner_uid !== acceptedOwner.uid ||
    typeof metadata.account_job_id !== "string" ||
    !/^[a-f0-9]{24}$/.test(metadata.account_job_id) ||
    metadata.model_id !== MODEL_SHA256 ||
    metadata.recipe_digest !== FULL_TIMELINE_RECIPE_DIGEST ||
    ![1, 2].includes(Number(metadata.validation_version)) ||
    metadata.trim_enabled !== false ||
    typeof metadata.bytes !== "number" ||
    !Number.isSafeInteger(metadata.bytes) ||
    metadata.bytes <= 0 ||
    metadata.bytes > ACCOUNT_CACHE_MAX_BYTES ||
    typeof metadata.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
    typeof metadata.duration_seconds !== "number" ||
    !Number.isFinite(metadata.duration_seconds) ||
    metadata.duration_seconds <= 0 ||
    metadata.duration_seconds > MVP_MAX_DURATION_SECONDS ||
    typeof metadata.source_duration_seconds !== "number" ||
    !Number.isFinite(metadata.source_duration_seconds) ||
    metadata.source_duration_seconds <= 0 ||
    metadata.source_duration_seconds > MVP_MAX_DURATION_SECONDS ||
    Math.abs(metadata.duration_seconds - metadata.source_duration_seconds) >
      0.25 ||
    Math.abs(metadata.source_duration_seconds - request.duration_seconds) >
      0.25 ||
    !desktopRecord(metadata.source) ||
    metadata.source.kind !== "youtube" ||
    metadata.source.video_id !== request.video_id ||
    accountOutputCacheKey(
      acceptedOwner.uid,
      metadata.account_job_id,
      Buffer.from(metadata.sha256, "hex").toString("base64"),
      FULL_TIMELINE_RECIPE_DIGEST,
    ) !== cacheKey
  )
    return null;
  if (!(await validVocalHash(path, metadata.bytes, metadata.sha256, current)))
    return null;
  await current();
  const title = sanitizeSourceTitle(metadata.source_title);
  return {
    output_path: path,
    duration_seconds: metadata.duration_seconds,
    source_duration_seconds: metadata.source_duration_seconds,
    bytes: metadata.bytes,
    sha256: metadata.sha256,
    model_id: MODEL_SHA256,
    trim_enabled: false,
    timings_ms: {},
    owner_uid: acceptedOwner.uid,
    account_job_id: metadata.account_job_id,
    recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
    validation_version: metadata.validation_version as 1 | 2,
    ...(title ? { source_title: title } : {}),
  };
}

/** Find only already resident owner vocals. No credentials, network requests, decoding, inference or audio writes. */
export async function findResidentAccountYouTube(
  config: Pick<LocalConfig, "cache_root" | "root">,
  owner: LocalLibraryOwner,
  request: { video_id: string; duration_seconds?: number },
  options: ResidentAccountOptions & {
    catalog?: Pick<DesktopCatalog, "youtubeCandidates">;
  },
): Promise<{
  cache_key: string;
  duration_seconds: number;
  source_duration_seconds: number;
  job_id: string;
  source_title?: string;
} | null> {
  request = { ...request };
  const acceptedOwner = { ...owner };
  const current = residentFence(acceptedOwner, options);
  await current();
  if (
    !isVideoId(request.video_id) ||
    (request.duration_seconds !== undefined &&
      (!Number.isFinite(request.duration_seconds) ||
        request.duration_seconds <= 0 ||
        request.duration_seconds > MVP_MAX_DURATION_SECONDS))
  )
    throw new DesktopApiError("UNSUPPORTED_VIDEO");
  const catalog =
    options.catalog ??
    new DesktopCatalog(join(config.root, "desktop-catalog"), config.cache_root);
  const candidates = await catalog.youtubeCandidates(
    acceptedOwner,
    request.video_id,
  );
  await current();
  return await withCacheMutation(config.cache_root, async () => {
    for (const candidate of candidates) {
      await current();
      const duration =
        request.duration_seconds ??
        candidate.source_duration_seconds ??
        candidate.duration_seconds;
      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > MVP_MAX_DURATION_SECONDS
      )
        continue;
      const audio = await readResidentAccountYouTube(
        config.cache_root,
        acceptedOwner,
        {
          video_id: request.video_id,
          duration_seconds: duration,
        },
        candidate.cache_key,
        options,
      );
      if (
        audio &&
        audio.account_job_id === candidate.job_id &&
        audio.sha256 === candidate.sha256 &&
        audio.bytes === candidate.bytes
      ) {
        await current();
        const title =
          sanitizeSourceTitle(candidate.source_title) ?? audio.source_title;
        return {
          cache_key: candidate.cache_key,
          duration_seconds: audio.duration_seconds,
          source_duration_seconds: audio.source_duration_seconds,
          job_id: audio.account_job_id,
          ...(title ? { source_title: title } : {}),
        };
      }
    }
    await current();
    return null;
  });
}

/** Download only an owner-issued R2 capability. No token/URL is persisted or sent to media tools. */
export async function cacheAccountResult(
  config: LocalConfig,
  scope: AccountScope,
  job: JobMetadata,
  grant: DownloadGrant,
  options: AccountCacheOptions,
): Promise<AccountCacheResult> {
  const owner: AccountScope = {
    firebase_uid: scope.firebase_uid,
    session_generation: scope.session_generation,
  };
  if (
    !/^[A-Za-z0-9_.:@+-]{1,128}$/.test(owner.firebase_uid) ||
    !desktopUuid(owner.session_generation)
  )
    throw new DesktopApiError("ACCOUNT_SCOPE_INVALID");
  job = parseJobMetadata(job);
  if (
    job.status !== "ready" ||
    !job.can_download_output ||
    !job.output ||
    job.output.bytes > ACCOUNT_CACHE_MAX_BYTES
  )
    throw new DesktopApiError("CLOUD_RESULT_UNAVAILABLE");
  grant = parseDownloadGrant(grant);
  const output = job.output;
  const sha256 = Buffer.from(output.sha256, "base64").toString("hex");
  const key = accountCacheKey(owner, job);
  const target = join(config.cache_root, "vocals", key);
  const path = join(target, "vocals.mp3");
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(180_000),
  ]);
  const current = async () => {
    if (signal.aborted)
      throw new DesktopApiError(
        options.signal.aborted ? "CANCELLED" : "ACCOUNT_DOWNLOAD_TIMEOUT",
      );
    try {
      if ((await options.isCurrent(owner)) === false)
        throw new DesktopApiError("ACCOUNT_CHANGED");
    } catch (error) {
      if (error instanceof DesktopApiError) throw error;
      throw new DesktopApiError("ACCOUNT_CHANGED");
    }
    if (signal.aborted)
      throw new DesktopApiError(
        options.signal.aborted ? "CANCELLED" : "ACCOUNT_DOWNLOAD_TIMEOUT",
      );
  };
  await current();
  try {
    const mutate =
      options.withCacheMutation ??
      (<T>(operation: () => Promise<T>) =>
        withCacheMutation(config.cache_root, operation));
    return await mutate(async () => {
      await current();
      await assertCacheDirectory(config.cache_root, config.cache_root);
      await assertCacheDirectory(
        config.cache_root,
        join(config.cache_root, "vocals"),
        true,
      );
      await assertCacheDirectory(
        config.cache_root,
        join(config.cache_root, "jobs"),
        true,
      );
      await recoverAccountAttempts(config.cache_root, current);
      const pinned = async () => {
        const keys = await readPlaybackPins(config.cache_root);
        const supplied =
          typeof options.pinnedCacheKeys === "function"
            ? await options.pinnedCacheKeys()
            : options.pinnedCacheKeys;
        for (const value of supplied ?? []) {
          if (!/^[a-f0-9]{64}$/.test(value))
            throw new DesktopApiError("CACHE_UNSAFE");
          keys.add(value);
        }
        return keys;
      };
      const cached = await readOwnedCache(
        config,
        owner,
        job,
        target,
        sha256,
        signal,
        current,
      );
      if (cached) {
        await current();
        await makeOfflineSpace(
          config.cache_root,
          0,
          target,
          await pinned(),
          budget(options),
        );
        await remember(options, owner, job, cached, key, path);
        await current();
        const accessed = new Date();
        await utimes(target, accessed, accessed);
        await pinPlaybackHandoff(config.cache_root, key);
        await current();
        return result(cached, key, job.id, true);
      }
      if ((await pinned()).has(key))
        throw new DesktopApiError("CACHE_CORRUPT_PINNED");
      // Preflight audio admission, then enforce exact audio plus manifest bytes before publication.
      await makeOfflineSpace(
        config.cache_root,
        output.bytes,
        target,
        await pinned(),
        budget(options),
      );
      const disk = await statfs(config.cache_root);
      if (disk.bavail * disk.bsize < output.bytes + 64 * 1024 ** 2)
        throw new DesktopApiError("DISK_SPACE_LOW");
      const attempt = randomUUID();
      const staging = join(config.cache_root, "jobs", `account-${attempt}`);
      await mkdir(staging, { mode: 0o700 });
      const stageIdentity = await lstat(staging);
      const markerPath = join(
        config.cache_root,
        "jobs",
        `.account-${attempt}.json`,
      );
      let markerIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
      let promoted = false;
      let adopted = false;
      try {
        await writePrivate(
          markerPath,
          Buffer.from(
            JSON.stringify({
              version: 1,
              nonce: attempt,
              pid: process.pid,
              owner_uid: owner.firebase_uid,
              job_id: job.id,
            }),
          ),
          async (file) => {
            markerIdentity = await file.stat();
          },
        );
        await syncDirectory(join(config.cache_root, "jobs"));
        const downloaded = join(staging, "vocals.mp3");
        await download(
          downloaded,
          output.bytes,
          sha256,
          grant,
          signal,
          current,
          options.fetcher ?? fetch,
        );
        // The server has already validated the exact digest and known recipe.
        // Download checks that digest while streaming; Chrome/AVPlayer performs
        // the actual playback decode. Legacy/general Library downloads retain
        // local media validation unless this explicit contract is requested.
        const serverValidated = options.validation === "server";
        if (serverValidated && !fullTimeline(job))
          throw new DesktopApiError("TIMELINE_INCOMPATIBLE");
        const duration = serverValidated
          ? (output.duration_seconds ?? job.input.duration_seconds)
          : await validateMedia(config, downloaded, job, signal, current);
        if (
          serverValidated &&
          (!Number.isFinite(duration) ||
            duration <= 0 ||
            Math.abs(duration - job.input.duration_seconds) > 0.25)
        )
          throw new DesktopApiError("TIMELINE_MISMATCH");
        const videoId =
          job.source_kind === "url" && job.source_url
            ? parseYouTubeVideoId(job.source_url)
            : null;
        const title =
          sanitizeSourceTitle(job.display_name) ??
          sanitizeSourceTitle(job.source_title);
        const metadata: StoredAccountAudio = {
          output_path: path,
          duration_seconds: duration,
          source_duration_seconds: job.input.duration_seconds,
          bytes: output.bytes,
          sha256,
          model_id:
            job.recipe_digest === FULL_TIMELINE_RECIPE_DIGEST
              ? MODEL_SHA256
              : "account-result",
          trim_enabled: job.trim_enabled,
          timings_ms: {},
          owner_uid: owner.firebase_uid,
          account_job_id: job.id,
          recipe_digest: job.recipe_digest,
          validation_version: serverValidated ? 2 : 1,
          ...(title ? { source_title: title } : {}),
          ...(videoId && job.source_url === canonicalYouTubeUrl(videoId)
            ? { source: { kind: "youtube" as const, video_id: videoId } }
            : {}),
        };
        const bytes = Buffer.from(JSON.stringify(metadata));
        if (bytes.length > 16 * 1024) throw new DesktopApiError("CACHE_UNSAFE");
        await writePrivate(join(staging, "result.json"), bytes);
        await syncDirectory(staging);
        await current();
        const pins = await pinned();
        if (pins.has(key)) throw new DesktopApiError("CACHE_CORRUPT_PINNED");
        await makeOfflineSpace(
          config.cache_root,
          output.bytes + bytes.length,
          target,
          pins,
          budget(options),
        );
        await removeOwnedTarget(config.cache_root, target);
        await current();
        await rename(staging, target);
        promoted = true;
        await syncDirectory(join(config.cache_root, "vocals"));
        await current();
        await remember(options, owner, job, metadata, key, path);
        await current();
        await pinPlaybackHandoff(config.cache_root, key);
        await current();
        adopted = true;
        return result(metadata, key, job.id, false);
      } finally {
        if (promoted && !adopted) {
          const named = await lstat(target).catch(() => null);
          if (
            named &&
            named.ino === stageIdentity.ino &&
            named.dev === stageIdentity.dev
          ) {
            await removeOwnedTarget(config.cache_root, target);
            await options.catalog?.discard?.(
              {
                uid: owner.firebase_uid,
                session_generation: owner.session_generation,
              },
              key,
              sha256,
            );
          }
        }
        if (!promoted) {
          const named = await lstat(staging).catch(() => null);
          if (
            named &&
            named.ino === stageIdentity.ino &&
            named.dev === stageIdentity.dev
          )
            await rm(staging, { recursive: true, force: true });
        }
        const marker = await lstat(markerPath).catch(() => null);
        if (
          marker &&
          markerIdentity &&
          marker.ino === markerIdentity.ino &&
          marker.dev === markerIdentity.dev
        )
          await unlink(markerPath);
      }
    });
  } catch (error) {
    if (error instanceof DesktopApiError) throw error;
    if (error instanceof LocalProcessingError)
      throw new DesktopApiError(
        error.code === "CANCELLED" ? "CANCELLED" : "ACCOUNT_AUDIO_INVALID",
      );
    const code =
      error instanceof Error &&
      [
        "CACHE_UNSAFE",
        "LOCAL_COMPANION_BUSY",
        "OFFLINE_CACHE_FULL",
        "CACHE_LIMIT_INVALID",
      ].includes(error.message)
        ? error.message
        : "ACCOUNT_CACHE_FAILED";
    throw new DesktopApiError(code);
  }
}
function budget(options: AccountCacheOptions) {
  return options.offline_bytes_limit === undefined
    ? {}
    : { limit_bytes: options.offline_bytes_limit };
}
function result(
  metadata: StoredAccountAudio,
  key: string,
  id: string,
  hit: boolean,
): AccountCacheResult {
  return {
    vocal_path: metadata.output_path,
    duration_seconds: metadata.duration_seconds,
    source_duration_seconds: metadata.source_duration_seconds,
    cache_key: key,
    bytes: metadata.bytes,
    sha256: metadata.sha256,
    trim_enabled: metadata.trim_enabled,
    job_id: id,
    cache_hit: hit,
  };
}
async function remember(
  options: AccountCacheOptions,
  owner: AccountScope,
  job: JobMetadata,
  metadata: StoredAccountAudio,
  key: string,
  path: string,
) {
  if (!options.catalog) return;
  const title =
    sanitizeSourceTitle(job.display_name) ??
    sanitizeSourceTitle(job.source_title);
  const entry: DesktopCatalogEntry = {
    cache_key: key,
    operation_id: job.id,
    job_id: job.id,
    source_kind: job.source_kind ?? "file",
    vocal_path: path,
    duration_seconds: metadata.duration_seconds,
    source_duration_seconds: metadata.source_duration_seconds,
    trim_enabled: metadata.trim_enabled,
    bytes: metadata.bytes,
    sha256: metadata.sha256,
    ...(metadata.source ? { video_id: metadata.source.video_id } : {}),
    ...(title ? { source_title: title } : {}),
  };
  await options.catalog.remember(
    { uid: owner.firebase_uid, session_generation: owner.session_generation },
    entry,
  );
}
async function download(
  path: string,
  bytes: number,
  digest: string,
  grant: DownloadGrant,
  signal: AbortSignal,
  current: () => Promise<void>,
  fetcher: typeof fetch,
) {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const abort = () => {
    void reader?.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await current();
    try {
      response = await fetcher(grant.url, {
        method: "GET",
        redirect: "error",
        signal,
        headers: { Accept: "audio/mpeg", "Accept-Encoding": "identity" },
      });
    } catch {
      await current();
      throw new DesktopApiError("ACCOUNT_DOWNLOAD_UNAVAILABLE");
    }
    await current();
    if (
      response.status !== 200 ||
      response.redirected ||
      !response.body ||
      !/^audio\/mpeg(?:;|$)/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      ![null, "identity"].includes(response.headers.get("content-encoding"))
    ) {
      await response.body?.cancel();
      throw new DesktopApiError("ACCOUNT_DOWNLOAD_INVALID");
    }
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^[0-9]{1,10}$/.test(length) || Number(length) !== bytes)
    ) {
      await response.body.cancel();
      throw new DesktopApiError("ACCOUNT_DOWNLOAD_LENGTH_MISMATCH");
    }
    const hash = createHash("sha256");
    let received = 0;
    reader = response.body.getReader();
    while (true) {
      await current();
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.length;
      if (received > bytes)
        throw new DesktopApiError("ACCOUNT_DOWNLOAD_LENGTH_MISMATCH");
      hash.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.length) {
        const written = await file.write(
          chunk.value,
          offset,
          chunk.value.length - offset,
        );
        if (written.bytesWritten <= 0)
          throw new DesktopApiError("ACCOUNT_CACHE_FAILED");
        offset += written.bytesWritten;
      }
    }
    await current();
    if (received !== bytes)
      throw new DesktopApiError("ACCOUNT_DOWNLOAD_LENGTH_MISMATCH");
    if (hash.digest("hex") !== digest)
      throw new DesktopApiError("ACCOUNT_DOWNLOAD_CHECKSUM_MISMATCH");
    await file.sync();
    await rememberTransferredAudio(file, path, bytes, digest);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    if (!reader) await response?.body?.cancel().catch(() => {});
    await file.close();
  }
}
async function privateFile(path: string, maximum: number): Promise<FileHandle> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat(),
      named = await lstat(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > maximum ||
      named.isSymbolicLink() ||
      info.ino !== named.ino ||
      info.dev !== named.dev
    )
      throw new DesktopApiError("CACHE_UNSAFE");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
async function validVocalHash(
  path: string,
  bytes: number,
  digest: string,
  current: () => Promise<void>,
): Promise<boolean> {
  try {
    return await verifyPrivateAudio(path, bytes, digest, current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw new DesktopApiError("CACHE_UNSAFE");
    throw error;
  }
}
async function readOwnedCache(
  config: LocalConfig,
  owner: AccountScope,
  job: JobMetadata,
  root: string,
  digest: string,
  signal: AbortSignal,
  current: () => Promise<void>,
): Promise<StoredAccountAudio | null> {
  if (!(await assertCacheDirectory(config.cache_root, root))) return null;
  await assertOwnedContents(config.cache_root, root);
  let metadata: unknown;
  try {
    const file = await privateFile(join(root, "result.json"), 16 * 1024);
    try {
      metadata = JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    )
      return null;
    throw error;
  }
  const path = join(root, "vocals.mp3");
  if (
    !desktopRecord(metadata) ||
    metadata.output_path !== path ||
    metadata.owner_uid !== owner.firebase_uid ||
    metadata.account_job_id !== job.id ||
    metadata.recipe_digest !== job.recipe_digest ||
    metadata.sha256 !== digest ||
    metadata.bytes !== job.output!.bytes ||
    metadata.trim_enabled !== job.trim_enabled ||
    ![1, 2].includes(Number(metadata.validation_version)) ||
    metadata.source_duration_seconds !== job.input.duration_seconds ||
    typeof metadata.duration_seconds !== "number" ||
    !Number.isFinite(metadata.duration_seconds) ||
    metadata.duration_seconds <= 0 ||
    metadata.duration_seconds > 1800.25 ||
    (!job.trim_enabled &&
      Math.abs(metadata.duration_seconds - job.input.duration_seconds) >
        0.25) ||
    (job.trim_enabled &&
      metadata.duration_seconds > job.input.duration_seconds + 0.25) ||
    (job.output!.duration_seconds !== null &&
      Math.abs(metadata.duration_seconds - job.output!.duration_seconds) > 0.25)
  )
    return null;
  if (
    metadata.model_id !==
    (job.recipe_digest === FULL_TIMELINE_RECIPE_DIGEST
      ? MODEL_SHA256
      : "account-result")
  )
    return null;
  const videoId =
    job.source_kind === "url" && job.source_url
      ? parseYouTubeVideoId(job.source_url)
      : null;
  if (
    videoId
      ? !desktopRecord(metadata.source) ||
        metadata.source.kind !== "youtube" ||
        metadata.source.video_id !== videoId
      : metadata.source !== undefined
  )
    return null;
  try {
    if (!(await validVocalHash(path, job.output!.bytes, digest, current)))
      return null;
    await current();
    return metadata as unknown as StoredAccountAudio;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (
      error instanceof DesktopApiError &&
      error.code === "ACCOUNT_AUDIO_INVALID"
    )
      return null;
    throw error;
  }
}
async function validateMedia(
  config: LocalConfig,
  path: string,
  job: JobMetadata,
  signal: AbortSignal,
  current: () => Promise<void>,
): Promise<number> {
  await current();
  const probe = await runBounded(
    config.ffprobe_path,
    [
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-show_entries",
      "format=format_name,duration:stream=codec_name,codec_type,sample_rate,channels",
      "-of",
      "json",
      path,
    ],
    {
      signal,
      timeout_ms: 30_000,
      max_output_bytes: 64 * 1024,
      env: localToolEnvironment(config),
    },
  );
  let value: unknown;
  try {
    value = JSON.parse(probe.stdout);
  } catch {
    throw new DesktopApiError("ACCOUNT_AUDIO_INVALID");
  }
  if (
    !desktopRecord(value) ||
    !desktopRecord(value.format) ||
    !Array.isArray(value.streams) ||
    value.streams.length !== 1 ||
    !desktopRecord(value.streams[0]) ||
    value.format.format_name !== "mp3" ||
    value.streams[0].codec_name !== "mp3" ||
    value.streams[0].codec_type !== "audio" ||
    ![1, 2].includes(Number(value.streams[0].channels)) ||
    ![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(
      Number(value.streams[0].sample_rate),
    )
  )
    throw new DesktopApiError("ACCOUNT_AUDIO_INVALID");
  const duration = Number(value.format.duration);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 1800.25 ||
    (!job.trim_enabled &&
      Math.abs(duration - job.input.duration_seconds) > 0.25) ||
    (job.trim_enabled && duration > job.input.duration_seconds + 0.25) ||
    (job.output!.duration_seconds !== null &&
      Math.abs(duration - job.output!.duration_seconds) > 0.25)
  )
    throw new DesktopApiError("ACCOUNT_AUDIO_INVALID");
  await current();
  await runBounded(
    config.ffmpeg_path,
    [
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-err_detect",
      "explode",
      "-protocol_whitelist",
      "file",
      "-i",
      path,
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
      signal,
      timeout_ms: 60_000,
      max_output_bytes: 1024,
      env: localToolEnvironment(config),
    },
  );
  // Validate the bytes again after tools close, so a changed local path cannot publish trusted metadata.
  const file = await privateFile(path, ACCOUNT_CACHE_MAX_BYTES);
  try {
    const before = await file.stat();
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      await current();
      hash.update(chunk);
    }
    const after = await file.stat();
    if (
      before.size !== job.output!.bytes ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      hash.digest("base64") !== job.output!.sha256
    )
      throw new DesktopApiError("ACCOUNT_DOWNLOAD_CHECKSUM_MISMATCH");
  } finally {
    await file.close();
  }
  await current();
  return duration;
}
async function writePrivate(
  path: string,
  bytes: Buffer,
  onCreated?: (file: FileHandle) => Promise<void>,
) {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await onCreated?.(file);
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string) {
  const file = await open(path, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function assertOwnedContents(cacheRoot: string, path: string) {
  for (const name of await readdir(path)) {
    if (!["vocals.mp3", "result.json"].includes(name))
      throw new DesktopApiError("CACHE_UNSAFE");
    await cacheFileBytes(cacheRoot, join(path, name));
  }
}
async function removeOwnedTarget(cacheRoot: string, path: string) {
  if (!(await assertCacheDirectory(cacheRoot, path))) return;
  await assertOwnedContents(cacheRoot, path);
  await rm(path, { recursive: true, force: true });
}

async function recoverAccountAttempts(
  cacheRoot: string,
  current: () => Promise<void>,
): Promise<void> {
  const jobs = join(cacheRoot, "jobs");
  const names = await readdir(jobs);
  if (names.length > 4096) throw new DesktopApiError("CACHE_UNSAFE");
  for (const name of names) {
    if (
      !/^\.account-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/.test(
        name,
      )
    )
      continue;
    await current();
    const nonce = name.slice(9, -5);
    const path = join(jobs, `account-${nonce}`);
    const markerPath = join(jobs, name);
    let file: FileHandle;
    try {
      file = await privateFile(markerPath, 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const markerIdentity = await file.stat();
    let marker: unknown;
    try {
      marker = JSON.parse(await file.readFile("utf8"));
    } catch {
      throw new DesktopApiError("CACHE_UNSAFE");
    } finally {
      await file.close();
    }
    if (
      !desktopRecord(marker) ||
      Object.keys(marker).some(
        (key) =>
          !["version", "nonce", "pid", "owner_uid", "job_id"].includes(key),
      ) ||
      marker.version !== 1 ||
      marker.nonce !== nonce ||
      !Number.isSafeInteger(marker.pid) ||
      Number(marker.pid) < 1 ||
      typeof marker.owner_uid !== "string" ||
      !/^[A-Za-z0-9_.:@+-]{1,128}$/.test(marker.owner_uid) ||
      typeof marker.job_id !== "string" ||
      !/^[a-f0-9]{24}$/.test(marker.job_id)
    )
      throw new DesktopApiError("CACHE_UNSAFE");
    try {
      process.kill(Number(marker.pid), 0);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    const exists = await assertCacheDirectory(cacheRoot, path);
    const identity = exists ? await lstat(path) : null;
    if (exists)
      for (const child of await readdir(path)) {
        if (!["vocals.mp3", "result.json"].includes(child))
          throw new DesktopApiError("CACHE_UNSAFE");
        await cacheFileBytes(cacheRoot, join(path, child));
      }
    await current();
    if (identity) {
      const named = await lstat(path);
      if (named.ino !== identity.ino || named.dev !== identity.dev)
        throw new DesktopApiError("CACHE_UNSAFE");
      await rm(path, { recursive: true, force: true });
    }
    const markerNamed = await lstat(markerPath);
    if (
      markerNamed.ino !== markerIdentity.ino ||
      markerNamed.dev !== markerIdentity.dev
    )
      throw new DesktopApiError("CACHE_UNSAFE");
    await unlink(markerPath);
  }
}
