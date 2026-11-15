import { createHash } from "node:crypto";
import { lstat, readFile, unlink } from "node:fs/promises";
import { vi } from "vitest";
import {
  sameConsumerProcess,
  type ConsumerProcessIdentity,
  type ConsumerStorageCleanupReceipt,
} from "../../worker/src/platform/windows/consumer-native.js";
import type { StorageWrite } from "../src/main/storage/write-journal.js";
import { partialWriteTarget } from "../src/main/storage/partial-write-policy.js";
/** Injected native boundary over isolated real files. No Win32 HANDLE/DPAPI
 * claim: source rows, exact creation birth, live copier and ACK state are checked. */
export function storagePartialNativeFixture(options: {
  path(relative: string): string;
  cacheHeld(): boolean;
  currentProcess(pid: number): Promise<ConsumerProcessIdentity | null>;
}) {
  const completed = new Map<
    string,
    Extract<ConsumerStorageCleanupReceipt, { state: "completed" }>
  >();
  return {
    discardStoragePartial: vi.fn(
      async (id: string): Promise<ConsumerStorageCleanupReceipt> => {
        if (!options.cacheHeld()) throw new Error("PEER_DENIED");
        const journal = JSON.parse(
            await readFile(options.path("storage\\writes.json"), "utf8"),
          ) as { writes: StorageWrite[] },
          row = journal.writes.find((r) => r.id === id);
        if (
          !row ||
          !row.birth ||
          row.kind !== "file" ||
          !partialWriteTarget(row.relativePath)
        )
          throw new Error("PATH_UNSAFE");
        const actualOwner = await options.currentProcess(row.owner.pid);
        if (
          !row.settled &&
          actualOwner &&
          sameConsumerProcess(actualOwner, row.owner)
        )
          return { state: "pending" };
        const receiptId = createHash("sha256").update(id).digest("hex"),
          prior = completed.get(receiptId),
          path = options.path(row.relativePath);
        if (prior) {
          try {
            await lstat(path);
            throw new Error("PATH_UNSAFE");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          return prior;
        }
        const actual = await lstat(path, { bigint: true });
        if (
          !actual.isFile() ||
          actual.isSymbolicLink() ||
          actual.nlink !== 1n ||
          String(actual.dev) !== row.birth.device ||
          String(actual.ino) !== row.birth.fileId ||
          String(actual.birthtimeNs) !== row.birth.bornAt
        )
          throw new Error("PATH_UNSAFE");
        await unlink(path);
        const receipt = {
          state: "completed" as const,
          receiptId,
          nonce: createHash("sha256").update(`nonce:${id}`).digest("hex"),
        };
        completed.set(receiptId, receipt);
        return receipt;
      },
    ),
    acknowledgeStorageCleanup: vi.fn(
      async (
        receipt: Extract<ConsumerStorageCleanupReceipt, { state: "completed" }>,
      ) => {
        if (!options.cacheHeld()) throw new Error("PEER_DENIED");
        const prior = completed.get(receipt.receiptId);
        if (prior && JSON.stringify(prior) !== JSON.stringify(receipt))
          throw new Error("PEER_DENIED");
        completed.delete(receipt.receiptId);
      },
    ),
  };
}
