import { expect, it, vi } from "vitest";
import { DesktopMaintenanceGate } from "../src/main/maintenance-gate.js";
import { ConsumerUpdateLifecycle } from "../src/main/update/desktop-lifecycle.js";
import { createDesktopFleetRecoveryActivity } from "../src/main/fleet/desktop-maintenance.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const idle = vi.fn((_allowed: number) => true),
    reservation = { assertIdle: vi.fn(), release: vi.fn() },
    retire = vi.fn(async () => {}),
    changed = vi.fn(),
    reserve = vi.fn(() => reservation),
    gate = new DesktopMaintenanceGate({ idle, reserve, changed });
  return {
    gate,
    idle,
    reservation,
    retire,
    reserve,
    adapter: createDesktopFleetRecoveryActivity(gate, retire),
  };
}
it("reserves the real intake gate with exactly one accepted command and releases uncommitted maintenance normally", async () => {
  const f = fixture();
  const activity = await f.adapter.consumerActivity.acquire(
    "a",
    new AbortController().signal,
  );
  expect(f.idle).toHaveBeenCalledWith(1);
  expect(f.gate.reserved()).toBe(true);
  expect(f.adapter.ownsReservation()).toBe(true);
  await activity.release();
  expect(f.gate.reserved()).toBe(false);
  expect(f.adapter.ownsReservation()).toBe(false);
  expect(f.reservation.release).toHaveBeenCalledOnce();
  expect(f.retire).not.toHaveBeenCalled();
  f.adapter.finishCommitted();
});
it("rejects unrelated transactions and returns only the same real reservation for matching retries", async () => {
  const f = fixture(),
    a = await f.adapter.consumerActivity.acquire(
      "a",
      new AbortController().signal,
    );
  await expect(
    f.adapter.consumerActivity.acquire("b", new AbortController().signal),
  ).rejects.toThrow("UPDATE_BUSY");
  expect(
    await f.adapter.consumerActivity.acquire("a", new AbortController().signal),
  ).toBe(a);
  expect(f.reserve).toHaveBeenCalledOnce();
  await a.release();
});
it("retirement remains fenced until coordinator releases after journal clearance and explicit finish", async () => {
  const f = fixture(),
    a = await f.adapter.consumerActivity.acquire(
      "a",
      new AbortController().signal,
    );
  await f.adapter.commit();
  expect(f.retire).toHaveBeenCalledWith(f.reservation);
  expect(f.gate.reserved()).toBe(true);
  expect(() => f.adapter.finishCommitted()).toThrow(
    "UPDATE_FINALIZE_UNCONFIRMED",
  );
  await a.release();
  expect(f.gate.reserved()).toBe(true);
  expect(f.reservation.release).not.toHaveBeenCalled();
  f.adapter.finishCommitted();
  expect(f.gate.reserved()).toBe(false);
  expect(f.adapter.ownsReservation()).toBe(false);
  f.adapter.finishCommitted();
});
it("deduplicates asynchronous commit, refuses clearing pending retirement, and commits real gate only once", async () => {
  const f = fixture(),
    wait = deferred(),
    a = await f.adapter.consumerActivity.acquire(
      "a",
      new AbortController().signal,
    );
  f.retire.mockImplementationOnce(async () => {
    await wait.promise;
  });
  const one = f.adapter.commit(),
    two = f.adapter.commit();
  expect(two).toBe(one);
  await vi.waitFor(() => expect(f.retire).toHaveBeenCalledOnce());
  await a.release();
  expect(() => f.adapter.finishCommitted()).toThrow(
    "UPDATE_FINALIZE_UNCONFIRMED",
  );
  expect(f.gate.reserved()).toBe(true);
  wait.resolve();
  await one;
  await f.adapter.commit();
  expect(f.retire).toHaveBeenCalledOnce();
  f.adapter.finishCommitted();
  expect(f.gate.reserved()).toBe(false);
});
it("a failed/uncertain retirement keeps its exact gate and can retry the same transaction without erasing proof", async () => {
  const f = fixture(),
    a = await f.adapter.consumerActivity.acquire(
      "a",
      new AbortController().signal,
    );
  f.retire.mockRejectedValueOnce(Error("ACK_LOST"));
  await expect(f.adapter.commit()).rejects.toThrow("ACK_LOST");
  await a.release();
  expect(f.gate.reserved()).toBe(true);
  expect(f.reservation.release).not.toHaveBeenCalled();
  expect(() => f.adapter.finishCommitted()).toThrow(
    "UPDATE_FINALIZE_UNCONFIRMED",
  );
  await expect(
    f.adapter.consumerActivity.acquire("b", new AbortController().signal),
  ).rejects.toThrow("UPDATE_BUSY");
  expect(
    await f.adapter.consumerActivity.acquire("a", new AbortController().signal),
  ).toBe(a);
  await f.adapter.commit();
  expect(f.retire).toHaveBeenCalledTimes(2);
  expect(() => f.adapter.finishCommitted()).toThrow(
    "UPDATE_FINALIZE_UNCONFIRMED",
  );
  await a.release();
  f.adapter.finishCommitted();
  expect(f.gate.reserved()).toBe(false);
});
it("a consumer becoming busy before commit remains fenced until a genuine later idle retirement", async () => {
  const f = fixture(),
    a = await f.adapter.consumerActivity.acquire(
      "a",
      new AbortController().signal,
    );
  f.idle.mockReturnValue(false);
  await expect(f.adapter.commit()).rejects.toThrow("UPDATE_BUSY");
  await a.release();
  expect(f.gate.reserved()).toBe(true);
  expect(f.retire).not.toHaveBeenCalled();
  expect(() => f.adapter.finishCommitted()).toThrow(
    "UPDATE_FINALIZE_UNCONFIRMED",
  );
  f.idle.mockReturnValue(true);
  await f.adapter.commit();
  f.adapter.finishCommitted();
  expect(f.retire).toHaveBeenCalledOnce();
});
it("busy or aborted acquisition cannot fabricate a held activity lease", async () => {
  const f = fixture();
  f.idle.mockReturnValue(false);
  await expect(
    f.adapter.consumerActivity.acquire("a", new AbortController().signal),
  ).rejects.toThrow("UPDATE_BUSY");
  expect(f.adapter.ownsReservation()).toBe(false);
  expect(f.gate.reserved()).toBe(false);
  f.idle.mockReturnValue(true);
  const abort = new AbortController();
  abort.abort();
  await expect(
    f.adapter.consumerActivity.acquire("a", abort.signal),
  ).rejects.toThrow();
  expect(f.gate.reserved()).toBe(false);
  await expect(f.adapter.commit()).rejects.toThrow(
    "UPDATE_FINALIZE_UNCONFIRMED",
  );
});
it("a stale adapter cannot finish or release another transaction's real gate", async () => {
  const f = fixture(),
    a = await f.adapter.consumerActivity.acquire(
      "a",
      new AbortController().signal,
    );
  await f.adapter.commit();
  f.gate.finishCommitted();
  await f.gate.acquire("b", 1, new AbortController().signal, async () => {});
  expect(f.adapter.ownsReservation()).toBe(false);
  await expect(a.release()).rejects.toThrow("UPDATE_FINALIZE_UNCONFIRMED");
  expect(() => f.adapter.finishCommitted()).toThrow(
    "UPDATE_FINALIZE_UNCONFIRMED",
  );
  expect(f.gate.matches("b")).toBe(true);
});
it("actual command/settlement lifecycle never clears the committed gate while coordinator work still runs", async () => {
  const f = fixture(),
    lifecycle = new ConsumerUpdateLifecycle(),
    journal = deferred(),
    events: string[] = [];
  let hasJournal = true;
  const command = lifecycle.execute(async () => {
    const a = await f.adapter.consumerActivity.acquire(
      "a",
      new AbortController().signal,
    );
    await f.adapter.commit();
    events.push("retired");
    await journal.promise;
    hasJournal = false;
    events.push("journal:cleared");
    await a.release();
  });
  await vi.waitFor(() => expect(events).toEqual(["retired"]));
  const settlement = lifecycle.settle(async () => {
    expect(hasJournal).toBe(false);
    expect(lifecycle.commandActive()).toBe(false);
    f.adapter.finishCommitted();
    events.push("rebound");
  });
  await Promise.resolve();
  expect(lifecycle.busy()).toBe(true);
  expect(f.gate.reserved()).toBe(true);
  expect(events).toEqual(["retired"]);
  journal.resolve();
  await command;
  await settlement;
  expect(events).toEqual(["retired", "journal:cleared", "rebound"]);
  expect(lifecycle.busy()).toBe(false);
  expect(f.gate.reserved()).toBe(false);
});
