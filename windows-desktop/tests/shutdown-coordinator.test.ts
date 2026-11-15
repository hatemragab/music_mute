import { describe, expect, it, vi } from "vitest";
import { DesktopShutdownCoordinator } from "../src/main/shutdown/coordinator.js";
import { PendingOperations } from "../src/main/pending-operations.js";
describe("production staged shutdown ownership", () => {
  it("cancels before settling live commands, then reads and cleans late-created services before releasing exact gates", async () => {
    const pending = new PendingOperations(),
      abort = new AbortController(),
      events: string[] = [],
      owners: { close: () => Promise<void> }[] = [];
    let started!: () => void;
    const begun = new Promise<void>((r) => {
      started = r;
    });
    const work = pending.run(async () => {
      events.push("command");
      started();
      await new Promise<void>((r) =>
        abort.signal.addEventListener("abort", () => r(), { once: true }),
      );
      owners.push({
        close: async () => {
          events.push("late-owner-clean");
        },
      });
    });
    await begun;
    const coordinator = new DesktopShutdownCoordinator({
      fence: () => {
        events.push("fence");
      },
      cancel: () => [
        () => {
          events.push("cancel");
          abort.abort();
        },
      ],
      settle: () => pending.close(),
      cleanup: () => owners.map((owner) => owner.close),
      assertIdle: () => {
        if (pending.activity().pending) throw new Error("not idle");
      },
      release: () => [
        () => {
          events.push("account-gate");
        },
        () => {
          events.push("host");
        },
      ],
    });
    const result = coordinator.begin();
    expect(events).toEqual(["command", "fence", "cancel"]);
    await expect(pending.run(async () => {})).rejects.toThrow(
      "DESKTOP_SHUTTING_DOWN",
    );
    expect(await result).toMatchObject({
      phase: "complete",
      attempt: 1,
      errorCode: null,
    });
    await work;
    expect(events).toEqual([
      "command",
      "fence",
      "cancel",
      "late-owner-clean",
      "account-gate",
      "host",
    ]);
    expect(coordinator.activity()).toEqual({
      pending: 0,
      retained: 0,
      idle: true,
    });
  });
  it("retains gates on uncertain whole-tree cleanup and retries the same owner after the intake signal already aborted", async () => {
    const abort = new AbortController(),
      release = vi.fn(),
      fence = vi.fn(() => abort.abort()),
      owner = { idle: false },
      cleanup = vi.fn(async () => {
        if (!owner.idle) throw new Error("PRIVATE_PATH_TOKEN_SECRET");
      }),
      coordinator = new DesktopShutdownCoordinator({
        fence,
        cancel: () => [],
        settle: async () => {},
        cleanup: () => [cleanup],
        assertIdle: () => {
          if (!owner.idle) throw new Error("PRIVATE_ACTIVITY");
        },
        release: () => [release],
      });
    const views: unknown[] = [];
    coordinator.subscribe((view) => views.push(view));
    expect(await coordinator.begin()).toEqual({
      phase: "pending",
      attempt: 1,
      errorCode: "SHUTDOWN_PENDING",
    });
    expect(release).not.toHaveBeenCalled();
    expect(coordinator.activity()).toMatchObject({ retained: 1, idle: false });
    owner.idle = true;
    expect(await coordinator.retry()).toMatchObject({
      phase: "complete",
      attempt: 2,
    });
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(fence).toHaveBeenCalledOnce();
    expect(abort.signal.aborted).toBe(true);
    expect(JSON.stringify(views)).not.toMatch(/PRIVATE|SECRET|TOKEN/u);
  });
  it("a positive final same-owner cleanup supersedes a lost cancellation ACK; non-idle activity still fences gates", async () => {
    const release = vi.fn(),
      idle = vi.fn<() => void>(() => {
        throw new Error("retained");
      }),
      cleanup = vi.fn(async () => {}),
      coordinator = new DesktopShutdownCoordinator({
        fence: () => {},
        cancel: () => [
          () => {
            throw new Error("ACK_LOST");
          },
        ],
        settle: async () => {},
        cleanup: () => [cleanup],
        assertIdle: idle,
        release: () => [release],
      });
    expect((await coordinator.begin()).phase).toBe("pending");
    expect(release).not.toHaveBeenCalled();
    idle.mockImplementation(() => {});
    expect((await coordinator.retry()).phase).toBe("complete");
    expect(release).toHaveBeenCalledOnce();
  });
  it("release failure retries only captured unfinished gates and never a replacement owner", async () => {
    const first = vi.fn(),
      last = vi
        .fn()
        .mockRejectedValueOnce(new Error("HOST_CLOSE_UNKNOWN"))
        .mockResolvedValue(undefined),
      replacement = vi.fn(),
      releases = vi.fn(() => [first, last]),
      cleanup = vi.fn(async () => {}),
      coordinator = new DesktopShutdownCoordinator({
        fence: () => {},
        cancel: () => [],
        settle: async () => {},
        cleanup: () => [cleanup],
        assertIdle: () => {},
        release: releases,
      });
    expect((await coordinator.begin()).phase).toBe("pending");
    releases.mockReturnValue([replacement]);
    expect((await coordinator.retry()).phase).toBe("complete");
    expect(first).toHaveBeenCalledOnce();
    expect(last).toHaveBeenCalledTimes(2);
    expect(replacement).not.toHaveBeenCalled();
    expect(releases).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect((await coordinator.retry()).attempt).toBe(2);
  });
  it("concurrent begin/retry coalesces only the live attempt, with no permanently cached failed promise", async () => {
    let settle!: () => void;
    const release = vi.fn(),
      cleanup = vi
        .fn()
        .mockRejectedValueOnce(new Error("uncertain"))
        .mockResolvedValue(undefined),
      coordinator = new DesktopShutdownCoordinator({
        fence: () => {},
        cancel: () => [],
        settle: () =>
          new Promise<void>((r) => {
            settle = r;
          }),
        cleanup: () => [cleanup],
        assertIdle: () => {},
        release: () => [release],
      });
    const first = coordinator.begin();
    expect(coordinator.retry()).toBe(first);
    settle();
    expect((await first).phase).toBe("pending");
    const second = coordinator.retry();
    expect(second).not.toBe(first);
    settle();
    expect((await second).phase).toBe("complete");
    expect(release).toHaveBeenCalledOnce();
  });
  it("failed synchronous fence or unconfirmed barrier never releases despite successful individual cleanup", async () => {
    const fence = vi.fn().mockImplementationOnce(() => {
        throw new Error("FENCE_UNKNOWN");
      }),
      settle = vi
        .fn()
        .mockRejectedValueOnce(new Error("BARRIER_UNKNOWN"))
        .mockResolvedValue(undefined),
      release = vi.fn(),
      coordinator = new DesktopShutdownCoordinator({
        fence,
        cancel: () => [],
        settle,
        cleanup: () => [async () => {}],
        assertIdle: () => {},
        release: () => [release],
      });
    expect((await coordinator.begin()).phase).toBe("pending");
    expect(release).not.toHaveBeenCalled();
    expect((await coordinator.retry()).phase).toBe("complete");
    expect(fence).toHaveBeenCalledTimes(2);
  });
});
