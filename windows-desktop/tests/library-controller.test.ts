import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { historyFixture } from "./history-fixtures.js";
import {
  LibraryController,
  type LibraryControllerOptions,
} from "../src/main/library/controller.js";
import { LibraryStore } from "../src/main/library/store.js";
import { accountLibraryJob, localTrackId } from "../src/main/library/model.js";
import type { RealtimeUpdate } from "../src/main/realtime/user-realtime.js";
import type { SessionAccountScope } from "../src/shared/session-contracts.js";
import {
  libraryOwnerA,
  libraryOwnerB,
  libraryPersonal,
  libraryJob,
  MemoryLibraryDisk,
} from "./library-fixtures.js";
function fixture(
  history?: LibraryControllerOptions["history"],
  thumbnail?: LibraryControllerOptions["thumbnail"],
  accountDeleted?: LibraryControllerOptions["accountDeleted"],
) {
  let scope: SessionAccountScope | null = null;
  const disk = new MemoryLibraryDisk(),
    current = (candidate: SessionAccountScope | null) =>
      candidate?.firebaseUid === scope?.firebaseUid &&
      candidate?.generation === scope?.generation,
    store = new LibraryStore(disk, current, () => 10),
    listeners: ((update: RealtimeUpdate) => void)[] = [];
  const request = vi.fn(async () => ({
      url: "https://fixture.r2.cloudflarestorage.com/output?signature=test",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    })),
    cache = {
      local: vi.fn(async () => ({})),
      lookup: vi.fn(async () => null),
      download: vi.fn(async () => ({})),
      adopt: vi.fn(async () => ({})),
    },
    removeCache = vi.fn(async () => {}),
    deleteLocal = vi.fn(async () => {});
  const controller = new LibraryController({
    store,
    cache: cache as never,
    scope: () => scope,
    realtime: {
      watch: vi.fn((_resource, _params, listener) => {
        listeners.push(listener);
        return () => {};
      }),
    },
    request,
    removeCache,
    deleteLocal,
    ...(history ? { history } : {}),
    ...(thumbnail ? { thumbnail } : {}),
    ...(accountDeleted ? { accountDeleted } : {}),
  });
  return {
    disk,
    store,
    controller,
    request,
    cache,
    removeCache,
    deleteLocal,
    listeners,
    setScope: async (next: SessionAccountScope | null) => {
      scope = next;
      await controller.setScope(next);
    },
    changeScope: (next: SessionAccountScope | null) => {
      scope = next;
    },
  };
}
describe("Library event-driven controller code fixtures", () => {
  async function linkedDownloadFixture(raw = libraryJob()) {
    const h = fixture(),
      personal = libraryPersonal();
    await h.store.rememberPersonal(personal, null);
    const entry = (await h.store.snapshot(null)).guest.entries[0]!,
      id = localTrackId(entry);
    await h.setScope(libraryOwnerA);
    await h.store.saveAccountJobs(libraryOwnerA, [accountLibraryJob(raw)]);
    await h.store.linkPersonal(id, libraryOwnerA, raw.id, entry.vocals.sha256);
    await h.controller.refreshLocal();
    h.request.mockClear();
    return { ...h, id, entry };
  }
  it.each(["voice", "original"] as const)(
    "restores only a genuinely absent linked %s copy through the exact variant grant",
    async (variant) => {
      const h = await linkedDownloadFixture();
      h.cache.local.mockRejectedValueOnce(
        Object.assign(new Error("missing"), { code: "ENOENT" }),
      );
      await h.controller.download(h.id, variant);
      expect(h.request).toHaveBeenCalledOnce();
      expect(h.request).toHaveBeenCalledWith(
        libraryOwnerA,
        `/jobs/${libraryJob().id}/download-grants`,
        "POST",
        { variant: variant === "voice" ? "output" : "input" },
        expect.any(AbortSignal),
      );
      expect(h.cache.download).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        libraryOwnerA,
        expect.any(AbortSignal),
        variant,
      );
      h.controller.dispose();
    },
  );
  it.each([
    "EACCES",
    "EPERM",
    "EIO",
    "LIBRARY_RESULT_INVALID",
    "LIBRARY_RESULT_UNAVAILABLE",
  ])(
    "refuses linked network restoration after %s instead of hiding a local integrity/permission fault",
    async (code) => {
      const h = await linkedDownloadFixture(),
        failure = Object.assign(new Error(code), { code });
      h.cache.local.mockRejectedValueOnce(failure);
      await expect(h.controller.download(h.id)).rejects.toBe(failure);
      expect(h.request).not.toHaveBeenCalled();
      expect(h.cache.download).not.toHaveBeenCalled();
      h.controller.dispose();
    },
  );
  it.each(["voice", "original"] as const)(
    "rejects different linked %s size before requesting a grant even when its hash matches",
    async (variant) => {
      const raw = libraryJob();
      (variant === "voice" ? raw.output : raw.input).bytes = 4;
      const h = await linkedDownloadFixture(raw);
      h.cache.local.mockRejectedValueOnce(
        Object.assign(new Error("missing"), { code: "ENOENT" }),
      );
      await expect(h.controller.download(h.id, variant)).rejects.toThrow(
        "LIBRARY_RESULT_INVALID",
      );
      expect(h.request).not.toHaveBeenCalled();
      expect(h.cache.download).not.toHaveBeenCalled();
      h.controller.dispose();
    },
  );
  it("refuses the missing-copy fallback when its captured account changes during the local lookup", async () => {
    const h = await linkedDownloadFixture();
    h.cache.local.mockImplementationOnce(async () => {
      h.changeScope(libraryOwnerB);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    await expect(h.controller.download(h.id)).rejects.toThrow(
      "ACCOUNT_CHANGED",
    );
    expect(h.request).not.toHaveBeenCalled();
    expect(h.cache.download).not.toHaveBeenCalled();
    h.controller.dispose();
  });
  it("reports a failed current catalog load after clearing old-owner rows and can recover on a later scope event", async () => {
    const h = fixture();
    await h.setScope(libraryOwnerA);
    vi.spyOn(h.store, "snapshot").mockRejectedValueOnce(
      new Error("private corrupt catalog path"),
    );
    await expect(h.setScope(null)).rejects.toThrow();
    expect(h.controller.view()).toMatchObject({
      state: "error",
      accountState: "signed-out",
      errorCode: "LIBRARY_UNAVAILABLE",
      tracks: [],
      visibleIds: [],
    });
    expect(JSON.stringify(h.controller.view())).not.toContain(
      "private corrupt",
    );
    await h.controller.act({
      type: "QUERY",
      query: { ...h.controller.view().query, search: "another title" },
    });
    expect(h.controller.view()).toMatchObject({
      state: "error",
      errorCode: "LIBRARY_UNAVAILABLE",
      query: { search: "another title" },
    });
    await h.setScope(null);
    expect(h.controller.view().state).toBe("ready");
    h.controller.dispose();
  });
  it("does not let a delayed failed A catalog load overwrite the ready B scope", async () => {
    const h = fixture();
    let fail!: (error: Error) => void;
    vi.spyOn(h.store, "snapshot").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const old = h.setScope(libraryOwnerA);
    const rejected = expect(old).rejects.toThrow();
    await h.setScope(libraryOwnerB);
    fail(new Error("old catalog failure"));
    await rejected;
    expect(h.controller.view()).toMatchObject({
      state: "ready",
      errorCode: null,
      accountState: "connecting",
    });
    h.controller.dispose();
  });
  it("updates Most Played immediately on actual local play across accounts without catalog reads or thumbnail requests", async () => {
    const history = historyFixture(),
      thumbnail = vi.fn(async () => null),
      h = fixture(history.controller, thumbnail);
    await history.controller.restore();
    await h.store.rememberPersonal(libraryPersonal("Alpha"), null);
    await h.store.rememberPersonal(libraryPersonal("Zulu"), null);
    await history.controller.setScope(libraryOwnerA);
    await h.setScope(libraryOwnerA);
    await h.controller.act({
      type: "QUERY",
      query: {
        search: "",
        filter: "all",
        sort: "most-played",
        mostPlayedOnly: false,
        starredOnly: false,
      },
    });
    const tracks = h.controller.view().tracks,
      zulu = tracks.find((track) => track.title === "Zulu")!,
      alpha = tracks.find((track) => track.title === "Alpha")!;
    const source = history.controller.accountingFor(zulu),
      id = randomUUID(),
      reads = h.cache.local.mock.calls.length,
      thumbnails = thumbnail.mock.calls.length;
    expect(h.controller.view().visibleIds).toEqual([alpha.id, zulu.id]);
    await source.begin(zulu.id, id);
    expect(h.controller.view().visibleIds).toEqual([zulu.id, alpha.id]);
    expect(
      h.controller.view().tracks.find((track) => track.id === zulu.id)
        ?.playCount,
    ).toBe(1);
    expect(h.cache.local.mock.calls.length).toBe(reads);
    expect(thumbnail.mock.calls.length).toBe(thumbnails);
    await history.controller.setScope(libraryOwnerB);
    await h.setScope(libraryOwnerB);
    await source.begin(zulu.id, randomUUID());
    expect(
      h.controller.view().tracks.find((track) => track.id === zulu.id)
        ?.playCount,
    ).toBe(2);
    const revision = h.controller.view().revision;
    h.controller.dispose();
    await source.begin(zulu.id, randomUUID());
    expect(h.controller.view().revision).toBe(revision);
    await history.controller.dispose();
  });
  it("reports evicted local copies as unavailable without deleting the catalog or user source", async () => {
    const h = fixture();
    await h.store.rememberPersonal(libraryPersonal(), null);
    await h.setScope(null);
    expect(h.controller.view().tracks[0]).toMatchObject({
      offline: true,
      originalAvailable: true,
    });
    h.cache.local.mockRejectedValue(new Error("LIBRARY_RESULT_UNAVAILABLE"));
    await h.controller.refreshLocal();
    expect(h.controller.view().tracks[0]).toMatchObject({
      offline: false,
      originalAvailable: false,
      canExport: false,
    });
    expect(h.controller.view().tracks).toHaveLength(1);
    h.controller.dispose();
  });
  it("keeps loaded pages live, merges by trusted ID, and replaces only a changed page", async () => {
    const h = fixture();
    await h.setScope(libraryOwnerA);
    const first = libraryJob(),
      second = libraryJob("0123456789abcdef01234568", "Second");
    h.listeners[0]!({
      live: true,
      errorCode: null,
      data: { items: [first], next_cursor: "page-2" },
    });
    await h.controller.flush();
    await h.controller.nextPage();
    h.listeners[1]!({
      live: true,
      errorCode: null,
      data: { items: [second], next_cursor: null },
    });
    await h.controller.flush();
    expect(
      h.controller
        .view()
        .tracks.map((track) => track.title)
        .sort(),
    ).toEqual(["Cloud voice", "Second"]);
    h.listeners[0]!({
      live: true,
      errorCode: null,
      data: { items: [], next_cursor: "page-2" },
    });
    await h.controller.flush();
    expect(h.controller.view().tracks.map((track) => track.title)).toEqual([
      "Second",
    ]);
    expect(h.controller.view().nextCursor).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
    h.controller.dispose();
  });
  it("persists guest results across account changes and rolls back a captured account change", async () => {
    const h = fixture(),
      result = libraryPersonal();
    const id = await h.store.rememberPersonal(result, null);
    expect(await h.store.rememberPersonal(result, null)).toBe(id);
    expect((await h.disk.read(null)).entries).toHaveLength(1);
    h.disk.afterWrite = () => {
      h.disk.afterWrite = undefined;
      h.changeScope(libraryOwnerA);
    };
    await h.store.rememberPersonal(libraryPersonal(), null);
    expect((await h.disk.read(null)).entries).toHaveLength(2);
    h.disk.afterWrite = () => h.changeScope(libraryOwnerB);
    await expect(
      h.store.rememberPersonal(libraryPersonal(), libraryOwnerA),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    expect((await h.disk.read(null)).entries).toHaveLength(2);
  });
  it("applies full snapshots atomically and rejects previous-account notifications", async () => {
    const h = fixture();
    await h.store.rememberPersonal(libraryPersonal(), null);
    await h.setScope(libraryOwnerA);
    h.listeners[0]!({
      live: true,
      errorCode: null,
      data: { items: [libraryJob()], next_cursor: null },
    });
    await h.controller.flush();
    expect(h.controller.view().tracks).toHaveLength(2);
    const old = h.listeners[0]!;
    await h.setScope(libraryOwnerB);
    expect(h.controller.view().tracks).toHaveLength(1);
    old({
      live: true,
      errorCode: null,
      data: { items: [libraryJob()], next_cursor: null },
    });
    await h.controller.flush();
    expect(h.controller.view().tracks).toHaveLength(1);
    expect(h.request).not.toHaveBeenCalled();
  });
  it("keeps disconnected offline metadata and receives reconnect replacement without HTTP reads", async () => {
    const h = fixture();
    await h.setScope(libraryOwnerA);
    h.listeners[0]!({
      live: true,
      errorCode: null,
      data: { items: [libraryJob()], next_cursor: "next" },
    });
    await h.controller.flush();
    h.listeners[0]!({ live: false, errorCode: null, data: null });
    await h.controller.flush();
    expect(h.controller.view()).toMatchObject({
      accountState: "disconnected",
      tracks: [{ title: "Cloud voice" }],
      nextCursor: "next",
    });
    h.listeners[0]!({
      live: true,
      errorCode: null,
      data: { items: [libraryJob(undefined, "Changed")], next_cursor: null },
    });
    await h.controller.flush();
    expect(h.controller.view().tracks[0]?.title).toBe("Changed");
    expect(h.request).not.toHaveBeenCalled();
  });
  it("separates stars/hide/cache removal from explicit server deletion and rename", async () => {
    const h = fixture();
    await h.setScope(libraryOwnerA);
    h.listeners[0]!({
      live: true,
      errorCode: null,
      data: { items: [libraryJob()], next_cursor: null },
    });
    await h.controller.flush();
    const id = libraryJob().id;
    await h.controller.act({ type: "STAR", trackId: id });
    expect(h.controller.view().tracks[0]?.starred).toBe(true);
    await h.controller.act({ type: "HIDE", trackId: id });
    expect(h.controller.view().visibleIds).toEqual([]);
    await h.controller.act({ type: "RESTORE", trackId: id });
    await h.controller.act({ type: "REMOVE_CACHE", trackId: id });
    expect(h.removeCache).toHaveBeenCalledOnce();
    expect(h.request).not.toHaveBeenCalled();
    await h.controller.act({ type: "RENAME", trackId: id, title: " Renamed " });
    expect(h.request).toHaveBeenLastCalledWith(
      libraryOwnerA,
      `/jobs/${id}`,
      "PATCH",
      { display_name: "Renamed" },
      expect.any(AbortSignal),
    );
    await expect(
      h.controller.act({
        type: "DELETE_ACCOUNT",
        trackId: id,
        confirmation: "wrong",
      }),
    ).rejects.toThrow("INVALID_REQUEST");
    await h.controller.act({
      type: "DELETE_ACCOUNT",
      trackId: id,
      confirmation: "delete-account-item",
    });
    expect(h.request).toHaveBeenLastCalledWith(
      libraryOwnerA,
      `/jobs/${id}`,
      "DELETE",
      undefined,
      expect.any(AbortSignal),
    );
  });
  it("retires acknowledged account deletion only after its current-owner server reply", async () => {
    const accountDeleted = vi.fn(async () => {}),
      h = fixture(undefined, undefined, accountDeleted);
    await h.setScope(libraryOwnerA);
    h.listeners[0]!({
      live: true,
      errorCode: null,
      data: { items: [libraryJob()], next_cursor: null },
    });
    await h.controller.flush();
    let acknowledge!: () => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = () => resolve({ url: "", expires_at: "" });
        }),
    );
    const deleting = h.controller.act({
      type: "DELETE_ACCOUNT",
      trackId: libraryJob().id,
      confirmation: "delete-account-item",
    });
    expect(accountDeleted).not.toHaveBeenCalled();
    acknowledge();
    await deleting;
    expect(accountDeleted).toHaveBeenCalledExactlyOnceWith(
      libraryJob().id,
      libraryOwnerA,
    );
    h.controller.dispose();
  });
  it("does not retire playback on rejected deletion or an old account's late acknowledgement", async () => {
    const accountDeleted = vi.fn(async () => {}),
      h = fixture(undefined, undefined, accountDeleted);
    await h.setScope(libraryOwnerA);
    h.listeners[0]!({
      live: true,
      errorCode: null,
      data: { items: [libraryJob()], next_cursor: null },
    });
    await h.controller.flush();
    const command = {
      type: "DELETE_ACCOUNT",
      trackId: libraryJob().id,
      confirmation: "delete-account-item",
    };
    h.request.mockRejectedValueOnce(new Error("DELETION_REJECTED"));
    await expect(h.controller.act(command)).rejects.toThrow(
      "DELETION_REJECTED",
    );
    expect(accountDeleted).not.toHaveBeenCalled();
    let acknowledge!: () => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = () => resolve({ url: "", expires_at: "" });
        }),
    );
    const deleting = h.controller.act(command);
    const rejected = expect(deleting).rejects.toThrow("ACCOUNT_CHANGED");
    await h.setScope(libraryOwnerB);
    acknowledge();
    await rejected;
    expect(accountDeleted).not.toHaveBeenCalled();
    h.controller.dispose();
  });
  it("derives visible queue order and obtains separate output/input grants", async () => {
    const h = fixture();
    await h.setScope(libraryOwnerA);
    h.listeners[0]!({
      live: true,
      errorCode: null,
      data: {
        items: [
          libraryJob("0123456789abcdef01234567", "Z"),
          libraryJob("1123456789abcdef01234567", "A"),
        ],
        next_cursor: null,
      },
    });
    await h.controller.flush();
    await h.controller.act({
      type: "QUERY",
      query: {
        search: "",
        filter: "all",
        sort: "title",
        mostPlayedOnly: false,
        starredOnly: false,
      },
    });
    expect(h.controller.view().visibleIds).toEqual([
      "1123456789abcdef01234567",
      "0123456789abcdef01234567",
    ]);
    await h.controller.download(libraryJob().id, "original");
    expect(h.request).toHaveBeenLastCalledWith(
      libraryOwnerA,
      `/jobs/${libraryJob().id}/download-grants`,
      "POST",
      { variant: "input" },
      expect.any(AbortSignal),
    );
    expect(h.cache.download).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.any(Object),
      libraryOwnerA,
      expect.any(AbortSignal),
      "original",
    );
  });
  it("adopts only current-owner trusted metadata when a ready socket row has not arrived", async () => {
    const h = fixture();
    await h.setScope(libraryOwnerA);
    await h.controller.adoptCloudResult(
      "capability",
      libraryJob().id,
      libraryOwnerA,
      libraryJob(),
    );
    expect(h.cache.adopt).toHaveBeenCalledOnce();
    expect((await h.disk.read(libraryOwnerA.firebaseUid)).jobs).toHaveLength(1);
    await h.setScope(libraryOwnerB);
    await expect(
      h.controller.adoptCloudResult(
        "capability",
        libraryJob().id,
        libraryOwnerA,
        libraryJob(),
      ),
    ).rejects.toThrow("ACCOUNT_CHANGED");
    expect(h.cache.adopt).toHaveBeenCalledOnce();
  });
  it("rejects malformed snapshots without half-replacing the previous page", async () => {
    const h = fixture();
    await h.setScope(libraryOwnerA);
    await h.store.saveAccountJobs(libraryOwnerA, [
      accountLibraryJob(libraryJob()),
    ]);
    h.listeners[0]!({
      live: true,
      errorCode: null,
      data: { items: [libraryJob(), { id: "invalid" }], next_cursor: null },
    });
    await h.controller.flush();
    expect(h.controller.view().state).toBe("error");
    expect((await h.disk.read(libraryOwnerA.firebaseUid)).jobs).toHaveLength(1);
  });
  it("leaves Library usable while separate history recovery is required", async () => {
    const h = fixture({
      reconcile: async () => {
        throw new Error("HISTORY_CORRUPT");
      },
      count: () => {
        throw new Error("HISTORY_CORRUPT");
      },
    });
    await h.store.rememberPersonal(libraryPersonal(), null);
    await h.setScope(null);
    expect(h.controller.view()).toMatchObject({
      state: "ready",
      tracks: [{ playCount: 0, offline: true }],
    });
  });

  it("hydrates visible thumbnails from events with dedupe and query fencing", async () => {
    let finish!: (value: string) => void;
    const thumbnail = vi.fn(
        async () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      ),
      h = fixture(undefined, thumbnail);
    await h.store.rememberPersonal(libraryPersonal("Visible"), null);
    await h.store.rememberPersonal(libraryPersonal("Hidden"), null);
    await h.setScope(null);
    await h.controller.act({
      type: "QUERY",
      query: {
        search: "Visible",
        filter: "all",
        sort: "title",
        mostPlayedOnly: false,
        starredOnly: false,
      },
    });
    finish("data:image/jpeg;base64,Y29kZS1maXh0dXJl");
    await vi.waitFor(() =>
      expect(h.controller.view().tracks[0]?.thumbnailDataUrl).toBe(
        "data:image/jpeg;base64,Y29kZS1maXh0dXJl",
      ),
    );
    expect(h.controller.view().visibleIds).toHaveLength(1);
    expect(h.controller.view().tracks).toHaveLength(2);
    expect(thumbnail).toHaveBeenCalledOnce();
  });
});
