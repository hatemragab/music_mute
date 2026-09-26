import { afterEach, expect, test, vi } from "vitest";
import { ApiClient } from "./client";
import { fromWire, toWire } from "./wire";

afterEach(() => vi.unstubAllGlobals());

test("wire conversion keeps signed transfer headers unchanged", () => {
  expect(
    toWire({ requestId: "x", signed: { headers: { "x-amz-meta-ABC": "ok" } } }),
  ).toEqual({
    request_id: "x",
    signed: { headers: { "x-amz-meta-ABC": "ok" } },
  });
  expect(fromWire({ next_cursor: null })).toEqual({ nextCursor: null });
});

test("a safe read refreshes a 401 once and preserves installation scope", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response("{}", { status: 401 }))
    .mockResolvedValueOnce(
      new Response('{"next_cursor":null}', { status: 200 }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const token = vi
    .fn()
    .mockResolvedValueOnce("old")
    .mockResolvedValueOnce("new");
  const api = new ApiClient({
    origin: "https://api.example.com",
    token,
    installationId: () => "installation",
  });
  await expect(api.get("/jobs")).resolves.toEqual({ nextCursor: null });
  expect(token).toHaveBeenLastCalledWith(true);
  expect(fetchMock.mock.calls[1][1].headers.get("Authorization")).toBe(
    "Bearer new",
  );
  expect(fetchMock.mock.calls[1][1].headers.get("X-Installation-Id")).toBe(
    "installation",
  );
});

test("a failed write is not retried and exposes server code and retry delay", async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response('{"code":"PROCESSING_UNAVAILABLE","request_id":"r"}', {
      status: 429,
      headers: { "Retry-After": "7" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const api = new ApiClient({
    origin: "https://api.example.com",
    token: async () => "token",
    installationId: () => "id",
  });
  await expect(
    api.post("/media-imports", { requestId: "r" }),
  ).rejects.toMatchObject({
    status: 429,
    code: "PROCESSING_UNAVAILABLE",
    requestId: "r",
    retryAfter: 7,
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
