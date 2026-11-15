import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BrowserAccountAuthority } from "../src/main/browser/account-authority.js";
import {
  parseBrowserAccountCommand,
  type BrowserAccountAuthorityOptions,
} from "../src/main/browser/account-contracts.js";
import {
  FULL_TIMELINE_RECIPE_DIGEST,
  type RealtimeAccess,
} from "../../chrome-extension/src/companion/cloud-provider.js";
import type { AccountSnapshot } from "../../chrome-extension/src/companion/account-realtime.js";
import type { AccountSessionScope } from "../src/main/account/account-controller.js";
import type { ConsumerProcessIdentity } from "../../worker/src/platform/windows/consumer-native.js";
import { accountView } from "./fleet-fixtures.js";
import {
  BrowserToolkit,
  projectBrowserEvent,
} from "../src/main/browser/toolkit.js";
import {
  processingPolicy,
  processingUsage,
  ownerA,
  ownerB,
} from "./realtime-fixtures.js";
import {
  parseProcessingPolicy,
  parseUsage,
} from "../src/main/usage/presentation.js";
const peer: ConsumerProcessIdentity = {
  pid: 42,
  creationTime: "133400000000000000",
  sid: "S-1-5-21-1-2-3-1001",
  sessionId: 1,
};
const media = {
  url: "http://127.0.0.1:4321/media/opaque",
  duration_seconds: 60,
  trim_enabled: false as const,
  model_id: "a".repeat(64),
};
class Realtime implements RealtimeAccess {
  listeners = new Map<string, (snapshot: AccountSnapshot) => void>();
  start = vi.fn();
  stop = vi.fn(() => this.listeners.clear());
  read = vi.fn<RealtimeAccess["read"]>();
  onState: RealtimeAccess["onState"] = () => () => {};
  watch: RealtimeAccess["watch"] = (resource, params, listener) => {
    this.listeners.set(`${resource}:${params.id}`, listener);
    return () => this.listeners.delete(`${resource}:${params.id}`);
  };
}
describe("trusted browser toolkit commands", () => {
  it("CHECK is owner/peer bound, excludes a concurrent owner and streams only fixed component status", async () => {
    let finish!: () => void;
    const inspector = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
      toolkit = new BrowserToolkit({
        packageIdentity: "a".repeat(64),
        inspect: {
          runtime: inspector,
          model: async () => {},
          youtube_tools: async () => {},
        },
        clearCache: async () => {},
        recordEvent: () => {},
      }),
      f = fixture("local", { toolkit });
    await f.execute("selection");
    const initial = await f.execute("check");
    expect(initial).toMatchObject({
      ok: true,
      state: {
        installation_check: {
          status: { state: "running", installation_id: "a".repeat(64) },
        },
      },
    });
    expect(await f.execute("check")).toMatchObject({
      ok: false,
      error_code: "INSTALLATION_CHECK_BUSY",
    });
    expect(
      await f.execute(
        "check",
        {},
        { ...peer, creationTime: "133400000000000099" },
      ),
    ).toMatchObject({ ok: false, error_code: "PEER_DENIED" });
    if (!initial.ok) throw new Error("fixture failed");
    const waiting = f.execute("wait", {
      after_revision: initial.state.revision,
      instance_id: initial.state.instance_id,
    });
    finish();
    expect(await waiting).toMatchObject({
      ok: true,
      state: {
        installation_check: {
          request_id: initial.state.installation_check?.request_id,
        },
      },
    });
    await vi.waitFor(() => expect(toolkit.checking()).toBe(false));
    const final = await f.execute("selection");
    expect(final).toMatchObject({
      ok: true,
      state: { installation_check: { status: { state: "passed" } } },
    });
    expect(f.calls).toEqual([]);
    expect(f.authorization).not.toHaveBeenCalled();
    await f.authority.dispose();
    await toolkit.dispose();
  });
  it("maintenance denies CHECK/cache before effects and sanitized EVENT stays local", async () => {
    const clearCache = vi.fn(async (_signal: AbortSignal) => {}),
      recordEvent = vi.fn(async () => {}),
      runtime = vi.fn(async () => {}),
      toolkit = new BrowserToolkit({
        packageIdentity: "a".repeat(64),
        inspect: {
          runtime,
          model: async () => {},
          youtube_tools: async () => {},
        },
        clearCache,
        recordEvent,
      }),
      f = fixture("local", { toolkit, consumersAllowed: () => false });
    await f.execute("selection");
    expect(await f.execute("check")).toMatchObject({
      ok: false,
      error_code: "PROCESSING_MAINTENANCE",
    });
    expect(await f.execute("clear_cache")).toMatchObject({
      ok: false,
      error_code: "PROCESSING_MAINTENANCE",
    });
    expect(clearCache).not.toHaveBeenCalled();
    expect(runtime).not.toHaveBeenCalled();
    const event = projectBrowserEvent({
      severity: "info",
      code: "OK",
      event: "raw private url",
      metrics: { playing: true, token: "secret" },
    });
    expect(await f.execute("event", { event })).toMatchObject({ ok: true });
    expect(recordEvent).toHaveBeenCalledExactlyOnceWith(event);
    expect(f.calls).toEqual([]);
    await f.authority.dispose();
    await toolkit.dispose();
  });
});
function fixture(
  mode: "local" | "cloud" = "cloud",
  additions: Partial<BrowserAccountAuthorityOptions> = {},
) {
  let scope: AccountSessionScope | null = ownerA,
    clock = Date.now(),
    selected = mode;
  const listeners = new Set<() => void>(),
    rt = new Realtime(),
    ownerId = randomUUID(),
    jobId = "0123456789abcdef01234567",
    calls: { path: string; body: Record<string, unknown> }[] = [];
  const release = vi.fn(async () => {}),
    authorization = vi.fn(async () => "synthetic.private.token"),
    verifyPeer = vi.fn(async () => true),
    publish = vi.fn(async () => ({ media, release })),
    find = vi.fn(
      async () =>
        null as { media: typeof media; release: () => Promise<void> } | null,
    );
  const options: BrowserAccountAuthorityOptions = {
    origin: "https://api.example.test",
    installationId: randomUUID(),
    selectedMode: () => selected,
    account: {
      view: () => accountView(),
      sessionScope: () => scope,
      assertScope: (s) => {
        if (
          !scope ||
          scope.firebaseUid !== s.firebaseUid ||
          scope.generation !== s.generation
        )
          throw new Error("ACCOUNT_CHANGED");
      },
      authorization,
      subscribe: (listener) => {
        const call = () => listener(accountView());
        listeners.add(call);
        return () => listeners.delete(call);
      },
    },
    usage: {
      view: () => ({
        connection: "live",
        authenticated: true,
        libraryReady: false,
        usageState: "current",
        usage: parseUsage(processingUsage()),
        policyState: "current",
        policy: parseProcessingPolicy(processingPolicy()),
        errorCode: null,
      }),
      assertCloudSubmission: vi.fn(),
      subscribe: () => () => {},
    },
    realtime: { cloudLease: () => rt },
    modeStore: {
      read: async () => selected,
      write: async (value) => {
        selected = value;
      },
    },
    media: { publish },
    localReuse: { find },
    verifyPeer,
    now: () => clock,
    fetch: vi.fn(async (url, init) => {
      const path = new URL(url).pathname,
        body = JSON.parse(String(init.body));
      calls.push({ path, body });
      if (path === "/media-imports")
        return Response.json({
          import_id: "0123456789abcdef01234568",
          status: "submitted",
          job_id: jobId,
          error: null,
        });
      if (path.endsWith("/download-grants"))
        return Response.json({
          url: "https://fixture.r2.cloudflarestorage.com/private?signature=secret",
          expires_at: new Date(Date.now() + 60000).toISOString(),
        });
      if (path.endsWith("/cancellations"))
        return Response.json({ id: jobId, status: "cancel_requested" });
      throw new Error("unexpected fixture request");
    }),
  };
  Object.assign(options, additions);
  const authority = new BrowserAccountAuthority(options);
  const command = (action: string, fields: Record<string, unknown> = {}) => ({
    version: 1,
    request_id: randomUUID(),
    owner_id: ownerId,
    action,
    ...fields,
  });
  const execute = (
    action: string,
    fields: Record<string, unknown> = {},
    actual = peer,
  ) => authority.execute(command(action, fields), actual);
  const ready = (duration = 60) => {
    const request = calls.find((row) => row.path === "/media-imports")!.body;
    rt.listeners.get(`job:${jobId}`)?.({
      data: {
        id: jobId,
        request_id: request.request_id,
        status: "ready",
        source_kind: "url",
        source_url: "https://www.youtube.com/watch?v=bZxrIoCPsOc",
        recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
        trim_enabled: false,
        can_download_input: true,
        can_download_output: true,
        input: {
          extension: "m4a",
          content_type: "audio/mp4",
          bytes: 1000,
          duration_seconds: duration,
          sha256: Buffer.alloc(32, 1).toString("base64"),
        },
        output: {
          extension: "mp3",
          content_type: "audio/mpeg",
          bytes: 500,
          duration_seconds: null,
          sha256: Buffer.alloc(32, 1).toString("base64"),
        },
        error: null,
      },
    });
  };
  return {
    authority,
    options,
    command,
    execute,
    rt,
    calls,
    ready,
    authorization,
    publish,
    release,
    find,
    verifyPeer,
    setMode: (value: typeof selected) => {
      selected = value;
    },
    setScope: (value: typeof scope) => {
      scope = value;
      for (const listener of listeners) listener();
    },
    advance: () => {
      clock += 60001;
    },
  };
}
async function selection(f: ReturnType<typeof fixture>) {
  const reply = await f.execute("selection");
  if (!reply.ok) throw new Error(reply.error_code);
  return reply.state.selection.processing_scope!;
}
async function start(f: ReturnType<typeof fixture>, scope: string) {
  return f.execute("start", {
    video_id: "bZxrIoCPsOc",
    duration_seconds: 60,
    processing_scope: scope,
  });
}
describe("trusted Windows manual browser cloud authority", () => {
  it("fences new processing/reuse/publication while retaining repair and safe selection transport", async () => {
    let allowed = true;
    const f = fixture("cloud", { consumersAllowed: () => allowed });
    const scope = await selection(f);
    allowed = false;
    expect(await start(f, scope)).toMatchObject({
      ok: false,
      error_code: "PROCESSING_MAINTENANCE",
    });
    expect(f.calls).toHaveLength(0);
    const hello = await f.execute("selection");
    expect(hello).toMatchObject({
      ok: true,
      state: {
        selection: {
          cloud_ready: false,
          error_code: "PROCESSING_MAINTENANCE",
          cache_reuse_supported: false,
          publication_supported: false,
        },
      },
    });
    expect(
      await f.execute("local_lookup", {
        video_id: "bZxrIoCPsOc",
        duration_seconds: 60,
        cache_only: false,
      }),
    ).toMatchObject({ ok: false, error_code: "PROCESSING_MAINTENANCE" });
    expect(f.find).not.toHaveBeenCalled();
    expect(
      await f.execute("playback_started", {
        job_id: randomUUID(),
        video_id: "bZxrIoCPsOc",
      }),
    ).toMatchObject({ ok: false, error_code: "PROCESSING_MAINTENANCE" });
    allowed = true;
    expect(await start(f, scope)).toMatchObject({ ok: true });
    await f.authority.dispose();
  });
  it("reads local selection/cache capabilities without authentication or inference", async () => {
    const f = fixture("local");
    await selection(f);
    expect(f.authorization).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    expect(f.authority.activity().activeJobs).toBe(0);
    await f.authority.dispose();
  });
  it("rejects browser-selectable tokens, unknown fields and changed peer birth", async () => {
    const f = fixture();
    await selection(f);
    expect(() =>
      parseBrowserAccountCommand(f.command("selection", { token: "secret" })),
    ).toThrow("INVALID_COMMAND");
    expect(
      await f.execute(
        "status",
        {},
        { ...peer, creationTime: "133400000000000001" },
      ),
    ).toMatchObject({ ok: false, error_code: "PEER_DENIED" });
    f.verifyPeer.mockResolvedValue(false);
    expect(await f.execute("selection")).toMatchObject({
      ok: false,
      error_code: "PEER_DENIED",
    });
    await f.authority.dispose();
  });
  it("uses existing manual import and full-snapshot realtime without local Prepare, and exposes only loopback media", async () => {
    const f = fixture(),
      scope = await selection(f);
    const reply = await start(f, scope);
    expect(reply.ok).toBe(true);
    await vi.waitFor(() =>
      expect(f.rt.listeners.has("job:0123456789abcdef01234567")).toBe(true),
    );
    expect(f.calls[0]).toMatchObject({
      path: "/media-imports",
      body: {
        url: "https://www.youtube.com/watch?v=bZxrIoCPsOc",
        trim_enabled: false,
      },
    });
    f.ready();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
    let state = await f.execute("status");
    await vi.waitFor(async () => {
      state = await f.execute("status");
      expect(state).toMatchObject({
        ok: true,
        state: { job: { state: "READY", provider: "ONLINE_MUSICMUTE", media } },
      });
    });
    expect(JSON.stringify(state)).not.toMatch(
      /synthetic|firebase|cloudflarestorage|signature|S-1-5|generation|refresh_token/u,
    );
    await f.authority.dispose();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("preserves exact request replay without a second intake POST and rejects changed body", async () => {
    const f = fixture(),
      scope = await selection(f),
      input = f.command("start", {
        video_id: "bZxrIoCPsOc",
        duration_seconds: 60,
        processing_scope: scope,
      });
    await f.authority.execute(input, peer);
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    expect(await f.authority.execute(input, peer)).toMatchObject({ ok: true });
    expect(
      await f.authority.execute({ ...input, duration_seconds: 61 }, peer),
    ).toMatchObject({ ok: false, error_code: "REQUEST_ID_REUSED" });
    expect(f.calls.filter((row) => row.path === "/media-imports")).toHaveLength(
      1,
    );
    await f.authority.dispose();
  });
  it("fences saved provider and account generation before billable intake", async () => {
    const f = fixture(),
      scope = await selection(f);
    f.setMode("local");
    expect(await start(f, scope)).toMatchObject({
      ok: false,
      error_code: "PROCESSING_SELECTION_CHANGED",
    });
    f.setMode("cloud");
    f.setScope(ownerB);
    expect(await start(f, scope)).toMatchObject({
      ok: false,
      error_code: "ACCOUNT_CHANGED",
    });
    expect(f.calls).toEqual([]);
    await f.authority.dispose();
  });
  it("does not publish an old account's result after the media transfer race", async () => {
    const f = fixture(),
      scope = await selection(f);
    let finish!: (value: {
      media: typeof media;
      release: typeof f.release;
    }) => void;
    f.publish.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await start(f, scope);
    await vi.waitFor(() => expect(f.rt.listeners.size).toBe(1));
    f.ready();
    await vi.waitFor(() => expect(f.publish).toHaveBeenCalledOnce());
    f.setScope(ownerB);
    finish({ media, release: f.release });
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
    expect(await f.execute("status")).toMatchObject({
      ok: true,
      state: { job: null },
    });
    await f.authority.dispose();
  });
  it("rejects different video timelines before downloading/publishing", async () => {
    const f = fixture(),
      scope = await selection(f);
    await start(f, scope);
    await vi.waitFor(() => expect(f.rt.listeners.size).toBe(1));
    f.ready(63);
    await vi.waitFor(async () =>
      expect(await f.execute("status")).toMatchObject({
        ok: true,
        state: { job: { state: "FAILED", error_code: "TIMELINE_MISMATCH" } },
      }),
    );
    expect(f.publish).not.toHaveBeenCalled();
    await f.authority.dispose();
  });
  it("cache-only guest restoration preserves opaque saved job and survives app account changes", async () => {
    const f = fixture("local"),
      restoreId = randomUUID();
    f.find.mockResolvedValue({ media, release: f.release });
    await selection(f);
    expect(
      await f.execute("local_lookup", {
        video_id: "bZxrIoCPsOc",
        duration_seconds: 60,
        cache_only: true,
        restore_job_id: restoreId,
      }),
    ).toMatchObject({
      ok: true,
      state: {
        job: {
          job_id: restoreId,
          state: "READY",
          cache_hit: true,
          provider: "LOCAL_WINDOWS",
        },
      },
    });
    expect(f.find).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheOnly: true,
        videoId: "bZxrIoCPsOc",
        peer,
      }),
    );
    f.setScope(null);
    expect(await f.execute("status")).toMatchObject({
      ok: true,
      state: { job: { job_id: restoreId, state: "READY" } },
    });
    expect(f.authorization).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
    await f.authority.dispose();
  });
  it("reaps crashed signed peers with exact birth and releases retained media; pending ACK keeps authority alive", async () => {
    const f = fixture("local");
    f.find.mockResolvedValue({ media, release: f.release });
    await selection(f);
    await f.execute("local_lookup", {
      video_id: "bZxrIoCPsOc",
      duration_seconds: 60,
      cache_only: true,
    });
    f.advance();
    f.verifyPeer.mockResolvedValue(false);
    const ack = f.authority.holdReply();
    await f.authority.reapExpired();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.authority.activity().idle).toBe(false);
    ack();
    expect(f.authority.activity().idle).toBe(true);
    await f.authority.dispose();
  });
  it("fences idle retirement synchronously and reopens only the exact released reservation", async () => {
    const f = fixture("local");
    const reservation = f.authority.beginIdleClose();
    expect(reservation).not.toBeNull();
    expect(f.authority.beginIdleClose()).toBeNull();
    await expect(selection(f)).rejects.toThrow("PEER_DENIED");
    reservation!.assertIdle();
    reservation!.release();
    await selection(f);
    expect(f.authority.beginIdleClose()).toBeNull();
    await f.authority.dispose();
  });
  it("keeps guest cache available without account configuration and refuses manual Cloud before authorization", async () => {
    const f = fixture("local", { origin: null });
    f.find.mockResolvedValue({ media, release: f.release });
    const hello = await f.execute("selection");
    expect(hello.ok && hello.state.selection.cache_reuse_supported).toBe(true);
    expect(
      (
        await f.execute("local_lookup", {
          video_id: "bZxrIoCPsOc",
          duration_seconds: 60,
          cache_only: true,
        })
      ).ok,
    ).toBe(true);
    const cloud = fixture("cloud", { origin: null });
    const selection = await cloud.execute("selection");
    expect(selection.ok && selection.state.selection.error_code).toBe(
      "CONFIGURATION_REQUIRED",
    );
    const reply = await cloud.execute("start", {
      video_id: "bZxrIoCPsOc",
      duration_seconds: 60,
      processing_scope: "a".repeat(64),
    });
    expect(reply).toMatchObject({
      ok: false,
      error_code: "CONFIGURATION_REQUIRED",
    });
    expect(cloud.authorization).not.toHaveBeenCalled();
    expect(cloud.calls).toEqual([]);
    await Promise.all([f.authority.dispose(), cloud.authority.dispose()]);
  });
  it("rechecks real reply acknowledgements after the idle fence before committing", async () => {
    const f = fixture("local");
    const reservation = f.authority.beginIdleClose()!;
    const reply = f.authority.holdReply();
    expect(() => reservation.assertIdle()).toThrow("ACCOUNT_AUTHORITY_BUSY");
    expect(() => reservation.commit()).toThrow("ACCOUNT_AUTHORITY_BUSY");
    reply();
    await reservation.commit();
    reservation.release();
    expect(f.authority.beginIdleClose()).toBeNull();
    await expect(selection(f)).rejects.toThrow("PEER_DENIED");
  });
});

describe("owner-proof-bound guest first-playback publication", () => {
  function publication() {
    let changed:
      | ((value: {
          ownerId: string;
          jobId: string;
          videoId: string;
          state: "pending" | "saving" | "saved";
        }) => void)
      | undefined;
    return {
      port: {
        subscribe: vi.fn((listener: NonNullable<typeof changed>) => {
          changed = listener;
          return vi.fn();
        }),
        playbackStarted: vi.fn(async () => "pending" as const),
      },
      emit: (value: Parameters<NonNullable<typeof changed>>[0]) =>
        changed?.(value),
    };
  }
  const personalPeer = { ...peer, pid: 43 },
    jobId = randomUUID();
  const prove = vi.fn(
    async (request: {
      ownerId: string;
      jobId: string;
      videoId: string;
      peer: ConsumerProcessIdentity;
    }) => ({
      version: 1 as const,
      owner_id: request.ownerId,
      owner_kind: "chrome" as const,
      job_id: request.jobId,
      video_id: request.videoId,
      peer: request.peer,
      vocals: {
        artifact_id: randomUUID(),
        bytes: 256,
        sha256: "b".repeat(64),
        duration_seconds: 60,
        content_type: "audio/mpeg" as const,
      },
    }),
  );
  it("requires actual owner proof before first playback and publishes later save state through subscriptions", async () => {
    const pub = publication(),
      proof = vi.fn(prove),
      f = fixture("local", {
        publication: pub.port,
        provePersonalOwner: proof,
      });
    await selection(f);
    const command = f.command("playback_started", {
        job_id: jobId,
        video_id: "bZxrIoCPsOc",
      }),
      reply = await f.authority.execute(command, peer, personalPeer);
    expect(reply).toMatchObject({
      ok: true,
      state: { publication: { job_id: jobId, state: "pending" } },
    });
    expect(proof).toHaveBeenCalledWith({
      ownerId: command.owner_id,
      jobId,
      videoId: "bZxrIoCPsOc",
      peer: personalPeer,
    });
    expect(pub.port.playbackStarted).toHaveBeenCalledWith(
      expect.objectContaining({
        proof: expect.objectContaining({ job_id: jobId, peer: personalPeer }),
      }),
    );
    if (!reply.ok) throw new Error("fixture failed");
    const waiting = f.execute("wait", {
      after_revision: reply.state.revision,
      instance_id: reply.state.instance_id,
    });
    pub.emit({
      ownerId: command.owner_id,
      jobId,
      videoId: "bZxrIoCPsOc",
      state: "saved",
    });
    expect(await waiting).toMatchObject({
      ok: true,
      state: { publication: { state: "saved" } },
    });
    expect(f.calls).toEqual([]);
    await f.authority.dispose();
  });
  it("cannot publish guessed job/video identity or a missing original personal peer", async () => {
    const pub = publication(),
      f = fixture("local", {
        publication: pub.port,
        provePersonalOwner: vi.fn(async (request) => ({
          ...(await prove(request)),
          job_id: randomUUID(),
        })),
      });
    await selection(f);
    const command = f.command("playback_started", {
      job_id: jobId,
      video_id: "bZxrIoCPsOc",
    });
    expect(
      await f.authority.execute(command, peer, personalPeer),
    ).toMatchObject({ ok: false, error_code: "PEER_DENIED" });
    expect(await f.authority.execute(command, peer)).toMatchObject({
      ok: false,
      error_code: "PEER_DENIED",
    });
    expect(pub.port.playbackStarted).not.toHaveBeenCalled();
    await f.authority.dispose();
  });
  it("never republishes a verified reused community voice", async () => {
    const pub = publication(),
      f = fixture("local", {
        publication: pub.port,
        provePersonalOwner: prove,
      });
    f.find.mockResolvedValue({ media, release: f.release });
    await selection(f);
    const cached = await f.execute("local_lookup", {
      video_id: "bZxrIoCPsOc",
      duration_seconds: 60,
      cache_only: false,
    });
    if (!cached.ok || !cached.state.job) throw new Error("fixture failed");
    expect(
      await f.execute("playback_started", {
        job_id: cached.state.job.job_id,
        video_id: "bZxrIoCPsOc",
      }),
    ).toMatchObject({ ok: true });
    expect(pub.port.playbackStarted).not.toHaveBeenCalled();
    await f.authority.dispose();
  });
});
