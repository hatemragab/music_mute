import { expect, it } from "vitest";
import { parseStoreNodeRotation } from "../src/shared/store-node-rotation.js";
import { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";
const node = {
  sid: "S-1-5-21-1-2-3-1001",
  sessionId: 1,
  pid: 124,
  creationTime: "132000000000000000",
};
const expected = {
  nonce: "b".repeat(64),
  previous: "a".repeat(64),
  node,
  creator: { pid: 123, creationTime: "131000000000000000" },
};
const reply = () => ({
  version: 1,
  accepted: true,
  request_nonce: expected.nonce,
  rotated: true,
  capability: "c".repeat(64),
  remaining: 2048,
  pid: node.pid,
  creation_time: node.creationTime,
  node_pid: node.pid,
  node_creation_time: node.creationTime,
  creator_pid: expected.creator.pid,
  creator_creation_time: expected.creator.creationTime,
});
it("receives original-node generation data without constructing a role/issuer or changing model ownership", () => {
  const data = parseStoreNodeRotation(reply(), expected);
  expect(data).toEqual({
    capability: "c".repeat(64),
    rotated: true,
    remaining: 2048,
  });
  expect(Object.isFrozen(data)).toBe(true);
  expect(data).not.toBeInstanceOf(StoreNodeIssuer);
  expect(data).not.toHaveProperty("owner");
  expect(data).not.toHaveProperty("ready");
  expect(
    parseStoreNodeRotation(
      {
        ...reply(),
        rotated: false,
        capability: expected.previous,
        remaining: 15,
      },
      expected,
    ),
  ).toEqual({ capability: expected.previous, rotated: false, remaining: 15 });
});
it.each([
  { pid: 125 },
  { node_pid: 125 },
  { creation_time: "132000000000000001" },
  { node_creation_time: "132000000000000001" },
  { creator_pid: 125 },
  { creator_creation_time: "131000000000000001" },
  { request_nonce: "d".repeat(64) },
  { accepted: false },
  { version: 2 },
  { capability: expected.previous },
  { capability: "g".repeat(64) },
  { remaining: 2047 },
  { remaining: 2049 },
  { remaining: 0 },
  { remaining: 1.5 },
  { rotated: 1 },
  { rotated: false, remaining: 1 },
  { rotated: false, capability: expected.previous, remaining: 0 },
  { ownership_nonce: "f".repeat(64) },
  { role: "personal" },
  { replay_reset: true },
  { ready: true },
  { pid: undefined },
])(
  "rejects changed peer/nonce/capability or caller rotation/reset fields %#",
  (change) => {
    expect(() =>
      parseStoreNodeRotation({ ...reply(), ...change }, expected),
    ).toThrow("STORE_NODE_ISSUER_DENIED");
  },
);
it("never invokes getter adapters or accepts inherited/hidden/invalid expected actor fields", () => {
  const accessor = Object.defineProperty(reply(), "capability", {
    enumerable: true,
    get: () => {
      throw new Error("GETTER_MUST_NOT_RUN");
    },
  });
  for (const value of [
    null,
    [],
    Object.create(reply()),
    accessor,
    Object.defineProperty(reply(), "capability", {
      enumerable: false,
      value: "c".repeat(64),
    }),
  ])
    expect(() => parseStoreNodeRotation(value, expected)).toThrow(
      "STORE_NODE_ISSUER_DENIED",
    );
  for (const expectation of [
    { ...expected, node: { ...node, pid: 0 } },
    { ...expected, node: { ...node, sessionId: 0 } },
    { ...expected, node: { ...node, creationTime: "0" } },
    { ...expected, creator: { ...expected.creator, pid: node.pid } },
    {
      ...expected,
      creator: { ...expected.creator, creationTime: "18446744073709551616" },
    },
    { ...expected, nonce: "z".repeat(64) },
  ])
    expect(() => parseStoreNodeRotation(reply(), expectation)).toThrow(
      "STORE_NODE_ISSUER_DENIED",
    );
});
