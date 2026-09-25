import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient, ApiError, submitWithReceiptReadBack } from "./api-client";
import { toWireCase } from "./wire-case";

const response = (status: number, body: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const problem = (
  status: number,
  code: string,
  detail: string,
  headers?: HeadersInit,
) =>
  response(
    status,
    {
      type: "about:blank",
      title: status === 429 ? "Too Many Requests" : "Forbidden",
      status,
      detail,
      code,
      request_id: "request-1",
    },
    { "content-type": "application/problem+json; charset=utf-8", ...headers },
  );

describe("ApiClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refreshes once and retries a safe read after a 401", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(problem(401, "UNAUTHENTICATED", "Sign in again"))
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

  it("returns null for an empty successful JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new ApiClient({
      origin: "https://api.example.test",
      getToken: vi.fn().mockResolvedValue("token"),
    });

    await expect(client.get("/admin/users/user-1/restriction")).resolves.toBe(
      null,
    );
  });

  it("still rejects malformed non-empty JSON responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new ApiClient({
      origin: "https://api.example.test",
      getToken: vi.fn().mockResolvedValue("token"),
    });

    await expect(client.get("/admin/users/user-1")).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });

  it("never replays a mutation after an authentication failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(problem(401, "UNAUTHENTICATED", "Sign in again"));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient({
      origin: "https://api.example.test",
      getToken: vi.fn().mockResolvedValue("token"),
    });

    await expect(
      client.post("/admin/releases/release-1/publications", {
        operationId: "op",
      }),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects for authenticated JSON and CSV requests", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { ok: true }))
      .mockResolvedValueOnce(
        new Response("id\n1", {
          status: 200,
          headers: { "content-type": "text/csv" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      origin: "https://api.example.test",
      getToken: vi.fn().mockResolvedValue("token"),
    });

    await client.get("/admin/session", { redirect: "follow" });
    await client.download("/admin/exports/jobs.csv");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example.test/admin/session",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.test/admin/exports/jobs.csv",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("decodes problem JSON and preserves Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        problem(429, "RATE_LIMITED", "Try again later", {
          "retry-after": "12",
        }),
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
      message: "Try again later",
      requestId: "request-1",
      retryAfterSeconds: 12,
    });
  });

  it("does not accept legacy JSON error fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        response(403, {
          code: "FORBIDDEN",
          message: "Legacy detail",
          requestId: "legacy-request",
        }),
      ),
    );
    const client = new ApiClient({
      origin: "https://api.example.test",
      getToken: vi.fn().mockResolvedValue("token"),
    });

    await expect(client.get("/admin/session")).rejects.toMatchObject({
      status: 403,
      code: "REQUEST_FAILED",
      message: "The request could not be completed.",
      requestId: undefined,
    });
  });

  it("rejects stale camelCase success responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(response(200, { policyRevision: 3 })),
    );
    const client = new ApiClient({
      origin: "https://api.example.test",
      getToken: vi.fn().mockResolvedValue("token"),
    });

    await expect(client.get("/admin/worker-fleet/policy")).rejects.toThrow(
      "non-wire key",
    );
  });

  it("uses snake_case JSON and query keys while preserving upload headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response(200, {
        _id: "record-1",
        policy_revision: 3,
        grant: { headers: { "Content-Type": "audio/mpeg" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      origin: "https://api.example.test",
      getToken: vi.fn().mockResolvedValue("token"),
    });

    await expect(
      client.post("/admin/worker-fleet/policy?groupId=studio", {
        operationId: "op-1",
        recipes: [{ maxSlotsPerMachine: 2 }],
      }),
    ).resolves.toEqual({
      _id: "record-1",
      policyRevision: 3,
      grant: { headers: { "Content-Type": "audio/mpeg" } },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/admin/worker-fleet/policy?group_id=studio",
      expect.objectContaining({
        body: JSON.stringify({
          operation_id: "op-1",
          recipes: [{ max_slots_per_machine: 2 }],
        }),
      }),
    );
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
          origin: "https://api.example.test/admin",
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
      .mockResolvedValue(response(200, toWireCase(receipt)));
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
