import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttemptProgressReporter,
  publicAttemptProgress,
} from "../src/runtime/progress-reporter.js";

afterEach(() => vi.useRealTimers());

describe("attempt progress transport", () => {
  it("reports actual window completion without claiming durable job completion", () => {
    expect(
      publicAttemptProgress("separation", {
        unit: "windows",
        completed: 8,
        total: 20,
      }),
    ).toEqual({ phase: "separating", phasePercent: 40 });
    expect(
      publicAttemptProgress("separation", {
        unit: "windows",
        completed: 20,
        total: 20,
      }),
    ).toEqual({ phase: "separating", phasePercent: 99 });
    expect(publicAttemptProgress("output-upload")).toEqual({
      phase: "saving-result",
      phasePercent: null,
    });
  });

  it("coalesces updates and sends them in bounded sequence", async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const reporter = new AttemptProgressReporter(send, () => undefined);
    reporter.update({ phase: "preparing", phasePercent: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledWith({
      sequence: 1,
      phase: "preparing",
      phasePercent: null,
    });
    reporter.update({ phase: "separating", phasePercent: null });
    reporter.update({ phase: "separating", phasePercent: 40 });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenLastCalledWith({
      sequence: 2,
      phase: "separating",
      phasePercent: 40,
    });
    reporter.update({ phase: "saving-result", phasePercent: null });
    reporter.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("records a failed update without blocking a later stage", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const failure = vi.fn();
    const reporter = new AttemptProgressReporter(send, failure);
    reporter.update({ phase: "preparing", phasePercent: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(failure).toHaveBeenCalledTimes(1);
    reporter.update({ phase: "separating", phasePercent: null });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenLastCalledWith({
      sequence: 2,
      phase: "separating",
      phasePercent: null,
    });
    reporter.close();
  });

  it("retries the latest stage after a temporary control-plane failure", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const reporter = new AttemptProgressReporter(send, () => undefined);
    reporter.update({ phase: "separating", phasePercent: 35 });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenLastCalledWith({
      sequence: 2,
      phase: "separating",
      phasePercent: 35,
    });
    reporter.close();
  });
});
