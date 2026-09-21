import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useVisibleInterval } from "./use-visible-interval";

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
};

describe("useVisibleInterval", () => {
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("runs only while the dashboard is visible and cleans up its timer", () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const callback = vi.fn();
    const { unmount } = renderHook(() => useVisibleInterval(callback, 1_000));

    act(() => vi.advanceTimersByTime(2_000));
    expect(callback).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(2_000);
    });
    expect(callback).toHaveBeenCalledTimes(2);

    setVisibility("visible");
    act(() => vi.advanceTimersByTime(1_000));
    expect(callback).toHaveBeenCalledTimes(3);

    unmount();
    act(() => vi.advanceTimersByTime(2_000));
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("does not allocate polling work until enabled", () => {
    vi.useFakeTimers();
    setVisibility("visible");
    const callback = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useVisibleInterval(callback, 1_000, enabled),
      { initialProps: { enabled: false } },
    );

    act(() => vi.advanceTimersByTime(2_000));
    expect(callback).not.toHaveBeenCalled();

    rerender({ enabled: true });
    act(() => vi.advanceTimersByTime(1_000));
    expect(callback).toHaveBeenCalledOnce();
  });
});
