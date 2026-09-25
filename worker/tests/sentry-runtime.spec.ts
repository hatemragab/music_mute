import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEvent } from "../src/runtime/worker-runtime.js";

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
  flush: vi.fn(),
}));
vi.mock("@sentry/node", () => sdk);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

const event: RuntimeEvent = {
  schemaVersion: 2,
  recordedAt: "2026-09-25T00:00:00.000Z",
  sequence: 1,
  sessionId: "cb56441d-f2df-4b44-a320-6f37dfa81f7f",
  incarnation: "fixture",
  component: "worker-runtime",
  severity: "error",
  kind: "attempt-failed",
  workerId: "a69d3899-2214-4427-98cf-b9a4449aeae1",
  jobId: "64b000000000000000000001",
  attemptId: "99f8016b-67f3-4f4b-beb4-205a7b87147e",
  code: "DOWNLOAD_FAILED",
  stage: "input-download",
  retryable: true,
};

describe("handled runtime Sentry failures", () => {
  it("submits an attempt-correlated sanitized event through the SDK privacy filter", async () => {
    vi.stubEnv("MUSICMUTE_SENTRY_ENABLED", "true");
    const reporting = await import("../src/observability/sentry.js");
    reporting.initializeWorkerSentry();
    reporting.captureWorkerRuntimeEvent(event);
    expect(sdk.captureException).toHaveBeenCalledOnce();
    const tags = sdk.captureException.mock.calls[0]![1].tags;
    const beforeSend = sdk.init.mock.calls[0]![0].beforeSend;
    const filtered = beforeSend({
      tags: { ...tags, credential: "private" },
      exception: { values: [{ type: "Error", value: "secret raw detail" }] },
    });
    expect(filtered.tags.attemptId).toBe(event.attemptId);
    expect(filtered.tags.failureCode).toBe("DOWNLOAD_FAILED");
    expect(JSON.stringify(filtered)).not.toMatch(
      /private|secret raw detail|credential/,
    );
    sdk.captureException.mockImplementationOnce(() => {
      throw new Error("reporter unavailable");
    });
    expect(() => reporting.captureWorkerRuntimeEvent(event)).not.toThrow();
  });

  it("respects disabled reporting", async () => {
    vi.stubEnv("MUSICMUTE_SENTRY_ENABLED", "false");
    const reporting = await import("../src/observability/sentry.js");
    reporting.initializeWorkerSentry();
    reporting.captureWorkerRuntimeEvent(event);
    expect(sdk.captureException).not.toHaveBeenCalled();
  });
});
