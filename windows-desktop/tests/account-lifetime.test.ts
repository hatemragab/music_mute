import { afterEach, expect, it, vi } from "vitest";
import { AccountAuthorityLifetime } from "../src/main/account-lifetime.js";
afterEach(() => {
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  let headless = true,
    idle = true;
  const reservation = { assertIdle: vi.fn(), release: vi.fn() },
    reserve = vi.fn(() => reservation),
    retire = vi.fn();
  const lifetime = new AccountAuthorityLifetime({
    headless: () => headless,
    idle: () => idle,
    reserve,
    retire,
    graceMs: 50,
  });
  return {
    lifetime,
    reservation,
    reserve,
    retire,
    ui: () => {
      headless = false;
      lifetime.changed();
    },
    busy: () => {
      idle = false;
      lifetime.changed();
    },
    idle: () => {
      idle = true;
      lifetime.changed();
    },
  };
}
it("retains a cold headless authority through its startup grace and atomically reserves before retirement", async () => {
  const f = fixture();
  f.lifetime.changed();
  await vi.advanceTimersByTimeAsync(49);
  expect(f.reserve).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.reservation.assertIdle).toHaveBeenCalledOnce();
  expect(f.retire).toHaveBeenCalledWith(f.reservation);
  f.lifetime.changed();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.retire).toHaveBeenCalledOnce();
});
it("keeps actual jobs, grants and pending acknowledgements alive and starts a new grace after idle", async () => {
  const f = fixture();
  f.lifetime.changed();
  await vi.advanceTimersByTimeAsync(25);
  f.busy();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.retire).not.toHaveBeenCalled();
  f.idle();
  await vi.advanceTimersByTimeAsync(50);
  expect(f.retire).toHaveBeenCalledOnce();
});
it("cancels retirement when the UI reopens without creating another account authority", async () => {
  const f = fixture();
  f.lifetime.changed();
  f.ui();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.reserve).not.toHaveBeenCalled();
});
it("does not retire on a raced idle observation or failed real authority proof", async () => {
  const f = fixture();
  f.reservation.assertIdle.mockImplementation(() => {
    throw new Error("ACCOUNT_AUTHORITY_BUSY");
  });
  f.lifetime.changed();
  await vi.advanceTimersByTimeAsync(50);
  expect(f.retire).not.toHaveBeenCalled();
  expect(f.reservation.release).toHaveBeenCalledOnce();
});
it("releases the exact reservation if a visible window arrives during reservation", async () => {
  const f = fixture();
  f.reserve.mockImplementation(() => {
    f.ui();
    return f.reservation;
  });
  f.lifetime.changed();
  await vi.advanceTimersByTimeAsync(50);
  expect(f.retire).not.toHaveBeenCalled();
  expect(f.reservation.release).toHaveBeenCalledOnce();
});
it("has no polling callback after explicit closure", async () => {
  const f = fixture();
  f.lifetime.changed();
  f.lifetime.close();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.reserve).not.toHaveBeenCalled();
  f.lifetime.changed();
  expect(vi.getTimerCount()).toBe(0);
});
