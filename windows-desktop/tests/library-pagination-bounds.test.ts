import { describe, expect, it, vi } from "vitest";
import { LibraryController } from "../src/main/library/controller.js";
import { LibraryStore } from "../src/main/library/store.js";
import type { RealtimeUpdate } from "../src/main/realtime/user-realtime.js";
import {
  libraryJob,
  libraryOwnerA,
  MemoryLibraryDisk,
} from "./library-fixtures.js";

function fixture() {
  const disk = new MemoryLibraryDisk(),
    store = new LibraryStore(disk, () => true),
    pages: ((update: RealtimeUpdate) => void)[] = [],
    request = vi.fn(),
    controller = new LibraryController({
      store,
      scope: () => libraryOwnerA,
      realtime: {
        watch: (_resource, _params, listener) => {
          pages.push(listener);
          return () => {};
        },
      },
      cache: {
        lookup: async () => null,
        download: vi.fn(),
        adopt: vi.fn(),
        local: vi.fn(),
      },
      request,
      removeCache: vi.fn(),
      deleteLocal: vi.fn(),
    });
  async function snapshot(page: number, count: number, next: string | null) {
    pages[page]!({
      live: true,
      errorCode: null,
      data: {
        items: Array.from({ length: count }, (_, index) =>
          libraryJob((page * 50 + index + 1).toString(16).padStart(24, "0")),
        ),
        next_cursor: next,
      },
    });
    await controller.flush();
  }
  return { controller, store, pages, request, snapshot };
}
describe("W16 bounded loaded-page live Library", () => {
  it("refuses an eighty-third live page without HTTP reads or unbounded subscription growth", async () => {
    const f = fixture();
    try {
      await f.controller.setScope(libraryOwnerA);
      for (let page = 0; page < 82; page++) {
        await f.snapshot(page, 0, `page-${page + 1}`);
        if (page < 81) await f.controller.nextPage();
      }
      expect(f.pages).toHaveLength(82);
      await expect(f.controller.nextPage()).rejects.toThrow(
        "LIBRARY_CAPACITY_REACHED",
      );
      expect(f.pages).toHaveLength(82);
      expect(f.controller.view().tracks).toEqual([]);
      expect(f.request).not.toHaveBeenCalled();
    } finally {
      f.controller.dispose();
    }
  });
  it("retains exactly 4096 loaded rows when a new snapshot would exceed the bounded deduplicated catalog", async () => {
    const f = fixture();
    try {
      await f.controller.setScope(libraryOwnerA);
      for (let page = 0; page < 82; page++) {
        await f.snapshot(
          page,
          page === 81 ? 46 : 50,
          page === 81 ? null : `page-${page + 1}`,
        );
        if (page < 81) await f.controller.nextPage();
      }
      expect(f.controller.view().tracks).toHaveLength(4096);
      expect((await f.store.snapshot(libraryOwnerA)).account.jobs).toHaveLength(
        4096,
      );
      await f.snapshot(81, 47, null);
      expect(f.controller.view()).toMatchObject({
        state: "error",
        errorCode: "LIBRARY_CAPACITY_REACHED",
      });
      expect(f.controller.view().tracks).toHaveLength(4096);
      expect((await f.store.snapshot(libraryOwnerA)).account.jobs).toHaveLength(
        4096,
      );
      expect(f.request).not.toHaveBeenCalled();
    } finally {
      f.controller.dispose();
    }
  }, 15000);
});
