import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserCloudProvider } from "../src/companion/browser-cloud-provider.js";
import { withCacheMutation } from "../src/companion/cache-mutator.js";
import { writeOfflineCacheBudget } from "../src/companion/cache-settings.js";
import * as accountCache from "../src/companion/account-cache.js";
import * as desktopService from "../src/companion/desktop-service.js";
import {
  AccountApiClient,
  DesktopApiError,
} from "../src/companion/account-api.js";
import { AccountRealtimeClient } from "../src/companion/account-realtime.js";
import {
  CloudProcessingProvider,
  FULL_TIMELINE_RECIPE_DIGEST,
  type CloudResult,
} from "../src/companion/cloud-provider.js";
import type { LocalConfig } from "../src/companion/config.js";
import {
  LocalMacProvider,
  MODEL_SHA256,
} from "../src/companion/local-provider.js";
import { LocalPairSyncClient } from "../src/companion/local-sync-client.js";
import { LocalSyncOutbox } from "../src/companion/sync-outbox.js";
import type { DesktopSession } from "../src/shared/desktop-protocol.js";
import type { PipelineHooks, StartPayload } from "../src/shared/protocol.js";

const roots: string[] = [];
const bytes = Buffer.from("synthetic full-timeline vocals");
const preparedBytes = Buffer.from("synthetic prepared source");
const digest = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
const jobId = "0123456789abcdef01234567";
const request: StartPayload = {
  provider: "ONLINE_MUSICMUTE",
  video_id: "abcdefghijk",
  duration_seconds: 60,
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-browser-cloud-"));
  roots.push(root);
  const workRoot = join(root, "jobs", randomUUID());
  const config: LocalConfig = {
    root,
    cache_root: root,
    logs_root: join(root, "logs"),
    models_root: join(root, "models"),
    app_resources: join(root, "resources"),
    python_path: "/fixture/python",
    node_path: "/fixture/node",
    ffmpeg_path: "/fixture/ffmpeg",
    ffprobe_path: "/fixture/ffprobe",
    yt_dlp_path: "/fixture/ytdlp",
    js_runtime_path: "/fixture/deno",
    engine_root: "/fixture/engine",
    runner_path: "/fixture/runner",
  };
  await mkdir(workRoot, { recursive: true, mode: 0o700 });
  await mkdir(config.app_resources!, { mode: 0o700 });
  await writeFile(
    join(config.app_resources!, "desktop-public-config.json"),
    JSON.stringify({ backend_base_url: "https://api.music-mute.com" }),
    { mode: 0o600 },
  );
  const session: DesktopSession = {
    firebase_uid: "synthetic-owner",
    session_generation: randomUUID(),
    installation_id: randomUUID(),
    id_token: "fixture.payload.signature",
  };
  let current = true;
  const sessionAccess = vi.fn().mockResolvedValue(session);
  const verifyCurrent = vi.fn().mockImplementation(async () => current);
  const controller = new AbortController();
  const hooks: PipelineHooks = {
    signal: controller.signal,
    onProgress: vi.fn(),
    onDiagnostic: vi.fn(),
  };
  const acquired = {
    original: {
      path: join(workRoot, "source.webm"),
      extension: "webm",
      content_type: "audio/webm",
      bytes: preparedBytes.length,
      duration_seconds: 60,
      sha256: digest(preparedBytes),
    },
    source: {
      kind: "youtube" as const,
      video_id: request.video_id,
      format_id: "251",
      audio_track_id: null,
      audio_is_default: null,
      language: null,
    },
    source_title: "Synthetic source",
    timings_ms: { metadata: 1, download: 2 },
  };
  const acquire = vi
    .spyOn(LocalMacProvider.prototype, "acquireYouTube")
    .mockImplementation(async () => {
      await writeFile(acquired.original.path, preparedBytes, { mode: 0o600 });
      return acquired;
    });
  const inference = vi
    .spyOn(LocalMacProvider.prototype, "prepare")
    .mockRejectedValue(new Error("UNEXPECTED_INFERENCE"));
  const preparation = vi
    .spyOn(desktopService, "prepareCloudFile")
    .mockImplementation(async (_config, original) => {
      const input_path = join(workRoot, "cloud.m4a");
      await writeFile(input_path, preparedBytes, { mode: 0o600 });
      await rm(original.input_path);
      return {
        ...original,
        input_path,
        extension: "m4a",
        content_type: "audio/mp4",
      };
    });
  const grant = {
    method: "PUT" as const,
    url: "https://fixture.r2.cloudflarestorage.com/private?signature=fixture",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    headers: {
      "Content-Type": "audio/mp4",
      "If-None-Match": "*",
      "x-amz-checksum-sha256": Buffer.from(
        digest(preparedBytes),
        "hex",
      ).toString("base64"),
      "x-amz-meta-sha256": Buffer.from(digest(preparedBytes), "hex").toString(
        "base64",
      ),
    },
  };
  const cloudResult: CloudResult = {
    job: {
      id: jobId,
      request_id: workRoot.split("/").at(-1)!,
      status: "ready",
      processing_origin: "cloud",
      source_kind: "url",
      source_url: "https://www.youtube.com/watch?v=abcdefghijk",
      source_title: null,
      display_name: null,
      recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
      local_profile_id: null,
      trim_enabled: false,
      input: {
        extension: "m4a",
        content_type: "audio/mp4",
        bytes: preparedBytes.length,
        duration_seconds: 60,
        sha256: Buffer.from(digest(preparedBytes), "hex").toString("base64"),
      },
      output: {
        extension: "mp3",
        content_type: "audio/mpeg",
        bytes: bytes.length,
        duration_seconds: 60,
        sha256: Buffer.from(digest(bytes), "hex").toString("base64"),
      },
      can_download_input: true,
      can_download_output: true,
      error: null,
    },
    download_grant: {
      url: "https://fixture.r2.cloudflarestorage.com/result?signature=fixture",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  const start = vi
    .spyOn(CloudProcessingProvider.prototype, "startYouTube")
    .mockResolvedValue(cloudResult);
  const fileStart = vi
    .spyOn(CloudProcessingProvider.prototype, "startFile")
    .mockRejectedValue(new Error("UNEXPECTED_FILE_UPLOAD"));
  const upload = vi
    .spyOn(LocalPairSyncClient.prototype, "upload")
    .mockResolvedValue();
  const pairSave = vi
    .spyOn(LocalPairSyncClient.prototype, "savePending")
    .mockRejectedValue(new Error("UNEXPECTED_PAIR_SAVE"));
  const pairStage = vi
    .spyOn(LocalSyncOutbox.prototype, "stage")
    .mockRejectedValue(new Error("UNEXPECTED_PAIR_STAGE"));
  const cached = {
    vocal_path: join(root, "validated-account-vocals.mp3"),
    duration_seconds: 60,
    source_duration_seconds: 60,
    cache_key: "a".repeat(64),
    bytes: bytes.length,
    sha256: digest(bytes),
    trim_enabled: false,
    job_id: jobId,
    cache_hit: false,
  };
  const cache = vi
    .spyOn(accountCache, "cacheAccountResult")
    .mockImplementation(async () => {
      await writeFile(cached.vocal_path, bytes, { mode: 0o600 });
      return cached;
    });
  const cancel = vi
    .spyOn(CloudProcessingProvider.prototype, "cancel")
    .mockResolvedValue();
  const close = vi.spyOn(CloudProcessingProvider.prototype, "close");
  const onCloudJob = vi.fn();
  const provider = new BrowserCloudProvider(config, {
    session: sessionAccess,
    verifyCurrent,
    onCloudJob,
  });
  return {
    root,
    config,
    workRoot,
    session,
    sessionAccess,
    verifyCurrent,
    controller,
    hooks,
    acquired,
    acquire,
    inference,
    preparation,
    start,
    upload,
    fileStart,
    pairSave,
    pairStage,
    cache,
    cached,
    cloudResult,
    cancel,
    close,
    provider,
    onCloudJob,
    grant,
    changeOwner: () => {
      current = false;
    },
  };
}

describe("browser cloud URL processing", () => {
  it("submits only the URL without acquisition, source tools, conversion or upload", async () => {
    const e = await fixture();
    const result = await e.provider.prepare(request, e.workRoot, e.hooks);
    expect(e.sessionAccess).toHaveBeenCalledWith(e.controller.signal);
    expect(e.acquire).not.toHaveBeenCalled();
    expect(e.preparation).not.toHaveBeenCalled();
    expect(e.upload).not.toHaveBeenCalled();
    expect(e.start).toHaveBeenCalledExactlyOnceWith({
      request_id: e.cloudResult.job.request_id,
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    expect(e.cache.mock.calls[0]?.[4]).toMatchObject({
      signal: e.controller.signal,
      withCacheMutation: expect.any(Function),
      validation: "server",
    });
    const mutate = e.cache.mock.calls[0]?.[4].withCacheMutation;
    expect(await mutate!(async () => "held-lease")).toBe("held-lease");
    expect(await readFile(result.output_path)).toEqual(bytes);
    expect(result).toMatchObject({
      trim_enabled: false,
      duration_seconds: 60,
      source_duration_seconds: 60,
      model_id: MODEL_SHA256,
      sha256: digest(bytes),
      source: { ...e.acquired.source, format_id: "cloud-import" },
    });
    expect(result.original).toBeUndefined();
    expect(result.shared_youtube_profile).toBeUndefined();
    expect(e.inference).not.toHaveBeenCalled();
    expect(e.fileStart).not.toHaveBeenCalled();
    expect(e.pairSave).not.toHaveBeenCalled();
    expect(e.pairStage).not.toHaveBeenCalled();
    expect(e.cancel).not.toHaveBeenCalled();
    expect(e.close).toHaveBeenCalledOnce();
    expect(e.onCloudJob).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ firebase_uid: e.session.firebase_uid }),
      jobId,
    );
    await expect(readFile(join(e.workRoot, "cloud.m4a"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
    expect(JSON.stringify(result)).not.toContain("signature=");
    expect(
      JSON.stringify(vi.mocked(e.hooks.onDiagnostic).mock.calls),
    ).not.toContain(e.session.id_token);
  });

  it.each(["LOCAL_MACOS", "LOCAL_WINDOWS"] as const)(
    "refuses provider %s before authorizing or acquiring",
    async (provider) => {
      const e = await fixture();
      await expect(
        e.provider.prepare({ ...request, provider }, e.workRoot, e.hooks),
      ).rejects.toMatchObject({ code: "INVALID_CLOUD_REQUEST" });
      expect(e.sessionAccess).not.toHaveBeenCalled();
      expect(e.acquire).not.toHaveBeenCalled();
    },
  );

  it("requires an app account before acquisition", async () => {
    const e = await fixture();
    e.sessionAccess.mockRejectedValue(new DesktopApiError("ACCOUNT_REQUIRED"));
    await expect(
      e.provider.prepare(request, e.workRoot, e.hooks),
    ).rejects.toMatchObject({ code: "ACCOUNT_REQUIRED" });
    expect(e.acquire).not.toHaveBeenCalled();
    expect(e.start).not.toHaveBeenCalled();
  });

  it("rejects a different backend video before downloading vocals", async () => {
    const e = await fixture();
    e.cloudResult.job.source_url =
      "https://www.youtube.com/watch?v=lmnopqrstuv";
    await expect(
      e.provider.prepare(request, e.workRoot, e.hooks),
    ).rejects.toMatchObject({ code: "SOURCE_IDENTITY_MISMATCH" });
    expect(e.cache).not.toHaveBeenCalled();
    expect(e.acquire).not.toHaveBeenCalled();
  });

  it("fences an account change before submitting the URL", async () => {
    const e = await fixture();
    e.changeOwner();
    await expect(
      e.provider.prepare(request, e.workRoot, e.hooks),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(e.start).not.toHaveBeenCalled();
    expect(e.acquire).not.toHaveBeenCalled();
  });

  it.each(["PROCESSING_ALLOWANCE_EXHAUSTED", "API_UNAVAILABLE"])(
    "passes %s through without retry or local fallback",
    async (code) => {
      const e = await fixture();
      e.start.mockRejectedValue(new DesktopApiError(code));
      await expect(
        e.provider.prepare(request, e.workRoot, e.hooks),
      ).rejects.toMatchObject({ code });
      expect(e.start).toHaveBeenCalledOnce();
      expect(e.inference).not.toHaveBeenCalled();
      expect(e.fileStart).not.toHaveBeenCalled();
      expect(e.cache).not.toHaveBeenCalled();
      expect(e.cancel).toHaveBeenCalledOnce();
    },
  );

  it("fences a late cloud completion before account cache or browser publication", async () => {
    const e = await fixture();
    e.start.mockImplementation(async () => {
      e.changeOwner();
      return e.cloudResult;
    });
    await expect(
      e.provider.prepare(request, e.workRoot, e.hooks),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(e.cache).not.toHaveBeenCalled();
    expect(e.onCloudJob).not.toHaveBeenCalled();
    expect(e.cancel).not.toHaveBeenCalled();
    await expect(
      readFile(join(e.workRoot, "vocals.mp3")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fences a late account cache completion before copying vocals or notifying the app", async () => {
    const e = await fixture();
    e.cache.mockImplementation(async () => {
      e.changeOwner();
      return e.cached;
    });
    await expect(
      e.provider.prepare(request, e.workRoot, e.hooks),
    ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(e.onCloudJob).not.toHaveBeenCalled();
    await expect(
      readFile(join(e.workRoot, "vocals.mp3")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["trim", "recipe"])(
    "refuses an incompatible cloud %s before downloading",
    async (field) => {
      const e = await fixture();
      if (field === "trim") e.cloudResult.job.trim_enabled = true;
      else e.cloudResult.job.recipe_digest = "b".repeat(64);
      await expect(
        e.provider.prepare(request, e.workRoot, e.hooks),
      ).rejects.toMatchObject({ code: "TIMELINE_INCOMPATIBLE" });
      expect(e.cache).not.toHaveBeenCalled();
    },
  );

  it("refuses measured timeline loss after cloud output validation", async () => {
    const e = await fixture();
    e.cached.duration_seconds = 59;
    await expect(
      e.provider.prepare(request, e.workRoot, e.hooks),
    ).rejects.toMatchObject({ code: "TIMELINE_MISMATCH" });
    expect(e.onCloudJob).not.toHaveBeenCalled();
    await expect(
      readFile(join(e.workRoot, "vocals.mp3")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["corrupt", "symlink"])(
    "refuses a %s cache artifact before player publication",
    async (kind) => {
      const e = await fixture();
      e.cache.mockImplementation(async () => {
        if (kind === "corrupt")
          await writeFile(e.cached.vocal_path, Buffer.alloc(bytes.length), {
            mode: 0o600,
          });
        else {
          const foreign = join(e.root, "foreign.mp3");
          await writeFile(foreign, bytes, { mode: 0o600 });
          await symlink(foreign, e.cached.vocal_path);
        }
        return e.cached;
      });
      await expect(
        e.provider.prepare(request, e.workRoot, e.hooks),
      ).rejects.toBeDefined();
      expect(e.onCloudJob).not.toHaveBeenCalled();
      await expect(
        readFile(join(e.workRoot, "vocals.mp3")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves an existing output when exclusive scratch creation is refused", async () => {
    const e = await fixture();
    const target = join(e.workRoot, "vocals.mp3");
    await writeFile(target, "existing private scratch", { mode: 0o600 });
    await expect(
      e.provider.prepare(request, e.workRoot, e.hooks),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(target, "utf8")).toBe("existing private scratch");
    expect(e.onCloudJob).not.toHaveBeenCalled();
  });

  it("preserves pending-save vocals when the shared cache budget cannot admit a cloud result", async () => {
    const e = await fixture();
    e.cache.mockRestore();
    await withCacheMutation(e.config.cache_root, () =>
      writeOfflineCacheBudget(e.config.cache_root, 1_000_000_000),
    );
    const key = "f".repeat(64),
      directory = join(e.root, "vocals", key),
      protectedPath = join(directory, "vocals.mp3");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(protectedPath, "wx", 0o600);
    try {
      await file.truncate(1_000_000_000);
    } finally {
      await file.close();
    }
    const pinnedCacheKeys = vi.fn().mockResolvedValue(new Set([key]));
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("UNEXPECTED_TRANSFER"));
    const provider = new BrowserCloudProvider(e.config, {
      session: e.sessionAccess,
      verifyCurrent: e.verifyCurrent,
      pinnedCacheKeys,
      fetcher,
    });
    await expect(
      withCacheMutation(e.config.cache_root, () =>
        provider.prepare(request, e.workRoot, e.hooks),
      ),
    ).rejects.toMatchObject({ message: "OFFLINE_CACHE_FULL" });
    expect(pinnedCacheKeys).toHaveBeenCalled();
    expect((await stat(protectedPath)).size).toBe(1_000_000_000);
    expect(fetcher).not.toHaveBeenCalled();
    expect(e.onCloudJob).not.toHaveBeenCalled();
  });

  it("downloads checksum-verified vocals without local media tools under the JobManager lease", async () => {
    const e = await fixture();
    e.cache.mockRestore();
    e.config.ffmpeg_path = execFileSync("which", ["ffmpeg"], {
      encoding: "utf8",
    }).trim();
    e.config.ffprobe_path = "/unavailable/ffprobe";
    const audio = execFileSync(
      e.config.ffmpeg_path,
      [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=880:duration=60",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "160k",
        "-ar",
        "44100",
        "-ac",
        "2",
        "-f",
        "mp3",
        "pipe:1",
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    e.config.ffmpeg_path = "/unavailable/ffmpeg";
    e.cloudResult.job.output!.bytes = audio.length;
    e.cloudResult.job.output!.sha256 = Buffer.from(
      digest(audio),
      "hex",
    ).toString("base64");
    e.cloudResult.job.output!.duration_seconds = null;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array(audio), {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(audio.length),
        },
      }),
    );
    const provider = new BrowserCloudProvider(e.config, {
      session: e.sessionAccess,
      verifyCurrent: e.verifyCurrent,
      fetcher,
    });
    const result = await withCacheMutation(e.config.cache_root, () =>
      provider.prepare(request, e.workRoot, e.hooks),
    );
    expect(await readFile(result.output_path)).toEqual(audio);
    expect(result.sha256).toBe(digest(audio));
    expect(Math.abs(result.duration_seconds - 60)).toBeLessThanOrEqual(0.25);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(e.inference).not.toHaveBeenCalled();
    await expect(
      readFile(join(e.root, ".mutation.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels one accepted URL job on Stop with a separately authorized command", async () => {
    const e = await fixture();
    e.start.mockRestore();
    e.cancel.mockRestore();
    vi.spyOn(AccountRealtimeClient.prototype, "start").mockImplementation(
      () => {},
    );
    vi.spyOn(AccountRealtimeClient.prototype, "watch").mockImplementation(
      () => {
        queueMicrotask(() => e.controller.abort());
        return () => {};
      },
    );
    const api = vi
      .spyOn(AccountApiClient.prototype, "request")
      .mockImplementation(async (_scope, path, _method, _body, signal) => {
        if (path === "/media-imports")
          return {
            import_id: jobId,
            job_id: jobId,
            status: "submitted",
            error_code: null,
          };
        if (path.endsWith("/cancellations")) {
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(signal!.aborted).toBe(false);
          return { id: jobId, status: "cancel_requested" };
        }
        throw new Error("UNEXPECTED_API_REQUEST");
      });
    await expect(
      e.provider.prepare(request, e.workRoot, e.hooks),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(api.mock.calls.map((call) => call[1])).toEqual([
      "/media-imports",
      `/jobs/${jobId}/cancellations`,
    ]);
    expect(e.cache).not.toHaveBeenCalled();
    expect(e.close).toHaveBeenCalledOnce();
    await expect(readFile(join(e.workRoot, "cloud.m4a"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("refreshes the app session for cancellation without the aborted work signal", async () => {
    const e = await fixture();
    e.start.mockRestore();
    e.cancel.mockRestore();
    vi.spyOn(AccountRealtimeClient.prototype, "start").mockImplementation(
      () => {},
    );
    const watch = vi
      .spyOn(AccountRealtimeClient.prototype, "watch")
      .mockImplementation(() => () => {});
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (target) => {
      const path = new URL(String(target)).pathname;
      let body: unknown;
      if (path === "/media-imports")
        body = {
          import_id: jobId,
          job_id: jobId,
          status: "submitted",
          error_code: null,
        };
      else if (path.endsWith("/cancellations"))
        body = { id: jobId, status: "cancel_requested" };
      else throw new Error("UNEXPECTED_API_REQUEST");
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const provider = new BrowserCloudProvider(e.config, {
      session: e.sessionAccess,
      verifyCurrent: e.verifyCurrent,
      fetcher,
    });
    const result = provider.prepare(request, e.workRoot, e.hooks);
    const rejection = expect(result).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await vi.waitFor(() => expect(watch).toHaveBeenCalledOnce());
    e.controller.abort();
    await rejection;
    const sessionCancelSignal = e.sessionAccess.mock.calls.at(-1)?.[0];
    expect(sessionCancelSignal).toBeInstanceOf(AbortSignal);
    expect(sessionCancelSignal).not.toBe(e.controller.signal);
    expect(sessionCancelSignal.aborted).toBe(false);
    expect(
      e.sessionAccess.mock.calls
        .slice(0, -1)
        .every((args) => args[0] === e.controller.signal),
    ).toBe(true);
    expect(
      fetcher.mock.calls.map((call) => new URL(String(call[0])).pathname),
    ).toEqual(["/media-imports", `/jobs/${jobId}/cancellations`]);
    const cancelSignal = fetcher.mock.calls.at(-1)?.[1]?.signal;
    expect(cancelSignal).toBeInstanceOf(AbortSignal);
    expect(cancelSignal).not.toBe(e.controller.signal);
    expect(cancelSignal!.aborted).toBe(false);
  });

  it("contains remote cancellation failures and reports only a fixed local code", async () => {
    const e = await fixture();
    e.start.mockRejectedValue(new DesktopApiError("UPLOAD_REJECTED"));
    e.cancel.mockRejectedValue(
      new Error("private-token-and-provider-exception"),
    );
    await expect(
      e.provider.prepare(request, e.workRoot, e.hooks),
    ).rejects.toMatchObject({ code: "UPLOAD_REJECTED" });
    expect(e.cancel).toHaveBeenCalledOnce();
    expect(e.close).toHaveBeenCalledOnce();
    expect(e.hooks.onDiagnostic).toHaveBeenCalledExactlyOnceWith({
      component: "companion",
      severity: "warning",
      event: "diagnostic_error",
      code: "CLOUD_CANCELLATION_UNAVAILABLE",
    });
    expect(
      JSON.stringify(vi.mocked(e.hooks.onDiagnostic).mock.calls),
    ).not.toContain("private-token");
  });
});
