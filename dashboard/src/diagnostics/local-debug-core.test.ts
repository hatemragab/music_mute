import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalLogger, redactLocalLog } from "./local-debug-core";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
describe("private local diagnostics", () => {
  it("redacts nested and encoded credentials, safe errors, URLs and connection strings", () => {
    const marker = "SYNTHETIC_SECRET_DO_NOT_RETAIN";
    const result = JSON.stringify(
      redactLocalLog({
        password: marker,
        nested: [{ authorization: `Bearer ${marker}` }],
        json: JSON.stringify({ access_token: marker }),
        encoded: btoa(JSON.stringify({ refresh_token: marker })),
        url: `https://user:${marker}@example.test/audio?X-Amz-Signature=${marker}`,
        detail: `mongodb://user:${marker}@localhost/db`,
        error: new Error(marker),
      }),
    );
    expect(result).not.toContain(marker);
    expect(result).toContain("REDACTED");
  });
  it("bounds recursion, arrays, strings and getters without evaluating arbitrary accessors", () => {
    const getter = vi.fn(() => "private");
    const object = Object.defineProperty(
      { value: "x".repeat(9000), list: Array(100).fill(1) },
      "secretish",
      { enumerable: true, get: getter },
    );
    const result = JSON.stringify(redactLocalLog(object));
    expect(getter).not.toHaveBeenCalled();
    expect(result).toContain("string_limit");
    expect(result).toContain("array_limit");
    expect(result.length).toBeLessThan(6000);
  });
  it("does not send or log when disabled and rejects non-loopback endpoints", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const options of [
      { enabled: false, endpoint: "http://127.0.0.1:19740" },
      { enabled: true, endpoint: "https://example.test" },
    ]) {
      const logger = createLocalLogger({
        ...options,
        source: "web-client",
        payloads: true,
      });
      logger.emit("test.event", { safe: true });
      expect(logger.status().enabled).toBe(false);
    }
    await tick();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves HTTP results and request correlation while redacting payloads", async () => {
    const captured: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("19740")) {
        captured.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return new Response(null, { status: 202 });
      }
      return new Response(
        JSON.stringify({ password: "SYNTHETIC_SECRET", result: 42 }),
        {
          status: 201,
          headers: {
            "content-type": "application/json",
            "x-request-id": "request-safe-1",
          },
        },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const logger = createLocalLogger({
      enabled: true,
      source: "web-client",
      endpoint: "http://127.0.0.1:19740",
      payloads: true,
    });
    const response = await logger.fetch("http://localhost/api", {
      method: "POST",
      body: JSON.stringify({ token: "SYNTHETIC_SECRET" }),
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { result: number }).result).toBe(42);
    await tick();
    const responseLog = captured.find(
      (event) => event.name === "http.response",
    );
    expect(responseLog?.requestId).toBe("request-safe-1");
    expect(JSON.stringify(captured)).not.toContain("SYNTHETIC_SECRET");
    expect(logger.status().delivered).toBeGreaterThanOrEqual(2);
    logger.stop();
  });
  it("keeps abort identity and bounds pending writes under sink pressure", async () => {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            callbacks.push(() => resolve(new Response(null, { status: 503 })));
          }),
      ),
    );
    const logger = createLocalLogger({
      enabled: true,
      source: "web-client",
      endpoint: "http://127.0.0.1:19740",
      payloads: true,
    });
    for (let index = 0; index < 100; index++)
      logger.emit("test.pressure", { index });
    expect(logger.status().pending).toBeLessThanOrEqual(66);
    expect(logger.status().dropped).toBe(34);
    logger.stop();
    callbacks.forEach((callback) => callback());
    await tick();
    expect(logger.status().failed).toBe(2);
    const abort = new DOMException("private detail", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        if (!String(input).includes("19740")) throw abort;
        return new Response(null, { status: 202 });
      }),
    );
    const second = createLocalLogger({
      enabled: true,
      source: "web-client",
      endpoint: "http://127.0.0.1:19740",
    });
    await expect(second.fetch("http://localhost/fail")).rejects.toBe(abort);
    second.stop();
  });
});

it("redacts full bounded structured strings and never reads or clones an unconsumed response", async () => {
  const marker = "SYNTHETIC_LONG_SECRET";
  const redacted = JSON.stringify(
    redactLocalLog(
      JSON.stringify({
        items: Array.from({ length: 40 }, () => ({
          label: "safe".repeat(30),
          token: marker,
        })),
      }),
    ),
  );
  expect(redacted).not.toContain(marker);
  expect(redacted).toContain("REDACTED");
  const response = new Response("private binary", {
    headers: { "content-type": "audio/mpeg" },
  });
  const clone = vi.spyOn(response, "clone");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) =>
      String(input).includes("19740")
        ? new Response(null, { status: 202 })
        : response,
    ),
  );
  const logger = createLocalLogger({
    enabled: true,
    source: "web-client",
    endpoint: "http://127.0.0.1:19740",
    payloads: true,
  });
  expect(await logger.fetch("http://localhost/media")).toBe(response);
  expect(response.bodyUsed).toBe(false);
  expect(clone).not.toHaveBeenCalled();
  logger.stop();
});

it("records existing JSON consumption failure and bounds oversized metadata", async () => {
  const captured: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("19740")) {
        captured.push(
          JSON.parse(String(init?.body)) as Record<string, unknown>,
        );
        return new Response(null, { status: 202 });
      }
      return new Response('{"incomplete":', {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const logger = createLocalLogger({
    enabled: true,
    source: "web-client",
    endpoint: "http://127.0.0.1:19740",
    payloads: true,
  });
  const response = await logger.fetch("http://localhost/api");
  await expect(response.json()).rejects.toBeInstanceOf(SyntaxError);
  const metadata = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      "field" + index,
      "x".repeat(4000),
    ]),
  );
  logger.emit("test.oversized", undefined, "info", metadata);
  await tick();
  expect(captured.some((event) => event.name === "http.body_failed")).toBe(
    true,
  );
  expect(
    captured.every(
      (event) =>
        new TextEncoder().encode(JSON.stringify(event)).length <= 48 * 1024,
    ),
  ).toBe(true);
  expect(logger.status().omitted).toBeGreaterThan(0);
  logger.stop();
});

it("preserves business transport when a context provider throws", async () => {
  let businessCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      if (String(input).includes("19740"))
        return new Response(null, { status: 202 });
      businessCalls++;
      return new Response(JSON.stringify({ result: "unchanged" }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const logger = createLocalLogger({
    enabled: true,
    source: "web-client",
    endpoint: "http://127.0.0.1:19740",
    context: () => {
      throw new Error("private context failure");
    },
  });
  const response = await logger.fetch("http://localhost/api");
  expect(await response.json()).toEqual({ result: "unchanged" });
  expect(businessCalls).toBe(1);
  expect(logger.status().failed).toBeGreaterThan(0);
  logger.stop();
});

it("omits opaque runtime rejection and caught reasons without suppressing HTTP payloads", async () => {
  const opaque = "OpaqueUnlabelledCredentialValue571b23c9";
  const captured: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 202 });
    }),
  );
  const logger = createLocalLogger({
    enabled: true,
    source: "web-client",
    endpoint: "http://127.0.0.1:19740",
    payloads: true,
  });
  logger.emit("runtime.rejection", opaque, "error");
  logger.emit("runtime.error", { message: opaque }, "error");
  logger.emit("runtime.caught", opaque, "error");
  logger.emit("runtime.uncaught", new Error(opaque), "error");
  logger.emit("http.payload", {
    response: { result: "ordinary-safe-payload" },
  });
  await tick();
  expect(JSON.stringify(captured)).not.toContain(opaque);
  expect(
    captured.find((event) => event.name === "runtime.rejection")?.data,
  ).toEqual({ omitted: "untrusted_rejection_reason", type: "string" });
  expect(
    captured.find((event) => event.name === "runtime.error")?.data,
  ).toEqual({ omitted: "untrusted_rejection_reason", type: "object" });
  expect(
    captured.find((event) => event.name === "runtime.uncaught")?.data,
  ).toMatchObject({
    name: "Error",
    omitted: "untrusted_error_message_and_stack",
  });
  expect(captured.find((event) => event.name === "http.payload")?.data).toEqual(
    { response: { result: "ordinary-safe-payload" } },
  );
  logger.stop();
});
