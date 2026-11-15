import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  parseStoreFleetAttemptExpectation,
  parseStoreFleetAttemptState,
} from "../src/shared/store-fleet-workspace.js";

// Receiving observations only: these values create no original native row,
// directory handle, Job/EOF certificate, cleanup right or GPU authority.
function observation() {
  return {
    version: 1,
    distribution: "microsoft-store",
    kind: "fleet-attempt",
    attemptId: randomUUID(),
    token: "a".repeat(64),
    inventorySha256: "b".repeat(64),
    runtimeManifestSha256: "c".repeat(64),
    nodeOwner: {
      role: "fleet",
      nonce: "d".repeat(64),
      identity: {
        sid: "S-1-5-21-1-2-3-1001",
        sessionId: 1,
        pid: 400,
        creationTime: "133900000000000000",
      },
    },
    directoryBirth: {
      device: "1",
      file_id: "2",
      born_at: "133900000000000001",
    },
  };
}
it("snapshots and freezes the full original-row observation without accepting caller aliases", () => {
  const raw = observation(),
    snapshot = structuredClone(raw),
    parsed = parseStoreFleetAttemptExpectation(raw);
  expect(parsed).toEqual(snapshot);
  expect(parsed).not.toBe(raw);
  expect(parsed.nodeOwner).not.toBe(raw.nodeOwner);
  expect(parsed.nodeOwner.identity).not.toBe(raw.nodeOwner.identity);
  raw.token = "e".repeat(64);
  raw.nodeOwner.identity.pid = 999;
  raw.directoryBirth.file_id = "9";
  expect(parsed).toEqual(snapshot);
  for (const object of [
    parsed,
    parsed.nodeOwner,
    parsed.nodeOwner.identity,
    parsed.directoryBirth,
  ])
    expect(Object.isFrozen(object)).toBe(true);
});
it("requires every exact top-level field and rejects extra, hidden or non-data fields", () => {
  const raw = observation();
  for (const key of Object.keys(raw)) {
    const missing = { ...raw };
    delete missing[key as keyof typeof raw];
    expect(() => parseStoreFleetAttemptExpectation(missing)).toThrow(
      "STORE_FLEET_WORKSPACE_INVALID",
    );
  }
  for (const changed of [
    { ...raw, ready: true },
    { ...raw, [Symbol("authority")]: true },
    Object.assign(Object.create({ authority: true }), raw),
  ])
    expect(() => parseStoreFleetAttemptExpectation(changed)).toThrow();
  const getter = vi.fn(() => raw.nodeOwner),
    accessor = { ...raw };
  Object.defineProperty(accessor, "nodeOwner", {
    enumerable: true,
    get: getter,
  });
  expect(() => parseStoreFleetAttemptExpectation(accessor)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each([
  ["version", true],
  ["distribution", "legacy"],
  ["kind", "cpu-tools"],
  ["attemptId", "not-an-id"],
  ["token", "A".repeat(64)],
  ["token", null],
  ["inventorySha256", "x".repeat(64)],
  ["runtimeManifestSha256", "a".repeat(63)],
] as const)("denies invalid %s=%j", (key, value) => {
  expect(() =>
    parseStoreFleetAttemptExpectation({ ...observation(), [key]: value }),
  ).toThrow("STORE_FLEET_WORKSPACE_INVALID");
});
it.each([{ role: "prepare" }, { nonce: "invalid" }, { native: true }])(
  "rejects incomplete or foreign owner metadata %j",
  (change) => {
    const raw = observation();
    expect(() =>
      parseStoreFleetAttemptExpectation({
        ...raw,
        nodeOwner: { ...raw.nodeOwner, ...change },
      }),
    ).toThrow();
  },
);
it.each([
  { sid: "S-1-5-18" },
  { sessionId: 0 },
  { pid: 0 },
  { pid: 1.5 },
  { creationTime: "0" },
  { creationTime: "18446744073709551616" },
  { extra: true },
])("rejects incomplete or unbound process identity %j", (change) => {
  const raw = observation();
  expect(() =>
    parseStoreFleetAttemptExpectation({
      ...raw,
      nodeOwner: {
        ...raw.nodeOwner,
        identity: { ...raw.nodeOwner.identity, ...change },
      },
    }),
  ).toThrow();
});
it.each(["device", "file_id", "born_at"] as const)(
  "requires canonical uint64 directory %s",
  (key) => {
    const raw = observation();
    for (const value of [
      "",
      "01",
      "-1",
      "1.5",
      "18446744073709551616",
      1,
      null,
    ])
      expect(() =>
        parseStoreFleetAttemptExpectation({
          ...raw,
          directoryBirth: { ...raw.directoryBirth, [key]: value },
        }),
      ).toThrow();
    expect(
      parseStoreFleetAttemptExpectation({
        ...raw,
        directoryBirth: {
          ...raw.directoryBirth,
          [key]: "18446744073709551615",
        },
      }).directoryBirth[key],
    ).toBe("18446744073709551615");
  },
);
it("rejects zero file identity, extra/missing directory fields and nested accessors", () => {
  const raw = observation();
  for (const directoryBirth of [
    { ...raw.directoryBirth, file_id: "0" },
    { device: "1", file_id: "2" },
    { ...raw.directoryBirth, linkCount: 1 },
  ])
    expect(() =>
      parseStoreFleetAttemptExpectation({ ...raw, directoryBirth }),
    ).toThrow();
  const getter = vi.fn(() => "2"),
    directoryBirth = { ...raw.directoryBirth };
  Object.defineProperty(directoryBirth, "file_id", {
    enumerable: true,
    get: getter,
  });
  expect(() =>
    parseStoreFleetAttemptExpectation({ ...raw, directoryBirth }),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each([
  { quiescent: false, retired: false },
  { quiescent: true, retired: false },
  { quiescent: true, retired: true },
])("receives coherent original-row state %j as observations only", (row) => {
  const parsed = parseStoreFleetAttemptState(row);
  expect(parsed).toEqual(row);
  expect(parsed).not.toBe(row);
  expect(Object.isFrozen(parsed)).toBe(true);
});
it.each([
  { quiescent: false, retired: true },
  { quiescent: true },
  { retired: true },
  { quiescent: 1, retired: false },
  { quiescent: true, retired: null },
  { quiescent: true, retired: true, job: "confirmed" },
])("rejects contradictory or forged state %j", (row) => {
  expect(() => parseStoreFleetAttemptState(row)).toThrow(
    "STORE_FLEET_WORKSPACE_INVALID",
  );
});
