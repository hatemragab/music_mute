import { describe, expect, it, vi } from "vitest";
import {
  BrowserToolkit,
  parseBrowserToolkitEvent,
  projectBrowserEvent,
} from "../src/main/browser/toolkit.js";
import {
  isInstallationCheck,
  type InstallationCheck,
} from "../../chrome-extension/src/shared/installation-check.js";
function fixture() {
  const inspect = {
      runtime: vi.fn(async (_signal: AbortSignal) => {}),
      model: vi.fn(async (_signal: AbortSignal) => {}),
      youtube_tools: vi.fn(async (_signal: AbortSignal) => {}),
    },
    clearCache = vi.fn(async (_signal: AbortSignal) => {}),
    recordEvent = vi.fn(async () => {});
  return {
    toolkit: new BrowserToolkit({
      packageIdentity: "a".repeat(64),
      inspect,
      clearCache,
      recordEvent,
    }),
    inspect,
    clearCache,
    recordEvent,
  };
}
describe("explicit Windows browser toolkit", () => {
  it("reserves CHECK before awaiting, publishes valid full snapshots, and clears the reservation before ACK", async () => {
    const f = fixture(),
      snapshots: InstallationCheck[] = [];
    let complete!: () => void;
    f.inspect.runtime.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          complete = r;
        }),
    );
    const check = f.toolkit.startCheck(new AbortController().signal, (s) =>
      snapshots.push(s),
    );
    expect(() =>
      f.toolkit.startCheck(new AbortController().signal, () => {}),
    ).toThrow("INSTALLATION_CHECK_BUSY");
    expect(f.inspect.model).not.toHaveBeenCalled();
    complete();
    expect((await check.done).state).toBe("passed");
    expect(f.toolkit.checking()).toBe(false);
    expect(snapshots.every(isInstallationCheck)).toBe(true);
    expect(snapshots[0]?.checks.map((s) => s.state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(snapshots.at(-1)?.checks.map((s) => s.state)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(
      (await f.toolkit.startCheck(new AbortController().signal, () => {}).done)
        .state,
    ).toBe("passed");
    expect(f.inspect.runtime).toHaveBeenCalledTimes(2);
  });
  it("missing runtime does not probe a model or tools and raw failures never reach Chrome", async () => {
    const f = fixture();
    f.inspect.runtime.mockRejectedValue(new Error("C:\\private\\token-secret"));
    const status = await f.toolkit.startCheck(
      new AbortController().signal,
      () => {
        throw new Error("observer disconnected");
      },
    ).done;
    expect(status.checks[0]?.error_code).toBe("INSTALLATION_CHECK_FAILED");
    expect(status.state).toBe("failed");
    expect(f.inspect.model).not.toHaveBeenCalled();
    expect(f.inspect.youtube_tools).not.toHaveBeenCalled();
    f.inspect.runtime.mockRejectedValueOnce(
      new Error("UPPERCASE_PRIVATE_SECRET"),
    );
    expect(
      (await f.toolkit.startCheck(new AbortController().signal, () => {}).done)
        .checks[0]?.error_code,
    ).toBe("INSTALLATION_CHECK_FAILED");
    expect(JSON.stringify(status)).not.toMatch(
      /private|token-secret|observer/u,
    );
  });
  it("dispose waits for actual probe cleanup after cancellation", async () => {
    const f = fixture();
    let release!: () => void;
    f.inspect.runtime.mockImplementationOnce(
      (signal) =>
        new Promise<void>((r) => {
          signal.addEventListener("abort", () => {
            release = r;
          });
        }),
    );
    const check = f.toolkit.startCheck(new AbortController().signal, () => {});
    let disposed = false;
    const closing = f.toolkit.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(f.toolkit.checking()).toBe(true);
    release();
    await closing;
    expect((await check.done).checks[0]?.error_code).toBe("CANCELLED");
    expect(f.toolkit.checking()).toBe(false);
    expect(() =>
      f.toolkit.startCheck(new AbortController().signal, () => {}),
    ).toThrow("LOCAL_HOST_UNAVAILABLE");
  });
  it("cache cleanup invokes only its supplied eligible-cache port, retains signal and exposes failures", async () => {
    const f = fixture(),
      signal = new AbortController().signal;
    await f.toolkit.clearCache(signal);
    expect(f.clearCache).toHaveBeenCalledExactlyOnceWith(signal);
    expect(f.inspect.runtime).not.toHaveBeenCalled();
    f.clearCache.mockRejectedValueOnce(new Error("STORAGE_RECOVERY_PENDING"));
    await expect(f.toolkit.clearCache(signal)).rejects.toThrow(
      "STORAGE_RECOVERY_PENDING",
    );
  });
  it("projects only fixed local diagnostics and rejects private wire fields without JSON-key-order dependence", async () => {
    const safe = projectBrowserEvent({
      severity: "warning",
      code: "OK",
      url: "https://private.invalid",
      token: "secret",
      metrics: { playing: true, active_tabs: 2, url: "private" },
    });
    expect(safe).toEqual({
      subsystem: "chrome",
      event: "resource_sample",
      severity: "warning",
      code: "OK",
      phase: null,
      metrics: { playing: true, active_tabs: 2 },
      job: null,
    });
    const reordered = {
      job: null,
      metrics: { active_tabs: 2, playing: true },
      phase: null,
      code: "OK",
      severity: "warning",
      event: "resource_sample",
      subsystem: "chrome",
    };
    expect(parseBrowserToolkitEvent(reordered)).toEqual(safe);
    expect(() =>
      parseBrowserToolkitEvent({ ...safe, token: "secret" }),
    ).toThrow("INVALID_COMMAND");
    expect(() =>
      parseBrowserToolkitEvent({ ...safe, metrics: { token: "secret" } }),
    ).toThrow("INVALID_COMMAND");
    const f = fixture();
    await f.toolkit.recordEvent(safe);
    expect(f.recordEvent).toHaveBeenCalledExactlyOnceWith(safe);
    expect(JSON.stringify(safe)).not.toMatch(/private|secret|https/u);
  });
});
