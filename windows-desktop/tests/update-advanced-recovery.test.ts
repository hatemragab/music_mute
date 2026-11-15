import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { authorizeAdvancedUpdateRecovery } from "../src/main/update/advanced-recovery.js";

const receipt = {
  transaction: randomUUID(),
  machineId: randomUUID(),
  authority: "a".repeat(64),
  source: "catalog" as const,
};
function fixture() {
  return {
    command: {
      type: "FLEET_ADVANCED" as const,
      command: { type: "RECOVER" as const },
    },
    advanced: { pendingUpdateRecovery: vi.fn(async () => receipt) },
    updater: { matchesAdvancedRecovery: vi.fn(async () => true) },
    current: vi.fn(() => true),
    signal: new AbortController().signal,
  };
}
it("allows only matching protected update recovery through already existing services", async () => {
  const f = fixture();
  expect(await authorizeAdvancedUpdateRecovery(f)).toBe(true);
  expect(f.updater.matchesAdvancedRecovery).toHaveBeenCalledExactlyOnceWith(
    receipt,
  );
});
it("cannot use a read/force command or an absent existing service to enter the recovery exception", async () => {
  const f = fixture();
  expect(
    await authorizeAdvancedUpdateRecovery({
      ...f,
      command: { type: "GET_SNAPSHOT" },
    }),
  ).toBe(false);
  const { advanced: _advanced, ...absent } = f;
  expect(await authorizeAdvancedUpdateRecovery(absent)).toBe(false);
  expect(f.advanced.pendingUpdateRecovery).not.toHaveBeenCalled();
  expect(f.updater.matchesAdvancedRecovery).not.toHaveBeenCalled();
});
it("rejects a replaced window/controller while its private receipt read is pending", async () => {
  const f = fixture();
  let resolve!: (value: typeof receipt) => void,
    current = true;
  f.current.mockImplementation(() => current);
  f.advanced.pendingUpdateRecovery.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const check = authorizeAdvancedUpdateRecovery(f);
  current = false;
  resolve(receipt);
  expect(await check).toBe(false);
  expect(f.updater.matchesAdvancedRecovery).not.toHaveBeenCalled();
});
it("rejects abort, mismatched source/owner proof and failed protected reads", async () => {
  const f = fixture();
  f.updater.matchesAdvancedRecovery.mockResolvedValue(false);
  expect(await authorizeAdvancedUpdateRecovery(f)).toBe(false);
  f.advanced.pendingUpdateRecovery.mockRejectedValue(
    new Error("private proof failure"),
  );
  expect(await authorizeAdvancedUpdateRecovery(f)).toBe(false);
  const abort = new AbortController();
  abort.abort();
  const fresh = fixture();
  expect(
    await authorizeAdvancedUpdateRecovery({ ...fresh, signal: abort.signal }),
  ).toBe(false);
  expect(fresh.advanced.pendingUpdateRecovery).not.toHaveBeenCalled();
});
