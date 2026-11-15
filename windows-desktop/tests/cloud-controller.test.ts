import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CloudController,
  type CloudMediaPort,
} from "../src/main/cloud/controller.js";
import { parseCloudCommand } from "../src/shared/cloud-contracts.js";
import {
  FULL_TIMELINE_RECIPE_DIGEST,
  type RealtimeAccess,
} from "../../chrome-extension/src/companion/cloud-provider.js";
import type { AccountSnapshot } from "../../chrome-extension/src/companion/account-realtime.js";
import type { AccountView } from "../src/shared/account-contracts.js";
import type { AccountSessionScope } from "../src/main/account/account-controller.js";
import type { AccountUsageView } from "../src/shared/usage-contracts.js";
import { accountView } from "./fleet-fixtures.js";
import {
  processingPolicy,
  processingUsage,
  ownerA,
  ownerB,
} from "./realtime-fixtures.js";
import {
  parseProcessingPolicy,
  parseUsage,
  processingAdmissionPreview,
} from "../src/main/usage/presentation.js";
class Realtime implements RealtimeAccess {
  listeners = new Map<string, (value: AccountSnapshot) => void>();
  start = vi.fn();
  stop = vi.fn(() => {
    this.listeners.clear();
  });
  read = vi.fn<RealtimeAccess["read"]>();
  onState: RealtimeAccess["onState"] = () => () => {};
  watch: RealtimeAccess["watch"] = (resource, params, listener) => {
    this.listeners.set(`${resource}:${params.id}`, listener);
    return () => {
      this.listeners.delete(`${resource}:${params.id}`);
    };
  };
  emit(resource: string, id: string, data: unknown) {
    this.listeners.get(`${resource}:${id}`)?.({ data });
  }
}
function fixture() {
  let scope: AccountSessionScope | null = ownerA,
    account = accountView(),
    clock = Date.now(),
    savedMode: "local" | "cloud" = "local";
  const accountListeners = new Set<(view: AccountView) => void>(),
    usageListeners = new Set<(view: AccountUsageView) => void>();
  let usage: AccountUsageView = {
    connection: "live",
    authenticated: true,
    libraryReady: false,
    usageState: "current",
    usage: parseUsage(processingUsage()),
    policyState: "current",
    policy: parseProcessingPolicy(processingPolicy()),
    errorCode: null,
  };
  const rt = new Realtime(),
    jobId = "0123456789abcdef01234567",
    input = {
      extension: "m4a",
      content_type: "audio/mp4",
      bytes: 1000,
      duration_seconds: 60,
      sha256: Buffer.alloc(32, 1).toString("base64"),
    },
    upload = {
      method: "PUT",
      url: "https://fixture.r2.cloudflarestorage.com/private?signature=secret",
      expires_at: new Date(Date.now() + 60000).toISOString(),
      headers: {
        "Content-Type": "audio/mp4",
        "If-None-Match": "*",
        "x-amz-checksum-sha256": input.sha256,
        "x-amz-meta-sha256": input.sha256,
      },
    },
    calls: { path: string; body: Record<string, unknown>; headers: Headers }[] =
      [],
    fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname,
        body = JSON.parse(String(init.body));
      calls.push({ path, body, headers: new Headers(init.headers) });
      if (path === "/media-imports")
        return Response.json({
          import_id: "0123456789abcdef01234568",
          status: "submitted",
          job_id: jobId,
          error: null,
        });
      if (path === "/jobs")
        return Response.json({
          id: jobId,
          request_id: body.request_id,
          status: "awaiting_upload",
          upload,
        });
      if (path.endsWith("/upload-completions"))
        return Response.json({ id: jobId, status: "queued" });
      if (path.endsWith("/download-grants"))
        return Response.json({
          url: "https://fixture.r2.cloudflarestorage.com/result?signature=secret",
          expires_at: new Date(Date.now() + 60000).toISOString(),
        });
      if (path.endsWith("/cancellations"))
        return Response.json({ id: jobId, status: "cancel_requested" });
      throw new Error("unsupported fixture route");
    });
  const uploadMedia = vi.fn(async () => {}),
    close = vi.fn(async () => {}),
    media: CloudMediaPort = {
      prepareFile: vi.fn(async () => ({
        input,
        source: "audio_file" as const,
        title: "Fixture",
        upload: uploadMedia,
        close,
      })),
      download: vi.fn(async () => "5abf13bd-06a0-4b21-a700-f7056125c3ab"),
    },
    modeStore = {
      read: vi.fn(async () => savedMode),
      write: vi.fn(async (mode: typeof savedMode) => {
        savedMode = mode;
      }),
    },
    authorization = vi.fn(async () => "header.payload.synthetic-private");
  const controller = new CloudController({
    origin: "https://api.example.test",
    installationId: "d7ea7de6-52e9-4b96-8834-3b517941bdb0",
    account: {
      view: () => account,
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
        accountListeners.add(listener);
        return () => {
          accountListeners.delete(listener);
        };
      },
    },
    usage: {
      view: () => usage,
      assertCloudSubmission: (state) => {
        const decision = processingAdmissionPreview(
          "cloud",
          false,
          state,
          usage,
        );
        if (!decision.allowed) throw new Error(decision.reason!);
      },
      subscribe: (listener) => {
        usageListeners.add(listener);
        return () => {
          usageListeners.delete(listener);
        };
      },
    },
    realtime: { cloudLease: () => rt },
    modeStore,
    media,
    localReady: () => true,
    fetch: fetcher,
    now: () => clock,
  });
  const ready = (kind: "url" | "file" = "url") => {
    const request = calls.find(
      (call) => call.path === (kind === "url" ? "/media-imports" : "/jobs"),
    )!.body;
    rt.emit("job", jobId, {
      id: jobId,
      request_id: request.request_id,
      status: "ready",
      source_kind: kind,
      source_url:
        kind === "url" ? "https://www.youtube.com/watch?v=bZxrIoCPsOc" : null,
      recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
      trim_enabled: false,
      can_download_input: true,
      can_download_output: true,
      input,
      output: {
        extension: "mp3",
        content_type: "audio/mpeg",
        bytes: 500,
        duration_seconds: null,
        sha256: input.sha256,
      },
      error: null,
    });
  };
  return {
    controller,
    media,
    uploadMedia,
    close,
    rt,
    calls,
    fetcher,
    modeStore,
    authorization,
    usage,
    ready,
    jobId,
    advance: (ms: number) => {
      clock += ms;
    },
    setOwner: (next: AccountSessionScope | null) => {
      scope = next;
      account = {
        ...account,
        state: next ? "signed-in" : "signed-out",
        user: next ? account.user : null,
      };
      for (const listener of accountListeners) listener(account);
    },
    setUsage: (next: AccountUsageView) => {
      usage = next;
      for (const listener of usageListeners) listener(usage);
    },
    setAccount: (next: AccountView) => {
      account = next;
      for (const listener of accountListeners) listener(account);
    },
    saved: () => savedMode,
  };
}
async function selected(f: ReturnType<typeof fixture>) {
  await f.controller.restore();
  await f.controller.setMode("cloud");
}
describe("explicit cloud desktop authority", () => {
  it("presents an expired confirmation error when UI submission starts without awaiting remote work", async () => {
    const f = fixture();
    await selected(f);
    const c = f.controller.prepareYouTubeConfirmation({
      videoId: "bZxrIoCPsOc",
    });
    f.advance(6 * 60000);
    f.controller.submitConfirmed(c.capability, true);
    await vi.waitFor(() =>
      expect(f.controller.view().errorCode).toBe("CLOUD_CONFIRMATION_EXPIRED"),
    );
    expect(f.calls).toHaveLength(0);
    await f.controller.shutdown();
  });
  it("waits for detached owner's CPU preparation and cleanup before closing native authority", async () => {
    const f = fixture();
    await selected(f);
    let finish!: () => void;
    const boundary = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(f.media.prepareFile).mockImplementation(async () => {
      await boundary;
      return {
        input: {
          extension: "m4a",
          content_type: "audio/mp4",
          bytes: 1,
          duration_seconds: 1,
          sha256: Buffer.alloc(32).toString("base64"),
        },
        source: "audio_file",
        title: "Fixture",
        upload: async () => {},
        close: f.close,
      };
    });
    const c = f.controller.prepareFileConfirmation({
      fileCapability: randomUUID(),
      name: "audio.wav",
      bytes: 1,
    });
    const running = f.controller.confirm(c.capability, true);
    await vi.waitFor(() => expect(f.media.prepareFile).toHaveBeenCalled());
    f.setOwner(ownerB);
    let closed = false;
    const shutdown = f.controller.shutdown().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await shutdown;
    await running;
    expect(f.close).toHaveBeenCalled();
    expect(f.calls).toHaveLength(0);
  });
  it("hands ready metadata only to the current trusted Library owner and clears completed presentation on A to B", async () => {
    const f = fixture();
    await selected(f);
    const c = f.controller.prepareYouTubeConfirmation({
        videoId: "bZxrIoCPsOc",
      }),
      running = f.controller.confirm(c.capability, true);
    await vi.waitFor(() =>
      expect(f.rt.listeners.has(`job:${f.jobId}`)).toBe(true),
    );
    f.ready();
    const view = await running;
    expect(
      f.controller.completedResult(view.resultCapability!, ownerA).id,
    ).toBe(f.jobId);
    const copy = f.controller.completedResult(view.resultCapability!, ownerA);
    copy.id = "foreign";
    expect(
      f.controller.completedResult(view.resultCapability!, ownerA).id,
    ).toBe(f.jobId);
    f.setOwner(ownerB);
    expect(f.controller.view()).toMatchObject({
      phase: "idle",
      job: null,
      resultCapability: null,
    });
    expect(() =>
      f.controller.completedResult(view.resultCapability!, ownerB),
    ).toThrow("CLOUD_RESULT_UNAVAILABLE");
    expect(() =>
      f.controller.completedResult(view.resultCapability!, ownerA),
    ).toThrow();
    f.controller.dispose();
  });
  it("reports a known job cancellation request without claiming backend cancellation completion", async () => {
    const f = fixture();
    await selected(f);
    const c = f.controller.prepareYouTubeConfirmation({
        videoId: "bZxrIoCPsOc",
      }),
      running = f.controller.confirm(c.capability, true);
    await vi.waitFor(() =>
      expect(f.rt.listeners.has(`job:${f.jobId}`)).toBe(true),
    );
    expect(await f.controller.cancel()).toMatchObject({
      phase: "cancellation-requested",
      errorCode: null,
    });
    expect((await running).phase).toBe("cancellation-requested");
    expect(
      f.calls.filter((call) => call.path.endsWith("/cancellations")),
    ).toHaveLength(1);
    f.controller.dispose();
  });
  it("makes unavailable import cancellation explicit before the backend assigns a job", async () => {
    const f = fixture();
    await selected(f);
    f.fetcher.mockResolvedValueOnce(
      Response.json({
        import_id: "0123456789abcdef01234568",
        status: "queued",
        job_id: null,
        error: null,
      }),
    );
    const c = f.controller.prepareYouTubeConfirmation({
        videoId: "bZxrIoCPsOc",
      }),
      running = f.controller.confirm(c.capability, true);
    await vi.waitFor(() =>
      expect(f.rt.listeners.has("import:0123456789abcdef01234568")).toBe(true),
    );
    expect(await f.controller.cancel()).toMatchObject({
      phase: "cancelled",
      errorCode: "CLOUD_IMPORT_CANCELLATION_UNAVAILABLE",
    });
    expect((await running).errorCode).toBe(
      "CLOUD_IMPORT_CANCELLATION_UNAVAILABLE",
    );
    expect(f.calls.some((call) => call.path.endsWith("/cancellations"))).toBe(
      false,
    );
    f.controller.dispose();
  });
  it("preserves Cloud selection while signed out and exposes no browser tokens", async () => {
    const f = fixture();
    await selected(f);
    f.setOwner(null);
    expect(f.controller.view()).toMatchObject({
      mode: "cloud",
      ready: false,
      reason: "SIGN_IN_REQUIRED",
      signInRequired: true,
    });
    expect(f.saved()).toBe("cloud");
    expect(f.controller.browserSettings().automatic_processing_allowed).toBe(
      false,
    );
    expect(() =>
      f.controller.prepareYouTubeConfirmation({ videoId: "bZxrIoCPsOc" }),
    ).toThrow("SIGN_IN_REQUIRED");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(f.controller.browserSettings())).not.toContain(
      "bearer",
    );
    f.controller.dispose();
  });
  it("a browser handoff only prefills and automatic processing stays within Local duration rules", async () => {
    const f = fixture();
    await f.controller.restore();
    expect(f.controller.acceptBrowserHandoff("bZxrIoCPsOc", 60)).toEqual({
      videoId: "bZxrIoCPsOc",
      durationSeconds: 60,
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.controller.assertBrowserAutomatic(1200)).toBeUndefined();
    expect(() => f.controller.assertBrowserAutomatic(1201)).toThrow();
    await f.controller.setMode("cloud");
    expect(() => f.controller.assertBrowserAutomatic(60)).toThrow();
    expect(f.controller.view().phase).toBe("idle");
    f.controller.dispose();
  });
  it("requires frozen owner, rights and a single-use confirmation before HTTP intake", async () => {
    const f = fixture();
    await selected(f);
    const confirmation = f.controller.prepareYouTubeConfirmation({
      videoId: "bZxrIoCPsOc",
      durationSeconds: 60,
    });
    await expect(
      f.controller.confirm(confirmation.capability, false),
    ).rejects.toThrow("CLOUD_CONFIRMATION_INVALID");
    expect(f.fetcher).not.toHaveBeenCalled();
    const processing = f.controller.confirm(confirmation.capability, true);
    await vi.waitFor(() =>
      expect(f.rt.listeners.has(`job:${f.jobId}`)).toBe(true),
    );
    await expect(
      f.controller.confirm(confirmation.capability, true),
    ).rejects.toThrow("CLOUD_BUSY");
    f.ready();
    const result = await processing;
    expect(result.phase).toBe("ready");
    expect(result.resultCapability).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      f.calls.filter((call) => call.path === "/media-imports"),
    ).toHaveLength(1);
    expect(
      f.calls.every(
        (call) =>
          call.headers.get("authorization") ===
          "Bearer header.payload.synthetic-private",
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("signature=secret");
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
    f.controller.dispose();
  });
  it.each(["stale", "unavailable", "paused", "quota"])(
    "requires current authority for %s before any intake",
    async (reason) => {
      const f = fixture();
      await selected(f);
      const next = structuredClone(f.usage);
      if (reason === "stale") next.usageState = "stale";
      if (reason === "unavailable") next.policyState = "unavailable";
      if (reason === "paused") next.policy!.acceptNewJobs = false;
      if (reason === "quota") next.usage!.remainingSeconds = 0;
      f.setUsage(next);
      expect(() =>
        f.controller.prepareYouTubeConfirmation({ videoId: "bZxrIoCPsOc" }),
      ).toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
      f.controller.dispose();
    },
  );
  it("does not require Library readiness for an authenticated current cloud command", async () => {
    const f = fixture();
    await selected(f);
    expect(f.usage.libraryReady).toBe(false);
    expect(f.controller.view().ready).toBe(true);
    expect(
      f.controller.prepareYouTubeConfirmation({ videoId: "bZxrIoCPsOc" }),
    ).toBeDefined();
    f.controller.dispose();
  });
  it("hiding URL controls never cancels accepted work or creates a new submission restriction", async () => {
    const f = fixture();
    await selected(f);
    const c = f.controller.prepareYouTubeConfirmation({
        videoId: "bZxrIoCPsOc",
      }),
      running = f.controller.confirm(c.capability, true);
    await vi.waitFor(() =>
      expect(f.rt.listeners.has(`job:${f.jobId}`)).toBe(true),
    );
    const next = structuredClone(f.usage);
    next.policy!.linkImportVisible = false;
    next.policy!.linkImportReason = "user_hidden";
    f.setUsage(next);
    expect(f.controller.view().linkImportVisible).toBe(false);
    expect(f.calls.some((call) => call.path.endsWith("/cancellations"))).toBe(
      false,
    );
    f.ready();
    expect((await running).phase).toBe("ready");
    f.controller.dispose();
  });
  it("keeps accepted Cloud work when the user changes the preference to Local", async () => {
    const f = fixture();
    await selected(f);
    const c = f.controller.prepareYouTubeConfirmation({
        videoId: "bZxrIoCPsOc",
      }),
      running = f.controller.confirm(c.capability, true);
    await vi.waitFor(() =>
      expect(f.rt.listeners.has(`job:${f.jobId}`)).toBe(true),
    );
    await f.controller.setMode("local");
    f.ready();
    expect(await running).toMatchObject({ mode: "local", phase: "ready" });
    expect(
      f.calls.filter((call) => call.path === "/media-imports"),
    ).toHaveLength(1);
    f.controller.dispose();
  });
  it("rechecks policy after delayed token access and never submits if it became unavailable", async () => {
    const f = fixture();
    await selected(f);
    let release!: (value: string) => void;
    f.authorization.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const c = f.controller.prepareYouTubeConfirmation({
        videoId: "bZxrIoCPsOc",
      }),
      running = f.controller.confirm(c.capability, true);
    await vi.waitFor(() => expect(release).toBeDefined());
    const next = structuredClone(f.usage);
    next.policyState = "unavailable";
    f.setUsage(next);
    release("header.payload.synthetic-private");
    expect((await running).errorCode).toBe("CLOUD_POLICY_UNAVAILABLE");
    expect(f.fetcher).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it("fences A to B during authorization and drops the old result without a new-account request", async () => {
    const f = fixture();
    await selected(f);
    let release!: (value: string) => void;
    f.authorization.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const c = f.controller.prepareYouTubeConfirmation({
        videoId: "bZxrIoCPsOc",
      }),
      running = f.controller.confirm(c.capability, true);
    await vi.waitFor(() => expect(release).toBeDefined());
    f.setOwner(ownerB);
    release("header.payload.synthetic-private");
    await running;
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.controller.view().job).toBeNull();
    expect(f.controller.view().confirmation).toBeNull();
    f.controller.dispose();
  });
  it("a backend 503 stays unavailable with one POST and no local fallback", async () => {
    const f = fixture();
    await selected(f);
    f.fetcher.mockImplementation(
      async () =>
        new Response(JSON.stringify({ code: "SERVICE_UNAVAILABLE" }), {
          status: 503,
          headers: { "content-type": "application/problem+json" },
        }),
    );
    const c = f.controller.prepareYouTubeConfirmation({
      videoId: "bZxrIoCPsOc",
    });
    expect((await f.controller.confirm(c.capability, true)).errorCode).toBe(
      "CLOUD_POLICY_UNAVAILABLE",
    );
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.media.prepareFile).not.toHaveBeenCalled();
    await expect(f.controller.confirm(c.capability, true)).rejects.toThrow(
      "CLOUD_CONFIRMATION_INVALID",
    );
    f.controller.dispose();
  });
  it("validates confirmation expiry and safe strict commands", async () => {
    const f = fixture();
    await selected(f);
    const c = f.controller.prepareFileConfirmation({
      fileCapability: randomUUID(),
      name: "input.wav",
      bytes: 1000,
    });
    f.advance(300001);
    await expect(f.controller.confirm(c.capability, true)).rejects.toThrow(
      "CLOUD_CONFIRMATION_EXPIRED",
    );
    expect(f.media.prepareFile).not.toHaveBeenCalled();
    expect(() =>
      parseCloudCommand({
        type: "CONFIRM",
        capability: c.capability,
        rightsConfirmed: true,
        url: "https://attacker.invalid",
      }),
    ).toThrow();
    expect(() =>
      parseCloudCommand({
        type: "PREPARE_FILE",
        fileCapability: randomUUID(),
        name: "../private",
        bytes: 1000,
      }),
    ).toThrow();
    f.controller.dispose();
  });
  it("prepares and uploads the file before the existing completion/job snapshots", async () => {
    const f = fixture();
    await selected(f);
    const c = f.controller.prepareFileConfirmation({
        fileCapability: randomUUID(),
        name: "input.wav",
        bytes: 1000,
      }),
      running = f.controller.confirm(c.capability, true);
    await vi.waitFor(() =>
      expect(f.rt.listeners.has(`job:${f.jobId}`)).toBe(true),
    );
    expect(f.uploadMedia).toHaveBeenCalledOnce();
    expect(f.calls.find((call) => call.path === "/jobs")?.body).toMatchObject({
      policy_version: 2,
      preparation_profile_id: "audio-cap-aac-lc-160-v1",
      trim_enabled: false,
    });
    f.ready("file");
    expect((await running).phase).toBe("ready");
    expect(f.close).toHaveBeenCalledOnce();
    f.controller.dispose();
  });
});
