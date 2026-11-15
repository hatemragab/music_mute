import { expect, it, vi } from "vitest";
import { SessionPreparationGate } from "../src/main/session/preparation-gate.js";
import type { ConsumerMutexLease } from "../../worker/src/platform/windows/consumer-native.js";
const lease: ConsumerMutexLease = {
  scope: "prepare",
  nonce: "a".repeat(64),
  abandoned: false,
  identity: {
    pid: 10,
    creationTime: "133700000000000",
    sid: "S-1-5-21-1-2-3-1001",
    sessionId: 1,
  },
};
function fixture() {
  const native = {
    acquireMutex: vi.fn(async () => lease as ConsumerMutexLease | null),
    releaseMutex: vi.fn(async () => {}),
    vaultRead: vi.fn(async () => null as Buffer | null),
  };
  return { native, gate: new SessionPreparationGate(native) };
}
it("held Prepare denies cold startup before any role/config action; cleared gate stays cheap and lease covers startup", async () => {
  const f = fixture();
  f.native.acquireMutex.mockResolvedValueOnce(null);
  await expect(f.gate.beginStartup()).rejects.toThrow("UPDATE_BUSY");
  expect(f.native.vaultRead).not.toHaveBeenCalled();
  await f.gate.beginStartup();
  const action = vi.fn(async () => "owned");
  expect(await f.gate.launch(action)).toBe("owned");
  expect(f.native.acquireMutex).toHaveBeenCalledTimes(2);
  expect(f.native.releaseMutex).not.toHaveBeenCalled();
  await f.gate.completeStartup();
  expect(f.native.releaseMutex).toHaveBeenCalledExactlyOnceWith(lease);
});
it.each([
  "malformed",
  JSON.stringify({ phase: "retiring" }),
  JSON.stringify({ phase: "retired" }),
  "",
])(
  "any retained/malformed mutation WAL fences startup and zeroes read bytes (%s)",
  async (value) => {
    const f = fixture(),
      bytes = Buffer.from(value);
    f.native.vaultRead.mockResolvedValueOnce(bytes);
    await expect(f.gate.beginStartup()).rejects.toThrow("UPDATE_BUSY");
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(f.native.releaseMutex).toHaveBeenCalledExactlyOnceWith(lease);
  },
);
it("new-role launches after startup hold an actual Prepare mutex through the exact launch and recheck WAL", async () => {
  const f = fixture();
  await f.gate.beginStartup();
  await f.gate.completeStartup();
  let finish!: (v: string) => void;
  const action = vi.fn(
    () =>
      new Promise<string>((r) => {
        finish = r;
      }),
  );
  const launch = f.gate.launch(action);
  await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
  expect(f.native.releaseMutex).toHaveBeenCalledTimes(1);
  finish("owned");
  expect(await launch).toBe("owned");
  expect(f.native.releaseMutex).toHaveBeenCalledTimes(2);
  f.native.vaultRead.mockResolvedValueOnce(Buffer.from("retained WAL"));
  await expect(f.gate.launch(action)).rejects.toThrow("UPDATE_BUSY");
  expect(action).toHaveBeenCalledOnce();
});
it("release uncertainty stays a rejected startup fence and cannot be called completed", async () => {
  const f = fixture();
  await f.gate.beginStartup();
  f.native.releaseMutex.mockRejectedValueOnce(new Error("ACK_LOST"));
  await expect(f.gate.completeStartup()).rejects.toThrow("ACK_LOST");
  await f.gate.completeStartup();
  expect(f.native.releaseMutex).toHaveBeenCalledTimes(2);
});
