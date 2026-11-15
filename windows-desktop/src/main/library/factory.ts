import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { win32 } from "node:path";
import type { ConsumerProcessIdentity } from "../../../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../host-context.js";
import type { SessionAccountScope } from "../../shared/session-contracts.js";
import type { PersonalJobView } from "../../shared/personal-contracts.js";
import type { PersonalStoredResult } from "../personal/controller.js";
import { LibraryStore, WindowsLibraryDisk, libraryNamespace } from "./store.js";
import { LibraryArtifactCache } from "./artifacts.js";
import { LibraryPins } from "./pins.js";
import { LibraryPlaybackProvider } from "./provider.js";
import {
  LibraryController,
  type LibraryControllerOptions,
} from "./controller.js";
import { localTrackId } from "./model.js";
import { LibraryThumbnailCache } from "./thumbnails.js";
import { WindowsLocalDeletionJournal } from "../storage/local-deletions.js";
import type {
  ConsumerFileBirth,
  ConsumerStorageCleanupReceipt,
} from "../../../../worker/src/platform/windows/consumer-native.js";
type Completed = Extract<ConsumerStorageCleanupReceipt, { state: "completed" }>;
const treeCleanups = new WeakMap<
  HostContext,
  Map<string, { birth: ConsumerFileBirth; receipt?: Completed }>
>();
/** Caller holds the cache mutex/pins. Native retains the selected generation
 * through disposition; failed ACK resumes only that captured metadata closure. */
async function removeTree(
  host: HostContext,
  relative: string,
  signal: AbortSignal,
  expected?: ConsumerFileBirth,
): Promise<void> {
  signal.throwIfAborted();
  const local =
    /^personal\\results\\[a-f0-9-]{36}\.([a-f0-9-]{36})\.deleted$/u.exec(
      relative,
    );
  if (!local && !/^library\\media\\[a-f0-9]{64}\\[a-f0-9]{24}$/u.test(relative))
    throw new Error("PATH_UNSAFE");
  let retained = treeCleanups.get(host);
  if (!retained) {
    retained = new Map();
    treeCleanups.set(host, retained);
  }
  let selected = retained.get(relative);
  if (!selected) {
    let birth = expected;
    if (!birth) {
      try {
        const stat = await lstat(win32.join(host.personalRoot, relative), {
          bigint: true,
        });
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n)
          throw new Error("PATH_UNSAFE");
        birth = {
          device: String(stat.dev),
          fileId: String(stat.ino),
          bornAt: String(stat.birthtimeNs),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !local)
          return;
        throw error;
      }
    }
    if (retained.size >= 16) throw new Error("LIBRARY_DELETE_PENDING");
    selected = { birth };
    retained.set(relative, selected);
  }
  if (
    !host.native.discardLibraryTree ||
    !host.native.acknowledgeLibraryTreeCleanup
  )
    throw new Error("LIBRARY_DELETE_PENDING");
  if (!selected.receipt) {
    const receipt = await host.native.discardLibraryTree(
      relative,
      selected.birth,
      local?.[1] ?? null,
    );
    if (receipt.state !== "completed")
      throw new Error("LIBRARY_DELETE_PENDING");
    selected.receipt = receipt;
  }
  if (!local) {
    await host.native.acknowledgeLibraryTreeCleanup(selected.receipt);
    retained.delete(relative);
  }
}
async function acknowledgeTrees(host: HostContext): Promise<void> {
  const retained = treeCleanups.get(host);
  if (!retained?.size) return;
  const rows = await new WindowsLocalDeletionJournal(host, async (pid) => {
    if (!host.native.processIdentity) throw new Error("LIBRARY_DELETE_PENDING");
    return host.native.processIdentity(pid);
  }).readOwned();
  for (const [relative, selected] of retained) {
    const local = /\.([a-f0-9-]{36})\.deleted$/u.exec(relative);
    if (!selected.receipt || (local && rows.some((row) => row.id === local[1])))
      continue;
    if (!host.native.acknowledgeLibraryTreeCleanup)
      throw new Error("LIBRARY_DELETE_PENDING");
    await host.native.acknowledgeLibraryTreeCleanup(selected.receipt);
    retained.delete(relative);
  }
}
export function createWindowsLibrary(options: {
  host: HostContext;
  current(scope: SessionAccountScope | null): boolean;
  processIdentity(pid: number): Promise<ConsumerProcessIdentity | null>;
  controller: Omit<
    LibraryControllerOptions,
    "store" | "cache" | "removeCache" | "deleteLocal"
  >;
  consumeResult?: ConstructorParameters<typeof LibraryArtifactCache>[2];
  fetch?: typeof fetch;
  retainedProtectedDirectories?: () => Promise<ReadonlySet<string>>;
}) {
  const { host, current } = options,
    deletions = new WindowsLocalDeletionJournal(host, options.processIdentity),
    disk = new WindowsLibraryDisk(host),
    store = new LibraryStore(disk, current),
    cache = new LibraryArtifactCache(
      host,
      current,
      options.consumeResult,
      options.fetch,
    ),
    thumbnails = new LibraryThumbnailCache(host, options.fetch),
    pins = new LibraryPins(
      host,
      options.processIdentity,
      options.retainedProtectedDirectories,
    ),
    playback = new LibraryPlaybackProvider(host, store, cache, pins, current);
  const assert = (scope: SessionAccountScope | null, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!current(scope)) throw new Error("ACCOUNT_CHANGED");
  };
  const controller = new LibraryController({
    ...options.controller,
    thumbnail: (url, signal) => thumbnails.resolve(url, signal),
    store,
    cache,
    removeCache: async (track, scope, signal) => {
      if (!track.accountOwned || !track.jobId)
        throw new Error("LIBRARY_ACTION_UNAVAILABLE");
      const relative = `library\\media\\${libraryNamespace(scope.firebaseUid)}\\${track.jobId}`;
      await pins.exclusiveUnpinned([relative], async () => {
        assert(scope, signal);
        await removeTree(host, relative, signal);
      });
    },
    deleteLocal: async (trackId, scope, signal) => {
      await pins.exclusiveUnpinned([], async (assertUnpinned) => {
        /* Resolve and delete under one physical mutex; no nested catalog mutation. */ assert(
          scope,
          signal,
        );
        const guest = await disk.read(null),
          entry = guest.entries.find(
            (entry) => localTrackId(entry) === trackId,
          );
        if (!entry) throw new Error("LIBRARY_ACTION_UNAVAILABLE");
        const relative = `personal\\results\\${entry.personalJobId}`;
        assertUnpinned(relative);
        const deletion = await deletions.beginOwned(
            entry.personalJobId,
            entry.original.sha256,
            entry.vocals.sha256,
          ),
          tombstone = deletions.tombstone(deletion);
        let finished = false;
        try {
          await host.native.validatePath("personal", relative, "directory");
          await host.native.validatePath("personal", tombstone, "absent");
          if (!host.native.moveLocalLibraryDeletion)
            throw new Error("LIBRARY_DELETE_PENDING");
          await host.native.moveLocalLibraryDeletion(deletion.id, "tombstone");
          const previous = structuredClone(guest);
          guest.entries = guest.entries.filter((row) => row !== entry);
          guest.revision = randomUUID();
          try {
            assert(scope, signal);
            await disk.write(guest);
            assert(scope, signal);
          } catch (error) {
            await disk.write(previous);
            await host.native.moveLocalLibraryDeletion(deletion.id, "restore");
            throw error;
          }
          // The catalog commit is final; cleanup uses a non-cancellable bounded owned tree.
          await removeTree(
            host,
            tombstone,
            new AbortController().signal,
            deletion.directory,
          );
          await deletions.finishOwned(deletion);
          finished = true;
          await acknowledgeTrees(host);
        } finally {
          if (!finished) await deletions.settleOwned(deletion);
        }
      });
    },
  });
  let closing = false;
  const recoverLocalDeletes = () =>
    pins.exclusiveUnpinned([], async (assertUnpinned) => {
      if (!host.native.listLibraryCleanups)
        throw new Error("LIBRARY_DELETE_PENDING");
      let retained = treeCleanups.get(host);
      if (!retained) {
        retained = new Map();
        treeCleanups.set(host, retained);
      }
      for (const row of await host.native.listLibraryCleanups()) {
        const previous = retained.get(row.relativePath);
        if (
          previous &&
          JSON.stringify(previous.birth) !== JSON.stringify(row.birth)
        )
          throw new Error("LIBRARY_DELETE_CHANGED");
        if (!previous)
          retained.set(row.relativePath, {
            birth: row.birth,
            ...(row.receipt ? { receipt: row.receipt } : {}),
          });
        else if (row.receipt) {
          if (
            previous.receipt &&
            JSON.stringify(previous.receipt) !== JSON.stringify(row.receipt)
          )
            throw new Error("LIBRARY_DELETE_CHANGED");
          previous.receipt = row.receipt;
        }
      }
      await acknowledgeTrees(host);
      for (const [relative, selected] of retained) {
        if (!relative.startsWith("library\\media\\")) continue;
        assertUnpinned(relative);
        await removeTree(
          host,
          relative,
          new AbortController().signal,
          selected.birth,
        );
      }
      const result = await deletions.recoverOwned(
        await disk.read(null),
        assertUnpinned,
        (relative, birth) =>
          removeTree(host, relative, new AbortController().signal, birth),
      );
      await acknowledgeTrees(host);
      return result;
    });
  return {
    controller,
    playback,
    store,
    cache,
    pins,
    thumbnails,
    recoverLocalDeletes,
    cleanupActivity: () => ({
      active:
        (treeCleanups.get(host)?.size ?? 0) +
        cache.cleanupActivity().active +
        (closing ? 1 : 0),
    }),
    close: async () => {
      if (closing) throw new Error("LIBRARY_BUSY");
      closing = true;
      try {
        await cache.close();
        await recoverLocalDeletes();
        if (
          (treeCleanups.get(host)?.size ?? 0) !== 0 ||
          cache.cleanupActivity().active !== 0
        )
          throw new Error("LIBRARY_DELETE_PENDING");
      } finally {
        closing = false;
      }
    },
    onPersonalResult: async (
      view: PersonalJobView,
      scope: SessionAccountScope | null,
      result?: PersonalStoredResult,
    ) => {
      await store.rememberPersonal(
        { ...view, state: "ready" },
        scope,
        result?.timeline,
      );
      await controller.refreshLocal();
    },
  };
}
