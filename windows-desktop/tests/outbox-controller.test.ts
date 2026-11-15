import { describe, expect, it, vi } from "vitest";
import { ownerA, ownerB } from "./realtime-fixtures.js";
import { localEntry, outboxFixture, jobId } from "./outbox-fixtures.js";
import { parseOutboxCommand } from "../src/shared/outbox-contracts.js";

describe("durable Windows original/voice account saving", () => {
  it("defers new captures, account reconnect and retry timers while paused, preserving the durable original request for resume", async () => {
    vi.useFakeTimers();
    const f = await outboxFixture();
    let allowed = true;
    f.options.consumersAllowed = () => allowed;
    try {
      const record = await f.controller.stage(localEntry(), ownerA);
      f.fetcher.mockRejectedValueOnce(new Error("NETWORK_UNAVAILABLE"));
      await f.run();
      const retained = structuredClone(f.saved.get(record.requestId));
      allowed = false;
      await expect(f.controller.stage(localEntry(), ownerA)).rejects.toThrow(
        "CONSUMERS_PAUSED",
      );
      await f.setOwner({ ...ownerA });
      f.controller.onConnected();
      f.advance(6000);
      await vi.advanceTimersByTimeAsync(6000);
      await f.controller.savePending();
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(f.saved.get(record.requestId)).toEqual(retained);
      expect(f.retained.has(record.requestId)).toBe(true);
      allowed = true;
      await f.controller.resume();
      expect(f.saved.get(record.requestId)?.state).toBe("committed");
      expect(f.server.size).toBe(1);
    } finally {
      await f.controller.dispose();
      vi.useRealTimers();
    }
  });
  it("keeps admitted capture busy through maintenance and an old-scope write acknowledgement without cancelling it", async () => {
    const f = await outboxFixture();
    let allowed = true;
    f.options.consumersAllowed = () => allowed;
    let finish!: () => void;
    const retain = vi.mocked(f.media.retain).getMockImplementation()!;
    vi.mocked(f.media.retain).mockImplementationOnce(async (...args) => {
      await retain(...args);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const entry = localEntry(),
      capture = f.controller.stage(entry, ownerA),
      rejected = expect(capture).rejects.toThrow("ACCOUNT_CHANGED");
    expect(f.controller.view().busy).toBe(true);
    await vi.waitFor(() => expect(finish).toBeDefined());
    allowed = false;
    await f.setOwner(ownerB);
    expect(f.controller.view()).toMatchObject({ busy: true, items: [] });
    await expect(f.controller.stage(localEntry(), ownerB)).rejects.toThrow(
      "CONSUMERS_PAUSED",
    );
    finish();
    await rejected;
    expect(f.controller.view().busy).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect([...f.saved.values()][0]?.ownerUid).toBe(ownerA.firebaseUid);
    await f.controller.dispose();
  });
  it("keeps an admitted drain counted until its current upload finishes and starts no second record while paused", async () => {
    const f = await outboxFixture();
    let allowed = true;
    f.options.consumersAllowed = () => allowed;
    const first = await f.controller.stage(localEntry(), ownerA),
      other = localEntry(true);
    other.catalog.cache_key = "e".repeat(64);
    const second = await f.controller.stage(other, ownerA, "community-link");
    let finish!: () => void;
    const upload = vi.mocked(f.media.upload).getMockImplementation()!;
    vi.mocked(f.media.upload).mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await upload(...args);
    });
    const run = f.run();
    await vi.waitFor(() => expect(finish).toBeDefined());
    allowed = false;
    expect(f.controller.view().busy).toBe(true);
    finish();
    await run;
    expect(f.saved.get(first.requestId)?.state).toBe("committed");
    expect(f.saved.get(second.requestId)).toMatchObject({
      state: "pending",
      attempts: 0,
    });
    expect(f.controller.view().busy).toBe(false);
    expect(f.media.release).toHaveBeenCalledOnce();
    expect(f.community.link).not.toHaveBeenCalled();
    allowed = true;
    await f.controller.resume();
    expect(f.saved.get(second.requestId)?.state).toBe("committed");
    await f.controller.dispose();
  });
  it("does not publish false idle after scope retirement while an actual old journal read is still pending", async () => {
    const f = await outboxFixture();
    let finish!: (records: never[]) => void;
    vi.spyOn(f.store, "list").mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const read = f.controller.restore(),
      rejected = expect(read).rejects.toThrow("ACCOUNT_CHANGED");
    expect(f.controller.view().busy).toBe(true);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.setOwner(null);
    expect(f.controller.view().busy).toBe(true);
    let disposed = false;
    const closing = f.controller.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    finish([]);
    await rejected;
    await closing;
    expect(f.controller.view().busy).toBe(false);
  });
  it("coalesces concurrent staging and prevents receipt notifications from competing with source capture", async () => {
    const f = await outboxFixture(),
      entry = localEntry();
    f.online();
    const write = vi.mocked(f.files.write).getMockImplementation()!;
    vi.mocked(f.files.write).mockImplementation(async (record) => {
      await write(record);
      f.controller.onConnected();
    });
    const [first, second] = await Promise.all([
      f.controller.stage(entry, ownerA),
      f.controller.stage(entry, ownerA),
    ]);
    await f.controller.savePending();
    expect(first.requestId).toBe(second.requestId);
    expect(f.saved.size).toBe(1);
    expect(f.server.size).toBe(1);
    expect(f.saved.get(first.requestId)).toMatchObject({
      state: "committed",
      captured: true,
      copiesReleased: true,
    });
    expect(f.media.describe).toHaveBeenCalledOnce();
    await f.controller.dispose();
  });
  it("awaits cancellation during a source capture before discarding its private files", async () => {
    const f = await outboxFixture(),
      entry = localEntry();
    let started = false;
    vi.mocked(f.media.retain).mockImplementationOnce(
      async (record, context) => {
        started = true;
        f.retained.add(record.requestId);
        await new Promise<void>((_resolve, reject) =>
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("CANCELLED")),
            { once: true },
          ),
        );
      },
    );
    const stage = f.controller.stage(entry, ownerA),
      rejected = expect(stage).rejects.toThrow("CANCELLED");
    await vi.waitFor(() => expect(started).toBe(true));
    const record = [...f.saved.values()][0]!;
    await f.controller.execute({
      type: "DISCARD",
      requestId: record.requestId,
    });
    await rejected;
    expect(f.saved.get(record.requestId)).toMatchObject({
      state: "discarded",
      copiesReleased: true,
    });
    expect(f.retained.size).toBe(0);
    expect(f.fetcher).not.toHaveBeenCalled();
    await f.controller.dispose();
  });
  it.each([1, 2])(
    "recovers initial journal fault %i after confirmed source output without a duplicate account request",
    async (boundary) => {
      const f = await outboxFixture(),
        entry = localEntry(),
        write = vi.mocked(f.files.write).getMockImplementation()!;
      let writes = 0;
      vi.mocked(f.files.write).mockImplementation(async (record) => {
        if (++writes === boundary) throw new Error("JOURNAL_WRITE_FAILED");
        await write(record);
      });
      await expect(f.controller.stage(entry, ownerA)).rejects.toThrow(
        "JOURNAL_WRITE_FAILED",
      );
      if (!f.saved.size) await f.controller.stage(entry, ownerA);
      else f.advance(6000);
      await f.run();
      expect(f.server.size).toBe(1);
      expect([...f.saved.values()][0]).toMatchObject({
        state: "committed",
        captured: true,
        copiesReleased: true,
      });
      await f.controller.dispose();
    },
  );
  it("captures offline independently of playback and commits/link/releases only after exact pair completion", async () => {
    const f = await outboxFixture(),
      entry = localEntry(),
      record = await f.controller.stage(entry, ownerA);
    expect(record.state).toBe("pending");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.retained.has(record.requestId)).toBe(true);
    await f.run();
    expect(f.saved.get(record.requestId)).toMatchObject({
      state: "committed",
      linked: true,
      copiesReleased: true,
      jobId,
    });
    expect(f.calls.map((call) => call.path)).toEqual([
      "/local-media-syncs",
      `/local-media-syncs/0123456789abcdef01234567/completions`,
    ]);
    expect(f.server.size).toBe(1);
    expect(f.retained.size).toBe(0);
    expect(f.controller.view().items[0]?.state).toBe("saved");
    const safe = JSON.stringify(f.controller.view());
    for (const forbidden of [
      "synthetic-private",
      "signature=secret",
      "owner-a",
      "relativePath",
      "original.m4a",
    ])
      expect(safe).not.toContain(forbidden);
    await f.controller.dispose();
  });
  it("deduplicates staging the same cache identity and rejects changed pair identity", async () => {
    const f = await outboxFixture(),
      entry = localEntry(),
      first = await f.controller.stage(entry, ownerA),
      second = await f.controller.stage(entry, ownerA);
    expect(second.requestId).toBe(first.requestId);
    expect(f.saved.size).toBe(1);
    entry.vocals.sha256 = "d".repeat(64);
    await expect(f.controller.stage(entry, ownerA)).rejects.toThrow(
      "OUTBOX_IDENTITY_CONFLICT",
    );
    await f.controller.dispose();
  });
  it("recovers a lost finalization response by the original idempotent request without reupload or duplicate job", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA),
      original = f.fetcher.getMockImplementation()!;
    let lost = true;
    f.fetcher.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (lost && String(args[0]).endsWith("/completions")) {
        lost = false;
        throw new Error("LOST_FINALIZE_RESPONSE");
      }
      return result;
    });
    await f.run();
    expect(f.saved.get(record.requestId)?.state).toBe("retry");
    const uploads = vi.mocked(f.media.upload).mock.calls.length;
    await f.reopen();
    f.advance(6000);
    await f.run();
    expect(f.saved.get(record.requestId)?.state).toBe("committed");
    expect(f.server.size).toBe(1);
    expect(vi.mocked(f.media.upload).mock.calls.length).toBe(uploads);
    expect(
      f.calls
        .filter((c) => c.path === "/local-media-syncs")
        .map((c) => c.body.request_id),
    ).toEqual([record.requestId, record.requestId]);
    await f.controller.dispose();
  });
  it("asks completion to resolve partial/ambiguous PUTs before retrying create-only uploads", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA),
      upload = vi.mocked(f.media.upload).getMockImplementation()!;
    vi.mocked(f.media.upload).mockImplementationOnce(async (...args) => {
      await upload(...args);
      throw new Error("UPLOAD_UNAVAILABLE");
    });
    await f.run();
    expect(f.calls.at(-1)?.path).toContain("completions");
    expect(f.saved.get(record.requestId)?.state).toBe("retry");
    f.advance(6000);
    await f.run();
    expect(f.saved.get(record.requestId)?.state).toBe("committed");
    expect(f.server.size).toBe(1);
    await f.controller.dispose();
  });
  it("persists and reuses the upload-grant request UUID after a lost refresh response", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA),
      original = f.fetcher.getMockImplementation()!;
    let lost = true;
    f.fetcher.mockImplementation(async (...args) => {
      const url = String(args[0]);
      if (url.endsWith("/local-media-syncs")) {
        await original(...args);
        return Response.json(f.sync(record.requestId, false, true));
      }
      if (url.endsWith("/upload-grants") && lost) {
        lost = false;
        await original(...args);
        throw new Error("LOST_REFRESH_RESPONSE");
      }
      return original(...args);
    });
    await f.run();
    const grantId = f.saved.get(record.requestId)?.grantRequestId;
    expect(grantId).toMatch(/^[a-f0-9-]{36}$/);
    f.advance(6000);
    await f.run();
    expect(
      f.calls
        .filter((c) => c.path.endsWith("upload-grants"))
        .map((c) => c.body.request_id),
    ).toEqual([grantId, grantId]);
    expect(f.saved.get(record.requestId)?.state).toBe("committed");
    await f.controller.dispose();
  });
  it("accepts another producer's committed reply during grant refresh without a new upload", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA),
      original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (...args) => {
      const url = String(args[0]);
      const result = await original(...args);
      if (url.endsWith("/local-media-syncs"))
        return Response.json(f.sync(record.requestId, false, true));
      if (url.endsWith("/upload-grants"))
        return Response.json(f.sync(record.requestId, true));
      return result;
    });
    await f.run();
    expect(f.saved.get(record.requestId)?.state).toBe("committed");
    expect(f.media.upload).not.toHaveBeenCalled();
    await f.controller.dispose();
  });
  it("honors rate-limit Retry-After and makes no status GET or early repeated POST", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA);
    f.fetcher.mockResolvedValue(
      Response.json(
        { code: "RATE_LIMITED" },
        { status: 429, headers: { "retry-after": "3600" } },
      ),
    );
    await f.run();
    const stored = f.saved.get(record.requestId)!;
    expect(stored.nextAttemptAt! - stored.updatedAt).toBeGreaterThanOrEqual(
      3600000,
    );
    const count = f.fetcher.mock.calls.length;
    f.advance(300000);
    await f.run();
    expect(f.fetcher).toHaveBeenCalledTimes(count);
    await f.controller.dispose();
  });
  it("blocks an expired reservation without silently issuing a replacement request", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA);
    f.fetcher.mockResolvedValue(
      Response.json({ ...f.sync(record.requestId), status: "expired" }),
    );
    await f.run();
    expect(f.saved.get(record.requestId)).toMatchObject({
      state: "blocked",
      errorCode: "LOCAL_SYNC_EXPIRED",
      nextAttemptAt: null,
    });
    f.advance(1000000);
    await f.run();
    expect(f.fetcher).toHaveBeenCalledOnce();
    await f.controller.dispose();
  });
  it.each([
    "verify",
    "authorization",
    "original",
    "vocals",
    "completion",
    "catalog",
  ])(
    "fences account switching during %s without assigning A pending media to B",
    async (boundary) => {
      const f = await outboxFixture(),
        record = await f.controller.stage(localEntry(), ownerA);
      if (boundary === "verify")
        vi.mocked(f.media.verify).mockImplementationOnce(async () => {
          await f.setOwner(ownerB);
        });
      if (boundary === "authorization")
        f.account.authorization.mockImplementationOnce(async () => {
          await f.setOwner(ownerB);
          return "header.payload.synthetic-B";
        });
      if (boundary === "original" || boundary === "vocals") {
        const original = vi.mocked(f.media.upload).getMockImplementation()!;
        vi.mocked(f.media.upload).mockImplementation(async (...args) => {
          if ((args[1] === args[0].original) === (boundary === "original"))
            await f.setOwner(ownerB);
          await original(...args);
        });
      }
      if (boundary === "completion") {
        const original = f.fetcher.getMockImplementation()!;
        f.fetcher.mockImplementation(async (...args) => {
          const result = await original(...args);
          if (String(args[0]).endsWith("/completions"))
            await f.setOwner(ownerB);
          return result;
        });
      }
      if (boundary === "catalog")
        f.catalog.attach.mockImplementationOnce(async () => {
          await f.setOwner(ownerB);
        });
      await f.run();
      expect(f.saved.get(record.requestId)?.ownerUid).toBe(ownerA.firebaseUid);
      expect(f.controller.view().items).toEqual([]);
      expect(
        f.calls.every(
          (call) => call.bearer === "Bearer header.payload.synthetic-private",
        ),
      ).toBe(true);
      await f.controller.dispose();
    },
  );
  it("keeps pending media on signout and resumes only the original UID using its new generation", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA);
    await f.setOwner(null);
    await f.run();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.retained.has(record.requestId)).toBe(true);
    await f.setOwner({
      ...ownerA,
      generation: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    await f.run();
    expect(f.saved.get(record.requestId)).toMatchObject({
      state: "committed",
      ownerGeneration: ownerA.generation,
      attemptGeneration: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    await f.controller.dispose();
  });
  it.each([3, 4, 5, 6, 7])(
    "recovers journal fault at boundary %i without duplicate backend records or losing retention",
    async (boundary) => {
      const f = await outboxFixture(),
        record = await f.controller.stage(localEntry(), ownerA),
        original = vi.mocked(f.files.write).getMockImplementation()!;
      let writes = 2;
      vi.mocked(f.files.write).mockImplementation(async (next) => {
        writes++;
        if (writes === boundary) throw new Error("JOURNAL_WRITE_FAILED");
        await original(next);
      });
      await f.run();
      f.advance(6000);
      await f.run();
      expect(f.saved.get(record.requestId)).toMatchObject({
        state: "committed",
        linked: true,
        copiesReleased: true,
      });
      expect(f.server.size).toBe(1);
      expect(f.retained.size).toBe(0);
      await f.controller.dispose();
    },
  );
  it("retries a catalog commit independently of remote saving and releases files only after the association is durable", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA);
    f.catalog.attach.mockRejectedValueOnce(new Error("CATALOG_UNAVAILABLE"));
    await f.run();
    expect(f.saved.get(record.requestId)).toMatchObject({
      state: "committed",
      linked: false,
      copiesReleased: false,
    });
    expect(f.retained.has(record.requestId)).toBe(true);
    const calls = f.calls.length;
    f.advance(6000);
    await f.run();
    expect(f.calls).toHaveLength(calls);
    expect(f.saved.get(record.requestId)).toMatchObject({
      linked: true,
      copiesReleased: true,
    });
    await f.controller.dispose();
  });
  it("saves a verified shared owner link without a pair upload, inference or processing intake", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(
        localEntry(true),
        ownerA,
        "community-link",
      );
    await f.run();
    expect(f.saved.get(record.requestId)).toMatchObject({
      kind: "community-link",
      state: "committed",
      original: null,
      linked: true,
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.media.upload).not.toHaveBeenCalled();
    expect(f.community.link).toHaveBeenCalledOnce();
    await f.controller.dispose();
  });
  it("discards only private retained copies and never invokes backend/shared-media deletion", async () => {
    const f = await outboxFixture(),
      record = await f.controller.stage(localEntry(), ownerA);
    await f.controller.execute({
      type: "DISCARD",
      requestId: record.requestId,
    });
    expect(f.saved.get(record.requestId)).toMatchObject({
      state: "discarded",
      copiesReleased: true,
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.retained.size).toBe(0);
    expect(() =>
      parseOutboxCommand({
        type: "DISCARD",
        requestId: record.requestId,
        ownerUid: ownerB.firebaseUid,
      }),
    ).toThrow();
    await f.controller.dispose();
  });
});
