import { describe, expect, it, vi } from "vitest";
import {
  PendingOperations,
  waitForDialog,
} from "../src/main/pending-operations.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("desktop native resource shutdown", () => {
  it("waits for all admitted commands, including asynchronous pin teardown", async () => {
    const scope = new PendingOperations(),
      work = deferred<void>(),
      release = deferred<void>();
    const events: string[] = [];
    const operation = scope.run(async () => {
      try {
        await work.promise;
      } finally {
        events.push("releasing");
        await release.promise;
        events.push("released");
      }
    });
    const closing = scope.close().then(() => {
      events.push("native-close");
    });
    work.resolve();
    await vi.waitFor(() => expect(events).toEqual(["releasing"]));
    release.resolve();
    await operation;
    await closing;
    expect(events).toEqual(["releasing", "released", "native-close"]);
  });
  it("refuses new commands and nested admissions once closure begins", async () => {
    const scope = new PendingOperations(),
      callback = vi.fn(async () => {});
    const first = scope.run(async () => {
      await expect(scope.run(callback)).rejects.toThrow(
        "DESKTOP_SHUTTING_DOWN",
      );
    });
    const closing = scope.close();
    expect(scope.close()).toBe(closing);
    await expect(scope.run(callback)).rejects.toThrow("DESKTOP_SHUTTING_DOWN");
    await first;
    await closing;
    expect(callback).not.toHaveBeenCalled();
  });
  it("retains failed-command cleanup and does not reject shutdown", async () => {
    const scope = new PendingOperations(),
      cleanup = deferred<void>();
    const operation = scope.run(async () => {
      try {
        throw new Error("fixture-failure");
      } finally {
        await cleanup.promise;
      }
    });
    const failure = expect(operation).rejects.toThrow("fixture-failure");
    let closed = false;
    const closing = scope.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    cleanup.resolve();
    await failure;
    await closing;
    expect(closed).toBe(true);
  });
  it("keeps closure pending through the other cleanup after one owner rejects", async () => {
    const scope = new PendingOperations(),
      writer = deferred<void>(),
      events: string[] = [];
    const cleanup = scope.runCleanup([
      async () => {
        events.push("failed-owner");
        throw new Error("private fixture error");
      },
      async () => {
        events.push("writer-retiring");
        await writer.promise;
        events.push("writer-retired");
      },
    ]);
    const rejected = expect(cleanup).rejects.toThrow("DESKTOP_CLEANUP_PENDING");
    const closing = scope.close().then(() => events.push("native-close"));
    await vi.waitFor(() =>
      expect(events).toEqual(["failed-owner", "writer-retiring"]),
    );
    expect(scope.activity().pending).toBe(1);
    writer.resolve();
    await rejected;
    await closing;
    expect(events).toEqual([
      "failed-owner",
      "writer-retiring",
      "writer-retired",
      "native-close",
    ]);
    expect(scope.activity().pending).toBe(0);
  });
  it("still invokes every cleanup when an earlier closure throws synchronously", async () => {
    const scope = new PendingOperations(),
      released = vi.fn(async () => {});
    await expect(
      scope.runCleanup([
        () => {
          throw new Error("private synchronous error");
        },
        released,
      ]),
    ).rejects.toThrow("DESKTOP_CLEANUP_PENDING");
    expect(released).toHaveBeenCalledOnce();
    await expect(
      scope.runCleanup([released, () => {}]),
    ).resolves.toBeUndefined();
    expect(released).toHaveBeenCalledTimes(2);
  });
});

describe("native dialog shutdown", () => {
  it("abandons a still-open dialog and ignores its later result", async () => {
    const dialog = deferred<string>(),
      abort = new AbortController(),
      createFile = vi.fn();
    const operation = waitForDialog(dialog.promise, abort.signal).then(
      createFile,
    );
    const failed = expect(operation).rejects.toThrow("fixture-shutdown");
    abort.abort(new Error("fixture-shutdown"));
    await failed;
    dialog.resolve("C:\\Users\\fixture\\export.mp3");
    await Promise.resolve();
    expect(createFile).not.toHaveBeenCalled();
  });
  it("returns ordinary dialog results and removes the abort listener", async () => {
    const abort = new AbortController(),
      removed = vi.spyOn(abort.signal, "removeEventListener");
    expect(await waitForDialog(Promise.resolve("selected"), abort.signal)).toBe(
      "selected",
    );
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
  });
  it("refuses a result when already aborted", async () => {
    const abort = new AbortController();
    abort.abort(new Error("fixture-shutdown"));
    await expect(
      waitForDialog(Promise.resolve("selected"), abort.signal),
    ).rejects.toThrow("fixture-shutdown");
  });
});
