import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  localEntry,
  outboxFixture,
  outboxInstallation,
} from "./outbox-fixtures.js";
import { ownerA, ownerB } from "./realtime-fixtures.js";
import {
  OUTBOX_ORIGINAL_BUDGET,
  parseOutboxRecord,
  stageOutbox,
} from "../src/main/outbox/model.js";

describe("outbox journal retention and identity", () => {
  it("keeps owner/installation/source/profile identity immutable through update", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA);
    for (const patch of [
      { ownerUid: ownerB.firebaseUid },
      { createdAt: record.createdAt - 1 },
      { title: "Changed" },
      { original: { ...record.original!, bytes: record.original!.bytes + 1 } },
    ])
      await expect(f.store.update(record, patch)).rejects.toThrow();
    expect(f.saved.get(record.requestId)).toEqual(record);
    await f.controller.dispose();
  });
  it("fences a stale writer revision and attempt nonce", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA),
      next = await f.store.update(record, {
        state: "saving",
        attemptId: randomUUID(),
        attemptGeneration: ownerA.generation,
      });
    await expect(f.store.update(record, { state: "blocked" })).rejects.toThrow(
      "OUTBOX_ATTEMPT_CHANGED",
    );
    expect(f.saved.get(record.requestId)?.attemptId).toBe(next.attemptId);
    await f.controller.dispose();
  });
  it("counts retained originals across all owners and reserves the budget before copying", async () => {
    const f = await outboxFixture();
    for (let n = 0; n < 2; n++) {
      const entry = localEntry();
      entry.catalog.cache_key = String(n + 1).repeat(64);
      entry.original.bytes = 100000000;
      const scope = n ? ownerB : ownerA;
      await f.store.create(
        stageOutbox(
          entry,
          scope,
          outboxInstallation,
          randomUUID(),
          "pair",
          Date.now(),
        ),
      );
    }
    const third = localEntry();
    third.catalog.cache_key = "3".repeat(64);
    third.original.bytes = OUTBOX_ORIGINAL_BUDGET - 200000000 + 1;
    await expect(
      f.store.create(
        stageOutbox(
          third,
          ownerA,
          outboxInstallation,
          randomUUID(),
          "pair",
          Date.now(),
        ),
      ),
    ).rejects.toThrow("OUTBOX_RETENTION_LIMIT");
    expect(f.media.retain).not.toHaveBeenCalled();
    await f.controller.dispose();
  });
  it("rejects damaged pair metadata, unsafe source paths and another installation before transfer", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA);
    for (const patch of [
      { modelDigest: "0".repeat(64) },
      { recipeDigest: "0".repeat(64) },
      { vocals: { ...record.vocals, relativePath: "C:\\private\\file" } },
      { original: { ...record.original!, durationSeconds: 100 } },
      { original: { ...record.original!, bytes: -1 } },
      { copiesReleased: true },
      { kind: "community-link" },
    ])
      expect(() =>
        parseOutboxRecord({ ...record, ...patch }, outboxInstallation),
      ).toThrow();
    expect(() => parseOutboxRecord(record, randomUUID())).toThrow();
    await f.controller.dispose();
  });
  it("recovers an atomic commit whose acknowledgement was lost without creating another journal", async () => {
    const f = await outboxFixture(),
      entry = localEntry(),
      record = stageOutbox(
        entry,
        ownerA,
        outboxInstallation,
        randomUUID(),
        "pair",
        Date.now(),
      ),
      original = vi.mocked(f.files.write).getMockImplementation()!;
    vi.mocked(f.files.write).mockImplementationOnce(async (r) => {
      await original(r);
      throw new Error("LOST_JOURNAL_ACK");
    });
    await expect(f.store.create(record)).rejects.toThrow("LOST_JOURNAL_ACK");
    const retried = await f.store.create(
      stageOutbox(
        entry,
        ownerA,
        outboxInstallation,
        randomUUID(),
        "pair",
        record.createdAt,
      ),
    );
    expect(retried.requestId).toBe(record.requestId);
    expect(f.saved.size).toBe(1);
    await f.controller.dispose();
  });
  it("never silently skips a corrupted pending journal", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA);
    f.saved.set(record.requestId, {
      ...record,
      vocals: { ...record.vocals, sha256: "broken" },
    });
    await expect(f.store.list()).rejects.toThrow("OUTBOX_ARTIFACT_INVALID");
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.controller.dispose();
  });
});
