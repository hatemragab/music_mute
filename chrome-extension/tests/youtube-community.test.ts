import type {
  StartPayload,
  PipelineHooks,
  LocalAudioArtifact,
} from "../src/shared/protocol.js";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopApiError } from "../src/companion/account-api.js";
import type { LocalConfig } from "../src/companion/config.js";
import {
  executeDesktopRequest,
  publicApiOrigin,
} from "../src/companion/desktop-service.js";
import { DesktopCatalog } from "../src/companion/desktop-catalog.js";
import * as files from "../src/companion/file-provider.js";
import type { GuestCredentialStore } from "../src/companion/guest-credentials.js";
import { Diagnostics } from "../src/companion/diagnostics.js";
import { JobManager } from "../src/companion/jobs.js";
import { MediaServer } from "../src/companion/media-server.js";
import { releaseCommunityPlayback } from "../src/companion/community-playback.js";
import { MODEL_SHA256 } from "../src/companion/local-provider.js";
import {
  CloudProcessingProvider,
  FULL_TIMELINE_RECIPE_DIGEST,
  parseJobMetadata,
} from "../src/companion/cloud-provider.js";
import { LocalSyncOutbox } from "../src/companion/sync-outbox.js";
import {
  parseCommunityDelivery,
  YouTubeCommunityClient,
  YOUTUBE_COMMUNITY_PROFILE,
  type CommunitySocket,
} from "../src/companion/youtube-community-client.js";
import { YouTubeCommunityOutbox } from "../src/companion/youtube-community-outbox.js";
import { SharedYouTubeProvider } from "../src/companion/youtube-community-provider.js";
import {
  parseYouTubeVideoId,
  type JobSnapshot,
  type ProcessingProvider,
} from "../src/shared/protocol.js";

const videoId = "bZxrIoCPsOc";
const token = "g".repeat(64);
const id = "0123456789abcdef01234567";
const originalBytes = Buffer.from("synthetic original bytes"),
  vocalBytes = Buffer.from("synthetic vocal bytes");
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const declaration = (kind: "original" | "vocals") => ({
  extension: kind === "original" ? "m4a" : "mp3",
  content_type: kind === "original" ? "audio/mp4" : "audio/mpeg",
  duration_seconds: 5,
  bytes: (kind === "original" ? originalBytes : vocalBytes).length,
  sha256: Buffer.from(
    digest(kind === "original" ? originalBytes : vocalBytes),
    "hex",
  ).toString("base64"),
});
const expiry = () => new Date(Date.now() + 300_000).toISOString();
const delivery = () => ({
  video_id: videoId,
  profile_id: YOUTUBE_COMMUNITY_PROFILE,
  provenance: "community_contributed",
  source_identity_verified: false,
  original: {
    declaration: declaration("original"),
    grant: {
      url: "https://fixture.r2.cloudflarestorage.com/original?signature=private",
      expires_at: expiry(),
    },
  },
  vocals: {
    declaration: declaration("vocals"),
    grant: {
      url: "https://fixture.r2.cloudflarestorage.com/vocals?signature=private",
      expires_at: expiry(),
    },
  },
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function vault(): GuestCredentialStore {
  let value: Awaited<ReturnType<GuestCredentialStore["load"]>> = {
    token,
    expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
  };
  return {
    load: vi.fn(async () => value),
    save: vi.fn(async (next) => {
      value = next;
    }),
  };
}
class Socket {
  readyState = 1 as const;
  onopen: CommunitySocket["onopen"] = null;
  onmessage: CommunitySocket["onmessage"] = null;
  onclose: CommunitySocket["onclose"] = null;
  onerror: CommunitySocket["onerror"] = null;
  send = vi.fn();
  close = vi.fn();
  opened() {
    this.onopen?.call(this as unknown as WebSocket, {} as Event);
  }
  snapshot(state: string, sequence = 1) {
    this.onmessage?.call(
      this as unknown as WebSocket,
      {
        data: JSON.stringify({
          type: "snapshot",
          video_id: videoId,
          state,
          expires_at: state === "ready" ? null : expiry(),
          sequence,
        }),
      } as MessageEvent,
    );
  }
}
function server() {
  let cached = false,
    offline = false,
    requestId = "",
    following = false,
    grantsUnavailable = false,
    grantsWaiting = false,
    oldContributionMissing = false,
    expectedToken = token,
    contributionId = id;
  const uploaded = new Set<string>(),
    socket = new Socket();
  const calls: {
    url: string;
    init: RequestInit | undefined;
    body: Record<string, unknown> | undefined;
  }[] = [];
  const view = (state = "preparing", grants: unknown = null) => ({
    contribution_id: contributionId,
    request_id: requestId,
    video_id: videoId,
    profile_id: YOUTUBE_COMMUNITY_PROFILE,
    state,
    producer: !following,
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    lease_expires_at: expiry(),
    upload_grants: grants,
  });
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input),
      body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : undefined;
    calls.push({ url, init, body });
    if (url.includes(".r2.cloudflarestorage.com")) {
      expect(init?.headers).not.toHaveProperty("Authorization");
      const kind = new URL(url).pathname.slice(1);
      if (init?.method === "PUT") {
        if (offline) throw new Error("network contains private URL");
        uploaded.add(kind);
        return new Response(null, { status: 200 });
      }
      const bytes = kind === "original" ? originalBytes : vocalBytes;
      return new Response(bytes, {
        headers: {
          "Content-Type": kind === "original" ? "audio/mp4" : "audio/mpeg",
          "Content-Length": String(bytes.length),
        },
      });
    }
    if (url.endsWith("/youtube-guest-sessions")) {
      expect(init?.headers).not.toHaveProperty("Authorization");
      return json({
        token,
        expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
      });
    }
    expect(init?.headers).toHaveProperty(
      "Authorization",
      `Bearer ${expectedToken}`,
    );
    if (url.endsWith("/youtube-cache-deliveries"))
      return cached
        ? json(delivery())
        : json({ code: "IMPORT_CACHE_MISS" }, 404);
    if (url.endsWith("/youtube-contributions")) {
      requestId = String(body?.request_id);
      if (oldContributionMissing) contributionId = "0123456789abcdef01234568";
      return json(view(following ? "waiting" : "preparing"));
    }
    if (url.endsWith("/source-deliveries"))
      return json({
        video_id: videoId,
        provenance: "trusted",
        source_identity_verified: true,
        original: delivery().original,
      });
    if (url.endsWith("/lease-renewals")) return json(view());
    if (url.endsWith("/failures")) return json(view("failed"));
    if (url.endsWith("/upload-grants")) {
      if (oldContributionMissing && url.includes(`/${id}/`))
        return json({ code: "YOUTUBE_CONTRIBUTION_NOT_FOUND" }, 404);
      expect(body?.request_id).toBe(requestId);
      if (grantsUnavailable) throw new Error("offline before grant freeze");
      if (grantsWaiting) {
        grantsWaiting = false;
        return json({ ...view("waiting"), producer: false });
      }
      if (cached) return json(view("ready"));
      const grants = Object.fromEntries(
        (["original", "vocals"] as const).map((kind) => [
          kind,
          {
            method: "PUT",
            url: `https://fixture.r2.cloudflarestorage.com/${kind}?signature=private`,
            expires_at: expiry(),
            headers: {
              "Content-Type": declaration(kind).content_type,
              "If-None-Match": "*",
              "x-amz-checksum-sha256": declaration(kind).sha256,
              "x-amz-meta-sha256": declaration(kind).sha256,
            },
          },
        ]),
      );
      return json(view("awaiting_upload", grants));
    }
    if (url.endsWith("/completions")) {
      if (uploaded.size !== 2) return json({ code: "UPLOAD_NOT_READY" }, 409);
      cached = true;
      return json(view("ready"));
    }
    throw new Error("unexpected request");
  });
  const client = new YouTubeCommunityClient(
    "https://api.music-mute.com",
    vault(),
    fetcher,
    () => {
      queueMicrotask(() => socket.opened());
      return socket;
    },
  );
  return {
    client,
    fetcher,
    calls,
    socket,
    cached: (value: boolean) => {
      cached = value;
    },
    offline: (value: boolean) => {
      offline = value;
    },
    following: () => {
      following = true;
    },
    unavailableGrants: (value: boolean) => {
      grantsUnavailable = value;
    },
    waitForGrants: () => {
      grantsWaiting = true;
    },
    rotateCapability: (nextToken: string) => {
      expectedToken = nextToken;
      oldContributionMissing = true;
    },
  };
}
async function environment(
  options: { deferPublication?: boolean; onStaged?: () => void } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mm-community-"));
  roots.push(root);
  const config: LocalConfig = {
    root,
    cache_root: join(root, "cache"),
    logs_root: join(root, "logs"),
    models_root: join(root, "models"),
    python_path: "/usr/bin/true",
    node_path: process.execPath,
    ffmpeg_path: "/usr/bin/true",
    ffprobe_path: "/usr/bin/true",
    yt_dlp_path: "/usr/bin/true",
    js_runtime_path: process.execPath,
    engine_root: root,
    runner_path: join(root, "runner.py"),
  };
  const prepare = vi.fn<ProcessingProvider["prepare"]>(
    async (request, work) => {
      await mkdir(work, { recursive: true, mode: 0o700 });
      const original = join(work, "source.m4a"),
        vocals = join(work, "vocals.mp3");
      await writeFile(original, originalBytes, { mode: 0o600 });
      await writeFile(vocals, vocalBytes, { mode: 0o600 });
      return {
        output_path: vocals,
        source_duration_seconds: 5,
        duration_seconds: 5,
        bytes: vocalBytes.length,
        sha256: digest(vocalBytes),
        model_id: MODEL_SHA256,
        trim_enabled: false,
        timings_ms: {},
        original: {
          path: original,
          ...declaration("original"),
          sha256: digest(originalBytes),
        },
        source: {
          kind: "youtube",
          video_id: request.video_id,
          format_id: "140",
          audio_track_id: null,
          audio_is_default: null,
          language: null,
        },
      };
    },
  );
  const base: ProcessingProvider = { id: "LOCAL_MACOS", prepare },
    s = server(),
    validate = vi.fn(async () => {});
  const provider = new SharedYouTubeProvider(
    config,
    base,
    async () => s.client,
    s.fetcher,
    validate,
    options,
  );
  const hooks = {
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    onDiagnostic: vi.fn(),
  };
  const request = {
    video_id: videoId,
    duration_seconds: 5,
    provider: "LOCAL_MACOS" as const,
  };
  return {
    root,
    config,
    prepare,
    base,
    provider,
    hooks,
    request,
    validate,
    ...s,
  };
}

describe("YouTube installation sharing", () => {
  it("processes a fresh native YouTube request signed out with no account configuration", async () => {
    const e = await environment();
    e.config.app_resources = e.root;
    const makeClient = vi.fn(
      async () =>
        new YouTubeCommunityClient(
          await publicApiOrigin(e.config),
          { load: vi.fn(), save: vi.fn() },
          e.fetcher,
        ),
    );
    const result = await executeDesktopRequest(
      e.config,
      {
        protocol_version: 1,
        request_id: randomUUID(),
        type: "LOCAL_START",
        payload: {
          source_kind: "url",
          youtube_url: `https://www.youtube.com/watch?v=${videoId}`,
        },
      },
      () => {},
      e.hooks.signal,
      {
        isCurrent: () => true,
        localProvider: e.base,
        communityClient: makeClient,
        inspectYouTube: async () => ({ duration_seconds: 5 }),
        fetcher: e.fetcher,
      },
    );
    expect(result.cache_hit).toBe(false);
    expect(await readFile(result.vocal_path as string)).toEqual(vocalBytes);
    expect(e.prepare).toHaveBeenCalledOnce();
    expect(makeClient).toHaveBeenCalledOnce();
    expect(e.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "ACCOUNT_NOT_CONFIGURED",
    "GUEST_CREDENTIALS_UNAVAILABLE",
    "COMMUNITY_UNAVAILABLE",
    "COMMUNITY_SESSION_UNAVAILABLE",
  ])(
    "keeps fresh Chrome local processing available when shared reuse fails: %s",
    async (code) => {
      const e = await environment();
      const ready = vi.fn(async () => {});
      const provider = new SharedYouTubeProvider(
        e.config,
        e.base,
        async () => {
          throw new DesktopApiError(code);
        },
        e.fetcher,
        e.validate,
        { beforeLocalPrepare: ready },
      );
      const audio = await provider.prepare(
        e.request,
        join(e.root, "work"),
        e.hooks,
      );
      expect(await readFile(audio.output_path)).toEqual(vocalBytes);
      expect(ready).toHaveBeenCalledOnce();
      expect(e.prepare).toHaveBeenCalledOnce();
      expect(audio).not.toHaveProperty("shared_youtube_profile");
      expect(audio).not.toHaveProperty("publication_pending");
      expect(e.fetcher).not.toHaveBeenCalled();
    },
  );

  it("keeps cancellation authoritative when optional shared initialization fails", async () => {
    const e = await environment(),
      controller = new AbortController();
    const provider = new SharedYouTubeProvider(e.config, e.base, async () => {
      controller.abort();
      throw new DesktopApiError("ACCOUNT_NOT_CONFIGURED");
    });
    await expect(
      provider.prepare(e.request, join(e.root, "work"), {
        ...e.hooks,
        signal: controller.signal,
      }),
    ).rejects.toThrow("CANCELLED");
    expect(e.prepare).not.toHaveBeenCalled();
  });

  it("does not run local processing twice after a producer has started", async () => {
    const e = await environment();
    e.prepare.mockRejectedValue(new DesktopApiError("COMMUNITY_UNAVAILABLE"));
    await expect(
      e.provider.prepare(e.request, join(e.root, "work"), e.hooks),
    ).rejects.toThrow("COMMUNITY_UNAVAILABLE");
    expect(e.prepare).toHaveBeenCalledOnce();
  });

  it("normalizes a guest-session network failure so local processing can continue", async () => {
    const e = await environment();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("fetch failed"));
    const provider = new SharedYouTubeProvider(
      e.config,
      e.base,
      async () =>
        new YouTubeCommunityClient(
          "https://api.music-mute.com",
          {
            load: async () => null,
            save: vi.fn(),
          },
          fetcher,
        ),
    );
    const audio = await provider.prepare(
      e.request,
      join(e.root, "work"),
      e.hooks,
    );
    expect(audio.sha256).toBe(digest(vocalBytes));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(e.prepare).toHaveBeenCalledOnce();
  });

  it("creates one guest session and saves its bearer only through the credential vault", async () => {
    const s = server();
    s.cached(true);
    const store: GuestCredentialStore = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {}),
    };
    const client = new YouTubeCommunityClient(
      "https://api.music-mute.com",
      store,
      s.fetcher,
    );
    await client.lookup(videoId, 5);
    await client.lookup(videoId, 5);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith({
      token,
      expires_at: expect.any(String),
    });
    expect(
      s.calls.filter((call) => call.url.endsWith("/youtube-guest-sessions")),
    ).toHaveLength(1);
    expect(s.calls.every((call) => !call.url.includes(token))).toBe(true);
  });
  it("renews a near-expiry capability before reserving a full-day producer", async () => {
    const s = server(),
      store = vault();
    store.load = vi.fn(async () => ({
      token,
      expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
    }));
    const client = new YouTubeCommunityClient(
      "https://api.music-mute.com",
      store,
      s.fetcher,
    );
    await client.reserve(videoId, new AbortController().signal);
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(s.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/youtube-guest-sessions",
      "/youtube-contributions",
    ]);
  });
  it.each([
    "https://www.youtube.com/watch?v=bZxrIoCPsOc&list=RDbZxrIoCPsOc&start_radio=1",
    "https://youtu.be/bZxrIoCPsOc?si=RLbbOevlM4lBmXHi",
  ])(
    "reuses another installation's private pair with no provider call for %s",
    async (url) => {
      const e = await environment();
      e.cached(true);
      const audio = await e.provider.prepare(
        { ...e.request, video_id: parseYouTubeVideoId(url)! },
        join(e.root, "work"),
        e.hooks,
      );
      expect(e.prepare).not.toHaveBeenCalled();
      expect(e.validate).toHaveBeenCalledTimes(1);
      expect(audio.original).toBeUndefined();
      expect(audio.original_declaration?.sha256).toBe(digest(originalBytes));
      expect(audio.shared_youtube_profile).toBe(YOUTUBE_COMMUNITY_PROFILE);
      expect(
        e.calls
          .filter((call) => call.url.includes(".r2."))
          .map((call) => new URL(call.url).pathname),
      ).toEqual(["/vocals"]);
      expect(
        e.calls.filter((call) => call.url.includes("/youtube-contributions")),
      ).toHaveLength(0);
      expect(
        e.calls.find((call) => call.url.endsWith("/youtube-cache-deliveries"))
          ?.body,
      ).toEqual({ url: `https://www.youtube.com/watch?v=${videoId}` });
      expect(
        e.calls
          .filter((call) => call.url.includes(".r2."))
          .every((call) => !JSON.stringify(call.init?.headers).includes(token)),
      ).toBe(true);
    },
  );
  it("reserves one producer and stages exact bytes without waiting for publication", async () => {
    const e = await environment();
    e.prepare.mockImplementationOnce(async (...args) => {
      expect(
        e.calls.some((call) => call.url.endsWith("/youtube-contributions")),
      ).toBe(true);
      return (await environment()).prepare(...args);
    });
    await e.provider.prepare(e.request, join(e.root, "work"), e.hooks);
    expect(e.prepare).toHaveBeenCalledTimes(1);
    const outbox = new YouTubeCommunityOutbox(
      join(e.root, "youtube-community-outbox"),
      e.fetcher,
    );
    const records = await outbox.records();
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe("pending");
    const record = records[0]!;
    expect(await readFile(record.original.path)).toEqual(originalBytes);
    expect(await readFile(record.vocals.path)).toEqual(vocalBytes);
    expect(
      e.calls.filter(
        (call) =>
          call.init?.method === "PUT" ||
          call.url.endsWith("/upload-grants") ||
          call.url.endsWith("/completions"),
      ),
    ).toHaveLength(0);
    await outbox.drain(e.client);
    expect((await outbox.records())[0]?.state).toBe("committed");
    await expect(readFile(record.original.path)).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
    const saved = await readFile(
      join(
        e.root,
        "youtube-community-outbox",
        record.request_id,
        "record.json",
      ),
      "utf8",
    );
    expect(saved).not.toContain(token);
    expect(saved).not.toContain("signature");
    expect(saved).not.toContain("Authorization");
    expect(saved).not.toContain("owner");
    expect(e.calls.filter((call) => call.init?.method === "PUT")).toHaveLength(
      2,
    );
  });
  it("does not join slow publication or an old backlog while preparing vocals or looking up duration", async () => {
    const e = await environment();
    await e.provider.prepare(e.request, join(e.root, "first"), e.hooks);
    const outbox = new YouTubeCommunityOutbox(
      join(e.root, "youtube-community-outbox"),
      e.fetcher,
    );
    expect((await outbox.records())[0]?.state).toBe("pending");
    let finishPublication!: () => void;
    const slowPublication = new Promise<void>((resolve) => {
      finishPublication = resolve;
    });
    const drain = vi
      .spyOn(YouTubeCommunityOutbox.prototype, "drain")
      .mockImplementation(() => slowPublication);
    e.cached(true);
    try {
      expect(await e.provider.sharedDuration(videoId, e.hooks.signal)).toBe(5);
      const prepared = await e.provider.prepare(
        e.request,
        join(e.root, "second"),
        e.hooks,
      );
      expect(prepared.sha256).toBe(digest(vocalBytes));
      expect(drain).not.toHaveBeenCalled();
      expect(e.prepare).toHaveBeenCalledTimes(1);
    } finally {
      finishPublication();
    }
  });
  it("retains a deferred pair after cancellation and scratch cleanup until explicit release", async () => {
    const e = await environment({ deferPublication: true });
    const controller = new AbortController();
    const work = join(e.root, "work");
    const audio = await e.provider.prepare(e.request, work, {
      ...e.hooks,
      signal: controller.signal,
    });
    expect(audio.publication_pending).toBe(true);
    controller.abort();
    await rm(work, { recursive: true });
    const outbox = new YouTubeCommunityOutbox(
      join(e.root, "youtube-community-outbox"),
      e.fetcher,
    );
    await outbox.drain(e.client);
    const record = (await outbox.records())[0]!;
    expect(record.state).toBe("pending");
    expect(record.publication_ready).toBe(false);
    expect(await readFile(record.original.path)).toEqual(originalBytes);
    expect(await readFile(record.vocals.path)).toEqual(vocalBytes);
    expect(e.calls.some((call) => call.init?.method === "PUT")).toBe(false);
    await outbox.release(videoId, digest(vocalBytes));
    await outbox.drain(e.client);
    expect((await outbox.records())[0]?.state).toBe("committed");
    expect(e.prepare).toHaveBeenCalledTimes(1);
  });
  it("retries a job cancelled after durable staging without acquisition and releases only after playback acknowledgement", async () => {
    let manager!: JobManager;
    let cancellation: Promise<void> | undefined;
    const e = await environment({
      deferPublication: true,
      onStaged: () => {
        cancellation ??= manager.cancel(manager.current()!.job_id);
      },
    });
    const diagnostics = new Diagnostics(e.config.logs_root);
    const media = new MediaServer(
      "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    await media.start();
    let terminal: ((snapshot: JobSnapshot) => void) | undefined;
    const outcome = () =>
      new Promise<JobSnapshot>((resolve) => {
        terminal = resolve;
      });
    manager = new JobManager(
      e.config.cache_root,
      e.provider,
      diagnostics,
      media,
      (snapshot) => {
        if (["READY", "FAILED", "CANCELLED"].includes(snapshot.state))
          terminal?.(snapshot);
      },
    );
    try {
      let done = outcome();
      const cancelled = await manager.start(e.request);
      expect(await done).toMatchObject({ state: "CANCELLED" });
      await cancellation;
      await expect(
        readFile(
          join(e.config.cache_root, "jobs", cancelled.job_id, "vocals.mp3"),
        ),
      ).rejects.toHaveProperty("code", "ENOENT");
      const beforeRetry = e.calls.length;
      expect(await e.provider.sharedDuration(videoId, e.hooks.signal)).toBe(5);
      done = outcome();
      await manager.start(e.request);
      const ready = await done;
      expect(ready).toMatchObject({ state: "READY", save_state: "pending" });
      expect(e.calls).toHaveLength(beforeRetry);
      expect(e.prepare).toHaveBeenCalledTimes(1);
      const outbox = new YouTubeCommunityOutbox(
        join(e.root, "youtube-community-outbox"),
        e.fetcher,
      );
      expect((await outbox.records())[0]?.publication_ready).toBe(false);
      expect(e.calls.some((call) => call.init?.method === "PUT")).toBe(false);
      expect(
        await releaseCommunityPlayback(
          manager.current(),
          {
            job_id: ready.job_id,
            video_id: videoId,
            sha256: digest(vocalBytes),
          },
          { job_id: ready.job_id, video_id: videoId },
          outbox,
          () => outbox.drain(e.client),
        ),
      ).toBe(true);
      expect((await outbox.records())[0]?.state).toBe("committed");
    } finally {
      await manager.close();
      await media.close();
      diagnostics.close();
    }
  });
  it("lets native playback recover a held Chrome pair and enables independent publication", async () => {
    const e = await environment({ deferPublication: true });
    const work = join(e.root, "first");
    await e.provider.prepare(e.request, work, e.hooks);
    await rm(work, { recursive: true });
    const staged = vi.fn();
    const native = new SharedYouTubeProvider(
      e.config,
      e.base,
      async () => e.client,
      e.fetcher,
      e.validate,
      { onStaged: staged },
    );
    const beforeRetry = e.calls.length;
    const restored = await native.prepare(
      e.request,
      join(e.root, "native"),
      e.hooks,
    );
    expect(restored).not.toHaveProperty("publication_pending");
    expect(await readFile(restored.output_path)).toEqual(vocalBytes);
    expect(e.prepare).toHaveBeenCalledTimes(1);
    expect(e.calls).toHaveLength(beforeRetry);
    expect(staged).toHaveBeenCalledTimes(1);
    const outbox = new YouTubeCommunityOutbox(
      join(e.root, "youtube-community-outbox"),
      e.fetcher,
    );
    expect((await outbox.records())[0]?.publication_ready).toBe(true);
    await outbox.drain(e.client);
    expect((await outbox.records())[0]?.state).toBe("committed");
  });
  it("replays an offline pair after scratch cleanup without YouTube acquisition or inference", async () => {
    const e = await environment();
    e.offline(true);
    const work = join(e.root, "work");
    await e.provider.prepare(e.request, work, e.hooks);
    await rm(work, { recursive: true });
    const outbox = new YouTubeCommunityOutbox(
      join(e.root, "youtube-community-outbox"),
      e.fetcher,
    );
    const pending = (await outbox.records())[0]!;
    expect(pending.state).toBe("pending");
    expect(await readFile(pending.original.path)).toEqual(originalBytes);
    e.offline(false);
    await outbox.drain(e.client);
    expect((await outbox.records())[0]?.state).toBe("committed");
    expect(e.prepare).toHaveBeenCalledTimes(1);
    expect(
      e.calls.filter((call) => call.url.endsWith("/youtube-contributions")),
    ).toHaveLength(1);
  });
  it("recovers prepared bytes after a lost preparation lease and follows another producer without overwrite", async () => {
    const e = await environment();
    e.unavailableGrants(true);
    const work = join(e.root, "work");
    await e.provider.prepare(e.request, work, e.hooks);
    await rm(work, { recursive: true });
    const outbox = new YouTubeCommunityOutbox(
      join(e.root, "youtube-community-outbox"),
      e.fetcher,
    );
    const initial = (await outbox.records())[0]!;
    e.unavailableGrants(false);
    e.waitForGrants();
    const recovering = outbox.drain(e.client);
    await vi.waitFor(() => expect(e.socket.send).toHaveBeenCalledTimes(1));
    e.cached(true);
    e.socket.snapshot("ready");
    await recovering;
    const receipt = (await outbox.records())[0]!;
    expect(receipt.state).toBe("committed");
    expect(receipt.cache_reused).toBe(true);
    expect(receipt.contribution_id).toBe(initial.contribution_id);
    expect(receipt.request_id).toBe(initial.request_id);
    expect(e.prepare).toHaveBeenCalledTimes(1);
    expect(e.calls.filter((call) => call.init?.method === "PUT")).toHaveLength(
      0,
    );
    await expect(readFile(initial.original.path)).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });
  it("reclaims the same prepared pair on a released-producer snapshot without re-running inference", async () => {
    const e = await environment();
    e.unavailableGrants(true);
    await e.provider.prepare(e.request, join(e.root, "work"), e.hooks);
    const outbox = new YouTubeCommunityOutbox(
      join(e.root, "youtube-community-outbox"),
      e.fetcher,
    );
    const initial = (await outbox.records())[0]!;
    e.unavailableGrants(false);
    e.waitForGrants();
    const recovering = outbox.drain(e.client);
    await vi.waitFor(() => expect(e.socket.send).toHaveBeenCalledTimes(1));
    e.socket.snapshot("missing");
    await recovering;
    expect((await outbox.records())[0]?.state).toBe("committed");
    expect(e.prepare).toHaveBeenCalledTimes(1);
    expect(
      e.calls
        .filter((call) => call.url.endsWith("/upload-grants"))
        .every((call) => call.body?.request_id === initial.request_id),
    ).toBe(true);
    expect(
      e.calls.filter((call) => call.url.endsWith("/youtube-contributions")),
    ).toHaveLength(1);
  });
  it("recovers a fully durable staging directory after a crash before its final rename", async () => {
    const e = await environment();
    e.unavailableGrants(true);
    const work = join(e.root, "work");
    await e.provider.prepare(e.request, work, e.hooks);
    await rm(work, { recursive: true });
    const outbox = new YouTubeCommunityOutbox(
      join(e.root, "youtube-community-outbox"),
      e.fetcher,
    );
    const record = (await outbox.records())[0]!;
    await rename(
      join(outbox.root, record.request_id),
      join(outbox.root, `.pair-${record.request_id}`),
    );
    e.unavailableGrants(false);
    await outbox.drain(e.client);
    expect((await outbox.records())[0]?.state).toBe("committed");
    expect(e.prepare).toHaveBeenCalledTimes(1);
  });
  it("rebinds an old-capability contribution using durable bytes and new public IDs without inference", async () => {
    const e = await environment();
    e.unavailableGrants(true);
    const work = join(e.root, "work");
    await e.provider.prepare(e.request, work, e.hooks);
    await rm(work, { recursive: true });
    const outbox = new YouTubeCommunityOutbox(
      join(e.root, "youtube-community-outbox"),
      e.fetcher,
    );
    const original = (await outbox.records())[0]!;
    const nextToken = "n".repeat(64);
    e.rotateCapability(nextToken);
    e.unavailableGrants(false);
    const store: GuestCredentialStore = {
      load: async () => ({
        token: nextToken,
        expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
      }),
      save: async () => {},
    };
    await outbox.drain(
      new YouTubeCommunityClient(
        "https://api.music-mute.com",
        store,
        e.fetcher,
      ),
    );
    const rebound = (await outbox.records())[0]!;
    expect(rebound.state).toBe("committed");
    expect(rebound.request_id).toBe(original.request_id);
    expect(rebound.contribution_id).toBe("0123456789abcdef01234568");
    expect(rebound.producer_request_id).not.toBe(original.request_id);
    expect(rebound.next_request_id).toBeUndefined();
    expect(e.prepare).toHaveBeenCalledTimes(1);
    const saved = await readFile(
      join(outbox.root, original.request_id, "record.json"),
      "utf8",
    );
    expect(saved).not.toContain(token);
    expect(saved).not.toContain(nextToken);
    expect(saved).not.toContain("signature");
  });
  it("waits on authenticated full snapshots as a follower and performs no status GET", async () => {
    const e = await environment();
    e.following();
    const result = e.provider.prepare(e.request, join(e.root, "work"), e.hooks);
    await vi.waitFor(() => expect(e.socket.send).toHaveBeenCalledTimes(1));
    expect(JSON.parse(e.socket.send.mock.calls[0]![0])).toEqual({
      type: "authenticate",
      token,
      video_id: videoId,
    });
    e.socket.snapshot("preparing");
    e.cached(true);
    e.socket.snapshot("ready", 2);
    await result;
    expect(e.prepare).not.toHaveBeenCalled();
    expect(
      e.calls.some(
        (call) => call.init?.method === "GET" && call.url.includes("api.music"),
      ),
    ).toBe(false);
    expect(
      e.calls.filter((call) => call.url.endsWith("/youtube-cache-deliveries")),
    ).toHaveLength(2);
  });
  it("releases a producer on local failure and propagates a sanitized error", async () => {
    const e = await environment();
    e.prepare.mockRejectedValue(new DesktopApiError("SOURCE_BOT_CHALLENGE"));
    await expect(
      e.provider.prepare(e.request, join(e.root, "work"), e.hooks),
    ).rejects.toThrow("SOURCE_BOT_CHALLENGE");
    expect(
      e.calls.filter((call) => call.url.endsWith("/failures")),
    ).toHaveLength(1);
  });
  it("rejects redirected hosts, mismatched profiles, hashes and timelines before acquisition", async () => {
    const corrupt = delivery();
    corrupt.vocals.grant.url = "https://unrelated.example/audio";
    expect(() => parseCommunityDelivery(corrupt, videoId, 5)).toThrow(
      "COMMUNITY_GRANT_INVALID",
    );
    expect(() =>
      parseCommunityDelivery(
        { ...delivery(), profile_id: "other" },
        videoId,
        5,
      ),
    ).toThrow("COMMUNITY_REPLY_INVALID");
    expect(() => parseCommunityDelivery(delivery(), "other_id___", 5)).toThrow(
      "COMMUNITY_REPLY_INVALID",
    );
    expect(() => parseCommunityDelivery(delivery(), videoId, 10)).toThrow(
      "TIMELINE_MISMATCH",
    );
    const hash = delivery();
    hash.original.declaration.sha256 = "bad";
    expect(() => parseCommunityDelivery(hash, videoId, 5)).toThrow(
      "COMMUNITY_REPLY_INVALID",
    );
  });
  it("does not treat authentication or policy failure as a cache miss", async () => {
    const client = new YouTubeCommunityClient(
      "https://api.music-mute.com",
      vault(),
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "AUTH_REQUIRED" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await expect(client.lookup(videoId, 5)).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      status: 401,
    });
  });
  it("keeps owner links fenced by UID while allowing renewed sessions for the same owner", async () => {
    const e = await environment(),
      outbox = new YouTubeCommunityOutbox(
        join(e.root, "youtube-community-outbox"),
      );
    const owner = { uid: "owner-a", session_generation: randomUUID() };
    await outbox.linkOwner(owner, {
      cache_key: "a".repeat(64),
      video_id: videoId,
      duration_seconds: 5,
      sha256: digest(vocalBytes),
    });
    expect(
      await outbox.ownerLinks({
        uid: "owner-b",
        session_generation: randomUUID(),
      }),
    ).toEqual([]);
    const renewed = { ...owner, session_generation: randomUUID() };
    const links = await outbox.ownerLinks(renewed);
    expect(links).toHaveLength(1);
    await outbox.finishOwnerLink(renewed, links[0]!, true);
    expect((await outbox.ownerLinks(owner))[0]?.state).toBe("completed");
  });
  it("returns a ready sync receipt when a deferred owner link finds its exact shared result", async () => {
    const e = await environment(),
      session = {
        firebase_uid: "owner-a",
        session_generation: randomUUID(),
        installation_id: randomUUID(),
        id_token: "synthetic-fixture-token",
      },
      owner = {
        uid: session.firebase_uid,
        session_generation: session.session_generation,
      },
      key = "a".repeat(64),
      vocalSHA = digest(vocalBytes),
      vocalRoot = join(e.config.cache_root, "vocals", key),
      vocalPath = join(vocalRoot, "vocals.mp3"),
      catalog = new DesktopCatalog(
        join(e.root, "desktop-catalog"),
        e.config.cache_root,
      ),
      outbox = new YouTubeCommunityOutbox(
        join(e.root, "youtube-community-outbox"),
      );
    await mkdir(vocalRoot, { recursive: true, mode: 0o700 });
    await mkdir(join(e.root, "desktop-catalog"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(vocalPath, vocalBytes, { mode: 0o600 });
    await writeFile(
      join(vocalRoot, "result.json"),
      JSON.stringify({
        output_path: vocalPath,
        source_duration_seconds: 5,
        duration_seconds: 5,
        trim_enabled: false,
        bytes: vocalBytes.length,
        sha256: vocalSHA,
        model_id: MODEL_SHA256,
        source: { kind: "youtube", video_id: videoId },
      }),
      { mode: 0o600 },
    );
    await catalog.remember(owner, {
      cache_key: key,
      operation_id: randomUUID(),
      source_kind: "url",
      video_id: videoId,
      vocal_path: vocalPath,
      duration_seconds: 5,
      source_duration_seconds: 5,
      trim_enabled: false,
      bytes: vocalBytes.length,
      sha256: vocalSHA,
    });
    await outbox.linkOwner(owner, {
      cache_key: key,
      video_id: videoId,
      duration_seconds: 5,
      sha256: vocalSHA,
    });
    const [link] = await outbox.ownerLinks(owner);
    expect(link).toBeDefined();
    await outbox.finishOwnerLink(owner, link!, false);
    e.config.app_resources = join(e.root, "resources");
    await mkdir(e.config.app_resources, { mode: 0o700 });
    await writeFile(
      join(e.config.app_resources, "desktop-public-config.json"),
      JSON.stringify({ backend_base_url: "https://api.music-mute.com" }),
      { mode: 0o600 },
    );
    const job = parseJobMetadata({
      id,
      request_id: randomUUID(),
      status: "ready",
      source_kind: "url",
      source_url: `https://www.youtube.com/watch?v=${videoId}`,
      recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
      trim_enabled: false,
      input: declaration("original"),
      output: declaration("vocals"),
      can_download_input: true,
      can_download_output: true,
      error: null,
    });
    vi.spyOn(
      CloudProcessingProvider.prototype,
      "findReusableYouTube",
    ).mockResolvedValue(job);
    const result = await executeDesktopRequest(
      e.config,
      {
        protocol_version: 1,
        request_id: randomUUID(),
        type: "SYNC",
        session,
        payload: {},
      },
      () => {},
      e.hooks.signal,
      {
        isCurrent: () => true,
        communityClient: async () => e.client,
        fetcher: e.fetcher,
      },
    );
    expect(result.items).toContainEqual({
      request_id: link!.request_id,
      cache_key: key,
      state: "ready",
      job_id: id,
    });
    expect((await catalog.list(owner)).entries[0]?.job_id).toBe(id);
    expect((await outbox.ownerLinks(owner))[0]?.state).toBe("completed");
    expect(result.pending_count).toBe(0);
  });
  it("keeps native local files private and never obtains a community session", async () => {
    const e = await environment(),
      selectedRoot = join(e.config.cache_root, "selected");
    await mkdir(selectedRoot, { recursive: true, mode: 0o700 });
    const source = join(selectedRoot, "source.m4a");
    await writeFile(source, originalBytes, { mode: 0o600 });
    vi.spyOn(files, "prepareDesktopFile").mockResolvedValue({
      root: selectedRoot,
      input_path: source,
      ...declaration("original"),
      sha256: digest(originalBytes),
    });
    vi.spyOn(files.FileLocalProvider.prototype, "prepare").mockImplementation(
      async (_request, work) => {
        await mkdir(work, { recursive: true, mode: 0o700 });
        const path = join(work, "vocals.mp3");
        await writeFile(path, vocalBytes, { mode: 0o600 });
        return {
          output_path: path,
          source_duration_seconds: 5,
          duration_seconds: 5,
          bytes: vocalBytes.length,
          sha256: digest(vocalBytes),
          model_id: MODEL_SHA256,
          trim_enabled: false,
          timings_ms: {},
          original: {
            path: source,
            ...declaration("original"),
            sha256: digest(originalBytes),
          },
        };
      },
    );
    const communityClient = vi.fn(async () => e.client);
    const result = await executeDesktopRequest(
      e.config,
      {
        protocol_version: 1,
        request_id: randomUUID(),
        type: "LOCAL_START",
        payload: { source_kind: "file", source_path: source },
      },
      () => {},
      e.hooks.signal,
      { isCurrent: () => true, communityClient },
    );
    expect(result.sync_state).toBe("local_only");
    expect(communityClient).not.toHaveBeenCalled();
    expect(e.calls).toEqual([]);
  });
  it.each([
    "https://www.youtube.com/watch?v=bZxrIoCPsOc&list=RDbZxrIoCPsOc&start_radio=1",
    "https://youtu.be/bZxrIoCPsOc?si=RLbbOevlM4lBmXHi",
  ])(
    "native guest intake reuses %s without consulting YouTube metadata",
    async (url) => {
      const e = await environment();
      e.cached(true);
      const probe = join(e.root, "probe");
      await writeFile(
        probe,
        '#!/bin/sh\ncase "$*" in *m4a) format="mov,mp4,m4a";; *) format="mp3";; esac\nprintf \'{"format":{"format_name":"%s","duration":"5"},"streams":[{"codec_type":"audio","channels":2,"sample_rate":"44100"}]}\' "$format"\n',
        { mode: 0o700 },
      );
      e.config.ffprobe_path = probe;
      const inspectYouTube = vi.fn(async () => {
        throw new Error("UNEXPECTED_YOUTUBE_METADATA");
      });
      const result = await executeDesktopRequest(
        e.config,
        {
          protocol_version: 1,
          request_id: randomUUID(),
          type: "LOCAL_START",
          payload: { source_kind: "url", youtube_url: url },
        },
        () => {},
        e.hooks.signal,
        {
          isCurrent: () => true,
          localProvider: e.base,
          communityClient: async () => e.client,
          fetcher: e.fetcher,
          inspectYouTube,
        },
      );
      expect(result.video_id).toBe(videoId);
      expect(result.duration_seconds).toBe(5);
      expect(inspectYouTube).not.toHaveBeenCalled();
      expect(e.prepare).not.toHaveBeenCalled();
    },
  );
  it("signed-in native reuse creates a Library reference without an owner pair upload", async () => {
    const e = await environment();
    e.cached(true);
    const probe = join(e.root, "probe");
    await writeFile(
      probe,
      '#!/bin/sh\ncase "$*" in *m4a) format="mov,mp4,m4a";; *) format="mp3";; esac\nprintf \'{"format":{"format_name":"%s","duration":"5"},"streams":[{"codec_type":"audio","channels":2,"sample_rate":"44100"}]}\' "$format"\n',
      { mode: 0o700 },
    );
    e.config.ffprobe_path = probe;
    e.config.app_resources = join(e.root, "resources");
    await mkdir(e.config.app_resources, { mode: 0o700 });
    e.config.python_path = join(e.root, "fixture-tool-guard");
    await writeFile(
      e.config.python_path,
      '#!/bin/sh\nwhile [ "$1" != "--run" ] && [ "$#" -gt 0 ]; do shift; done\nshift\nexec "$@"\n',
      { mode: 0o700 },
    );
    await writeFile(
      join(e.config.app_resources, "desktop-public-config.json"),
      JSON.stringify({ backend_base_url: "https://api.music-mute.com" }),
      { mode: 0o600 },
    );
    const session = {
      firebase_uid: "owner-a",
      session_generation: randomUUID(),
      installation_id: randomUUID(),
      id_token: "synthetic-fixture-token",
    };
    const job = parseJobMetadata({
      id,
      request_id: randomUUID(),
      status: "ready",
      source_kind: "url",
      source_url: `https://www.youtube.com/watch?v=${videoId}`,
      recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
      trim_enabled: false,
      input: declaration("original"),
      output: declaration("vocals"),
      can_download_input: true,
      can_download_output: true,
      error: null,
    });
    const lookup = vi
      .spyOn(CloudProcessingProvider.prototype, "findReusableYouTube")
      .mockResolvedValue(job);
    const result = await executeDesktopRequest(
      e.config,
      {
        protocol_version: 1,
        request_id: randomUUID(),
        type: "LOCAL_START",
        session,
        payload: {
          source_kind: "url",
          youtube_url: `https://youtu.be/${videoId}`,
        },
      },
      () => {},
      e.hooks.signal,
      {
        isCurrent: () => true,
        localProvider: e.base,
        communityClient: async () => e.client,
        fetcher: e.fetcher,
        inspectYouTube: vi.fn(async () => {
          throw new Error("UNEXPECTED_YOUTUBE_METADATA");
        }),
      },
    );
    expect(result.job_id).toBe(id);
    expect(result.sync_state).toBe("ready");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(
      await new LocalSyncOutbox(
        join(e.root, "sync-outbox"),
        e.config.cache_root,
      ).list({
        uid: session.firebase_uid,
        session_generation: session.session_generation,
      }),
    ).toEqual([]);
    expect(
      e.calls.some((call) => call.url.includes("/local-media-syncs")),
    ).toBe(false);
    expect(e.prepare).not.toHaveBeenCalled();
  });
});

it("reuses a trusted original without local YouTube acquisition", async () => {
  const e = await environment();
  const prepareSharedOriginal = vi.fn(
    async (
      request: StartPayload,
      work: string,
      hooks: PipelineHooks,
      original: LocalAudioArtifact,
    ) => {
      expect(await readFile(original.path)).toEqual(originalBytes);
      const audio = await e.prepare(request, work, hooks);
      return audio;
    },
  );
  const provider = new SharedYouTubeProvider(
    e.config,
    { ...e.base, prepareSharedOriginal } as ProcessingProvider,
    async () => e.client,
    e.fetcher,
    e.validate,
  );
  await provider.prepare(e.request, join(e.root, "source-reuse"), e.hooks);
  expect(prepareSharedOriginal).toHaveBeenCalledTimes(1);
  expect(e.calls.some((call) => call.url.endsWith("/source-deliveries"))).toBe(
    true,
  );
});

it("plays an authenticated shared result without installed media tools", async () => {
  const e = await environment();
  e.cached(true);
  e.config.ffmpeg_path = "/missing/ffmpeg";
  e.config.ffprobe_path = "/missing/ffprobe";
  const provider = new SharedYouTubeProvider(
    e.config,
    e.base,
    async () => e.client,
    e.fetcher,
  );
  const audio = await provider.prepare(
    e.request,
    join(e.root, "no-tools"),
    e.hooks,
  );
  expect(audio.sha256).toBe(digest(vocalBytes));
  expect(e.prepare).not.toHaveBeenCalled();
});

it.each([
  [404, "IMPORT_CACHE_MISS", true],
  [404, "RESOURCE_NOT_FOUND", false],
  [401, "UNAUTHENTICATED", false],
  [409, "YOUTUBE_CONTRIBUTION_CONFLICT", false],
])(
  "original lookup only falls back on an explicit cache miss: %s %s",
  async (status, code, miss) => {
    const e = await environment();
    const reservation = await e.client.reserve(videoId, e.hooks.signal);
    e.fetcher.mockResolvedValueOnce(Response.json({ code }, { status }));
    const lookup = e.client.lookupOriginal(reservation, 5, e.hooks.signal);
    if (miss) expect(await lookup).toBeNull();
    else await expect(lookup).rejects.toMatchObject({ code, status });
  },
);

it("rejects an unverified original before downloading or processing it", async () => {
  const e = await environment();
  const reservation = await e.client.reserve(videoId, e.hooks.signal);
  e.fetcher.mockResolvedValueOnce(
    Response.json({
      video_id: videoId,
      provenance: "community_contributed",
      source_identity_verified: false,
      original: delivery().original,
    }),
  );
  await expect(
    e.client.lookupOriginal(reservation, 5, e.hooks.signal),
  ).rejects.toMatchObject({ code: "COMMUNITY_REPLY_INVALID" });
});
