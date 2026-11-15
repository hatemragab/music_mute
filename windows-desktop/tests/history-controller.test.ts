import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  decodeHistory,
  emptyHistory,
  encodeHistory,
  HISTORY_MAX_CATALOG,
  HISTORY_MAX_RECEIPTS,
} from "../src/main/history/model.js";
import { parseHistoryCommand } from "../src/shared/history-contracts.js";
import { historyDevice, historyFixture, song } from "./history-fixtures.js";
import { ownerA, ownerB } from "./realtime-fixtures.js";
async function fixture() {
  const f = historyFixture();
  await f.controller.restore();
  await f.controller.reconcile([song]);
  return f;
}
describe("Windows durable listening accounting", () => {
  it("captures local playback under the Windows guest partition across account switches and later repeat sessions", async () => {
    const f = await fixture(),
      guest = { ...song, accountOwned: false },
      account = { ...song, accountOwned: true };
    await f.controller.setScope(ownerA);
    await f.controller.reconcile([guest, account]);
    const localPort = f.controller.accountingFor(guest),
      accountPort = f.controller.accountingFor(account);
    expect(() => localPort.begin("different-track", randomUUID())).toThrow(
      "HISTORY_SESSION_CONFLICT",
    );
    await localPort.begin(song.id, randomUUID());
    await accountPort.begin(song.id, randomUUID());
    expect(f.controller.count(guest)).toBe(1);
    expect(f.controller.count(account)).toBe(1);
    await f.controller.setScope(ownerB);
    await f.controller.reconcile([guest, account]);
    await localPort.begin(song.id, randomUUID());
    expect(f.controller.count(guest)).toBe(2);
    expect(f.controller.count(account)).toBe(0);
    expect(() => accountPort.begin(song.id, randomUUID())).toThrow(
      "HISTORY_OWNER_CHANGED",
    );
    await f.controller.setScope(null);
    await localPort.begin(song.id, randomUUID());
    expect(f.controller.count(guest)).toBe(3);
    expect(f.controller.canCount(account)).toBe(false);
    expect(f.controller.count(account)).toBe(0);
    expect(() => f.controller.accountingFor(account)).toThrow(
      "HISTORY_SCOPE_INVALID",
    );
    await f.controller.dispose();
    const reopened = historyFixture(historyDevice, f.saved);
    await reopened.controller.restore();
    expect(reopened.controller.count(guest)).toBe(3);
    await reopened.controller.setScope(ownerA);
    expect(reopened.controller.count(account)).toBe(1);
    await reopened.controller.dispose();
  });
  it("announces durable counts and alias changes without count notifications for listening progress", async () => {
    const f = await fixture(),
      changed = vi.fn(),
      off = f.controller.subscribeCounts(changed),
      id = randomUUID();
    changed.mockClear();
    await f.controller.begin(song.id, id);
    expect(changed).toHaveBeenCalledOnce();
    changed.mockClear();
    await f.controller.begin(song.id, id);
    await f.controller.pulse(song.id, id, 0, 1);
    f.advance(1000);
    await f.controller.pulse(song.id, id, 1, 1);
    await f.controller.end(song.id, id);
    expect(changed).not.toHaveBeenCalled();
    await f.controller.reconcile([
      { id: "new-alias", jobId: song.jobId, title: "Same" },
    ]);
    expect(changed).toHaveBeenCalledOnce();
    off();
    changed.mockClear();
    await f.controller.begin(song.id, randomUUID());
    expect(changed).not.toHaveBeenCalled();
    await f.controller.dispose();
  });
  it("keeps current account metrics available when the separate guest ledger needs recovery", async () => {
    const f = historyFixture();
    await f.controller.restore();
    f.saved.set(f.primary(), Buffer.from("damaged"));
    await f.controller.dispose();
    const next = historyFixture(historyDevice, f.saved),
      guest = { ...song, accountOwned: false },
      account = { id: "account", title: "Account", accountOwned: true };
    await next.controller.setScope(ownerA);
    await expect(next.controller.reconcile([guest, account])).rejects.toThrow(
      "HISTORY_CORRUPT",
    );
    expect(next.controller.canCount(guest)).toBe(false);
    expect(next.controller.canCount(account)).toBe(true);
    await next.controller
      .accountingFor(account)
      .begin(account.id, randomUUID());
    expect(next.controller.count(account)).toBe(1);
    await next.controller.dispose();
  });
  it("keeps a captured producer valid across repeated same-generation account presentation updates", async () => {
    const f = await fixture();
    await f.controller.setScope(ownerA);
    const port = f.controller.captureAccounting();
    await f.controller.setScope({ ...ownerA });
    await port.begin(song.id, randomUUID());
    expect(f.controller.count(song)).toBe(1);
  });
  it("does not overwrite an in-flight count with detached dirty progress during an account switch", async () => {
    const f = await fixture(),
      first = randomUUID();
    await f.controller.begin(song.id, first);
    await f.controller.pulse(song.id, first, 0, 1);
    let release!: () => void;
    vi.mocked(f.files.write).mockImplementationOnce(async (path, bytes) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      f.saved.set(path, bytes);
    });
    const next = f.controller.begin(song.id, randomUUID()),
      rejected = expect(next).rejects.toThrow("HISTORY_OWNER_CHANGED");
    await vi.waitFor(() => expect(release).toBeDefined());
    await f.controller.setScope(ownerA);
    release();
    await rejected;
    // Wait for the detached progress task and then reopen the original owner.
    await f.controller.begin("account-only", randomUUID());
    await f.controller.setScope(null);
    expect(f.controller.count(song)).toBe(2);
  });
  it("treats case variants of a UUID as the same receipt and rejects new events once close starts", async () => {
    const f = await fixture(),
      id = randomUUID();
    await f.controller.begin(song.id, id);
    await f.controller.begin(song.id, id.toUpperCase());
    expect(f.controller.count(song)).toBe(1);
    const close = f.controller.dispose();
    expect(() => f.controller.begin(song.id, randomUUID())).toThrow(
      "HISTORY_CLOSED",
    );
    await Promise.all([close, f.controller.dispose()]);
  });
  it("counts one real begin and preserves that count through duplicate events, pause/resume, source changes and seeking", async () => {
    const f = await fixture(),
      id = randomUUID();
    await f.controller.begin(song.id, id);
    for (let n = 0; n < 100; n++) {
      await f.controller.begin(song.id, id);
      f.advance(10);
      await f.controller.pulse(song.id, id, n % 2 ? 60 : 0, 1);
    }
    await f.controller.end(song.id, id);
    await f.controller.end(song.id, id);
    await f.controller.begin(song.id, id);
    expect(f.controller.count(song)).toBe(1);
    expect(f.controller.view().entries[0]?.listenedSeconds).toBe(0);
    await f.controller.dispose();
    const reopened = historyFixture(historyDevice, f.saved);
    await reopened.controller.restore();
    expect(reopened.controller.count(song)).toBe(1);
    await reopened.controller.begin(song.id, id);
    expect(reopened.controller.count(song)).toBe(1);
  });
  it("counts confirmed track/repeat/AB starts only through distinct logical session identities", async () => {
    const f = await fixture();
    for (let n = 0; n < 4; n++) {
      const id = randomUUID();
      await f.controller.begin(song.id, id);
      await f.controller.end(song.id, id);
    }
    expect(f.controller.count(song)).toBe(4);
    expect(
      decodeHistory(f.saved.get(f.primary())!, f.scope()).receipts,
    ).toHaveLength(4);
  });
  it("records continuous progress but rejects seek/rate/buffer discontinuities as listened time", async () => {
    const f = await fixture(),
      id = randomUUID();
    await f.controller.begin(song.id, id);
    await f.controller.pulse(song.id, id, 0, 1);
    f.advance(1000);
    await f.controller.pulse(song.id, id, 1, 1);
    f.advance(1000);
    await f.controller.pulse(song.id, id, 100, 1);
    f.advance(1000);
    await f.controller.pulse(song.id, id, 0, 1);
    f.advance(10000);
    await f.controller.pulse(song.id, id, 10, 1);
    f.advance(1000);
    await f.controller.pulse(song.id, id, 12, 2);
    f.advance(1000);
    await f.controller.pulse(song.id, id, 14, 2);
    await f.controller.end(song.id, id);
    expect(f.controller.view().entries[0]).toMatchObject({
      count: 1,
      listenedSeconds: 3,
      lastPosition: 14,
      lastListenedAt: "2026-10-09T00:00:15.000Z",
    });
  });
  it("coalesces progress writes while flushing at end and owner transition", async () => {
    const f = await fixture(),
      id = randomUUID();
    await f.controller.begin(song.id, id);
    const before = vi.mocked(f.files.write).mock.calls.length;
    await f.controller.pulse(song.id, id, 0, 1);
    for (let i = 1; i < 5; i++) {
      f.advance(500);
      await f.controller.pulse(song.id, id, i / 2, 1);
    }
    expect(vi.mocked(f.files.write).mock.calls.length).toBe(before);
    await f.controller.end(song.id, id);
    expect(vi.mocked(f.files.write).mock.calls.length).toBe(before + 2);
  });
  it("links local/cache/job aliases by maximum without summing unrelated prior copies", async () => {
    const f = await fixture(),
      job = { id: song.jobId, title: "Cloud" };
    for (let n = 0; n < 2; n++) await f.controller.begin(song.id, randomUUID());
    await f.controller.begin("other-cache", randomUUID());
    await f.controller.reconcile([
      { id: "other-cache", jobId: song.jobId, title: "Alias" },
      job,
    ]);
    expect(f.controller.count("other-cache")).toBe(2);
    expect(f.controller.count(job)).toBe(2);
    await f.controller.reconcile([song]);
    expect(f.controller.count(song)).toBe(2);
    await f.controller.begin("other-cache", randomUUID());
    expect(f.controller.count(song)).toBe(3);
    expect(f.controller.view().entries).toHaveLength(1);
  });
  it("uses descending counts then title and stable ID for Most Played", async () => {
    const f = await fixture(),
      bravo = { id: "bravo", title: "Bravo" },
      zulu = { id: "zulu", title: "Zulu" },
      unseen = { id: "unseen", title: "Zero" };
    await f.controller.begin(song.id, randomUUID());
    await f.controller.begin(song.id, randomUUID());
    await f.controller.begin(bravo.id, randomUUID());
    await f.controller.begin(zulu.id, randomUUID());
    expect(
      f.controller.mostPlayed([unseen, zulu, bravo, song]).map((t) => t.id),
    ).toEqual([song.id, "bravo", "zulu", "unseen"]);
    expect(
      f.controller
        .mostPlayed([unseen, zulu, bravo, song], true)
        .map((t) => t.id),
    ).toEqual([song.id, "bravo", "zulu"]);
  });
  it("isolates signed-out, A, B and later A generations without moving history", async () => {
    const f = await fixture(),
      local = randomUUID();
    await f.controller.begin(song.id, local);
    const localPort = f.controller.captureAccounting();
    await f.controller.setScope(ownerA);
    await f.controller.reconcile([song]);
    const a = randomUUID();
    await f.controller.begin(song.id, a);
    const aPort = f.controller.captureAccounting();
    await f.controller.setScope(ownerB);
    await f.controller.reconcile([song]);
    expect(f.controller.count(song)).toBe(0);
    await f.controller.pulse(song.id, a, 30, 1);
    expect(() => aPort.begin(song.id, randomUUID())).toThrow(
      "HISTORY_OWNER_CHANGED",
    );
    expect(() => localPort.begin(song.id, randomUUID())).toThrow(
      "HISTORY_OWNER_CHANGED",
    );
    await expect(aPort.pulse(song.id, a, 30, 1)).resolves.toBeUndefined();
    await expect(aPort.end(song.id, a)).resolves.toBeUndefined();
    await f.controller.begin(song.id, randomUUID());
    await f.controller.begin(song.id, randomUUID());
    await f.controller.setScope({ ...ownerA, generation: randomUUID() });
    expect(f.controller.count(song)).toBe(1);
    await f.controller.setScope(null);
    expect(f.controller.count(song)).toBe(1);
    expect(JSON.stringify(f.controller.view())).not.toContain(
      ownerA.firebaseUid,
    );
  });
  it("keeps a delayed A atomic commit in A while B loads a separate history", async () => {
    const f = await fixture();
    await f.controller.setScope(ownerA);
    await f.controller.reconcile([song]);
    let release!: () => void;
    vi.mocked(f.files.write).mockImplementationOnce(async (path, bytes) => {
      await new Promise<void>((r) => {
        release = r;
      });
      f.saved.set(path, bytes);
    });
    const start = f.controller.begin(song.id, randomUUID()),
      rejected = expect(start).rejects.toThrow("HISTORY_OWNER_CHANGED");
    await vi.waitFor(() => expect(release).toBeDefined());
    await f.controller.setScope(ownerB);
    release();
    await rejected;
    expect(f.controller.count(song)).toBe(0);
    await f.controller.setScope(ownerA);
    expect(f.controller.count(song)).toBe(1);
  });
  it("separates Windows/device identity changes from the existing ledger", async () => {
    const f = await fixture();
    await f.controller.begin(song.id, randomUUID());
    const changed = historyFixture(
      { ...historyDevice, installationId: randomUUID() },
      f.saved,
    );
    await changed.controller.restore();
    expect(changed.controller.count(song)).toBe(0);
    expect(f.controller.count(song)).toBe(1);
  });
  it("reads back an uncertain atomic commit before retry so a play cannot be counted twice", async () => {
    const f = await fixture(),
      id = randomUUID();
    vi.mocked(f.files.write).mockImplementationOnce(async (path, bytes) => {
      f.saved.set(path, bytes);
      throw new Error("POST_RENAME_FAILURE");
    });
    await expect(f.controller.begin(song.id, id)).rejects.toThrow(
      "POST_RENAME_FAILURE",
    );
    expect(f.controller.count(song)).toBe(1);
    await f.controller.begin(song.id, id);
    expect(f.controller.count(song)).toBe(1);
  });
  it("preserves a last-good ledger read-only after damage and recovers only explicitly", async () => {
    const f = await fixture();
    await f.controller.begin(song.id, randomUUID());
    f.saved.set(f.primary(), Buffer.from("damaged"));
    const reopened = historyFixture(historyDevice, f.saved);
    await reopened.controller.restore();
    expect(reopened.controller.view()).toMatchObject({
      state: "recovery-required",
      errorCode: "HISTORY_RECOVERY_REQUIRED",
    });
    expect(reopened.controller.count(song)).toBe(1);
    await expect(
      reopened.controller.begin(song.id, randomUUID()),
    ).rejects.toThrow("HISTORY_RECOVERY_REQUIRED");
    expect(f.saved.get(f.primary())?.toString()).toBe("damaged");
    await reopened.controller.execute({ type: "RECOVER" });
    expect(reopened.controller.view().state).toBe("ready");
    expect(
      [...f.saved.entries()]
        .find(([p]) => p.endsWith("recovery-original.json"))?.[1]
        .toString(),
    ).toBe("damaged");
    await reopened.controller.begin(song.id, randomUUID());
    expect(reopened.controller.count(song)).toBe(2);
  });
  it("requires explicit Clear when both copies are damaged and clears recoverable copies too", async () => {
    const f = await fixture();
    await f.controller.begin(song.id, randomUUID());
    for (const key of f.saved.keys()) f.saved.set(key, Buffer.from("damaged"));
    const reopened = historyFixture(historyDevice, f.saved);
    await reopened.controller.restore();
    expect(reopened.controller.view().errorCode).toBe("HISTORY_CORRUPT");
    await expect(
      reopened.controller.execute({ type: "RECOVER" }),
    ).rejects.toThrow("HISTORY_RECOVERY_UNAVAILABLE");
    await reopened.controller.execute({ type: "CLEAR" });
    expect(reopened.controller.count(song)).toBe(0);
    for (const bytes of f.saved.values())
      expect(decodeHistory(bytes, f.scope()).entries).toEqual([]);
  });
  it("bounds the ledger without evicting idempotency receipts or silently resetting counts", async () => {
    const f = await fixture(),
      record = emptyHistory(f.scope());
    record.entries = [
      {
        aliases: [song.id],
        count: 9,
        lastListenedAt: "2026-10-09T00:00:00.000Z",
        listenedSeconds: 0,
        lastPosition: 0,
      },
    ];
    record.receipts = Array.from({ length: HISTORY_MAX_RECEIPTS }, () => ({
      sessionId: randomUUID(),
      trackId: song.id,
    }));
    f.saved.set(f.primary(), encodeHistory(record));
    const reopened = historyFixture(historyDevice, f.saved);
    await reopened.controller.restore();
    await expect(
      reopened.controller.begin(song.id, randomUUID()),
    ).rejects.toThrow("HISTORY_CAPACITY_REACHED");
    expect(reopened.controller.count(song)).toBe(9);
    await expect(
      reopened.controller.reconcile(
        Array.from({ length: HISTORY_MAX_CATALOG + 1 }, (_, i) => ({
          id: `track-${i}`,
          title: "",
        })),
      ),
    ).rejects.toThrow("HISTORY_CAPACITY_REACHED");
  });
  it("rejects conflicting session identity, malformed events and arbitrary renderer data", async () => {
    const f = await fixture(),
      id = randomUUID();
    await f.controller.begin(song.id, id);
    await expect(f.controller.begin("other", id)).rejects.toThrow(
      "HISTORY_SESSION_CONFLICT",
    );
    await expect(f.controller.pulse(song.id, id, NaN, 1)).rejects.toThrow(
      "HISTORY_EVENT_INVALID",
    );
    await expect(f.controller.pulse("other", id, 0, 1)).rejects.toThrow(
      "HISTORY_SESSION_CONFLICT",
    );
    expect(() =>
      parseHistoryCommand({ type: "CLEAR", ownerUid: "other" }),
    ).toThrow();
    expect(() =>
      parseHistoryCommand(Object.create({ type: "CLEAR" })),
    ).toThrow();
    await f.controller.dispose();
    expect(() => f.controller.begin(song.id, randomUUID())).toThrow(
      "HISTORY_CLOSED",
    );
  });
});
