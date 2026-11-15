import { createHash } from "node:crypto";
import { lstat, readFile, unlink, rename } from "node:fs/promises";
import { vi } from "vitest";
import {
  sameConsumerProcess,
  type ConsumerCacheFileIdentity,
  type ConsumerProcessIdentity,
  type ConsumerStorageCleanupReceipt,
} from "../../worker/src/platform/windows/consumer-native.js";
import type { StorageWrite } from "../src/main/storage/write-journal.js";
type Completed = Extract<ConsumerStorageCleanupReceipt, { state: "completed" }>;
/** Isolated real-file receiver fixture. Journal authority, exact generations and
 * receipt/ACK replay are exercised; no Windows HANDLE or DPAPI execution claim. */
export function libraryArtifactNativeFixture(options: {
  path(relative: string): string;
  cacheHeld(): boolean;
  currentProcess(pid: number): Promise<ConsumerProcessIdentity | null>;
  acknowledgeOther(receipt: Completed): Promise<void>;
}) {
  const completed = new Map<string, Completed>();
  const publication = async (id: string, component: "media" | "metadata") => {
    if (!options.cacheHeld()) throw new Error("PEER_DENIED");
    const journal = JSON.parse(
      await readFile(options.path("storage\\writes.json"), "utf8"),
    ) as { writes: StorageWrite[] };
    const row = journal.writes.find((row) => row.id === id);
    if (
      !row?.publication ||
      (component !== "media" && component !== "metadata")
    )
      throw new Error("PATH_UNSAFE");
    const current = await options.currentProcess(row.owner.pid);
    if (!current || !sameConsumerProcess(current, row.owner))
      throw new Error("PEER_DENIED");
    const from =
        component === "media"
          ? row.relativePath
          : row.publication.temporaryMetadata,
      to =
        component === "media"
          ? row.publication.relativePath
          : row.publication.metadataPath,
      birth =
        component === "media"
          ? row.birth
          : row.publication.temporaryMetadataBirth;
    if (!birth) throw new Error("PATH_UNSAFE");
    const inspect = async (relative: string) => {
      const stat = await lstat(options.path(relative), { bigint: true });
      const identity = {
        device: String(stat.dev),
        fileId: String(stat.ino),
        bornAt: String(stat.birthtimeNs),
        bytes: Number(stat.size),
        writtenAt: String(stat.mtimeNs),
        changedAt: String(stat.ctimeNs),
      };
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1n ||
        ["device", "fileId", "bornAt"].some(
          (key) =>
            identity[key as keyof typeof identity] !==
            birth[key as keyof typeof birth],
        )
      )
        throw new Error("PATH_UNSAFE");
      if (
        component === "media" &&
        createHash("sha256")
          .update(await readFile(options.path(relative)))
          .digest("hex") !== row.publication!.sha256
      )
        throw new Error("PATH_UNSAFE");
      return { relativePath: relative, identity };
    };
    return { from, to, inspect };
  };
  return {
    publishLibraryArtifact: vi.fn(
      async (id: string, component: "media" | "metadata") => {
        const p = await publication(id, component);
        try {
          await p.inspect(p.from);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await p.inspect(p.to);
          return;
        }
        try {
          await lstat(options.path(p.to));
          throw new Error("PATH_UNSAFE");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await rename(options.path(p.from), options.path(p.to));
        await p.inspect(p.to);
      },
    ),
    inspectLibraryArtifactPublication: vi.fn(
      async (id: string, component: "media" | "metadata") => {
        const p = await publication(id, component);
        try {
          const result = await p.inspect(p.from);
          try {
            await lstat(options.path(p.to));
            throw new Error("PATH_UNSAFE");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          return result;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return p.inspect(p.to);
        }
      },
    ),
    discardLibraryArtifact: vi.fn(
      async (
        id: string,
        relative: string,
        identity: ConsumerCacheFileIdentity,
      ): Promise<ConsumerStorageCleanupReceipt> => {
        if (!options.cacheHeld()) throw new Error("PEER_DENIED");
        const journal = JSON.parse(
            await readFile(options.path("storage\\writes.json"), "utf8"),
          ) as { writes: StorageWrite[] },
          row = journal.writes.find((row) => row.id === id),
          publication = row?.publication,
          birth =
            relative === row?.relativePath ||
            relative === publication?.relativePath
              ? row?.birth
              : relative === publication?.temporaryMetadata ||
                  relative === publication?.metadataPath
                ? publication?.temporaryMetadataBirth
                : undefined;
        if (
          !row ||
          row.kind !== "file" ||
          !birth ||
          !relative.startsWith("library\\media\\")
        )
          throw new Error("PATH_UNSAFE");
        const current = await options.currentProcess(row.owner.pid);
        if (current && !sameConsumerProcess(current, row.owner))
          throw new Error("PEER_DENIED");
        if (
          ["device", "fileId", "bornAt"].some(
            (key) =>
              birth[key as keyof typeof birth] !==
              identity[key as keyof ConsumerCacheFileIdentity],
          )
        )
          throw new Error("PATH_UNSAFE");
        const receiptId = createHash("sha256")
            .update(JSON.stringify([id, relative, identity]))
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
        const actual = await lstat(path, { bigint: true }),
          expected: ConsumerCacheFileIdentity = {
            device: String(actual.dev),
            fileId: String(actual.ino),
            bornAt: String(actual.birthtimeNs),
            bytes: Number(actual.size),
            writtenAt: String(actual.mtimeNs),
            changedAt: String(actual.ctimeNs),
          };
        if (
          !actual.isFile() ||
          actual.isSymbolicLink() ||
          actual.nlink !== 1n ||
          Object.entries(expected).some(
            ([key, value]) =>
              identity[key as keyof ConsumerCacheFileIdentity] !== value,
          )
        )
          throw new Error("PATH_UNSAFE");
        await unlink(path);
        const receipt: Completed = {
          state: "completed",
          receiptId,
          nonce: createHash("sha256")
            .update(`nonce:${receiptId}`)
            .digest("hex"),
        };
        completed.set(receiptId, receipt);
        return receipt;
      },
    ),
    acknowledgeStorageCleanup: vi.fn(async (receipt: Completed) => {
      if (!options.cacheHeld()) throw new Error("PEER_DENIED");
      const prior = completed.get(receipt.receiptId);
      if (!prior) return options.acknowledgeOther(receipt);
      if (JSON.stringify(prior) !== JSON.stringify(receipt))
        throw new Error("PEER_DENIED");
      completed.delete(receipt.receiptId);
    }),
  };
}
