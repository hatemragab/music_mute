import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { projectErrorContext } from "../shared/error-context.js";
import { loadLocalConfig } from "./config.js";
import { checkInstallation } from "./installation-check.js";
import { Diagnostics } from "./diagnostics.js";
import { resolveDiagnosticIdentity } from "./diagnostic-identity.js";
import { LocalMacProvider, MODEL_SHA256 } from "./local-provider.js";
import { MediaServer } from "./media-server.js";
import {
  FrameDecoder,
  encodeFrame,
  validateCommand,
} from "./native-protocol.js";
import { JobManager } from "./jobs.js";
import { NativeAccountState } from "./account-state.js";
import { DesktopCatalog } from "./desktop-catalog.js";
import { findResidentAccountYouTube } from "./account-cache.js";
import { AccountCacheRestoreQueue } from "./account-cache-restore.js";
import { LocalSyncOutbox } from "./sync-outbox.js";
import { LocalSyncCaptureQueue } from "./local-sync-capture.js";
import { readPlaybackPins, withCacheMutation } from "./cache-mutator.js";
import { recoverJobWorkspaces } from "./job-workspace.js";
import { privateDirectory } from "./app-setup.js";
import { beginSample } from "./resource-monitor.js";
import { publicApiOrigin } from "./desktop-service.js";
import { MacGuestCredentialStore } from "./guest-credentials.js";
import { YouTubeCommunityClient } from "./youtube-community-client.js";
import { SharedYouTubeProvider } from "./youtube-community-provider.js";
import { YouTubeCommunityOutbox } from "./youtube-community-outbox.js";
import { startCommunityPublisher } from "./community-publisher.js";
import {
  releaseCommunityPlayback,
  type CommunityPlaybackIdentity,
} from "./community-playback.js";
import { BrowserProcessingBridge } from "./browser-processing-bridge.js";
import { BrowserCloudProvider } from "./browser-cloud-provider.js";
import type { LocalLibraryOwner } from "./sync-outbox.js";
import {
  MVP_MAX_DURATION_SECONDS,
  isLocalAudioDeclaration,
  sanitizeSourceTitle,
  VERSION,
  type NativeReply,
  type ProcessingProvider,
} from "../shared/protocol.js";

const startupStarted = performance.now();
const origin = (process.argv[2] ?? "").replace(/\/$/, "");
if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
  throw new Error("EXTENSION_ORIGIN_REQUIRED");
process.umask(0o077);
const config = await loadLocalConfig();
const browserBridge = new BrowserProcessingBridge(config);
await privateDirectory(config.root);
const accountState = new NativeAccountState(config.root);
const outbox = new LocalSyncOutbox(
  join(config.root, "sync-outbox"),
  config.cache_root,
);
const communityOutbox = new YouTubeCommunityOutbox(
  join(config.root, "youtube-community-outbox"),
);
const captures = new LocalSyncCaptureQueue(
  join(config.root, "sync-captures"),
  config.cache_root,
);
const restores = new AccountCacheRestoreQueue(
  join(config.root, "cache-restores"),
);
const catalog = new DesktopCatalog(
  join(config.root, "desktop-catalog"),
  config.cache_root,
);
const protectedCacheKeys = async () =>
  new Set([
    ...(await outbox.pinnedCacheKeys()),
    ...(await captures.pinnedCacheKeys()),
    ...(await readPlaybackPins(config.cache_root)),
  ]);
await withCacheMutation(config.cache_root, () =>
  recoverJobWorkspaces(config.cache_root),
);
await outbox.recover();
await captures.recover();
const identity = resolveDiagnosticIdentity(config);
const diagnostics = new Diagnostics(config.logs_root, { identity });
const stopSampling = beginSample(process.pid, (event) =>
  diagnostics.record(event),
);
const media = new MediaServer(
  origin,
  (code) =>
    diagnostics.record({
      component: "companion",
      severity: "warning",
      event: "diagnostic_error",
      code,
    }),
  { cacheRoot: config.cache_root },
);
await media.start();
let requestId: string = randomUUID();
let startAdmission = false;
let jobAccountScope: ReturnType<NativeAccountState["current"]>;
let residentLookup: AbortController | undefined;
let manualCheck: AbortController | undefined;
let closing = false;
let errorContextEnabled = false;
let backgroundPublicationEnabled = false;
let playbackIdentity: CommunityPlaybackIdentity | undefined;
let publicationWatcher: FSWatcher | undefined;
let publicationTimer: NodeJS.Timeout | undefined;
async function wakePublisher(): Promise<void> {
  if (!fixture) await startCommunityPublisher(config);
}
const fixture =
  process.env.MUSICMUTE_LOCAL_TEST_MODE === "1"
    ? process.env.MUSICMUTE_LOCAL_FIXTURE_AUDIO
    : undefined;
const provider: ProcessingProvider = fixture
  ? {
      id: "LOCAL_MACOS",
      async prepare(request, workRoot, hooks) {
        hooks.onProgress("fixture-separation");
        await mkdir(workRoot, { recursive: true, mode: 0o700 });
        const path = join(workRoot, "vocals.mp3");
        await copyFile(fixture, path);
        if (hooks.signal.aborted) throw new Error("CANCELLED");
        const bytes = await readFile(path);
        return {
          output_path: path,
          bytes: (await stat(path)).size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          model_id: MODEL_SHA256,
          trim_enabled: false,
          duration_seconds: request.duration_seconds,
          source_duration_seconds: request.duration_seconds,
          timings_ms: { fixture: 1 },
        };
      },
    }
  : new SharedYouTubeProvider(
      config,
      new LocalMacProvider(config),
      async () =>
        new YouTubeCommunityClient(
          await publicApiOrigin(config),
          new MacGuestCredentialStore(config),
        ),
      undefined,
      undefined,
      {
        get deferPublication() {
          return backgroundPublicationEnabled;
        },
        onStaged: () => {
          void wakePublisher().catch(() => {});
        },
      },
    );
if (provider instanceof SharedYouTubeProvider) {
  await privateDirectory(communityOutbox.root);
  void communityOutbox
    .records()
    .then((records) => {
      if (records.some((record) => record.state === "pending"))
        return wakePublisher();
    })
    .catch(() => {});
}
function send(reply: NativeReply): void {
  if (
    !errorContextEnabled &&
    reply.type === "JOB" &&
    reply.payload?.error_context
  ) {
    const payload = { ...reply.payload };
    delete payload.error_context;
    reply = { ...reply, payload };
  }
  if (process.stdout.writableLength > 1024 * 1024)
    throw new Error("NATIVE_BACKPRESSURE");
  process.stdout.write(encodeFrame(reply));
}
const localJobs = new JobManager(
  config.cache_root,
  provider,
  diagnostics,
  media,
  (snapshot) => {
    send({
      protocol_version: 1,
      request_id: requestId,
      type: "JOB",
      payload: snapshot,
    });
    if (snapshot.state === "READY") void refreshPublicationState();
  },
  {
    isCurrentOwner: (owner) => accountState.isCurrent(owner),
    // The shared catalog already covers URL results from every account. Never
    // serialize a desktop restore (and its five-second deadline) ahead of it.
    resolveCached:
      provider instanceof SharedYouTubeProvider
        ? undefined
        : async ({ owner, request, job_id, signal }) => {
            const started = performance.now();
            diagnostics.record({
              component: "companion",
              severity: "info",
              event: "stage_started",
              job_id,
              metrics: { stage: "account_cache_restore" },
            });
            try {
              if (!(await accountState.isCurrent(owner)))
                throw new Error("ACCOUNT_CHANGED");
              await restores.stage({
                owner,
                request_id: job_id,
                video_id: request.video_id,
                duration_seconds: request.duration_seconds,
              });
              const receipt = await restores.waitForReceipt(
                owner,
                job_id,
                signal,
                () => accountState.isCurrent(owner),
              );
              if (!(await accountState.isCurrent(owner)))
                throw new Error("ACCOUNT_CHANGED");
              if (signal.aborted) throw new Error("CANCELLED");
              if (
                receipt?.state !== "ready" ||
                receipt.expires_at <= Date.now()
              )
                return undefined;
              const resident = await findResidentAccountYouTube(
                config,
                owner,
                request,
                {
                  signal,
                  isCurrent: (scope) => accountState.isCurrent(scope),
                  catalog,
                },
              );
              if (receipt.expires_at <= Date.now()) return undefined;
              return resident &&
                resident.cache_key === receipt.cache_key &&
                resident.job_id === receipt.job_id
                ? resident.cache_key
                : undefined;
            } catch (error) {
              if (signal.aborted) throw new Error("CANCELLED");
              if (!(await accountState.isCurrent(owner)))
                throw new Error("ACCOUNT_CHANGED");
              const candidate =
                error && typeof error === "object" && "code" in error
                  ? String(error.code)
                  : error instanceof Error
                    ? error.message
                    : "ACCOUNT_RESTORE_UNAVAILABLE";
              if (["ACCOUNT_CHANGED", "CANCELLED"].includes(candidate))
                throw error;
              diagnostics.record({
                component: "companion",
                severity: "warning",
                event: "diagnostic_error",
                job_id,
                code: [
                  "ACCOUNT_RESTORE_UNSAFE",
                  "ACCOUNT_RESTORE_FULL",
                  "ACCOUNT_RESTORE_CONFLICT",
                  "ACCOUNT_RESTORE_UNAVAILABLE",
                  "CACHE_UNSAFE",
                  "LOCAL_COMPANION_BUSY",
                ].includes(candidate)
                  ? candidate
                  : "ACCOUNT_RESTORE_UNAVAILABLE",
              });
              return undefined;
            } finally {
              diagnostics.record({
                component: "companion",
                severity: "info",
                event: "stage_completed",
                job_id,
                metrics: {
                  stage: "account_cache_restore",
                  duration_ms: performance.now() - started,
                },
              });
            }
          },
    withCacheMutation: (operation) =>
      withCacheMutation(config.cache_root, operation),
    pinnedCacheKeys: protectedCacheKeys,
    beforePrepare: async (owner) => {
      if (!(await accountState.isCurrent(owner)))
        throw new Error("ACCOUNT_CHANGED");
      if (!(provider instanceof SharedYouTubeProvider))
        await outbox.assertAdmission();
    },
    onPrepared: async (result) => {
      if (!(await accountState.isCurrent(result.owner)))
        throw new Error("ACCOUNT_CHANGED");
      if (
        result.audio.shared_youtube_profile === "kim-vocal-2-full-timeline-v1"
      )
        return;
      const title = sanitizeSourceTitle(result.audio.source_title);
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
    },
    onReady: async (result) => {
      playbackIdentity = {
        job_id: result.request_id,
        video_id: result.request.video_id,
        sha256: result.audio.sha256,
      };
      if (!(await accountState.isCurrent(result.owner)))
        throw new Error("ACCOUNT_CHANGED");
      const title =
        (await catalog.sourceTitle(result.owner, result.cache_key)) ??
        sanitizeSourceTitle(result.audio.source_title);
      if (!(await accountState.isCurrent(result.owner)))
        throw new Error("ACCOUNT_CHANGED");
      const item = await catalog.remember(result.owner, {
        cache_key: result.cache_key,
        operation_id: result.request_id,
        source_kind: "url",
        video_id: result.request.video_id,
        vocal_path: result.audio.output_path,
        duration_seconds: result.audio.duration_seconds,
        source_duration_seconds: result.audio.source_duration_seconds,
        trim_enabled: result.audio.trim_enabled,
        bytes: result.audio.bytes,
        sha256: result.audio.sha256,
        ...(title ? { source_title: title } : {}),
      });
      if (
        result.owner &&
        result.audio.shared_youtube_profile === "kim-vocal-2-full-timeline-v1"
      ) {
        await communityOutbox.linkOwner(result.owner, {
          cache_key: result.cache_key,
          video_id: result.request.video_id,
          duration_seconds: result.audio.source_duration_seconds,
          sha256: result.audio.sha256,
        });
        if (!(await accountState.isCurrent(result.owner)))
          throw new Error("ACCOUNT_CHANGED");
        return;
      }
      if (
        result.owner &&
        result.cache_hit &&
        !item.job_id &&
        isLocalAudioDeclaration(
          result.audio.original_declaration,
          result.audio.source_duration_seconds,
        ) &&
        result.audio.source?.video_id === result.request.video_id &&
        !(await outbox.list(result.owner)).some(
          (record) => record.cache_key === result.cache_key,
        )
      )
        await captures.stage({
          owner: result.owner,
          request_id: result.request_id,
          cache_key: result.cache_key,
          video_id: result.request.video_id,
        });
    },
  },
);
async function refreshPublicationState(): Promise<void> {
  const identity = playbackIdentity;
  if (!identity || closing || localJobs.current()?.state !== "READY") return;
  try {
    const state = await communityOutbox.publicationState(
      identity.video_id,
      identity.sha256,
    );
    if (state && playbackIdentity === identity) {
      if (state === "pending" && localJobs.current()?.save_state === "saving")
        return;
      localJobs.setSaveState(identity.job_id, identity.video_id, state);
    }
  } catch {
    /* A save status never interrupts playback; the durable pair remains recoverable. */
  }
}
if (provider instanceof SharedYouTubeProvider) {
  try {
    publicationWatcher = watch(
      communityOutbox.root,
      { recursive: true },
      () => {
        if (publicationTimer) clearTimeout(publicationTimer);
        publicationTimer = setTimeout(() => {
          void refreshPublicationState();
        }, 50);
      },
    );
    publicationWatcher.on("error", () => {
      publicationWatcher?.close();
    });
  } catch {
    /* Publication and startup recovery do not depend on status observation. */
  }
}
let cloudOwner: LocalLibraryOwner | undefined;
let helloCloudOwner: LocalLibraryOwner | undefined;
let cloudJobId: string | undefined;
const cloudJobs = new JobManager(
  config.cache_root,
  new BrowserCloudProvider(config, {
    session: async (signal) => {
      const owner = cloudOwner;
      if (!owner) throw new Error("ACCOUNT_REQUIRED");
      if (!(await accountState.isCurrent(owner)))
        throw new Error("ACCOUNT_CHANGED");
      const session = await browserBridge.session(owner, signal);
      if (!(await accountState.isCurrent(owner)))
        throw new Error("ACCOUNT_CHANGED");
      return session;
    },
    verifyCurrent: (scope) =>
      accountState.isCurrent({
        uid: scope.firebase_uid,
        session_generation: scope.session_generation,
      }),
    onCloudJob: (_scope, jobId) => {
      cloudJobId = jobId;
    },
    pinnedCacheKeys: protectedCacheKeys,
  }),
  diagnostics,
  media,
  (snapshot) =>
    send({
      protocol_version: 1,
      request_id: requestId,
      type: "JOB",
      payload: snapshot,
    }),
  {
    isCurrentOwner: (owner) => accountState.isCurrent(owner),
    withCacheMutation: (operation) =>
      withCacheMutation(config.cache_root, operation),
    pinnedCacheKeys: protectedCacheKeys,
    onReady: async (result) => {
      if (!result.owner || !(await accountState.isCurrent(result.owner)))
        throw new Error("ACCOUNT_CHANGED");
      const title = sanitizeSourceTitle(result.audio.source_title);
      await catalog.remember(result.owner, {
        cache_key: result.cache_key,
        operation_id: result.request_id,
        source_kind: "url",
        video_id: result.request.video_id,
        vocal_path: result.audio.output_path,
        duration_seconds: result.audio.duration_seconds,
        source_duration_seconds: result.audio.source_duration_seconds,
        trim_enabled: false,
        bytes: result.audio.bytes,
        sha256: result.audio.sha256,
        ...(!result.cache_hit && cloudJobId ? { job_id: cloudJobId } : {}),
        ...(title ? { source_title: title } : {}),
      });
    },
  },
);
let jobs = localJobs;
const selectedProvider = () =>
  fixture ? Promise.resolve("LOCAL_MACOS" as const) : browserBridge.provider();
await accountState.start(async (code) => {
  residentLookup?.abort();
  const snapshot = jobs.current();
  diagnostics.record({
    component: "companion",
    severity: "warning",
    event: "diagnostic_error",
    code,
    ...(snapshot ? { job_id: snapshot.job_id } : {}),
  });
  if (snapshot) await jobs.cancel(snapshot.job_id, code);
});
diagnostics.record({
  component: "companion",
  severity: "info",
  event: "companion_started",
  metrics: {
    host_initialization_ms: Math.round(performance.now() - startupStarted),
    launcher_ms: Math.min(
      300_000,
      Math.max(0, Number(process.env.MUSICMUTE_LOCAL_LAUNCH_MS) || 0),
    ),
    installation_checks: false,
  },
});
async function shutdown(code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  manualCheck?.abort();
  publicationWatcher?.close();
  if (publicationTimer) clearTimeout(publicationTimer);
  residentLookup?.abort();
  process.stdin.pause();
  await localJobs.close();
  await cloudJobs.close();
  await media.close();
  diagnostics.record({
    component: "companion",
    severity: "info",
    event: "companion_stopped",
  });
  diagnostics.close();
  stopSampling();
  accountState.close();
  process.exitCode = code;
}
async function handle(value: unknown): Promise<void> {
  let currentId: string = randomUUID();
  try {
    const command = validateCommand(value);
    currentId = command.request_id;
    if (command.type === "EVENT") {
      diagnostics.record(command.payload);
      return;
    }
    if (command.type === "HELLO") {
      backgroundPublicationEnabled ||=
        command.payload.capabilities?.includes("background_publication_v1") ===
        true;
      errorContextEnabled ||=
        command.payload.capabilities?.includes("error_context_v1") === true;
      const processingProvider = await selectedProvider();
      const helloOwner = accountState.current();
      if (!(await accountState.isCurrent(helloOwner)))
        throw new Error("ACCOUNT_CHANGED");
      helloCloudOwner =
        processingProvider === "ONLINE_MUSICMUTE" && helloOwner
          ? { ...helloOwner }
          : undefined;
      send({
        protocol_version: 1,
        request_id: currentId,
        type: "HELLO",
        payload: {
          // HELLO means the transport can accept a request. Engine readiness
          // is checked lazily only when a cache miss actually needs inference.
          ready: true,
          version: VERSION,
          platform: process.platform,
          arch: process.arch,
          max_duration_seconds: MVP_MAX_DURATION_SECONDS,
          capabilities: [
            "error_context_v1",
            "cloud_handoff_v1",
            ...(command.payload.capabilities?.includes(
              "background_publication_v1",
            )
              ? ["background_publication_v1" as const]
              : []),
            ...(command.payload.capabilities?.includes(
              "processing_selection_v1",
            )
              ? ["processing_selection_v1" as const]
              : []),
          ],
          background_publication_supported: true,
          installation_check_supported: true,
          installation_id:
            identity.package_inventory_sha256 ??
            createHash("sha256")
              .update("musicmute-development-check-v1")
              .digest("hex"),
          processing_provider: processingProvider,
          ...(helloCloudOwner
            ? {
                processing_scope: createHash("sha256")
                  .update(
                    JSON.stringify([
                      helloCloudOwner.uid,
                      helloCloudOwner.session_generation,
                    ]),
                  )
                  .digest("hex"),
              }
            : {}),
        },
      });
    } else if (command.type === "PLAYBACK_STARTED") {
      if (!backgroundPublicationEnabled) throw new Error("INVALID_COMMAND");
      const captured = jobs.current();
      const released = await releaseCommunityPlayback(
        captured,
        playbackIdentity,
        command.payload,
        communityOutbox,
        wakePublisher,
      );
      if (released)
        localJobs.setSaveState(
          command.payload.job_id,
          command.payload.video_id,
          "saving",
        );
      send({
        protocol_version: 1,
        request_id: currentId,
        type: "JOB",
        payload: jobs.current(),
      });
    } else if (command.type === "START") {
      if (manualCheck) throw new Error("INSTALLATION_CHECK_BUSY");
      if (startAdmission || localJobs.busy() || cloudJobs.busy())
        throw new Error("LOCAL_COMPANION_BUSY");
      startAdmission = true;
      const lookup = new AbortController();
      residentLookup = lookup;
      try {
        const processingProvider = await selectedProvider();
        if (command.payload.provider !== processingProvider)
          throw new Error("PROCESSING_SELECTION_CHANGED");
        const owner = accountState.current();
        if (!(await accountState.isCurrent(owner)))
          throw new Error("ACCOUNT_CHANGED");
        jobAccountScope = owner;
        if (processingProvider === "ONLINE_MUSICMUTE") {
          if (!owner) throw new Error("ACCOUNT_REQUIRED");
          if (
            owner.uid !== helloCloudOwner?.uid ||
            owner.session_generation !== helloCloudOwner.session_generation
          )
            throw new Error("ACCOUNT_CHANGED");
          if (closing || lookup.signal.aborted) throw new Error("CANCELLED");
          cloudOwner = { ...owner };
          cloudJobId = undefined;
          jobs = cloudJobs;
          requestId = command.request_id;
          const sourceDigest = createHash("sha256")
            .update(JSON.stringify(["browser-cloud-owner-v1", owner.uid]))
            .digest("hex");
          await jobs.start(command.payload, owner, sourceDigest, lookup.signal);
          return;
        }
        jobs = localJobs;
        const local = await jobs.peekCache(command.payload);
        const resident =
          !local && owner
            ? await findResidentAccountYouTube(config, owner, command.payload, {
                signal: lookup.signal,
                isCurrent: (scope) => accountState.isCurrent(scope),
                catalog,
              })
            : null;
        if (!(await accountState.isCurrent(owner)))
          throw new Error("ACCOUNT_CHANGED");
        if (closing || lookup.signal.aborted) throw new Error("CANCELLED");
        requestId = command.request_id;
        if (resident && owner) {
          await jobs.startCached(
            command.payload,
            owner,
            resident.cache_key,
            lookup.signal,
          );
        } else {
          if (!(await accountState.isCurrent(owner)))
            throw new Error("ACCOUNT_CHANGED");
          if (closing || lookup.signal.aborted) throw new Error("CANCELLED");
          await jobs.start(command.payload, owner, undefined, lookup.signal);
        }
      } finally {
        if (residentLookup === lookup) residentLookup = undefined;
        startAdmission = false;
      }
    } else if (command.type === "CANCEL") {
      await jobs.cancel(command.payload.job_id);
      send({
        protocol_version: 1,
        request_id: currentId,
        type: "JOB",
        payload: jobs.current(),
      });
    } else if (command.type === "STATUS") {
      const capturedJobs = jobs;
      const captured = capturedJobs.current();
      if (captured?.state === "READY" && captured.provider === "LOCAL_MACOS") {
        const provider = await selectedProvider();
        const currentAccount = await accountState.isCurrent(jobAccountScope);
        if (
          capturedJobs !== jobs ||
          capturedJobs.current()?.job_id !== captured.job_id
        )
          throw new Error("SESSION_STOPPED");
        if (!currentAccount || provider !== "LOCAL_MACOS") {
          await capturedJobs.cancel(captured.job_id);
          throw new Error(
            currentAccount ? "PROCESSING_SELECTION_CHANGED" : "ACCOUNT_CHANGED",
          );
        }
      }
      send({
        protocol_version: 1,
        request_id: currentId,
        type: "JOB",
        payload: jobs.current(),
      });
    } else if (command.type === "CLEAR_CACHE") {
      await jobs.clearCache();
      send({
        protocol_version: 1,
        request_id: currentId,
        type: "JOB",
        payload: null,
      });
    } else if (command.type === "CHECK") {
      if (
        manualCheck ||
        startAdmission ||
        localJobs.busy() ||
        cloudJobs.busy() ||
        jobs.current()?.state === "READY"
      )
        throw new Error("INSTALLATION_CHECK_BUSY");
      const controller = new AbortController();
      manualCheck = controller;
      try {
        await checkInstallation(
          config,
          identity.package_inventory_sha256 ??
            createHash("sha256")
              .update("musicmute-development-check-v1")
              .digest("hex"),
          AbortSignal.any([controller.signal, AbortSignal.timeout(360_000)]),
          (payload) =>
            send({
              protocol_version: 1,
              request_id: command.request_id,
              type: "CHECK",
              payload,
            }),
        );
      } finally {
        if (manualCheck === controller) manualCheck = undefined;
      }
    } else if (command.type === "DIAGNOSTICS") {
      const result = await diagnostics.export();
      send({
        protocol_version: 1,
        request_id: currentId,
        type: "REPORT",
        payload: { path: result.path, report: diagnostics.snapshot() },
      });
    }
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z][A-Z_0-9]{2,64}$/.test(error.message)
        ? error.message
        : "COMMAND_FAILED";
    const context = errorContextEnabled
      ? projectErrorContext(
          error && typeof error === "object" && "acquisition_failure" in error
            ? error.acquisition_failure
            : error,
        )
      : undefined;
    send({
      protocol_version: 1,
      request_id: currentId,
      type: "ERROR",
      payload: {
        error_code: code,
        ...(context ? { error_context: context } : {}),
      },
    });
    diagnostics.record({
      component: "companion",
      severity: "error",
      event: "diagnostic_error",
      request_id: currentId,
      code,
    });
  }
}
const decoder = new FrameDecoder();
process.stdin.on("data", (chunk) => {
  try {
    for (const value of decoder.push(Buffer.from(chunk))) void handle(value);
  } catch {
    diagnostics.record({
      component: "companion",
      severity: "error",
      event: "diagnostic_error",
      code: "FRAME_INVALID",
    });
    void shutdown(1);
  }
});
process.stdin.on("end", () => {
  try {
    decoder.finish();
  } catch {
    diagnostics.record({
      component: "companion",
      severity: "error",
      event: "diagnostic_error",
      code: "FRAME_TRUNCATED",
    });
  }
  void shutdown();
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    void shutdown();
  });
process.on("uncaughtException", () => {
  diagnostics.record({
    component: "companion",
    severity: "error",
    event: "diagnostic_error",
    code: "COMPANION_CRASH",
  });
  void shutdown(1);
});
process.on("unhandledRejection", () => {
  diagnostics.record({
    component: "companion",
    severity: "error",
    event: "diagnostic_error",
    code: "COMPANION_REJECTION",
  });
  void shutdown(1);
});
