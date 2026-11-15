import { describe, expect, it } from "vitest";
import { parseStoreRoleOwner } from "../src/main/session/store-role-owner.js";
import { parseStoreBootReceipt } from "../src/shared/store-boot-receipt.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";

const product = STORE_PRODUCTS.worker,
  fullName = `${product.identityName}_0.1.3.2_x64__${product.publisherId}`,
  packageValue = {
    identityName: product.identityName,
    publisher: product.publisher,
    publisherId: product.publisherId,
    familyName: product.familyName,
    fullName,
    packageVersion: "0.1.3.2",
    architecture: "x64",
    signatureKind: 3,
    healthy: true,
    current: true,
    installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
  },
  node = {
    sid: "S-1-5-21-1-2-3-1001",
    session_id: 1,
    pid: 123,
    creation_time: "132000000000000000",
  },
  boot = parseStoreBootReceipt(
    "worker",
    {
      version: 1,
      package: packageValue,
      helper: { ...node, pid: 456, creation_time: "132000000000000001" },
      parent: node,
      logon_sid: "S-1-5-5-2-3",
    },
    123,
    456,
  ),
  index = "a".repeat(64),
  baseline = {
    version: 1,
    role: "session-agent",
    nonce: "b".repeat(64),
    node,
    package: packageValue,
    inventory_sha256: index,
    protocol_abi: 1,
  };
describe("Store actual role owner receiving policy", () => {
  it("validates synthetic matching data without minting a native transport", () => {
    expect(parseStoreRoleOwner(baseline, boot, "session-agent", index)).toEqual(
      {
        role: "session-agent",
        nonce: "b".repeat(64),
        identity: boot.parent,
      },
    );
  });
  it.each([
    "version",
    "role",
    "nonce",
    "node",
    "package",
    "inventory_sha256",
    "protocol_abi",
  ])("denies missing %s", (key) => {
    const value: Record<string, unknown> = { ...baseline };
    delete value[key];
    expect(() =>
      parseStoreRoleOwner(value, boot, "session-agent", index),
    ).toThrow("STORE_ROLE_OWNER_DENIED");
  });
  it.each([
    { version: 2 },
    { role: "personal" },
    { role: "worker-node" },
    { nonce: "B".repeat(64) },
    { nonce: "b".repeat(63) },
    { inventory_sha256: "c".repeat(64) },
    { protocol_abi: 2 },
    { receipt: "private DPAPI record" },
    { job: "Local\\caller-selected" },
    { node: { ...node, pid: 124 } },
    { node: { ...node, creation_time: "132000000000000002" } },
    { node: { ...node, sid: "S-1-5-21-1-2-3-1002" } },
    { node: { ...node, session_id: 2 } },
    { node: { ...node, job: "caller-selected" } },
    { package: { ...packageValue, signatureKind: 2 } },
    { package: { ...packageValue, current: false } },
  ])("denies foreign owner/generation/authority data %j", (changed) => {
    expect(() =>
      parseStoreRoleOwner(
        { ...baseline, ...changed },
        boot,
        "session-agent",
        index,
      ),
    ).toThrow("STORE_ROLE_OWNER_DENIED");
  });
  it("rejects getters/prototypes/symbol extras without reading executable accessors", () => {
    let called = false;
    const getter = { ...baseline };
    Object.defineProperty(getter, "nonce", {
      enumerable: true,
      get() {
        called = true;
        return "b".repeat(64);
      },
    });
    expect(() =>
      parseStoreRoleOwner(getter, boot, "session-agent", index),
    ).toThrow("STORE_ROLE_OWNER_DENIED");
    const nested = { ...node };
    Object.defineProperty(nested, "pid", {
      enumerable: true,
      get() {
        called = true;
        return 123;
      },
    });
    expect(() =>
      parseStoreRoleOwner(
        { ...baseline, node: nested },
        boot,
        "session-agent",
        index,
      ),
    ).toThrow("STORE_ROLE_OWNER_DENIED");
    expect(called).toBe(false);
    for (const value of [
      Object.assign(Object.create({ foreign: true }), baseline),
      { ...baseline, [Symbol("extra")]: 1 },
    ])
      expect(() =>
        parseStoreRoleOwner(value, boot, "session-agent", index),
      ).toThrow("STORE_ROLE_OWNER_DENIED");
  });
});
