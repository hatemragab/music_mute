import { rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
vi.mock("node:path", async (original) => {
  const actual = await original<typeof import("node:path")>();
  return {
    ...actual,
    win32: {
      ...actual.win32,
      join: (...parts: string[]) =>
        actual.join(...parts.map((part) => part.replaceAll("\\", "/"))),
    },
  };
});
import { LibraryThumbnailCache } from "../src/main/library/thumbnails.js";
import { storageFixture } from "./storage-fixtures.js";

it.each(["deadline", "owner-abort"] as const)(
  "uses the fixed thumbnail deadline and returns safe fallback on %s before any private publication",
  async (fault) => {
    const f = await storageFixture(),
      deadline = new AbortController(),
      owner = new AbortController(),
      timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        expect(ms).toBe(10000);
        return deadline.signal;
      });
    let entered!: () => void;
    const headersPending = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        entered();
        return new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted fixture", "AbortError")),
            { once: true },
          );
        });
      }),
      cache = new LibraryThumbnailCache(f.host, fetcher),
      begin = vi.fn((relative: string, bytes: number) =>
        f.controller.beginPartialWrite(relative, bytes),
      );
    cache.setWriteAdmission({
      beginPartialWrite: begin,
      recoverPartialWrites: (relative, signal) =>
        f.controller.recoverPartialWrites(relative, signal),
    });
    try {
      const resolving = cache.resolve(
        "https://i.ytimg.com/vi/12345678901/hqdefault.jpg",
        owner.signal,
      );
      await headersPending;
      (fault === "deadline" ? deadline : owner).abort();
      expect(await resolving).toBeNull();
      expect(timeout).toHaveBeenCalledWith(10000);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]![1]).toMatchObject({
        credentials: "omit",
        redirect: "error",
      });
      expect(begin).not.toHaveBeenCalled();
      expect(await f.controller.writes.readOwned()).toEqual([]);
    } finally {
      timeout.mockRestore();
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
