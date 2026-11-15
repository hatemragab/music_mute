import { describe, expect, it, vi } from "vitest";
import {
  parseStoreFleetOwnerObservation,
  parseStoreFleetPeerObservation,
} from "../src/shared/store-fleet-control.js";

// Synthetic receiving data only; no OS package, retained native handle,
// original Job, processing admission or Ready capability is constructed.
const inventorySha256 = "a".repeat(64),
  owner = {
    role: "fleet",
    nonce: "b".repeat(64),
    identity: {
      sid: "S-1-5-21-1-2-3-1000",
      sessionId: 1,
      pid: 345,
      creationTime: "133000000000000000",
    },
  },
  observation = { version: 1, inventorySha256, owner },
  denied = "STORE_FLEET_CONTROL_INVALID";
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("Store Fleet owner observation receiving", () => {
  it("receives and deeply freezes the exact Fleet process observation", () => {
    const received = parseStoreFleetOwnerObservation(
      bytes(observation),
      inventorySha256,
    );
    expect(received).toEqual(observation);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received.owner)).toBe(true);
    expect(Object.isFrozen(received.owner?.identity)).toBe(true);
    expect(() =>
      Object.assign(received.owner!.identity, { pid: 346 }),
    ).toThrow();
    expect(
      parseStoreFleetOwnerObservation(bytes(received), inventorySha256),
    ).toEqual(received);
  });
  it("receives only explicit null as missing-row data for the same code generation", () => {
    const value = { version: 1, inventorySha256, owner: null };
    expect(
      parseStoreFleetOwnerObservation(bytes(value), inventorySha256),
    ).toEqual(value);
    expect(() =>
      parseStoreFleetOwnerObservation(bytes(value), "c".repeat(64)),
    ).toThrow(denied);
    for (const missing of [
      { version: 1, inventorySha256 },
      { ...value, owner: false },
      { ...value, owner: {} },
    ])
      expect(() =>
        parseStoreFleetOwnerObservation(bytes(missing), inventorySha256),
      ).toThrow(denied);
  });
  it("preserves the complete original process birth and validated current-user SID alternatives", () => {
    const identity = {
      sid: "S-1-12-1-1-2-3-1000",
      sessionId: 0xffffffff,
      pid: 2147483647,
      creationTime: "18446744073709551615",
    };
    const received = parseStoreFleetOwnerObservation(
      bytes({ ...observation, owner: { ...owner, identity } }),
      inventorySha256,
    );
    expect(received.owner?.identity).toEqual(identity);
    expect(received.owner?.nonce).toBe(owner.nonce);
  });
  it.each([
    { role: "personal" },
    { role: "prepare" },
    { role: "session-agent" },
    { role: "Fleet" },
    { nonce: "b".repeat(63) },
    { nonce: "B".repeat(64) },
    { nonce: null },
    { job: "confirmed" },
    { ready: true },
  ])(
    "rejects foreign roles, partial nonce or extra ownership claims %j",
    (change) => {
      expect(() =>
        parseStoreFleetOwnerObservation(
          bytes({ ...observation, owner: { ...owner, ...change } }),
          inventorySha256,
        ),
      ).toThrow(denied);
    },
  );
  it.each([
    { sid: "S-1-5-18" },
    { sid: "S-1-5-5-1-2" },
    { sid: "S-1-5-21-4294967296-2-3-1000" },
    { sid: 1000 },
    { sessionId: 0 },
    { sessionId: -1 },
    { sessionId: 1.5 },
    { sessionId: 0x100000000 },
    { sessionId: "1" },
    { pid: 0 },
    { pid: -1 },
    { pid: 2147483648 },
    { pid: 345.5 },
    { pid: "345" },
    { creationTime: "0" },
    { creationTime: "0133000000000000000" },
    { creationTime: "18446744073709551616" },
    { creationTime: 133000000000000000 },
    { creationTime: "2026-10-12T12:00:00Z" },
    { creationTime: "1" },
    { processPath: "C:\\caller\\worker.exe" },
    { elevated: false },
  ])(
    "rejects malformed or incomplete full native process identity %j",
    (change) => {
      expect(() =>
        parseStoreFleetOwnerObservation(
          bytes({
            ...observation,
            owner: { ...owner, identity: { ...owner.identity, ...change } },
          }),
          inventorySha256,
        ),
      ).toThrow(denied);
    },
  );
  it.each([
    { version: 2 },
    { version: "1" },
    { inventorySha256: "c".repeat(64) },
    { inventorySha256: "A".repeat(64) },
    { inventorySha256: "a".repeat(63) },
    { distribution: "microsoft-store" },
    { native: { owned: true } },
  ])(
    "rejects changed generation, version or additional fields %j",
    (change) => {
      expect(() =>
        parseStoreFleetOwnerObservation(
          bytes({ ...observation, ...change }),
          inventorySha256,
        ),
      ).toThrow(denied);
    },
  );
  it("rejects missing/renamed identity fields and legacy wire names", () => {
    for (const key of ["sid", "sessionId", "pid", "creationTime"]) {
      const identity: Record<string, unknown> = { ...owner.identity };
      delete identity[key];
      expect(() =>
        parseStoreFleetOwnerObservation(
          bytes({ ...observation, owner: { ...owner, identity } }),
          inventorySha256,
        ),
      ).toThrow(denied);
    }
    expect(() =>
      parseStoreFleetOwnerObservation(
        bytes({
          ...observation,
          owner: {
            ...owner,
            identity: {
              sid: owner.identity.sid,
              session_id: 1,
              pid: 345,
              creation_time: owner.identity.creationTime,
            },
          },
        }),
        inventorySha256,
      ),
    ).toThrow(denied);
  });
  it("validates the expected inventory digest before any caller coercion", () => {
    for (const value of ["", "A".repeat(64), "a".repeat(63), "not-a-digest"])
      expect(() =>
        parseStoreFleetOwnerObservation(bytes(observation), value),
      ).toThrow(denied);
    const coercion = vi.fn(() => inventorySha256);
    expect(() =>
      parseStoreFleetOwnerObservation(bytes(observation), {
        toString: coercion,
      } as unknown as string),
    ).toThrow(denied);
    expect(coercion).not.toHaveBeenCalled();
  });
});

describe("Store Fleet peer observation receiving", () => {
  it.each([true, false])(
    "receives sole owned=%s without adding authority",
    (owned) => {
      expect(parseStoreFleetPeerObservation(bytes({ owned }))).toBe(owned);
    },
  );
  it.each([
    null,
    [],
    {},
    true,
    false,
    { owned: null },
    { owned: 0 },
    { owned: 1 },
    { owned: "true" },
    { owned: {} },
    { owned: true, version: 1 },
    { owned: true, nonce: owner.nonce },
    { owned: true, ready: true },
  ])("rejects malformed boolean or extra fields %j", (value) => {
    expect(() => parseStoreFleetPeerObservation(bytes(value))).toThrow(denied);
  });
});

describe("bounded strict Fleet byte grammar", () => {
  it("accepts only the actual Uint8Array/Buffer slice, excluding adjacent pooled bytes", () => {
    const wire = bytes(observation),
      surrounding = Buffer.concat([
        Buffer.from("outside{"),
        wire,
        Buffer.from("}outside"),
      ]),
      sliced = surrounding.subarray(8, 8 + wire.byteLength),
      view = new Uint8Array(
        surrounding.buffer,
        surrounding.byteOffset + 8,
        wire.byteLength,
      );
    expect(parseStoreFleetOwnerObservation(sliced, inventorySha256)).toEqual(
      observation,
    );
    expect(parseStoreFleetOwnerObservation(view, inventorySha256)).toEqual(
      observation,
    );
    expect(() =>
      parseStoreFleetOwnerObservation(surrounding, inventorySha256),
    ).toThrow(denied);
  });
  it("enforces the actual byte extent at both exact size limits", () => {
    for (const [maximum, wire, parse] of [
      [
        4096,
        bytes(observation),
        (input: Uint8Array) =>
          parseStoreFleetOwnerObservation(input, inventorySha256),
      ],
      [256, bytes({ owned: true }), parseStoreFleetPeerObservation],
    ] as const) {
      expect(() =>
        parse(
          Buffer.concat([Buffer.alloc(maximum - wire.byteLength, 32), wire]),
        ),
      ).not.toThrow();
      expect(() =>
        parse(
          Buffer.concat([
            Buffer.alloc(maximum - wire.byteLength + 1, 32),
            wire,
          ]),
        ),
      ).toThrow(denied);
    }
  });
  it("rejects getter/prototype/structural byte shims without invoking their accessors", () => {
    const getter = vi.fn(() => 16),
      plain = Object.defineProperty({}, "byteLength", { get: getter }),
      fake = Object.create(Uint8Array.prototype);
    Object.defineProperty(fake, "byteLength", { get: getter });
    const real = bytes({ owned: true });
    Object.defineProperty(real, "byteLength", { get: getter });
    const subclass = new (class extends Uint8Array {})(bytes({ owned: true }));
    for (const value of [
      plain,
      fake,
      real,
      subclass,
      new Proxy(bytes({ owned: true }), {}),
      new Uint16Array(4),
    ]) {
      expect(() => parseStoreFleetPeerObservation(value as Uint8Array)).toThrow(
        denied,
      );
      expect(() =>
        parseStoreFleetOwnerObservation(value as Uint8Array, inventorySha256),
      ).toThrow(denied);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects accessor/serialization hooks and symbols on genuine bytes", () => {
    const getter = vi.fn(() => ({ owned: true }));
    for (const property of [
      "toJSON",
      "constructor",
      Symbol.iterator,
      "buffer",
      "byteOffset",
    ]) {
      const wire = bytes({ owned: true });
      Object.defineProperty(wire, property, { enumerable: true, get: getter });
      expect(() => parseStoreFleetPeerObservation(wire)).toThrow(denied);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    Buffer.alloc(0),
    Buffer.from([0xc3, 0x28]),
    Buffer.from([0xff]),
    Buffer.from("\ufeff{}"),
    Buffer.from("{} {}"),
    Buffer.from("[]"),
    Buffer.from('{"owned":true,"owned":true}'),
    Buffer.from('{"owned":true,"\\u006fwned":true}'),
    Buffer.from('{"__proto__":{"owned":true}}'),
    Buffer.from('{"owned":true,"prototype":{"ready":true}}'),
  ])("rejects malformed UTF8/BOM/duplicates or non-record JSON %j", (wire) => {
    expect(() => parseStoreFleetPeerObservation(wire)).toThrow(denied);
    expect(() =>
      parseStoreFleetOwnerObservation(wire, inventorySha256),
    ).toThrow(denied);
  });
  it("rejects duplicate decoded keys at every owner level", () => {
    const valid = bytes(observation).toString("utf8");
    for (const wire of [
      valid.replace('"version":1', '"version":1,"\\u0076ersion":1'),
      valid.replace('"role":"fleet"', '"role":"fleet","role":"fleet"'),
      valid.replace('"pid":345', '"pid":345,"\\u0070id":345'),
      `${valid} {}`,
      `\ufeff${valid}`,
    ])
      expect(() =>
        parseStoreFleetOwnerObservation(Buffer.from(wire), inventorySha256),
      ).toThrow(denied);
  });
});
