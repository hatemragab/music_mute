import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WindowsBrowserService } from "../src/main/browser/service.js";
import type { BrowserAccountState } from "../src/main/browser/account-contracts.js";
import type { NativeReply } from "../../chrome-extension/src/shared/protocol.js";
import type { SessionClient } from "../src/main/session/control.js";
const command = (type: string, payload: unknown = {}) => ({
  protocol_version: 1,
  request_id: randomUUID(),
  type,
  payload,
});
function fixture(
  provider: "LOCAL_WINDOWS" | "ONLINE_MUSICMUTE" = "ONLINE_MUSICMUTE",
) {
  const writes: NativeReply[] = [],
    personal = vi.fn<SessionClient["personal"]>(async () => {
      throw new Error("LOCAL_INSTALL_REQUIRED");
    }),
    getSession = vi.fn(async () => ({ personal })),
    peer = {
      pid: 42,
      creationTime: "133400000000000000",
      sid: "S-1-5-21-1-2-3-1001",
      sessionId: 1,
    };
  let state: BrowserAccountState = {
    version: 1,
    instance_id: randomUUID(),
    revision: 1,
    unchanged: false,
    selection: {
      processing_provider: provider,
      processing_scope: "a".repeat(64),
      cloud_ready: true,
      error_code: null,
      cache_reuse_supported: true,
      publication_supported: true,
    },
    job: null,
  };
  const account = {
    ownerId: randomUUID(),
    command: vi.fn(async () => structuredClone(state)),
    start: vi.fn(async (videoId: string, duration: number) => {
      state = {
        ...state,
        revision: 2,
        job: {
          job_id: randomUUID(),
          video_id: videoId,
          provider: "ONLINE_MUSICMUTE",
          state: "PROCESSING",
          stage: "cloud-importing",
        },
      };
      expect(duration).toBe(60);
      return structuredClone(state);
    }),
    wait: vi.fn(() => new Promise<BrowserAccountState>(() => {})),
    playbackStarted: vi.fn(async () => structuredClone(state)),
    close: vi.fn(async () => {}),
  };
  const service = new WindowsBrowserService({
    account,
    getSession,
    personalPeer: async () => peer,
    media: {
      issue: vi.fn(async () => {
        throw new Error("unexpected local media");
      }),
      close: vi.fn(async () => {}),
    },
    write: async (reply) => {
      writes.push(reply);
    },
    onDisconnected: vi.fn(),
  });
  return {
    service,
    account,
    getSession,
    personal,
    writes,
    peer,
    setState: (next: Partial<BrowserAccountState>) => {
      state = { ...state, ...next };
    },
  };
}
describe("one Windows native browser provider gateway", () => {
  it.each(["waiting-for-worker", "gpu-busy", "recovering"] as const)(
    "projects only %s into the existing Chrome stage and omits stale numeric progress",
    async (waitReason) => {
      const f = fixture("LOCAL_WINDOWS"),
        job = {
          id: randomUUID(),
          ownerId: f.service.ownerId,
          state: "preparing" as const,
          stage: "preparation" as const,
          waitReason,
          progress: 0.6,
          name: "YouTube",
          error: null,
          original: null,
          vocals: null,
        };
      f.personal.mockImplementation(async (request) => {
        if (request.action === "wait_changes") return new Promise(() => {});
        return {
          version: 1,
          requestId: request.requestId,
          ok: true,
          ...(request.action === "submit" ? { job } : { jobs: [] }),
        };
      });
      await f.service.command(
        command("START", {
          video_id: "bZxrIoCPsOc",
          duration_seconds: 60,
          provider: "LOCAL_WINDOWS",
        }),
      );
      const reply = f.writes.findLast((item) => item.type === "JOB");
      expect(reply).toMatchObject({
        type: "JOB",
        payload: {
          state: "PROCESSING",
          stage: waitReason,
          provider: "LOCAL_WINDOWS",
        },
      });
      expect(reply).not.toHaveProperty("payload.completed");
      expect(reply).not.toHaveProperty("payload.total");
      expect(JSON.stringify(reply)).not.toMatch(
        /gpuLuid|leaseNonce|waitReason|ownerId|S-1-5|C:\\/,
      );
      await f.service.close();
    },
  );
  it("explicit CHECK streams full component status with its original public request and no Prepare/GPU session", async () => {
    const f = fixture(),
      request = command("CHECK"),
      privateId = randomUUID(),
      started = Date.now();
    const status = {
      installation_id: "a".repeat(64),
      started_at: started,
      state: "running" as const,
      checks: [
        { component: "runtime" as const, state: "running" as const },
        { component: "model" as const, state: "pending" as const },
        { component: "youtube_tools" as const, state: "pending" as const },
      ],
    };
    f.setState({ installation_check: { request_id: privateId, status } });
    let publish!: (state: BrowserAccountState) => void;
    f.account.wait.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          publish = resolve;
        }),
    );
    await f.service.command(request);
    expect(f.writes.at(-1)).toEqual({
      protocol_version: 1,
      request_id: request.request_id,
      type: "CHECK",
      payload: status,
    });
    const state = await f.account.command();
    publish({
      ...state,
      revision: state.revision + 1,
      installation_check: {
        request_id: privateId,
        status: {
          ...status,
          state: "passed",
          completed_at: started + 1,
          checks: status.checks.map(({ component }) => ({
            component,
            state: "passed",
          })),
        },
      },
    });
    await vi.waitFor(() =>
      expect(f.writes.at(-1)).toMatchObject({
        type: "CHECK",
        request_id: request.request_id,
        payload: { state: "passed" },
      }),
    );
    expect(f.account.command).toHaveBeenCalledWith({ action: "check" });
    expect(f.getSession).not.toHaveBeenCalled();
    expect(f.account.start).not.toHaveBeenCalled();
    expect(JSON.stringify(f.writes)).not.toContain(privateId);
    await f.service.close();
  });
  it("CHECK busy is explicit while cache/event commands use the same trusted local authority", async () => {
    const f = fixture();
    f.account.command.mockRejectedValueOnce(
      new Error("INSTALLATION_CHECK_BUSY"),
    );
    await f.service.command(command("CHECK"));
    expect(f.writes.at(-1)).toMatchObject({
      type: "ERROR",
      payload: { error_code: "INSTALLATION_CHECK_BUSY" },
    });
    await f.service.command(command("CLEAR_CACHE"));
    expect(f.account.command).toHaveBeenLastCalledWith({
      action: "clear_cache",
    });
    await f.service.command(
      command("EVENT", {
        component: "extension",
        severity: "info",
        event: "private_URL_token",
        url: "https://secret.invalid",
        metrics: { playing: true, token: "secret" },
      }),
    );
    expect(f.account.command).toHaveBeenLastCalledWith({
      action: "event",
      event: {
        subsystem: "chrome",
        event: "resource_sample",
        severity: "info",
        code: "OK",
        phase: null,
        metrics: { playing: true },
        job: null,
      },
    });
    expect(f.getSession).not.toHaveBeenCalled();
    expect(f.account.start).not.toHaveBeenCalled();
    expect(f.writes.at(-1)).toMatchObject({ type: "JOB", payload: null });
    await f.service.close();
  });
  it("allows saved manual Cloud without preparing/opening a GPU session and never sends tokens to Chrome", async () => {
    const f = fixture();
    await f.service.command(command("HELLO"));
    expect(f.writes[0]).toMatchObject({
      type: "HELLO",
      payload: {
        ready: true,
        processing_provider: "ONLINE_MUSICMUTE",
        processing_scope: "a".repeat(64),
      },
    });
    await f.service.command(
      command("START", {
        video_id: "bZxrIoCPsOc",
        duration_seconds: 60,
        provider: "ONLINE_MUSICMUTE",
      }),
    );
    expect(f.account.start).toHaveBeenCalledWith(
      "bZxrIoCPsOc",
      60,
      "a".repeat(64),
      expect.any(String),
    );
    expect(f.getSession).not.toHaveBeenCalled();
    expect(f.writes.at(-1)).toMatchObject({
      type: "JOB",
      payload: { provider: "ONLINE_MUSICMUTE", state: "PROCESSING" },
    });
    expect(JSON.stringify(f.writes)).not.toMatch(
      /token|firebase|S-1-5|scope_uid|C:\\/u,
    );
    await f.service.close();
    expect(f.account.close).toHaveBeenCalledOnce();
  });
  it("checks verified guest cache before local inference and supports cache-only playback restore", async () => {
    const f = fixture("LOCAL_WINDOWS"),
      jobId = randomUUID();
    await f.service.command(command("HELLO"));
    f.getSession.mockClear();
    f.personal.mockClear();
    f.setState({
      job: {
        job_id: jobId,
        video_id: "bZxrIoCPsOc",
        provider: "LOCAL_WINDOWS",
        state: "READY",
        stage: "cache-ready",
        cache_hit: true,
        media: {
          url: "http://127.0.0.1:4321/media/opaque",
          duration_seconds: 60,
          trim_enabled: false,
          model_id: "a".repeat(64),
        },
      },
    });
    await f.service.command(
      command("START", {
        video_id: "bZxrIoCPsOc",
        duration_seconds: 60,
        provider: "LOCAL_WINDOWS",
      }),
    );
    expect(f.account.command).toHaveBeenLastCalledWith({
      action: "local_lookup",
      video_id: "bZxrIoCPsOc",
      duration_seconds: 60,
      cache_only: false,
    });
    expect(f.getSession).not.toHaveBeenCalled();
    await f.service.command(
      command("STATUS", {
        video_id: "bZxrIoCPsOc",
        duration_seconds: 60,
        job_id: jobId,
      }),
    );
    expect(f.account.command).toHaveBeenLastCalledWith({
      action: "local_lookup",
      video_id: "bZxrIoCPsOc",
      duration_seconds: 60,
      cache_only: true,
      restore_job_id: jobId,
    });
    expect(f.account.start).not.toHaveBeenCalled();
    expect(f.personal).not.toHaveBeenCalled();
    await f.service.close();
  });
  it("keeps missing Local setup an error after cache miss without starting Cloud as fallback", async () => {
    const f = fixture("LOCAL_WINDOWS");
    await f.service.command(command("HELLO"));
    await f.service.command(
      command("START", {
        video_id: "bZxrIoCPsOc",
        duration_seconds: 60,
        provider: "LOCAL_WINDOWS",
      }),
    );
    expect(f.writes.at(-1)).toMatchObject({
      type: "ERROR",
      payload: { error_code: "LOCAL_INSTALL_REQUIRED" },
    });
    expect(f.account.start).not.toHaveBeenCalled();
    await f.service.close();
  });
  it("rejects different duration before handing any voice grant to the extension", async () => {
    const f = fixture("LOCAL_WINDOWS");
    await f.service.command(command("HELLO"));
    f.setState({
      job: {
        job_id: randomUUID(),
        video_id: "bZxrIoCPsOc",
        provider: "LOCAL_WINDOWS",
        state: "READY",
        stage: "cache-ready",
        media: {
          url: "http://127.0.0.1:4321/media/opaque",
          duration_seconds: 63,
          trim_enabled: false,
          model_id: "a".repeat(64),
        },
      },
    });
    await f.service.command(
      command("START", {
        video_id: "bZxrIoCPsOc",
        duration_seconds: 60,
        provider: "LOCAL_WINDOWS",
      }),
    );
    expect(f.writes.at(-1)).toMatchObject({
      type: "ERROR",
      payload: { error_code: "TIMELINE_MISMATCH" },
    });
    await f.service.close();
  });
});
