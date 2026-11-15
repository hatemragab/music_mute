import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
const harness = vi.hoisted(() => ({
  watch: vi.fn(),
  event: undefined as
    undefined | ((event: string, file: string | null) => void),
  error: undefined as undefined | (() => void),
  close: vi.fn(),
}));
vi.mock("node:fs", async () => ({
  ...(await vi.importActual<typeof import("node:fs")>("node:fs")),
  watch: harness.watch,
}));
import { WindowsOutboxWatcher } from "../src/main/outbox/watcher.js";
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("private outbox receipt notifications", () => {
  it("wakes initial recovery and debounces only record changes without HTTP/timer reads", async () => {
    vi.useFakeTimers();
    harness.watch.mockImplementation((_root, _options, event) => {
      harness.event = event;
      return {
        on: (_name: string, error: () => void) => {
          harness.error = error;
        },
        close: harness.close,
      };
    });
    const host = {
        personalRoot: "C:\\fixture",
        directory: async () => "C:\\fixture\\outbox",
        native: { validatePath: vi.fn(async () => {}) },
      } as unknown as HostContext,
      pending = vi.fn(),
      watcher = new WindowsOutboxWatcher(host, pending);
    await watcher.start();
    expect(pending).toHaveBeenCalledOnce();
    harness.event?.("change", "owner/operation/vocals.mp3");
    await vi.advanceTimersByTimeAsync(200);
    expect(pending).toHaveBeenCalledOnce();
    harness.event?.("rename", "owner/operation/record.json");
    harness.event?.("change", "owner/operation/record.json");
    await vi.advanceTimersByTimeAsync(100);
    expect(pending).toHaveBeenCalledTimes(2);
    watcher.close();
    harness.event?.("change", "owner/operation/record.json");
    await vi.advanceTimersByTimeAsync(100);
    expect(pending).toHaveBeenCalledTimes(2);
    expect(harness.close).toHaveBeenCalledOnce();
  });
});
