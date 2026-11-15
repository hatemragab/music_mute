import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  durableLibraryRetainedDirectories,
  durablePendingOriginalBytes,
} from "../src/main/library/retained-directories.js";
import { JournalOutboxStore } from "../src/main/outbox/store.js";
import { outboxRoot, stageOutbox } from "../src/main/outbox/model.js";
import {
  parsePublicationRecord,
  type PublicationRecord,
} from "../src/main/reuse/publication.js";
import { localEntry, outboxInstallation } from "./outbox-fixtures.js";
import { ownerA, ownerB } from "./realtime-fixtures.js";

function fixture() {
  const a = stageOutbox(
      localEntry(),
      ownerA,
      outboxInstallation,
      randomUUID(),
      "pair",
      1,
    ),
    b = stageOutbox(
      localEntry(),
      ownerB,
      outboxInstallation,
      randomUUID(),
      "pair",
      1,
    ),
    released = {
      ...stageOutbox(
        localEntry(),
        ownerB,
        outboxInstallation,
        randomUUID(),
        "pair",
        1,
      ),
      state: "discarded" as const,
      copiesReleased: true,
    },
    files = {
      list: vi.fn(async (): Promise<unknown[]> => [a, b, released]),
      write: async () => {},
      locked: async <T>(operation: () => Promise<T>) => operation(),
    },
    outbox = new JournalOutboxStore(files, outboxInstallation),
    pending: PublicationRecord = parsePublicationRecord({
      version: 1,
      requestId: randomUUID(),
      producerRequestId: randomUUID(),
      jobId: randomUUID(),
      videoId: "bZxrIoCPsOc",
      originalSha256: "a".repeat(64),
      vocalsSha256: "b".repeat(64),
      originalBytes: 3,
      vocalsBytes: 3,
      claim: null,
      state: "pending",
      ready: false,
      declared: false,
      reservation: null,
      revision: 0,
      attempts: 0,
      nextAttemptAt: null,
      errorCode: null,
      createdAt: 1,
    }),
    committed = parsePublicationRecord({
      ...pending,
      requestId: randomUUID(),
      producerRequestId: randomUUID(),
      jobId: randomUUID(),
      state: "committed",
    }),
    publications = { list: vi.fn(async () => [pending, committed]) };
  return { outbox, files, publications, a, b, released, pending, committed };
}

describe("durable Library cleanup retention without live account controllers", () => {
  it("sums all owners' pending originals including discarded unreleased copies, excluding confirmed releases", async () => {
    const f = fixture(),
      third = stageOutbox(
        localEntry(),
        ownerB,
        outboxInstallation,
        randomUUID(),
        "pair",
        1,
      );
    f.a.original!.bytes = 100000000;
    f.b.original!.bytes = 100000000;
    f.b.state = "discarded";
    third.original!.bytes = 256 * 1024 ** 2 - 200000000;
    f.released.original!.bytes = 100000000;
    f.files.list.mockResolvedValue([f.a, f.b, third, f.released]);
    expect(await durablePendingOriginalBytes(f.outbox)).toBe(256 * 1024 ** 2);
    expect(f.files.list).toHaveBeenCalledOnce();
    third.original!.bytes += 1;
    expect(await durablePendingOriginalBytes(f.outbox)).toBe(
      256 * 1024 ** 2 + 1,
    );
    third.original!.bytes -= 1;
    f.b.copiesReleased = true;
    expect(await durablePendingOriginalBytes(f.outbox)).toBe(
      256 * 1024 ** 2 - 100000000,
    );
  });
  it("refuses pending-original admission data from a corrupt journal", async () => {
    const f = fixture();
    f.files.list.mockResolvedValueOnce([null]);
    await expect(durablePendingOriginalBytes(f.outbox)).rejects.toThrow(
      "OUTBOX_RECORD_INVALID",
    );
  });
  it("protects all owner outboxes, uncaptured sources and pending publications while signed out", async () => {
    const f = fixture(),
      retained = await durableLibraryRetainedDirectories(
        f.outbox,
        f.publications,
      );
    expect(retained).toEqual(
      new Set([
        outboxRoot(f.a),
        outboxRoot(f.b),
        win32.dirname(f.a.vocals.sourceRelativePath),
        win32.dirname(f.b.vocals.sourceRelativePath),
        `personal\\results\\${f.pending.jobId}`,
      ]),
    );
    expect(retained.has(outboxRoot(f.released))).toBe(false);
    expect(retained.has(`personal\\results\\${f.committed.jobId}`)).toBe(false);
    expect(f.files.list).toHaveBeenCalledOnce();
  });
  it("drops source retention only after its actual captured journal state, keeping the outbox copy", async () => {
    const f = fixture();
    f.a.captured = true;
    f.a.state = "pending";
    const retained = await durableLibraryRetainedDirectories(
      f.outbox,
      f.publications,
    );
    expect(retained.has(outboxRoot(f.a))).toBe(true);
    expect(retained.has(win32.dirname(f.a.vocals.sourceRelativePath))).toBe(
      false,
    );
    expect(retained.has(outboxRoot(f.b))).toBe(true);
  });
  it("refuses cleanup on a corrupt durable outbox instead of returning an empty retained set", async () => {
    const f = fixture();
    f.files.list.mockResolvedValueOnce([null]);
    await expect(
      durableLibraryRetainedDirectories(f.outbox, f.publications),
    ).rejects.toThrow("OUTBOX_RECORD_INVALID");
    expect(f.publications.list).not.toHaveBeenCalled();
  });
  it("preserves a publication read failure instead of making retained media evictable", async () => {
    const f = fixture(),
      error = new Error("COMMUNITY_OUTBOX_CORRUPT");
    f.publications.list.mockRejectedValueOnce(error);
    await expect(
      durableLibraryRetainedDirectories(f.outbox, f.publications),
    ).rejects.toBe(error);
  });
});
