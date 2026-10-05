import { describe, expect, it, vi } from "vitest";
import {
  AccountApiClient,
  accountApiOrigin,
  boundedJson,
} from "../src/companion/account-api.js";
import {
  parseDesktopRequest,
  type DesktopSession,
} from "../src/shared/desktop-protocol.js";
import { MAX_OFFLINE_VOCALS_BUDGET_BYTES } from "../src/shared/storage-policy.js";

const requestId = "9c434f91-4e73-4bb5-8fe2-cb186284f54a";
const session: DesktopSession = {
  firebase_uid: "owner-a",
  session_generation: "38b8e310-4805-42f2-b065-447b031c542e",
  installation_id: "ec1b47e6-c4b2-4e08-8957-fafbf5b18543",
  id_token: "header.payload.signature",
};
const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("native desktop account boundary", () => {
  it.each([
    1_000_000_000,
    2_000_000_000,
    5_000_000_000,
    MAX_OFFLINE_VOCALS_BUDGET_BYTES,
  ])(
    "accepts local cache setting %s without requiring an account",
    (budget_bytes) => {
      const request = {
        protocol_version: 1,
        request_id: requestId,
        type: "SET_CACHE_BUDGET",
        payload: { budget_bytes },
      };
      expect(parseDesktopRequest(JSON.stringify(request))).toEqual(request);
    },
  );
  it.each([
    {},
    { budget_bytes: "2000000000" },
    { budget_bytes: null },
    { budget_bytes: -1 },
    { budget_bytes: 0 },
    { budget_bytes: 500_000_000 },
    { budget_bytes: 1_500_000_000 },
    { budget_bytes: 1_000_000_000.5 },
    { budget_bytes: Number.MAX_SAFE_INTEGER },
    { budget_bytes: MAX_OFFLINE_VOCALS_BUDGET_BYTES + 1_000_000_000 },
    { budget_bytes: 2_000_000_000, force: true },
  ])("strictly rejects malformed storage setting %j", (payload) => {
    expect(() =>
      parseDesktopRequest(
        JSON.stringify({
          protocol_version: 1,
          request_id: requestId,
          type: "SET_CACHE_BUDGET",
          payload,
        }),
      ),
    ).toThrow("INVALID_DESKTOP_REQUEST");
  });
  it("allows offline owner association while requiring a token for cloud commands", () => {
    const { id_token: _token, ...owner } = session;
    const request = {
      protocol_version: 1,
      request_id: requestId,
      session: owner,
      type: "LOCAL_START",
      payload: {
        source_kind: "url",
        youtube_url: "https://www.youtube.com/watch?v=bZxrIoCPsOc",
      },
    };
    expect(parseDesktopRequest(JSON.stringify(request)).type).toBe(
      "LOCAL_START",
    );
    expect(() =>
      parseDesktopRequest(JSON.stringify({ ...request, type: "CLOUD_START" })),
    ).toThrow("INVALID_DESKTOP_REQUEST");
    expect(() =>
      parseDesktopRequest(
        JSON.stringify({
          ...request,
          payload: { ...request.payload, trim: true },
        }),
      ),
    ).toThrow();
  });

  it("accepts only an empty cache-clear payload and validates an optional local session", () => {
    const { id_token: _token, ...owner } = session;
    const request = {
      protocol_version: 1,
      request_id: requestId,
      type: "CLEAR_CACHE",
      payload: {},
    };
    expect(parseDesktopRequest(JSON.stringify(request))).toEqual(request);
    expect(
      parseDesktopRequest(JSON.stringify({ ...request, session: owner })),
    ).toEqual({ ...request, session: owner });
    expect(() =>
      parseDesktopRequest(
        JSON.stringify({ ...request, payload: { force: true } }),
      ),
    ).toThrow("INVALID_DESKTOP_REQUEST");
    expect(() =>
      parseDesktopRequest(
        JSON.stringify({
          ...request,
          session: { ...owner, installation_id: "not-a-uuid" },
        }),
      ),
    ).toThrow("INVALID_DESKTOP_REQUEST");
  });

  it.each([
    "http://api.music-mute.com",
    "https://user:password@api.music-mute.com",
    "https://api.music-mute.com/private",
    "https://api.music-mute.com/?token=secret",
  ])("rejects an unsafe API origin %s", (origin) => {
    expect(() => accountApiOrigin(origin)).toThrow("INVALID_API_ORIGIN");
  });

  it("uses native headers and forbids following a bearer redirect", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ committed: true }));
    const api = new AccountApiClient(
      "https://api.music-mute.com",
      async () => session,
      () => true,
      fetcher,
    );
    await api.request(session, "/local-media-syncs", "POST", {
      request_id: requestId,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://api.music-mute.com/local-media-syncs");
    expect(options.redirect).toBe("error");
    expect(options.headers["X-Installation-Id"]).toBe(session.installation_id);
    expect(options.headers.Authorization).toBe(`Bearer ${session.id_token}`);
  });

  it("fences a session change while retrieving credentials before sending", async () => {
    const fetcher = vi.fn();
    let current = true;
    const api = new AccountApiClient(
      "https://api.music-mute.com",
      async () => {
        current = false;
        return session;
      },
      () => current,
      fetcher,
    );
    await expect(api.request(session, "/jobs", "GET")).rejects.toMatchObject({
      code: "ACCOUNT_CHANGED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not expose a response after switching accounts during transport", async () => {
    let current = true;
    const fetcher = vi.fn().mockImplementation(async () => {
      current = false;
      return json({ items: [{ id: "account-a-private-job" }] });
    });
    const api = new AccountApiClient(
      "https://api.music-mute.com",
      async () => session,
      () => current,
      fetcher,
    );
    await expect(api.request(session, "/jobs", "GET")).rejects.toMatchObject({
      code: "ACCOUNT_CHANGED",
    });
  });

  it("never repeats a failed mutation or reveals remote private exception text", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValue(new Error("private signed URL and token"));
    const api = new AccountApiClient(
      "https://api.music-mute.com",
      async () => session,
      () => true,
      fetcher,
    );
    await expect(
      api.request(session, "/jobs", "POST", {}),
    ).rejects.toMatchObject({
      message: "API_UNAVAILABLE",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves quota codes and bounded Retry-After without remote prose", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        json(
          { code: "UPLOAD_LIMIT_REACHED", message: "user private data" },
          429,
          { "retry-after": "999999" },
        ),
      );
    const api = new AccountApiClient(
      "https://api.music-mute.com",
      async () => session,
      () => true,
      fetcher,
    );
    await expect(
      api.request(session, "/jobs", "POST", {}),
    ).rejects.toMatchObject({
      status: 429,
      message: "UPLOAD_LIMIT_REACHED",
      retry_after_seconds: 86400,
    });
  });

  it("bounds streamed replies even without a Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"private":"'));
        controller.enqueue(new Uint8Array(100));
        controller.close();
      },
    });
    await expect(
      boundedJson(
        new Response(body, { headers: { "content-type": "application/json" } }),
        64,
      ),
    ).rejects.toMatchObject({ code: "API_REPLY_TOO_LARGE" });
  });
});
