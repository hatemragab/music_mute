import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { GpuBrokerBank } from "../src/main/admission/broker-bank.js";
import { personalPeer, personalGpu } from "./personal-fixtures.js";
function fixture() {
  const values = new Map<string, Buffer>(),
    owner = {
      role: "personal" as const,
      nonce: "a".repeat(64),
      identity: personalPeer,
    },
    state = {
      version: 1,
      sid: personalPeer.sid,
      gpuLuid: personalGpu.luid,
      active: {
        nonce: "b".repeat(64),
        request: {
          requestId: randomUUID(),
          generation: randomUUID(),
          kind: "personal",
          owner,
          peer: { ...personalPeer, pid: 101 },
          gpu: personalGpu,
        },
      },
    },
    native = {
      vaultRead: async (_namespace: string, key: string) =>
        values.has(key) ? Buffer.from(values.get(key)!) : null,
      vaultWrite: vi.fn(
        async (_namespace: string, key: string, bytes: Buffer) => {
          values.set(key, Buffer.from(bytes));
        },
      ),
      vaultDelete: vi.fn(async (_namespace: string, key: string) => {
        values.delete(key);
      }),
      ownedTreeExited: vi.fn(async (actual: typeof owner) => {
        expect(actual).toEqual(owner);
        return false;
      }),
    };
  return {
    values,
    state,
    owner,
    native,
    open: () => new GpuBrokerBank(native, personalPeer.sid),
  };
}
it("legacy active ownership requires the exact positive whole-Job certificate before migration; failed/unknown proof is not capacity", async () => {
  const f = fixture();
  f.values.set("gpu_broker_state", Buffer.from(JSON.stringify(f.state)));
  const bank = f.open();
  await expect(bank.start()).rejects.toThrow("GPU_CHILDREN_STILL_ACTIVE");
  expect(f.native.vaultDelete).not.toHaveBeenCalled();
  f.native.ownedTreeExited.mockRejectedValueOnce(new Error("JOB_UNKNOWN"));
  await expect(bank.start()).rejects.toThrow("JOB_UNKNOWN");
  f.native.ownedTreeExited.mockResolvedValue(true);
  await bank.start();
  expect(f.values.has("gpu_broker_state")).toBe(false);
  expect(
    JSON.parse(f.values.get("gpu_broker_index")!.toString()).entries,
  ).toEqual([]);
});
it("lost retirement-delete ACK recovers from the protected exact before-effect receipt, not absence guesses", async () => {
  const f = fixture();
  f.values.set("gpu_broker_state", Buffer.from(JSON.stringify(f.state)));
  f.native.ownedTreeExited.mockResolvedValue(true);
  f.native.vaultDelete.mockImplementationOnce(async (_namespace, key) => {
    f.values.delete(key);
    throw new Error("DELETE_ACK_LOST");
  });
  await expect(f.open().start()).rejects.toThrow("DELETE_ACK_LOST");
  expect(
    JSON.parse(f.values.get("gpu_broker_index")!.toString()).legacy.owner,
  ).toEqual(f.owner);
  f.native.ownedTreeExited.mockResolvedValue(false);
  await expect(f.open().start()).rejects.toThrow("GPU_CHILDREN_STILL_ACTIVE");
  f.native.ownedTreeExited.mockResolvedValue(true);
  await f.open().start();
  expect(
    JSON.parse(f.values.get("gpu_broker_index")!.toString()).legacy,
  ).toBeNull();
});
it("ready-slot absence, unknown fields and duplicate slots cannot silently reset prior authority", async () => {
  const f = fixture();
  for (const index of [
    {
      version: 1,
      sid: personalPeer.sid,
      entries: [{ luid: personalGpu.luid, phase: "ready", retirement: null }],
      legacy: null,
    },
    {
      version: 1,
      sid: personalPeer.sid,
      entries: [],
      legacy: null,
      arbitraryKey: "secret",
    },
    {
      version: 1,
      sid: personalPeer.sid,
      entries: Array.from({ length: 2 }, () => ({
        luid: personalGpu.luid,
        phase: "opening",
        retirement: null,
      })),
      legacy: null,
    },
  ]) {
    f.values.set("gpu_broker_index", Buffer.from(JSON.stringify(index)));
    await expect(f.open().start()).rejects.toThrow("RESERVATION_INVALID");
  }
  expect(f.native.vaultDelete).not.toHaveBeenCalled();
});
it("slots are fixed, bounded16 and recorded before creation; no extra slot can appear during failed opening", async () => {
  const f = fixture(),
    bank = f.open();
  await bank.start();
  for (let i = 0; i < 16; i++) {
    const luid = i.toString(16).padStart(16, "0");
    await bank.open(luid, async (key) => {
      expect(
        JSON.parse(f.values.get("gpu_broker_index")!.toString()).entries.at(-1),
      ).toMatchObject({ luid, phase: "opening" });
      const idle = { ...f.state, gpuLuid: luid, active: null };
      f.values.set(key, Buffer.from(JSON.stringify(idle)));
      return key;
    });
  }
  await expect(bank.open("f".repeat(16), async () => "unsafe")).rejects.toThrow(
    "GPU_BUSY",
  );
  expect(f.values.size).toBe(17);
  await f.open().start();
  expect(f.values.size).toBe(1);
  expect(f.native.ownedTreeExited).not.toHaveBeenCalled();
});
