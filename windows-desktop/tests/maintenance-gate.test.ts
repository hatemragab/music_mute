import { expect, it, vi } from "vitest";
import { DesktopMaintenanceGate } from "../src/main/maintenance-gate.js";
function fixture() {
  let idle = true;
  const reservation = { assertIdle: vi.fn(), release: vi.fn() },
    retire = vi.fn(async () => {}),
    changed = vi.fn(),
    gate = new DesktopMaintenanceGate({
      idle: () => idle,
      reserve: () => reservation,
      changed,
    });
  return {
    gate,
    reservation,
    retire,
    changed,
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}
it("reserves intake before idle proof and keeps it fenced through the actual command settlement", async () => {
  const f = fixture(),
    lease = await f.gate.acquire(
      "transaction",
      1,
      new AbortController().signal,
      f.retire,
    );
  expect(f.gate.reserved()).toBe(true);
  await lease.commit();
  expect(f.retire).toHaveBeenCalledWith(f.reservation);
  expect(f.gate.reserved()).toBe(true);
  f.gate.finishCommitted();
  expect(f.gate.reserved()).toBe(false);
  expect(f.reservation.release).not.toHaveBeenCalled();
});
it("restores the same intake reservation when ordinary busy admission or cancellation fails", async () => {
  const f = fixture();
  f.setIdle(false);
  await expect(
    f.gate.acquire("a", 0, new AbortController().signal, f.retire),
  ).rejects.toThrow("UPDATE_BUSY");
  expect(f.gate.reserved()).toBe(false);
  expect(f.reservation.release).toHaveBeenCalledOnce();
  f.setIdle(true);
  const lease = await f.gate.acquire(
    "b",
    0,
    new AbortController().signal,
    f.retire,
  );
  await lease.release();
  expect(f.gate.reserved()).toBe(false);
});
it("blocks an unrelated transaction and rechecks changing real consumers before commit", async () => {
  const f = fixture(),
    lease = await f.gate.acquire(
      "a",
      1,
      new AbortController().signal,
      f.retire,
    );
  await expect(
    f.gate.acquire("b", 1, new AbortController().signal, f.retire),
  ).rejects.toThrow("UPDATE_BUSY");
  f.setIdle(false);
  await expect(lease.commit()).rejects.toThrow("UPDATE_BUSY");
  expect(f.retire).not.toHaveBeenCalled();
  await lease.release();
});
it("does not reopen intake or pretend to roll back after uncertain native retirement", async () => {
  const f = fixture();
  f.retire.mockRejectedValueOnce(new Error("ACK_LOST"));
  const lease = await f.gate.acquire(
    "a",
    0,
    new AbortController().signal,
    f.retire,
  );
  await expect(lease.commit()).rejects.toThrow("ACK_LOST");
  await expect(lease.release()).rejects.toThrow("UPDATE_FINALIZE_UNCONFIRMED");
  f.gate.finishCommitted();
  expect(f.gate.reserved()).toBe(true);
  expect(
    await f.gate.acquire("a", 0, new AbortController().signal, f.retire),
  ).toBe(lease);
  await lease.commit();
  f.gate.finishCommitted();
  expect(f.gate.reserved()).toBe(false);
});
