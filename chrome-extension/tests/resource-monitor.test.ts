import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginSample,
  RESOURCE_SAMPLE_INTERVAL_MS,
} from "../src/companion/resource-monitor";
import type { DiagnosticInput } from "../src/shared/protocol";

afterEach(() => vi.useRealTimers());
describe("owned process sampling", () => {
  it("samples companion resources locally and releases its sampling timer", () => {
    vi.useFakeTimers();
    const events: DiagnosticInput[] = [];
    const stop = beginSample(process.pid, (event) => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]?.metrics?.rss_bytes).toBeGreaterThan(0);
    expect(events[0]?.metrics?.resource_scope).toBe("companion");
    vi.advanceTimersByTime(RESOURCE_SAMPLE_INTERVAL_MS);
    expect(events).toHaveLength(2);
    stop();
    vi.advanceTimersByTime(RESOURCE_SAMPLE_INTERVAL_MS * 2);
    expect(events).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not leave a timer after stopping or expose arbitrary child arguments", () => {
    expect(() => beginSample(-1, () => undefined)).toThrow(
      "INVALID_RESOURCE_PID",
    );
    expect(() => beginSample(NaN, () => undefined)).toThrow(
      "INVALID_RESOURCE_PID",
    );
    vi.useFakeTimers();
    const stop = beginSample(process.pid, () => {
      throw new Error("fixture-handler-failure");
    });
    expect(() =>
      vi.advanceTimersByTime(RESOURCE_SAMPLE_INTERVAL_MS),
    ).not.toThrow();
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
