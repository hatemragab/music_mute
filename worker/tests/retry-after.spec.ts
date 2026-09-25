import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_RETRY_DELAY_MS,
  retryAfterMilliseconds,
} from "../src/runtime/retry-after.js";

afterEach(() => vi.restoreAllMocks());

describe("worker Retry-After", () => {
  it("accepts seconds and HTTP dates within the retry ceiling", () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2025-01-01T00:00:00.500Z"),
    );

    expect(retryAfterMilliseconds("1")).toBe(1_000);
    expect(retryAfterMilliseconds("Wed, 01 Jan 2025 00:00:02 GMT")).toBe(1_500);
    expect(retryAfterMilliseconds("0")).toBe(0);
  });

  it("marks longer waits as over the ceiling and ignores invalid values", () => {
    expect(retryAfterMilliseconds("60")).toBe(60_000);
    expect(retryAfterMilliseconds("999999")).toBeGreaterThan(
      MAX_RETRY_DELAY_MS,
    );
    expect(retryAfterMilliseconds("invalid")).toBeUndefined();
    expect(retryAfterMilliseconds(null)).toBeUndefined();
  });
});
