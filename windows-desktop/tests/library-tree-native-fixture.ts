import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  rmdir,
  unlink,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import type {
  ConsumerFileBirth,
  ConsumerStorageCleanupReceipt,
} from "../../worker/src/platform/windows/consumer-native.js";
import type { LocalDeletion } from "../src/main/storage/local-deletions.js";
type Completed = Extract<ConsumerStorageCleanupReceipt, { state: "completed" }>;
export function localLibraryMoveNativeFixture(options: {
  path(relative: string): string;
  cacheHeld(): boolean;
}) {
  return vi.fn(async (id: string, direction: "tombstone" | "restore") => {
    if (!options.cacheHeld()) throw new Error("PEER_DENIED");
    if (direction !== "tombstone" && direction !== "restore")
      throw new Error("BAD_REQUEST");
    const journal = JSON.parse(
      await readFile(options.path("storage\\deletions.json"), "utf8"),
    ) as { deletions: LocalDeletion[] };
    const row = journal.deletions.find((row) => row.id === id);
    if (!row) throw new Error("LIBRARY_DELETE_CHANGED");
    const canonical = `personal\\results\\${row.jobId}`,
      tombstone = `${canonical}.${id}.deleted`,
      from = options.path(direction === "tombstone" ? canonical : tombstone),
      to = options.path(direction === "tombstone" ? tombstone : canonical);
    const matching = async (path: string) => {
      const stat = await lstat(path, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        JSON.stringify({
          device: String(stat.dev),
          fileId: String(stat.ino),
          bornAt: String(stat.birthtimeNs),
        }) !== JSON.stringify(row.directory)
      )
        throw new Error("PATH_UNSAFE");
    };
    try {
      await matching(from);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await matching(to);
      return;
    }
    try {
      await lstat(to);
      throw new Error("PATH_UNSAFE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(from, to);
    await matching(to);
  });
}
/** Bounded portable receiving fixture over isolated files. Every leaf/root is
 * inventoried and rechecked; it does not execute a Windows HANDLE disposition. */
export function libraryTreeNativeFixture(options: {
  path(relative: string): string;
  cacheHeld(): boolean;
}) {
  const completed = new Map<string, Completed>(),
    acknowledged = new Map<string, Completed>();
  const records = new Map<
    string,
    {
      relativePath: string;
      birth: ConsumerFileBirth;
      deletionId: string | null;
      receipt: Completed | null;
    }
  >();
  return {
    moveLocalLibraryDeletion: localLibraryMoveNativeFixture(options),
    discardLibraryTree: vi.fn(
      async (
        relative: string,
        birth: ConsumerFileBirth,
        deletionId: string | null,
      ): Promise<ConsumerStorageCleanupReceipt> => {
        if (!options.cacheHeld()) throw new Error("PEER_DENIED");
        const local =
            /^personal\\results\\([a-f0-9-]{36})\.([a-f0-9-]{36})\.deleted$/u.exec(
              relative,
            ),
          account = /^library\\media\\[a-f0-9]{64}\\[a-f0-9]{24}$/u.test(
            relative,
          );
        if (local ? local[2] !== deletionId : !account || deletionId !== null)
          throw new Error("PATH_UNSAFE");
        const receiptId = createHash("sha256")
            .update(JSON.stringify([relative, birth, deletionId]))
            .digest("hex"),
          prior = completed.get(receiptId),
          path = options.path(relative);
        if (prior) {
          try {
            await lstat(path);
            throw new Error("PATH_UNSAFE");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          return prior;
        }
        const stat = await lstat(path, { bigint: true });
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          String(stat.dev) !== birth.device ||
          String(stat.ino) !== birth.fileId ||
          String(stat.birthtimeNs) !== birth.bornAt
        )
          throw new Error("PATH_UNSAFE");
        if (local) {
          const journal = JSON.parse(
              await readFile(options.path("storage\\deletions.json"), "utf8"),
            ) as { deletions: LocalDeletion[] },
            row = journal.deletions.find((row) => row.id === deletionId),
            catalog = JSON.parse(
              await readFile(
                options.path("library\\guest\\catalog.json"),
                "utf8",
              ),
            ) as { entries: { personalJobId: string }[] };
          if (
            !row ||
            row.jobId !== local[1] ||
            JSON.stringify(row.directory) !== JSON.stringify(birth) ||
            catalog.entries.some((entry) => entry.personalJobId === row.jobId)
          )
            throw new Error("PATH_UNSAFE");
          const pairBytes = await readFile(join(path, "pair.json")),
            pair = JSON.parse(pairBytes.toString("utf8")) as {
              original: { filename: string };
              vocals: { filename: string };
            };
          if (
            createHash("sha256").update(pairBytes).digest("hex") !==
              row.pairSha256 ||
            createHash("sha256")
              .update(await readFile(join(path, pair.original.filename)))
              .digest("hex") !== row.originalSha256 ||
            createHash("sha256")
              .update(await readFile(join(path, pair.vocals.filename)))
              .digest("hex") !== row.vocalsSha256
          )
            throw new Error("PATH_UNSAFE");
        }
        const inventory: {
          path: string;
          directory: boolean;
          identity: string;
        }[] = [];
        const collect = async (selected: string): Promise<void> => {
          const value = await lstat(selected, { bigint: true });
          if (
            value.isSymbolicLink() ||
            (!value.isDirectory() && (!value.isFile() || value.nlink !== 1n)) ||
            inventory.length >= 64
          )
            throw new Error("PATH_UNSAFE");
          const identity = [
            value.dev,
            value.ino,
            value.birthtimeNs,
            ...(value.isDirectory()
              ? []
              : [value.size, value.mtimeNs, value.ctimeNs]),
          ]
            .map(String)
            .join(":");
          inventory.push({
            path: selected,
            directory: value.isDirectory(),
            identity,
          });
          if (value.isDirectory())
            for (const name of await readdir(selected))
              await collect(join(selected, name));
        };
        await collect(path);
        if (records.size >= 16) throw new Error("LIBRARY_DELETE_PENDING");
        records.set(receiptId, {
          relativePath: relative,
          birth: structuredClone(birth),
          deletionId,
          receipt: null,
        });
        for (const entry of inventory.reverse()) {
          const value = await lstat(entry.path, { bigint: true }),
            identity = [
              value.dev,
              value.ino,
              value.birthtimeNs,
              ...(entry.directory
                ? []
                : [value.size, value.mtimeNs, value.ctimeNs]),
            ]
              .map(String)
              .join(":");
          if (identity !== entry.identity) throw new Error("PATH_UNSAFE");
          if (entry.directory) await rmdir(entry.path);
          else await unlink(entry.path);
        }
        const receipt: Completed = {
          state: "completed",
          receiptId,
          nonce: createHash("sha256")
            .update(`nonce:${receiptId}`)
            .digest("hex"),
        };
        completed.set(receiptId, receipt);
        records.set(receiptId, {
          relativePath: relative,
          birth: structuredClone(birth),
          deletionId,
          receipt,
        });
        return receipt;
      },
    ),
    acknowledgeLibraryTreeCleanup: vi.fn(async (receipt: Completed) => {
      if (!options.cacheHeld()) throw new Error("PEER_DENIED");
      const prior =
        completed.get(receipt.receiptId) ?? acknowledged.get(receipt.receiptId);
      if (!prior || JSON.stringify(prior) !== JSON.stringify(receipt))
        throw new Error("PEER_DENIED");
      completed.delete(receipt.receiptId);
      records.delete(receipt.receiptId);
      acknowledged.set(receipt.receiptId, receipt);
    }),
    listLibraryCleanups: vi.fn(async () => {
      if (!options.cacheHeld()) throw new Error("PEER_DENIED");
      return structuredClone([...records.values()]);
    }),
  };
}
