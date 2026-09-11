import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient, ApiError, submitWithReceiptReadBack } from "./api-client";

const response = (status: number, body: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("ApiClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refreshes once and retries a safe read after a 401", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(401, { code: "UNAUTHENTICATED" }))
      .mockResolvedValueOnce(response(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const getToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("old")
      .mockResolvedValueOnce("fresh");

    const client = new ApiClient({
      origin: "https://api.example.test",
      getToken,
    });

    await expect(client.get("/admin/session")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenNthCalledWith(2, true);
  });

  it("never replays a mutation after an authentication failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(401, { code: "UNAUTHENTICATED" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({
      origin: "https://api.example.test",
      getToken: vi.fn().mockResolvedValue("token"),
    });

    await expect(
      client.post("/admin/releases/release-1/publish", { operationId: "op" }),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the safe error envelope and Retry-After duration", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        response(
          429,
          {
            code: "RATE_LIMITED",
            message: "Try again later",
            requestId: "request-1",
          },
          { "retry-after": "12" },
        ),
      ),
    );
    const client = new ApiClient({
      origin: "https://api.example.test",
      getToken: vi.fn().mockResolvedValue("token"),
    });

    const error = await client.get("/admin/health").catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
      requestId: "request-1",
      retryAfterSeconds: 12,
    });
  });

  it("rejects insecure non-local API origins", () => {
    expect(
      () =>
        new ApiClient({
          origin: "http://api.example.test",
          getToken: vi.fn().mockResolvedValue("token"),
        }),
    ).toThrow("HTTPS");
  });

  it("rejects an API base path embedded in the configured origin", () => {
    expect(
      () =>
        new ApiClient({
          origin: "https://api.example.test/api/v1",
          getToken: vi.fn().mockResolvedValue("token"),
        }),
    ).toThrow("origin");
  });

  it("passes a succeeded operation receipt to resource read-back", async () => {
    const receipt = {
      operationId: "operation-1",
      status: "succeeded" as const,
      resourceId: "resource-7",
      revision: 4,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(200, receipt));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      origin: "https://api.example.test",
      getToken: vi.fn().mockResolvedValue("token"),
    });
    const readResult = vi.fn().mockResolvedValue({ id: "resource-7" });

    await expect(
      submitWithReceiptReadBack({
        client,
        operationId: "operation-1",
        submit: vi.fn().mockRejectedValue(new TypeError("connection reset")),
        readResult,
      }),
    ).resolves.toEqual({ id: "resource-7" });
    expect(readResult).toHaveBeenCalledWith(receipt);
  });
});
