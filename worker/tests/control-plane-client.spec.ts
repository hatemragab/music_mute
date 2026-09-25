import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneError,
  WorkerControlPlaneClient,
} from "../src/runtime/control-plane-client.js";
import { toWireCase } from "../src/runtime/wire-case.js";

const machineId = "cb56441d-f2df-4b44-a320-6f37dfa81f7f";
const workerId = "a69d3899-2214-4427-98cf-b9a4449aeae1";
const sessionId = "df10b680-7663-49ee-a251-4c20721e9ca8";
const incarnation = "e221c880-7196-4fa5-b1b8-ee504e87c04c";
const attemptId = "99f8016b-67f3-4f4b-beb4-205a7b87147e";
const commandId = "f684cb4d-cdef-4bbf-8925-d5701fdf20c7";

function json(
  value: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(toWireCase(value)), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function problem(
  code: string,
  status: number,
  headers?: Record<string, string>,
): Response {
  return json(
    {
      type: "about:blank",
      title: status === 429 ? "Too Many Requests" : "Service Unavailable",
      status,
      detail: "The request cannot be completed yet.",
      code,
      request_id: "request-1",
    },
    status,
    { "Content-Type": "application/problem+json; charset=utf-8", ...headers },
  );
}

describe("worker control-plane client", () => {
  it("requires the API origin without a route prefix", () => {
    expect(
      () =>
        new WorkerControlPlaneClient({
          baseUrl: "https://api.music-mute.com/old-prefix",
          credential: "x".repeat(43),
        }),
    ).toThrow("API origin");
  });

  it("preserves the worker rate-limit code and skips a retry beyond the delay ceiling", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) =>
      problem("WORKER_RATE_LIMITED", 429, { "Retry-After": "60" }),
    );
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: fetchMock as unknown as typeof fetch,
      maxAttempts: 3,
    });

    await expect(
      client.openSession(sessionId, incarnation),
    ).rejects.toMatchObject({
      code: "WORKER_RATE_LIMITED",
      status: 429,
      retryable: true,
      retryAfterMs: 60_000,
    } satisfies Partial<ControlPlaneError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://localhost/worker/sessions",
    );
  });

  it("does not decode legacy JSON errors as problem details", async () => {
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: vi.fn(async () =>
        json({ code: "WORKER_FORBIDDEN", message: "legacy" }, 403),
      ) as unknown as typeof fetch,
      maxAttempts: 1,
    });

    await expect(
      client.openSession(sessionId, incarnation),
    ).rejects.toMatchObject({
      code: "HTTP_403",
      status: 403,
    });
  });

  it("retries a rate limit once its short Retry-After expires", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        problem("WORKER_RATE_LIMITED", 429, { "Retry-After": "0" }),
      )
      .mockResolvedValueOnce(
        json({
          machineId,
          policyRevision: 3,
          serverTime: "2026-01-01T00:00:00.000Z",
        }),
      );
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: fetchMock as unknown as typeof fetch,
      maxAttempts: 2,
    });

    await expect(
      client.openSession(sessionId, incarnation),
    ).resolves.toMatchObject({ machineId });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a lost claim response with the same request identity", async () => {
    const requestBodies: string[] = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestBodies.push(String(init?.body));
      if (requestBodies.length === 1)
        return problem("WORKER_DEPENDENCY_UNAVAILABLE", 503);
      return json({ claim: null, serverTime: "2026-01-01T00:00:00.000Z" });
    });
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://127.0.0.1",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: fetchMock as unknown as typeof fetch,
      maxAttempts: 2,
    });
    const requestId = "74fcfb85-8cc8-49cb-b8c2-5db33a9896ea";
    const controller = new AbortController();

    await expect(
      client.claim(
        { workerId, sessionId, incarnation },
        "gpu-0",
        0,
        1,
        requestId,
        controller.signal,
      ),
    ).resolves.toEqual({
      claim: null,
      serverTime: "2026-01-01T00:00:00.000Z",
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(JSON.parse(requestBodies[0]!) as unknown).toMatchObject({
      request_id: requestId,
      applied_policy_revision: 1,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${"x".repeat(43)}`,
    });
  });

  it("validates the machine identity returned when a session opens", async () => {
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: vi.fn(async () =>
        json({
          machineId,
          policyRevision: 3,
          serverTime: "2026-01-01T00:00:00.000Z",
        }),
      ) as unknown as typeof fetch,
    });

    await expect(client.openSession(sessionId, incarnation)).resolves.toEqual({
      machineId,
      policyRevision: 3,
      serverTime: "2026-01-01T00:00:00.000Z",
    });
  });

  it("mints a short-lived hint ticket over HTTPS and derives the raw socket URL", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      json({
        ticket: "t".repeat(43),
        path: "/worker/hints/socket",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    );
    const client = new WorkerControlPlaneClient({
      baseUrl: "https://api.music-mute.com",
      credential: "x".repeat(43),
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.hintTicket()).resolves.toMatchObject({
      socketUrl: "wss://api.music-mute.com/worker/hints/socket",
      ticket: "t".repeat(43),
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.music-mute.com/worker/hints/tickets",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("parses pending remote commands from worker configuration", async () => {
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: vi.fn(async () =>
        json({
          machineId,
          machineStatus: "active",
          desiredRevision: 1,
          appliedRevision: 1,
          claimAllowed: true,
          policy: {
            revision: 1,
            acceptClaims: true,
            recipes: [],
            leaseSeconds: 90,
            processingDeadlineSeconds: 300,
          },
          commands: [
            {
              commandId,
              kind: "doctor",
              state: "pending",
              checks: ["service", "model"],
              recipeId: null,
              iterations: null,
              requestedAt: "2026-01-01T00:00:00.000Z",
              expiresAt: "2026-01-01T01:00:00.000Z",
              summary: null,
              metrics: [],
              completedAt: null,
              revision: 1,
            },
          ],
          serverTime: "2026-01-01T00:00:01.000Z",
        }),
      ) as unknown as typeof fetch,
    });

    await expect(client.config(sessionId, incarnation)).resolves.toMatchObject({
      commands: [{ commandId, kind: "doctor", checks: ["service", "model"] }],
    });
  });

  it("reports a remote command result with a caller-stable request ID", async () => {
    const requestId = "ab22125e-3085-42cf-b6b2-94e89b467df1";
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      json({ commandId, state: "succeeded", replayed: false }),
    );
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.completeCommand(commandId, sessionId, incarnation, requestId, {
      outcome: "succeeded",
      summary: "5 worker health checks passed",
      metrics: [{ name: "check.service", value: 1, unit: "boolean" }],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://localhost/worker/commands/${commandId}/results`,
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      request_id: requestId,
      session_id: sessionId,
      incarnation,
      outcome: "succeeded",
    });
  });

  it("rejects a mixed-attempt response", async () => {
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: vi.fn(async () =>
        json({
          requestId: "4b44d7e2-114e-4f1b-aa68-f334469c259d",
          attemptId,
          object: {
            key: "input/source.mp3",
            versionId: "v1",
            bytes: 1,
            sha256: "A".repeat(43) + "=",
            contentType: "audio/mpeg",
          },
          grant: {
            url: "https://storage.invalid/input",
            expiresAt: "2026-01-01T00:01:00.000Z",
          },
        }),
      ) as unknown as typeof fetch,
    });

    await expect(
      client.inputGrant(attemptId, { workerId, sessionId, incarnation }),
    ).rejects.toThrow("response identity changed");
  });

  it("requests and validates backend-confirmed self-unpair", async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      json({ machineId, status: "revoked", confirmed: true, revision: 4 }),
    );
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.unpair(true)).resolves.toEqual({
      machineId,
      status: "revoked",
      confirmed: true,
      revision: 4,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      force: true,
    });
  });

  it("validates machine authority status and tolerates future fields", async () => {
    const response = {
      machineId,
      status: "paused",
      groupId: "studio",
      policyRevision: 9,
      revision: 12,
      lastSeenAt: "2026-09-21T01:00:00.000Z",
      activeAttempts: 2,
      claimsAllowed: false,
      future_field: "new server field",
    };
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      json(response),
    );
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.machineStatus()).resolves.toEqual({
      ...response,
      future_field: undefined,
      futureField: "new server field",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://localhost/worker/status",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it("still rejects a machine status with an invalid required field", async () => {
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: (async () =>
        json({
          machineId,
          status: "paused",
          groupId: "studio",
          policyRevision: 9,
          revision: 12,
          lastSeenAt: null,
          activeAttempts: 2,
          claimsAllowed: "false",
          future_field: "new server field",
        })) as typeof fetch,
    });

    await expect(client.machineStatus()).rejects.toThrow(
      "Machine status response is invalid",
    );
  });

  it("requests a machine-authenticated macOS update candidate", async () => {
    const response = {
      schemaVersion: 1,
      platform: "darwin-arm64",
      signed: { keyId: "release-test" },
      grant: {
        url: "https://storage.invalid/release.tar.gz?token=one-use",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      json(response),
    );
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.macUpdateCandidate()).resolves.toMatchObject({
      signed: response.signed,
      grant: response.grant,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://localhost/worker/updates",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      platform: "darwin-arm64",
      download: false,
    });
  });
});
