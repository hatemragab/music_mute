import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  desktopRecord,
  type DesktopEvent,
  type DesktopRequest,
  type DesktopSource,
} from "../shared/desktop-protocol.js";
import {
  parseYouTubeVideoId,
  MVP_MAX_DURATION_SECONDS,
  isLocalAudioDeclaration,
  sanitizeSourceTitle,
  type JobSnapshot,
  type PreparedAudio,
  type ProcessingProvider,
  type StartPayload,
} from "../shared/protocol.js";
import { AccountApiClient, DesktopApiError } from "./account-api.js";
import type { AccountTransport } from "./account-realtime.js";
import {
  ACCOUNT_RESTORE_DEADLINE_MS,
  AccountCacheRestoreQueue,
} from "./account-cache-restore.js";
import { privateDirectory } from "./app-setup.js";
import {
  assertCacheDirectory,
  makeOfflineSpace,
  offlineCacheBytes,
} from "./cache-budget.js";
import {
  readOfflineCacheBudget,
  writeOfflineCacheBudget,
} from "./cache-settings.js";
import {
  withCacheMutation,
  readPlaybackPins,
  pinPlaybackHandoff,
} from "./cache-mutator.js";
import { CloudProcessingProvider, type CloudResult } from "./cloud-provider.js";
import type { LocalConfig } from "./config.js";
import { DesktopCatalog } from "./desktop-catalog.js";
import { Diagnostics } from "./diagnostics.js";
import { resolveDiagnosticIdentity } from "./diagnostic-identity.js";
import {
  FileLocalProvider,
  prepareDesktopFile,
  probeDesktopAudio,
  recoverDesktopFileStages,
  type DesktopFileSource,
} from "./file-provider.js";
import { JobManager, localCacheKey } from "./jobs.js";
import { recoverJobWorkspaces } from "./job-workspace.js";
import {
  cacheAccountResult,
  findResidentAccountYouTube,
} from "./account-cache.js";
import {
  LocalMacProvider,
  LocalProcessingError,
  MODEL_SHA256,
  runBounded,
} from "./local-provider.js";
import { LocalPairSyncClient, type SyncOutcome } from "./local-sync-client.js";
import { prepareOriginalPlayback } from "./original-playback.js";
import { LocalSyncCaptureQueue } from "./local-sync-capture.js";
import { prepareOneWarmCapture } from "./warm-local-sync.js";
import { MediaServer } from "./media-server.js";
import { MacGuestCredentialStore } from "./guest-credentials.js";
import { YouTubeCommunityClient } from "./youtube-community-client.js";
import { SharedYouTubeProvider } from "./youtube-community-provider.js";
import { YouTubeCommunityOutbox } from "./youtube-community-outbox.js";
import { startCommunityPublisher } from "./community-publisher.js";
import {
  LocalSyncOutbox,
  preserveLocalPairRecovery,
  retainLocalPairRecoverySource,
  type LocalLibraryOwner,
  type LocalSyncStage,
} from "./sync-outbox.js";

export interface DesktopDependencies {
  isCurrent: (owner?: LocalLibraryOwner) => boolean;
  verifyCurrent?: (owner?: LocalLibraryOwner) => Promise<boolean>;
  fetcher?: typeof fetch;
  localProvider?: ProcessingProvider;
  communityClient?: () => Promise<YouTubeCommunityClient>;
  inspectYouTube?: (
    id: string,
    signal: AbortSignal,
  ) => Promise<{ duration_seconds: number; source_title?: string }>;
  acquireYouTube?: LocalMacProvider["acquireYouTube"];
}
export function safeDesktopCode(error: unknown): string {
  const value =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : "DESKTOP_OPERATION_FAILED";
  return /^[A-Z][A-Z0-9_]{2,63}$/.test(value)
    ? value
    : "DESKTOP_OPERATION_FAILED";
}
type RetainedLocalAudio = PreparedAudio & { owner_uid?: string };
async function readRetained(path: string): Promise<RetainedLocalAudio | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size > 16384
    )
      throw new Error("CACHE_UNSAFE");
    return JSON.parse(await file.readFile("utf8")) as RetainedLocalAudio;
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    )
      return null;
    throw error;
  } finally {
    await file?.close();
  }
}

async function verifyPrivateSnapshot(
  path: string,
  bytes: number,
  sha256: string,
  signal: AbortSignal,
): Promise<void> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat(),
      named = await lstat(path);
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
      throw new Error("SOURCE_IDENTITY_MISMATCH");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      if (signal.aborted) throw new DesktopApiError("CANCELLED");
      hash.update(chunk);
    }
    const after = await file.stat(),
      current = await lstat(path);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      current.isSymbolicLink() ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      hash.digest("hex") !== sha256
    )
      throw new Error("SOURCE_IDENTITY_MISMATCH");
  } finally {
    await file.close();
  }
}

/** Requires the cache lease and a newly copied native file selection. */
async function warmFilePair(
  config: LocalConfig,
  owner: LocalLibraryOwner,
  cacheKey: string,
  selected: DesktopFileSource,
  audio: RetainedLocalAudio,
  signal: AbortSignal,
  title?: string,
): Promise<LocalSyncStage> {
  const declaration = audio.original_declaration,
    output = join(config.cache_root, "vocals", cacheKey, "vocals.mp3");
  if (
    audio.owner_uid !== owner.uid ||
    audio.source !== undefined ||
    audio.model_id !== MODEL_SHA256 ||
    audio.trim_enabled !== false ||
    audio.output_path !== output ||
    !Number.isSafeInteger(audio.bytes) ||
    audio.bytes <= 0 ||
    audio.bytes > 30 * 1024 ** 2 ||
    !/^[a-f0-9]{64}$/.test(audio.sha256) ||
    !Number.isFinite(audio.duration_seconds) ||
    audio.duration_seconds <= 0 ||
    audio.duration_seconds > MVP_MAX_DURATION_SECONDS + 0.25 ||
    !Number.isFinite(audio.source_duration_seconds) ||
    audio.source_duration_seconds <= 0 ||
    audio.source_duration_seconds > MVP_MAX_DURATION_SECONDS ||
    Math.abs(audio.duration_seconds - audio.source_duration_seconds) > 0.25 ||
    !isLocalAudioDeclaration(declaration, audio.source_duration_seconds)
  )
    throw new Error("SOURCE_IDENTITY_MISMATCH");
  if (
    declaration.sha256 !== selected.sha256 ||
    declaration.bytes !== selected.bytes ||
    declaration.extension !== selected.extension ||
    declaration.content_type !== selected.content_type ||
    Math.abs(declaration.duration_seconds - selected.duration_seconds) > 0.25
  )
    throw new Error("SOURCE_IDENTITY_MISMATCH");
  await assertCacheDirectory(config.cache_root, selected.root);
  await assertCacheDirectory(
    config.cache_root,
    join(config.cache_root, "vocals", cacheKey),
  );
  await verifyPrivateSnapshot(
    selected.input_path,
    selected.bytes,
    selected.sha256,
    signal,
  );
  await verifyPrivateSnapshot(output, audio.bytes, audio.sha256, signal);
  return {
    owner: { ...owner },
    request_id: basename(selected.root),
    cache_key: cacheKey,
    original: {
      path: selected.input_path,
      extension: selected.extension,
      content_type: selected.content_type,
      bytes: selected.bytes,
      duration_seconds: selected.duration_seconds,
      sha256: selected.sha256,
    },
    vocals: {
      path: output,
      extension: "mp3",
      content_type: "audio/mpeg",
      bytes: audio.bytes,
      duration_seconds: audio.duration_seconds,
      sha256: audio.sha256,
    },
    ...(title ? { title } : {}),
  };
}
export async function publicApiOrigin(config: LocalConfig): Promise<string> {
  if (!config.app_resources)
    throw new DesktopApiError("APP_RESOURCES_REQUIRED");
  const path = join(config.app_resources, "desktop-public-config.json");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new DesktopApiError("ACCOUNT_NOT_CONFIGURED");
  });
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 16384 ||
      info.mode & 0o022
    )
      throw new DesktopApiError("ACCOUNT_CONFIG_INVALID");
    const raw: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!desktopRecord(raw) || typeof raw.backend_base_url !== "string")
      throw new DesktopApiError("ACCOUNT_CONFIG_INVALID");
    return raw.backend_base_url;
  } finally {
    await handle.close();
  }
}
export { offlineCacheBytes } from "./cache-budget.js";

/** One bounded native command. Credentials never enter files, args, browser messages or diagnostics. */
export async function executeDesktopRequest(
  config: LocalConfig,
  request: DesktopRequest,
  emit: (event: DesktopEvent) => void,
  signal: AbortSignal,
  dependencies: DesktopDependencies,
): Promise<Record<string, unknown>> {
  const owner = request.session
    ? {
        uid: request.session.firebase_uid,
        session_generation: request.session.session_generation,
      }
    : undefined;
  const assertCurrent = () => {
    if (!dependencies.isCurrent(owner))
      throw new DesktopApiError("ACCOUNT_CHANGED");
    if (signal.aborted) throw new DesktopApiError("CANCELLED");
  };
  assertCurrent();
  const verifyCurrent = async () => {
    if (
      dependencies.verifyCurrent &&
      !(await dependencies.verifyCurrent(owner))
    )
      throw new DesktopApiError("ACCOUNT_CHANGED");
    assertCurrent();
  };
  await verifyCurrent();
  const catalog = new DesktopCatalog(
    join(config.root, "desktop-catalog"),
    config.cache_root,
  );
  const outbox = new LocalSyncOutbox(
    join(config.root, "sync-outbox"),
    config.cache_root,
  );
  const communityOutbox = new YouTubeCommunityOutbox(
    join(config.root, "youtube-community-outbox"),
    dependencies.fetcher,
  );
  const communityClient =
    dependencies.communityClient ??
    (async () =>
      new YouTubeCommunityClient(
        await publicApiOrigin(config),
        new MacGuestCredentialStore(config),
        dependencies.fetcher,
      ));
  const captures = new LocalSyncCaptureQueue(
    join(config.root, "sync-captures"),
    config.cache_root,
  );
  const restores = new AccountCacheRestoreQueue(
    join(config.root, "cache-restores"),
  );
  const diagnostics = new Diagnostics(join(config.logs_root, "desktop"), {
    identity: resolveDiagnosticIdentity(config),
  });
  diagnostics.record({
    component: "companion",
    severity: "info",
    event: "companion_started",
    request_id: request.request_id,
  });
  const progress = (stage: string, completed?: number, total?: number) => {
    assertCurrent();
    diagnostics.record({
      component: "companion",
      severity: "info",
      event: "job_progress",
      request_id: request.request_id,
      metrics: {
        stage,
        ...(completed === undefined ? {} : { progress_completed: completed }),
        ...(total === undefined ? {} : { progress_total: total }),
      },
    });
    emit({
      protocol_version: 1,
      request_id: request.request_id,
      type: "progress",
      payload: {
        stage: stage.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64),
        ...(completed === undefined ? {} : { completed }),
        ...(total === undefined ? {} : { total }),
      },
    });
  };
  const pinned = async () =>
    new Set([
      ...(await outbox.pinnedCacheKeys()),
      ...(await captures.pinnedCacheKeys()),
      ...(await readPlaybackPins(config.cache_root)),
    ]);
  let api: AccountApiClient | undefined;
  const accountApi = async () => {
    assertCurrent();
    if (!request.session?.id_token || !owner)
      throw new DesktopApiError("ACCOUNT_REQUIRED");
    api ??= new AccountApiClient(
      await publicApiOrigin(config),
      async () => {
        await verifyCurrent();
        return request.session!;
      },
      (scope) =>
        dependencies.isCurrent({
          uid: scope.firebase_uid,
          session_generation: scope.session_generation,
        }),
      dependencies.fetcher,
    );
    return api;
  };
  let cloud: CloudProcessingProvider | undefined;
  const cloudProvider = async () => {
    const transport = await accountApi();
    cloud ??= new CloudProcessingProvider({
      api: transport,
      scope: request.session!,
      signal,
      onProgress: (value) =>
        progress(`cloud_${value.phase}_${value.status ?? ""}`),
    });
    return cloud;
  };
  let selected: DesktopFileSource | undefined;
  let retainedSelectedRecovery = false;
  try {
    await privateDirectory(config.cache_root);
    await withCacheMutation(config.cache_root, async () => {
      await recoverDesktopFileStages(config.cache_root);
      await recoverJobWorkspaces(config.cache_root);
    });
    await outbox.recover();
    await captures.recover();
    if (request.type === "SET_CACHE_BUDGET") {
      return await withCacheMutation(config.cache_root, async () => {
        assertCurrent();
        const cache_bytes = await offlineCacheBytes(config.cache_root);
        assertCurrent();
        await writeOfflineCacheBudget(
          config.cache_root,
          request.payload.budget_bytes,
        );
        assertCurrent();
        return { cache_bytes, budget_bytes: request.payload.budget_bytes };
      });
    }
    if (request.type === "CLEAR_CACHE") {
      const cleared = await withCacheMutation(config.cache_root, async () => {
        assertCurrent();
        const protectedKeys = await pinned();
        assertCurrent();
        const usage = await makeOfflineSpace(
          config.cache_root,
          0,
          undefined,
          protectedKeys,
          {
            clear: true,
            onEvicted: (bytes) =>
              diagnostics.record({
                component: "companion",
                severity: "info",
                event: "cache_evicted",
                request_id: request.request_id,
                metrics: { cache_bytes: bytes },
              }),
          },
        );
        return {
          ...usage,
          budget_bytes: await readOfflineCacheBudget(config.cache_root),
        };
      });
      assertCurrent();
      return {
        cleared_entries: cleared.evicted_entries,
        cache_bytes: cleared.bytes,
        budget_bytes: cleared.budget_bytes,
      };
    }
    if (request.type === "LIBRARY_CACHE") {
      const page = await catalog.list(
        owner,
        request.payload.cursor,
        request.payload.limit ?? 50,
      );
      const cache_bytes = await offlineCacheBytes(config.cache_root);
      const budget_bytes = await readOfflineCacheBudget(config.cache_root);
      assertCurrent();
      return {
        items: page.entries,
        total: page.total,
        next_cursor: page.next_cursor ?? null,
        cache_bytes,
        budget_bytes,
      };
    }
    if (request.type === "LIBRARY_ORIGINAL_PLAYBACK") {
      const transport = await accountApi();
      const result = await prepareOriginalPlayback(
        config,
        transport,
        request.session!,
        request.payload.job_id,
        signal,
        dependencies.fetcher ? { fetcher: dependencies.fetcher } : {},
      );
      await verifyCurrent();
      return result;
    }
    if (request.type === "SYNC") {
      const transport = await accountApi();
      const ownerLinkItems: SyncOutcome[] = [];
      if (
        (await communityOutbox.records()).some(
          (record) => record.state === "pending",
        )
      )
        await communityOutbox
          .drain(await communityClient(), signal)
          .catch(() => {});
      for (const link of await communityOutbox.ownerLinks(owner!)) {
        if (
          link.state === "completed" ||
          Date.parse(link.expires_at) <= Date.now()
        )
          continue;
        try {
          await verifyCurrent();
          const shared = await (
            await cloudProvider()
          ).findReusableYouTube(link.video_id, link.duration_seconds);
          await verifyCurrent();
          if (
            shared &&
            shared.output?.sha256 ===
              Buffer.from(link.sha256, "hex").toString("base64")
          ) {
            await catalog.attachJob(
              owner!,
              link.cache_key,
              shared.id,
              link.sha256,
            );
            await verifyCurrent();
            await communityOutbox.finishOwnerLink(owner!, link, true);
            ownerLinkItems.push({
              request_id: link.request_id,
              cache_key: link.cache_key,
              state: "ready",
              job_id: shared.id,
            });
          } else await communityOutbox.finishOwnerLink(owner!, link, false);
        } catch (error) {
          assertCurrent();
          await communityOutbox
            .finishOwnerLink(owner!, link, false)
            .catch(() => {});
          diagnostics.record({
            component: "companion",
            severity: "warning",
            event: "diagnostic_error",
            code: safeDesktopCode(error),
          });
        }
      }
      const restore = await restores.claimOne(owner!);
      assertCurrent();
      if (restore) {
        const attemptSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(
            Math.max(
              1,
              Math.min(
                ACCOUNT_RESTORE_DEADLINE_MS,
                restore.expires_at - Date.now(),
              ),
            ),
          ),
        ]);
        const active = async () => {
          await verifyCurrent();
          if (attemptSignal.aborted || Date.now() >= restore.expires_at)
            throw new DesktopApiError("CANCELLED");
          await restores.assertActive(restore);
          await verifyCurrent();
          if (attemptSignal.aborted || Date.now() >= restore.expires_at)
            throw new DesktopApiError("CANCELLED");
        };
        const restoreTransport: AccountTransport = {
          origin: transport.origin,
          assertCurrent: (scope) => {
            transport.assertCurrent(scope);
            assertCurrent();
            if (attemptSignal.aborted || Date.now() >= restore.expires_at)
              throw new DesktopApiError("CANCELLED");
          },
          request: async (scope, path, method, body, requestSignal) => {
            await active();
            const value = await transport.request(
              scope,
              path,
              method,
              body,
              requestSignal
                ? AbortSignal.any([attemptSignal, requestSignal])
                : attemptSignal,
            );
            await active();
            return value;
          },
        };
        const remote = new CloudProcessingProvider({
          api: restoreTransport,
          scope: request.session!,
          signal: attemptSignal,
          onProgress: (value) => progress(`account_restore_${value.phase}`),
        });
        try {
          await active();
          const reusable = await remote.findReusableYouTube(
            restore.video_id,
            restore.duration_seconds,
          );
          await active();
          if (reusable) {
            const result = await remote.downloadJob(reusable.id, {
              video_id: restore.video_id,
              duration_seconds: restore.duration_seconds,
            });
            await active();
            if (!result.download_grant)
              throw new DesktopApiError("CLOUD_RESULT_UNAVAILABLE");
            const cached = await cacheAccountResult(
              config,
              request.session!,
              result.job,
              result.download_grant,
              {
                signal: attemptSignal,
                isCurrent: active,
                pinnedCacheKeys: pinned,
                catalog,
                ...(dependencies.fetcher
                  ? { fetcher: dependencies.fetcher }
                  : {}),
              },
            );
            await active();
            await restores.complete(restore, {
              state: "ready",
              cache_key: cached.cache_key,
              job_id: cached.job_id,
            });
          } else await restores.complete(restore, { state: "missing" });
        } catch (error) {
          assertCurrent();
          try {
            await restores.complete(restore, { state: "deferred" });
          } catch (completionError) {
            if (safeDesktopCode(completionError) !== "CANCELLED")
              diagnostics.record({
                component: "companion",
                severity: "warning",
                event: "diagnostic_error",
                code: safeDesktopCode(completionError),
              });
          }
          diagnostics.record({
            component: "companion",
            severity: "warning",
            event: "diagnostic_error",
            code: safeDesktopCode(error),
          });
        } finally {
          remote.close();
        }
      }
      const transfer = new LocalPairSyncClient(
        transport,
        outbox,
        dependencies.fetcher,
        verifyCurrent,
      );
      const existing = new Set(
        (await outbox.list(owner!)).map((record) => record.request_id),
      );
      // Release confirmed pending originals before admitting a warm-cache capture.
      const uploaded = await transfer.savePending(request.session!, signal);
      const captureItems = await prepareOneWarmCapture(
        config,
        owner!,
        captures,
        outbox,
        {
          verifyCurrent,
          hooks: {
            signal,
            onProgress: (stage, completed, total) =>
              progress(`account_source_${stage}`, completed, total),
            onDiagnostic: (event) => diagnostics.record(event),
          },
          ...(dependencies.acquireYouTube
            ? { acquire: dependencies.acquireYouTube }
            : {}),
        },
      );
      const added = new Set(
        (await outbox.list(owner!))
          .filter((record) => !existing.has(record.request_id))
          .map((record) => record.request_id),
      );
      const newlyUploaded = added.size
        ? await transfer.savePending(request.session!, signal, added)
        : [];
      const items = [
        ...ownerLinkItems,
        ...captureItems,
        ...uploaded,
        ...newlyUploaded,
      ];
      assertCurrent();
      for (const record of await outbox.list(owner!))
        if (record.receipt)
          await catalog.attachJob(
            owner!,
            record.cache_key,
            record.receipt.job_id,
          );
      const pending_count =
        (await outbox.list(owner!)).filter((item) => item.state !== "committed")
          .length +
        (await captures.list(owner!)).filter((item) =>
          ["pending", "capturing", "deferred"].includes(item.state),
        ).length +
        (await communityOutbox.ownerLinks(owner!)).filter(
          (link) =>
            link.state !== "completed" &&
            Date.parse(link.expires_at) > Date.now(),
        ).length;
      const capture_more_pending = (await captures.list(owner!)).some(
        (item) => item.state === "pending",
      );
      const cache_restore_more_pending = await restores.hasPending(owner!);
      assertCurrent();
      return {
        items,
        pending_count,
        capture_more_pending,
        cache_restore_more_pending,
      };
    }
    const source: DesktopSource | undefined =
      request.type === "LOCAL_START" || request.type === "CLOUD_START"
        ? request.payload
        : undefined;
    const videoId =
      source?.source_kind === "url"
        ? parseYouTubeVideoId(source.youtube_url)!
        : undefined;
    let sourceDigest: string | undefined;
    let duration = 0;
    const explicitTitle = sanitizeSourceTitle(source?.source_title);
    let title = explicitTitle;
    let provider: ProcessingProvider;
    let resident: Awaited<ReturnType<typeof findResidentAccountYouTube>> = null;
    const media = new MediaServer("chrome-extension://" + "a".repeat(32));
    const cacheCloudResult = async (
      result: CloudResult,
    ): Promise<Record<string, unknown>> => {
      if (!result.download_grant)
        throw new DesktopApiError("CLOUD_RESULT_UNAVAILABLE");
      await verifyCurrent();
      const cached = await cacheAccountResult(
        config,
        request.session!,
        result.job,
        result.download_grant,
        {
          signal,
          isCurrent: async () => {
            await verifyCurrent();
          },
          pinnedCacheKeys: pinned,
          catalog,
          ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
        },
      );
      assertCurrent();
      const resultTitle =
        title ??
        sanitizeSourceTitle(result.job.display_name) ??
        sanitizeSourceTitle(result.job.source_title);
      const resultVideoId =
        videoId ??
        (result.job.source_url && result.job.source_kind !== "file"
          ? parseYouTubeVideoId(result.job.source_url)
          : undefined);
      return {
        ...cached,
        operation_id: request.request_id,
        sync_state: "ready",
        ...(resultVideoId ? { video_id: resultVideoId } : {}),
        ...(resultTitle ? { source_title: resultTitle } : {}),
      };
    };
    if (request.type === "LIBRARY_DOWNLOAD") {
      return await cacheCloudResult(
        await (await cloudProvider()).downloadJob(request.payload.job_id),
      );
    } else if (request.type === "CLOUD_START") {
      const remote = await cloudProvider();
      if (source!.source_kind === "url")
        return await cacheCloudResult(
          await remote.startYouTube({
            url: source!.youtube_url,
            request_id: request.request_id,
            ...(title ? { source_title: title } : {}),
          }),
        );
      else {
        progress("preparing_cloud_file");
        selected = await withCacheMutation(config.cache_root, () =>
          prepareDesktopFile(config, source!.source_path, signal),
        );
        selected = await prepareCloudFile(config, selected, signal);
        assertCurrent();
        const transfer = new LocalPairSyncClient(
          await accountApi(),
          outbox,
          dependencies.fetcher,
        );
        const artifact = { path: selected.input_path, ...selected };
        const result = await remote.startFile(
          {
            request_id: request.request_id,
            source: "audio_file",
            input: {
              extension: selected.extension,
              content_type: selected.content_type,
              bytes: selected.bytes,
              duration_seconds: selected.duration_seconds,
              sha256: Buffer.from(selected.sha256, "hex").toString("base64"),
            },
            ...(title ? { source_title: title } : {}),
          },
          async (grant, _jobId, transferSignal) =>
            transfer.upload(request.session!, grant, artifact, transferSignal),
        );
        return await cacheCloudResult(result);
      }
    } else {
      if (source!.source_kind === "file") {
        progress("preparing_file");
        selected = await withCacheMutation(config.cache_root, () =>
          prepareDesktopFile(config, source!.source_path, signal),
        );
        duration = selected.duration_seconds;
        sourceDigest = createHash("sha256")
          .update(JSON.stringify([owner?.uid ?? "guest", selected.sha256]))
          .digest("hex");
        provider = new FileLocalProvider(config, selected);
      } else {
        const local =
          dependencies.localProvider ?? new LocalMacProvider(config);
        provider =
          !dependencies.localProvider || dependencies.communityClient
            ? new SharedYouTubeProvider(
                config,
                local,
                communityClient,
                dependencies.fetcher,
                undefined,
                {
                  onStaged: () => {
                    if (!dependencies.localProvider)
                      void startCommunityPublisher(config).catch(() => {});
                  },
                },
              )
            : local;
        // The local vocal cache is checked before acquisition metadata or account I/O.
        const key = localCacheKey({
          video_id: videoId!,
          provider: "LOCAL_MACOS",
          duration_seconds: 1,
        });
        const cached = await readRetained(
          join(config.cache_root, "vocals", key, "result.json"),
        );
        if (
          cached &&
          cached.duration_seconds > 0 &&
          cached.duration_seconds <= MVP_MAX_DURATION_SECONDS
        ) {
          const verified = await new JobManager(
            config.cache_root,
            provider,
            diagnostics,
            media,
            () => {},
            {
              withCacheMutation: (operation) =>
                withCacheMutation(config.cache_root, operation),
            },
          ).peekCache({
            video_id: videoId!,
            provider: provider.id,
            duration_seconds: cached.duration_seconds,
          });
          assertCurrent();
          if (verified) {
            duration = verified.source_duration_seconds;
            title ??= sanitizeSourceTitle(verified.source_title);
          }
        }
        if (!duration && owner) {
          resident = await findResidentAccountYouTube(
            config,
            owner,
            { video_id: videoId! },
            {
              signal,
              isCurrent: async () => {
                await verifyCurrent();
              },
              catalog,
            },
          );
          assertCurrent();
          if (resident) duration = resident.source_duration_seconds;
        }
        if (
          !duration &&
          request.session?.id_token &&
          !(provider instanceof SharedYouTubeProvider)
        ) {
          try {
            const remote = await cloudProvider();
            const reusable = await remote.findReusableYouTube(videoId!);
            if (reusable)
              return await cacheCloudResult(
                await remote.downloadJob(reusable.id, {
                  video_id: videoId!,
                  duration_seconds: reusable.input.duration_seconds,
                }),
              );
          } catch (error) {
            // A failed account lookup never changes local processing or consumes compute quota.
            assertCurrent();
            diagnostics.record({
              component: "companion",
              severity: "warning",
              event: "diagnostic_error",
              code: safeDesktopCode(error),
            });
          }
        }
        if (!duration && provider instanceof SharedYouTubeProvider) {
          duration = (await provider.sharedDuration(videoId!, signal)) ?? 0;
        }
        if (!duration) {
          progress("checking_youtube");
          const metadata = dependencies.inspectYouTube
            ? await dependencies.inspectYouTube(videoId!, signal)
            : await new LocalMacProvider(config).inspectYouTube(videoId!, {
                signal,
                onProgress: progress,
              });
          duration = metadata.duration_seconds;
          title ??= metadata.source_title;
        }
      }
    }
    assertCurrent();
    const start: StartPayload = {
      video_id: videoId ?? "local_file_",
      provider: provider.id,
      duration_seconds: duration,
    };
    const key = localCacheKey(start, sourceDigest);
    let stagingFailed = false;
    let residentPinned = false;
    // The native player uses a private file path; no listening HTTP server is needed here.
    let settle!: (value: JobSnapshot) => void;
    let terminal = new Promise<JobSnapshot>((resolve) => {
      settle = resolve;
    });
    const jobs = new JobManager(
      config.cache_root,
      provider,
      diagnostics,
      media,
      (snapshot) => {
        if (["READY", "FAILED", "CANCELLED"].includes(snapshot.state))
          settle(snapshot);
        else progress(snapshot.stage, snapshot.completed, snapshot.total);
      },
      {
        isCurrentOwner: async (candidate) => {
          await verifyCurrent();
          return dependencies.isCurrent(candidate);
        },
        pinnedCacheKeys: pinned,
        withCacheMutation: (operation) =>
          withCacheMutation(config.cache_root, operation),
        onReady: async (result) => {
          if (resident && result.cache_key === resident.cache_key) {
            assertCurrent();
            await pinPlaybackHandoff(config.cache_root, resident.cache_key);
            assertCurrent();
            residentPinned = true;
          }
        },
        beforePrepare: async () => {
          assertCurrent();
          if (!(provider instanceof SharedYouTubeProvider))
            await outbox.assertAdmission(selected?.bytes);
        },
        onPrepared: async (result) => {
          try {
            assertCurrent();
            title ??= sanitizeSourceTitle(result.audio.source_title);
            if (
              result.audio.shared_youtube_profile ===
                "kim-vocal-2-full-timeline-v1" &&
              videoId
            )
              return;
            await outbox.stage({
              owner: result.owner,
              request_id: result.request_id,
              cache_key: result.cache_key,
              original: result.audio.original!,
              vocals: {
                path: result.audio.output_path,
                extension: "mp3",
                content_type: "audio/mpeg",
                duration_seconds: result.audio.duration_seconds,
                bytes: result.audio.bytes,
                sha256: result.audio.sha256,
              },
              ...(result.audio.source ? { source: result.audio.source } : {}),
              ...(title ? { title } : {}),
            });
          } catch (error) {
            stagingFailed = true;
            throw error;
          }
        },
      },
    );
    const cancel = () => {
      void jobs.close();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (resident && owner) {
        await jobs.startCached(start, owner, resident.cache_key);
        const restored = await terminal;
        await jobs.close();
        assertCurrent();
        if (restored.state === "READY") {
          if (!residentPinned) throw new DesktopApiError("CACHE_UNSAFE");
          return {
            vocal_path: join(
              config.cache_root,
              "vocals",
              resident.cache_key,
              "vocals.mp3",
            ),
            duration_seconds: resident.duration_seconds,
            operation_id: restored.job_id,
            cache_key: resident.cache_key,
            cache_hit: true,
            job_id: resident.job_id,
            sync_state: "ready",
            ...(videoId ? { video_id: videoId } : {}),
            ...((title ?? resident.source_title)
              ? { source_title: title ?? resident.source_title }
              : {}),
          };
        }
        if (restored.error_code !== "CACHE_MISS")
          throw new DesktopApiError(restored.error_code ?? "PROCESSING_FAILED");
        terminal = new Promise<JobSnapshot>((resolve) => {
          settle = resolve;
        });
      }
      if (selected && owner && request.session?.id_token) {
        const selectedFile = selected;
        // Only the JobManager's complete retained-byte validation can suppress account lookup.
        const cached = await jobs.peekCache(start, sourceDigest);
        assertCurrent();
        if (!cached || cached.owner_uid !== owner.uid) {
          try {
            await verifyPrivateSnapshot(
              selectedFile.input_path,
              selectedFile.bytes,
              selectedFile.sha256,
              signal,
            );
            await verifyCurrent();
            const known = (await outbox.associations(owner)).find(
              (record) =>
                record.cache_key === key &&
                /^[a-f0-9]{24}$/.test(record.receipt?.job_id ?? "") &&
                record.original.sha256 === selectedFile.sha256 &&
                record.original.bytes === selectedFile.bytes &&
                record.original.extension === selectedFile.extension &&
                record.original.content_type === selectedFile.content_type &&
                Math.abs(
                  record.original.duration_seconds -
                    selectedFile.duration_seconds,
                ) <= 0.25,
            );
            assertCurrent();
            const input = {
              extension: selectedFile.extension,
              content_type: selectedFile.content_type,
              bytes: selectedFile.bytes,
              duration_seconds: selectedFile.duration_seconds,
              sha256: Buffer.from(selectedFile.sha256, "hex").toString(
                "base64",
              ),
            };
            const remote = await cloudProvider();
            const reusable = await remote.findReusableFile(
              input,
              known?.receipt?.job_id,
            );
            assertCurrent();
            if (reusable)
              return await cacheCloudResult(
                await remote.downloadJob(reusable.id, input),
              );
          } catch (error) {
            assertCurrent();
            diagnostics.record({
              component: "companion",
              severity: "warning",
              event: "diagnostic_error",
              code: safeDesktopCode(error),
            });
          }
        }
      }
      await jobs.start(start, owner, sourceDigest);
      const result = await terminal;
      await jobs.close();
      assertCurrent();
      if (result.state !== "READY")
        throw new DesktopApiError(result.error_code ?? "PROCESSING_FAILED");
      let retained = await readRetained(
        join(config.cache_root, "vocals", key, "result.json"),
      );
      if (!retained) throw new Error("CACHE_UNSAFE");
      let knownJobId: string | undefined;
      if (
        owner &&
        request.session?.id_token &&
        videoId &&
        retained.shared_youtube_profile === "kim-vocal-2-full-timeline-v1"
      ) {
        try {
          const shared = await (
            await cloudProvider()
          ).findReusableYouTube(videoId, retained.source_duration_seconds);
          await verifyCurrent();
          if (
            shared &&
            shared.output?.sha256 ===
              Buffer.from(retained.sha256, "hex").toString("base64")
          )
            knownJobId = shared.id;
        } catch (error) {
          assertCurrent();
          diagnostics.record({
            component: "companion",
            severity: "warning",
            event: "diagnostic_error",
            code: safeDesktopCode(error),
          });
        }
      }
      let pending:
        Awaited<ReturnType<LocalSyncOutbox["list"]>>[number] | undefined;
      let captureState: string | undefined;
      await withCacheMutation(config.cache_root, async () => {
        assertCurrent();
        retained = await readRetained(
          join(config.cache_root, "vocals", key, "result.json"),
        );
        if (!retained) throw new Error("CACHE_UNSAFE");
        if (result.cache_hit && !explicitTitle)
          title =
            (await catalog.sourceTitle(owner, key)) ??
            sanitizeSourceTitle(retained.source_title) ??
            title;
        else title ??= sanitizeSourceTitle(retained.source_title);
        const item = await catalog.remember(owner, {
          cache_key: key,
          operation_id: result.job_id,
          source_kind: videoId ? "url" : "file",
          vocal_path: retained.output_path,
          duration_seconds: retained.duration_seconds,
          source_duration_seconds: retained.source_duration_seconds,
          trim_enabled: retained.trim_enabled,
          bytes: retained.bytes,
          sha256: retained.sha256,
          ...(videoId ? { video_id: videoId } : {}),
          ...(title ? { source_title: title } : {}),
          ...(knownJobId ? { job_id: knownJobId } : {}),
        });
        title ??= item.source_title;
        knownJobId ??= item.job_id;
        if (owner) {
          if (
            videoId &&
            retained.shared_youtube_profile === "kim-vocal-2-full-timeline-v1"
          ) {
            await communityOutbox.linkOwner(owner, {
              cache_key: key,
              video_id: videoId,
              duration_seconds: retained.source_duration_seconds,
              sha256: retained.sha256,
            });
            const link = (await communityOutbox.ownerLinks(owner)).find(
              (candidate) => candidate.cache_key === key,
            );
            if (link && knownJobId)
              await communityOutbox.finishOwnerLink(owner, link, true);
            else captureState = "pending";
          }
          pending = (await outbox.list(owner)).find(
            (record) => record.cache_key === key,
          );
          if (result.cache_hit && selected && !knownJobId && !pending) {
            let pair: LocalSyncStage | undefined;
            try {
              pair = await warmFilePair(
                config,
                owner,
                key,
                selected,
                retained,
                signal,
                title,
              );
              await outbox.assertAdmission(pair.original.bytes);
              await verifyCurrent();
              const original = join(
                selected.root,
                `source.${selected.extension}`,
              );
              if (selected.input_path !== original)
                await rename(selected.input_path, original);
              selected.input_path = original;
              pair.original.path = original;
              retainedSelectedRecovery = true;
              await preserveLocalPairRecovery(config.cache_root, pair);
              pending = await outbox.stage(pair);
              retainedSelectedRecovery = false;
            } catch (error) {
              stagingFailed = true;
              if (pair && retainedSelectedRecovery) {
                try {
                  await retainLocalPairRecoverySource(config.cache_root, pair);
                } catch {
                  diagnostics.record({
                    component: "companion",
                    severity: "warning",
                    event: "diagnostic_error",
                    code: "LOCAL_SYNC_RECOVERY_FAILED",
                  });
                }
              }
              diagnostics.record({
                component: "companion",
                severity: "warning",
                event: "diagnostic_error",
                code: safeDesktopCode(error),
              });
            }
          } else if (
            result.cache_hit &&
            videoId &&
            !knownJobId &&
            !pending &&
            retained.shared_youtube_profile !== "kim-vocal-2-full-timeline-v1"
          ) {
            if (
              isLocalAudioDeclaration(
                retained.original_declaration,
                retained.source_duration_seconds,
              ) &&
              retained.source?.video_id === videoId
            ) {
              try {
                captureState = (
                  await captures.stage({
                    owner,
                    request_id: request.request_id,
                    cache_key: key,
                    video_id: videoId,
                  })
                ).state;
              } catch (error) {
                stagingFailed = true;
                diagnostics.record({
                  component: "companion",
                  severity: "warning",
                  event: "diagnostic_error",
                  code: safeDesktopCode(error),
                });
              }
            } else captureState = "rejected";
          }
        }
        await pinPlaybackHandoff(config.cache_root, key);
      });
      assertCurrent();
      if (!retained) throw new Error("CACHE_UNSAFE");
      return {
        vocal_path: retained.output_path,
        duration_seconds: retained.duration_seconds,
        source_duration_seconds: retained.source_duration_seconds,
        trim_enabled: retained.trim_enabled,
        operation_id: result.job_id,
        cache_key: key,
        cache_hit: result.cache_hit ?? false,
        ...(videoId ? { video_id: videoId } : {}),
        ...(title ? { source_title: title } : {}),
        ...(knownJobId
          ? { job_id: knownJobId }
          : pending?.receipt
            ? { job_id: pending.receipt.job_id }
            : {}),
        sync_state:
          knownJobId || pending?.receipt
            ? "ready"
            : stagingFailed || captureState === "rejected"
              ? "unavailable"
              : pending ||
                  (captureState !== undefined && captureState !== "completed")
                ? "pending"
                : "local_only",
      };
    } finally {
      signal.removeEventListener("abort", cancel);
      await jobs.close();
    }
  } catch (error) {
    const acquisition =
      !signal.aborted && error instanceof LocalProcessingError
        ? error.acquisition_failure
        : undefined;
    diagnostics.record({
      component: "companion",
      severity: signal.aborted ? "info" : "error",
      event: signal.aborted ? "job_cancelled" : "diagnostic_error",
      request_id: request.request_id,
      code: safeDesktopCode(error),
      ...(acquisition
        ? {
            metrics: {
              error_origin: "download",
              ...(acquisition.stage
                ? { acquisition_stage: acquisition.stage }
                : {}),
              ...(acquisition.exit_code === undefined
                ? {}
                : { exit_code: acquisition.exit_code }),
              ...(acquisition.http_status === undefined
                ? {}
                : { http_status: acquisition.http_status }),
              ...(acquisition.refusal_code
                ? { refusal_code: acquisition.refusal_code }
                : {}),
              ...(acquisition.block_reason
                ? { acquisition_block_reason: acquisition.block_reason }
                : {}),
              ...(acquisition.stderr_kind
                ? { acquisition_stderr_kind: acquisition.stderr_kind }
                : {}),
              ...(acquisition.stderr_bytes === undefined
                ? {}
                : { acquisition_stderr_bytes: acquisition.stderr_bytes }),
            },
          }
        : {}),
    });
    throw error;
  } finally {
    cloud?.close();
    if (selected && !retainedSelectedRecovery)
      await rm(selected.root, { recursive: true, force: true });
    diagnostics.record({
      component: "companion",
      severity: "info",
      event: "companion_stopped",
      request_id: request.request_id,
    });
    diagnostics.close();
  }
}

export async function prepareCloudFile(
  config: LocalConfig,
  input: DesktopFileSource,
  signal: AbortSignal,
): Promise<DesktopFileSource> {
  const output = join(input.root, "cloud.m4a");
  await runBounded(
    config.ffmpeg_path,
    [
      "-nostdin",
      "-v",
      "error",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      "mov,mp3,matroska,webm,ogg,aac,wav,flac",
      "-i",
      input.input_path,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
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
      "-n",
      output,
    ],
    {
      signal,
      timeout_ms: 180000,
      max_output_bytes: 65536,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    },
  );
  const probe = await probeDesktopAudio(config, output, signal);
  if (Math.abs(probe.duration_seconds - input.duration_seconds) > 0.25)
    throw new DesktopApiError("TIMELINE_MISMATCH");
  const file = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (info.size > 100 * 1024 ** 2)
      throw new DesktopApiError("FILE_TOO_LARGE");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false }))
      hash.update(chunk);
    await rm(input.input_path);
    return {
      ...input,
      input_path: output,
      extension: "m4a",
      content_type: "audio/mp4",
      bytes: info.size,
      sha256: hash.digest("hex"),
      duration_seconds: probe.duration_seconds,
    };
  } finally {
    await file.close();
  }
}
