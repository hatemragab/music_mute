import { describe, expect, it, vi } from "vitest";
import { WorkerControlPlaneClient } from "../src/runtime/control-plane-client.js";

const machineId = "cb56441d-f2df-4b44-a320-6f37dfa81f7f";
const workerId = "a69d3899-2214-4427-98cf-b9a4449aeae1";
const sessionId = "df10b680-7663-49ee-a251-4c20721e9ca8";
const incarnation = "e221c880-7196-4fa5-b1b8-ee504e87c04c";
const attemptId = "99f8016b-67f3-4f4b-beb4-205a7b87147e";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("worker control-plane client", () => {
  it("retries a lost claim response with the same request identity", async () => {
    const requestBodies: string[] = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestBodies.push(String(init?.body));
      if (requestBodies.length === 1)
        return json(
          {
            statusCode: 503,
            code: "WORKER_DEPENDENCY_UNAVAILABLE",
            message: "unavailable",
          },
          503,
        );
      return json({ claim: null, serverTime: "2026-01-01T00:00:00.000Z" });
    });
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://127.0.0.1/api/v1",
      credential: "x".repeat(43),
      allowInsecureLoopback: true,
      fetch: fetchMock as unknown as typeof fetch,
      maxAttempts: 2,
    });
    const requestId = "74fcfb85-8cc8-49cb-b8c2-5db33a9896ea";

    await expect(
      client.claim(
        { workerId, sessionId, incarnation },
        "gpu-0",
        0,
        1,
        requestId,
      ),
    ).resolves.toEqual({
      claim: null,
      serverTime: "2026-01-01T00:00:00.000Z",
    });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(JSON.parse(requestBodies[0]!) as unknown).toMatchObject({
      requestId,
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Bearer ${"x".repeat(43)}`,
    });
  });

  it("validates the machine identity returned when a session opens", async () => {
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost/api/v1",
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

  it("rejects a mixed-attempt response", async () => {
    const client = new WorkerControlPlaneClient({
      baseUrl: "http://localhost/api/v1",
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
});
