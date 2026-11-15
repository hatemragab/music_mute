import { expect, it, vi } from "vitest";
import {
  VaultFleetStore,
  fleetRecordAuthority,
  parseFleetRecord,
  parseFleetPurgedTombstone,
} from "../src/main/fleet/store.js";
import { record, fleetSid, fleetOrigin, fleetNow } from "./fleet-fixtures.js";
import type { ConsumerMutexLease } from "../../worker/src/platform/windows/consumer-native.js";
function fixture() {
  const original = record(),
    authority = fleetRecordAuthority(original),
    data = new Map<string, Buffer>([
      ["enrollment", Buffer.from(JSON.stringify(original))],
    ]),
    writes: string[] = [],
    lease = {
      scope: "cache",
      nonce: "a".repeat(64),
      abandoned: false,
      identity: {
        sid: fleetSid,
        sessionId: 1,
        pid: 123,
        creationTime: "133000000000000000",
      },
    } as ConsumerMutexLease,
    native = {
      vaultRead: vi.fn(async (_ns: string, key: string) =>
        data.has(key) ? Buffer.from(data.get(key)!) : null,
      ),
      vaultWrite: vi.fn(async (_ns: string, key: string, bytes: Buffer) => {
        writes.push(key);
        data.set(key, Buffer.from(bytes));
      }),
      vaultDelete: vi.fn(async (_ns: string, key: string) => {
        data.delete(key);
      }),
      acquireMutex: vi.fn(async () => lease),
      releaseMutex: vi.fn(async () => {}),
    };
  const receipt = {
    version: 1,
    machineId: original.machineId,
    authority,
    confirmedAt: new Date(fleetNow).toISOString(),
    revision: 3,
  };
  return {
    original,
    authority,
    receipt,
    data,
    writes,
    native,
    store: new VaultFleetStore(native, fleetSid, fleetOrigin),
  };
}
it("exact confirmed backend receipt retires every token while stable noncredential authority preserves recovery", async () => {
  const f = fixture();
  f.data.set("confirmed_unpair", Buffer.from(JSON.stringify(f.receipt)));
  for (const key of [
    "capacity",
    "active_runtime",
    "fleet_ticket",
    "child_bootstrap",
  ])
    f.data.set(key, Buffer.from("stale"));
  const retired = await f.store.retireIfCurrent(f.authority);
  expect(retired).toMatchObject({
    phase: "revoked",
    machineCredential: null,
    enrollmentCredential: null,
    installationCredential: null,
    retiredAuthority: f.authority,
    machineId: f.original.machineId,
    workerId: f.original.workerId,
  });
  expect(fleetRecordAuthority(retired)).toBe(f.authority);
  expect(await f.store.read()).toEqual(retired);
  expect(f.native.vaultDelete).toHaveBeenCalledTimes(4);
  expect(f.native.releaseMutex).toHaveBeenCalledOnce();
  expect(
    f.data.get("enrollment")!.includes(f.original.machineCredential!),
  ).toBe(false);
});
it("missing or foreign acknowledgement cannot erase usable credential state", async () => {
  for (const receipt of [
    null,
    { machineId: "10000000-0000-4000-8000-000000000001" },
    { authority: "f".repeat(64) },
  ]) {
    const f = fixture();
    if (receipt)
      f.data.set(
        "confirmed_unpair",
        Buffer.from(JSON.stringify({ ...f.receipt, ...receipt })),
      );
    await expect(f.store.retireIfCurrent(f.authority)).rejects.toThrow(
      "ADVANCED_REVOCATION_UNCONFIRMED",
    );
    expect((await f.store.read())!.machineCredential).toBe(
      f.original.machineCredential,
    );
    expect(f.writes).toEqual([]);
    expect(f.native.vaultDelete).not.toHaveBeenCalled();
  }
});
it("persistence failure preserves original tokens and confirmed receipt for explicit safe recovery", async () => {
  const f = fixture();
  f.data.set("confirmed_unpair", Buffer.from(JSON.stringify(f.receipt)));
  f.native.vaultWrite.mockRejectedValueOnce(new Error("DPAPI_WRITE_FAILED"));
  await expect(f.store.retireIfCurrent(f.authority)).rejects.toThrow(
    "DPAPI_WRITE_FAILED",
  );
  expect((await f.store.read())!.machineCredential).toBe(
    f.original.machineCredential,
  );
  expect(JSON.parse(f.data.get("confirmed_unpair")!.toString())).toEqual(
    f.receipt,
  );
  await f.store.retireIfCurrent(f.authority);
  expect((await f.store.read())!.machineCredential).toBeNull();
});
it("replacement credential after unpair response is never adopted or erased by old retirement", async () => {
  const f = fixture(),
    replacement = {
      ...f.original,
      machineCredential: "z".repeat(43),
      credentialRevision: 2,
    };
  f.data.set("enrollment", Buffer.from(JSON.stringify(replacement)));
  f.data.set("confirmed_unpair", Buffer.from(JSON.stringify(f.receipt)));
  await expect(f.store.retireIfCurrent(f.authority)).rejects.toThrow(
    "ADVANCED_MACHINE_CHANGED",
  );
  expect(await f.store.read()).toEqual(replacement);
  expect(f.native.vaultDelete).not.toHaveBeenCalled();
});
it("cleanup failure after null-token commit retries stale private authority cleanup without resurrecting credentials", async () => {
  const f = fixture();
  f.data.set("confirmed_unpair", Buffer.from(JSON.stringify(f.receipt)));
  f.native.vaultDelete.mockRejectedValueOnce(new Error("DPAPI_BUSY"));
  await expect(f.store.retireIfCurrent(f.authority)).rejects.toThrow(
    "DPAPI_BUSY",
  );
  expect((await f.store.read())!.machineCredential).toBeNull();
  const writes = f.writes.length;
  await f.store.retireIfCurrent(f.authority);
  expect(f.writes).toHaveLength(writes);
  expect(f.native.vaultDelete).toHaveBeenCalledTimes(5);
});
it("retired authority cannot override active credential identity and purge tombstone carries no tokens or user UID", () => {
  const f = fixture();
  for (const value of [
    { ...f.original, retiredAuthority: f.authority },
    {
      ...f.original,
      phase: "revoked",
      machineCredential: null,
      enrollmentCredential: null,
      installationCredential: null,
    },
  ])
    expect(() => parseFleetRecord(value, fleetSid)).toThrow(
      "FLEET_STATE_CORRUPT",
    );
  const tombstone = {
    version: 1,
    sid: fleetSid,
    machineId: f.original.machineId!,
    workerId: f.original.workerId,
    onboardingRevision: 1,
    authority: f.authority,
    purgedAt: new Date(fleetNow).toISOString(),
  };
  expect(parseFleetPurgedTombstone(tombstone, fleetSid)).toEqual(tombstone);
  expect(() =>
    parseFleetPurgedTombstone(
      { ...tombstone, machineCredential: "secret" },
      fleetSid,
    ),
  ).toThrow("FLEET_STATE_CORRUPT");
});
