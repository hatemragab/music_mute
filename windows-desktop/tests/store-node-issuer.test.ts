import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  STORE_PRODUCTS,
  parseStoreInstalledPackage,
} from "../src/shared/store-contracts.js";
import {
  parseStoreNodeBootstrap,
  parseStoreNodeInventory,
  parseStoreNodeManifestBytes,
  StoreNodeIssuer,
} from "../src/main/session/store-node-issuer.js";

const original = {
  version: 1,
  role: "session-agent",
  creator_pid: 123,
  creator_creation_time: "132000000000000000",
  creator_channel: "a".repeat(64),
  capability: "b".repeat(64),
};
function bytes(value: unknown = original) {
  return Buffer.from(JSON.stringify(value) + "\n");
}
describe("Store Node inherited receiving policy", () => {
  it("accepts only the bounded complete receiving frame, without minting an actor", () => {
    const parsed = parseStoreNodeBootstrap(bytes());
    expect(parsed).toEqual(original);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed).not.toBeInstanceOf(StoreNodeIssuer);
    for (const role of [
      "session-agent",
      "login-worker",
      "personal",
      "fleet",
      "prepare",
    ])
      expect(parseStoreNodeBootstrap(bytes({ ...original, role })).role).toBe(
        role,
      );
  });
  it.each([
    "version",
    "role",
    "creator_pid",
    "creator_creation_time",
    "creator_channel",
    "capability",
  ])("rejects missing %s", (field) => {
    const value: Record<string, unknown> = { ...original };
    delete value[field];
    expect(() => parseStoreNodeBootstrap(bytes(value))).toThrow(
      "STORE_NODE_ISSUER_DENIED",
    );
  });
  it.each([
    { version: 2 },
    { role: "worker-node" },
    { role: "Session-agent" },
    { role: "fleet " },
    { creator_pid: 0 },
    { creator_pid: -1 },
    { creator_pid: 2147483648 },
    { creator_pid: 1.5 },
    { creator_pid: "123" },
    { creator_creation_time: "0" },
    { creator_creation_time: "01" },
    { creator_creation_time: "-1" },
    { creator_creation_time: "18446744073709551616" },
    { creator_creation_time: "1e2" },
    { creator_channel: "A".repeat(64) },
    { creator_channel: "a".repeat(63) },
    { capability: "../private" },
    { capability: "b".repeat(65) },
    { path: "C:\\private\\node.exe" },
    { runtime: "windows-user" },
    { parent_pid: 123 },
  ])("rejects invalid or caller-selected fields %j", (changed) => {
    expect(() =>
      parseStoreNodeBootstrap(bytes({ ...original, ...changed })),
    ).toThrow("STORE_NODE_ISSUER_DENIED");
  });
  it("requires complete EOF frame grammar and strict UTF-8/unique fields", () => {
    const valid = bytes();
    for (const value of [
      Buffer.alloc(0),
      Buffer.alloc(4097, 32),
      valid.subarray(0, valid.length - 1),
      Buffer.concat([valid, valid]),
      Buffer.concat([valid, Buffer.from("\n")]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]),
      Buffer.concat([Buffer.from([0xff]), valid]),
      Buffer.from(valid.toString().replace(/\n$/u, "\r\n")),
      Buffer.from('{"version":1,' + valid.toString().slice(1)),
      Buffer.from('{"\\u0076ersion":1,' + valid.toString().slice(1)),
    ])
      expect(() => parseStoreNodeBootstrap(value)).toThrow(
        "STORE_NODE_ISSUER_DENIED",
      );
    expect(
      parseStoreNodeBootstrap(
        bytes({ ...original, creator_creation_time: "18446744073709551615" }),
      ).creator_creation_time,
    ).toBe("18446744073709551615");
  });
  it("denies construction from JSON or injected transport and denies unsupported host", async () => {
    expect(() =>
      Reflect.construct(StoreNodeIssuer, [
        Symbol("caller"),
        original,
        "C:\\private",
        "a".repeat(64),
        { bytes: 1, sha256: "b".repeat(64) },
      ]),
    ).toThrow("STORE_NODE_ISSUER_DENIED");
    await expect(
      Reflect.apply(StoreNodeIssuer.open, StoreNodeIssuer, [
        { receipt: original },
      ]),
    ).rejects.toThrow("STORE_NODE_ISSUER_DENIED");
    if (process.platform !== "win32" || process.arch !== "x64")
      await expect(StoreNodeIssuer.open()).rejects.toThrow(
        "STORE_NODE_ISSUER_DENIED",
      );
  });
  it("receives the complete runtime census beyond the ordinary IPC node limit", () => {
    const inventory = {
      version: 1,
      role: "worker",
      packageVersion: STORE_PRODUCTS.worker.packageVersion,
      protocolAbi: 1,
      appVersion: STORE_PRODUCTS.worker.appVersion,
      buildNumber: 1,
      entries: Array.from({ length: 6000 }, (_, index) => ({
        path: `worker/app/engine/musicmute_engine/module_${index.toString().padStart(5, "0")}.py`,
        bytes: 1,
        sha256: "a".repeat(64),
      })),
    };
    expect(
      parseStoreNodeInventory(Buffer.from(JSON.stringify(inventory))).entries,
    ).toHaveLength(6000);
    expect(() =>
      parseStoreNodeInventory(
        Buffer.from(JSON.stringify({ ...inventory, role: "gui" })),
      ),
    ).toThrow("STORE_NODE_ISSUER_DENIED");
    const malformed = JSON.stringify(inventory).replace(
      '"bytes":1',
      '"bytes":1,"\\u0062ytes":1',
    );
    expect(() => parseStoreNodeInventory(Buffer.from(malformed))).toThrow(
      "STORE_NODE_ISSUER_DENIED",
    );
  });
  it("checks protected internal manifest bytes against the exact outer leaf and current Worker version", () => {
    const product = STORE_PRODUCTS.worker,
      fullName = `${product.identityName}_${product.packageVersion}_x64__${product.publisherId}`,
      installed = parseStoreInstalledPackage("worker", {
        identityName: product.identityName,
        publisher: product.publisher,
        publisherId: product.publisherId,
        familyName: product.familyName,
        packageVersion: product.packageVersion,
        fullName,
        architecture: "x64",
        signatureKind: 3,
        healthy: true,
        current: true,
        installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
      });
    const manifest = {
        schemaVersion: 1,
        platform: "win32",
        architecture: "x64",
        releaseVersion: product.appVersion,
        installationProfile: "windows-user",
        entries: [
          {
            path: "app/dist/module.js",
            kind: "file",
            bytes: 1,
            sha256: "a".repeat(64),
          },
        ],
      },
      raw = Buffer.from(JSON.stringify(manifest)),
      index = parseStoreNodeInventory(
        Buffer.from(
          JSON.stringify({
            version: 1,
            role: "worker",
            packageVersion: product.packageVersion,
            appVersion: product.appVersion,
            buildNumber: 1,
            protocolAbi: 1,
            entries: [
              {
                path: "worker/release-manifest.json",
                bytes: raw.length,
                sha256: createHash("sha256").update(raw).digest("hex"),
              },
            ],
          }),
        ),
      );
    expect(
      parseStoreNodeManifestBytes(raw, index, installed, "b".repeat(64)),
    ).toEqual(manifest);
    for (const changed of [
      Buffer.from(raw.toString() + " "),
      Buffer.alloc(0),
      Buffer.from(raw.toString().replace("windows-user", "windows-store")),
    ])
      expect(() =>
        parseStoreNodeManifestBytes(changed, index, installed, "b".repeat(64)),
      ).toThrow("STORE_NODE_ISSUER_DENIED");
    expect(() =>
      parseStoreNodeManifestBytes(
        raw,
        { ...index, entries: [] },
        installed,
        "b".repeat(64),
      ),
    ).toThrow("STORE_NODE_ISSUER_DENIED");
    expect(() =>
      parseStoreNodeManifestBytes(raw, index, installed, "B".repeat(64)),
    ).toThrow("STORE_NODE_ISSUER_DENIED");
  });
});
