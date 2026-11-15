import { describe, expect, it } from "vitest";
import {
  parseStoreResourceIndexBytes,
  REQUIRED_STORE_GUI_RESOURCES,
} from "../src/main/browser/store-resource-index.js";
import {
  parseStorePackageIdentity,
  STORE_PRODUCTS,
} from "../src/shared/store-contracts.js";

function fixture() {
  const product = STORE_PRODUCTS.gui;
  return {
    version: 2,
    authority: {
      kind: "microsoft-store",
      role: "gui",
      identity: parseStorePackageIdentity("gui", {
        identityName: product.identityName,
        publisher: product.publisher,
        publisherId: product.publisherId,
        familyName: product.familyName,
        storeId: product.storeId,
      }),
      packageVersion: "0.1.0.0",
      protocolAbi: 1,
    },
    appVersion: "0.1.0",
    buildNumber: 1,
    entries: REQUIRED_STORE_GUI_RESOURCES.map((name) => {
      const split = name.indexOf(":");
      return {
        placement: name.slice(0, split),
        path: name.slice(split + 1),
        bytes: 32,
        sha256: "1".repeat(64),
      };
    }),
  };
}
const receive = (value: unknown) =>
  parseStoreResourceIndexBytes(Buffer.from(JSON.stringify(value)));
describe("Store resource seal receiving boundary", () => {
  it("accepts a complete Store seal without inventing Authenticode or archive pins", () => {
    const parsed = receive(fixture());
    expect(parsed.authority.identity.familyName).toBe(
      STORE_PRODUCTS.gui.familyName,
    );
    expect(Object.keys(parsed)).not.toContain("publisherSha256");
    expect(Object.keys(parsed)).not.toContain("payloadSha256");
    expect(Object.isFrozen(parsed.entries)).toBe(true);
  });
  it.each([
    "payloadSha256",
    "publisherSha256",
    "allowUnsigned",
    "developerMode",
  ])("rejects mixing legacy or bypass field %s into a Store seal", (key) =>
    expect(() => receive({ ...fixture(), [key]: "1".repeat(64) })).toThrow(
      "STORE_RESOURCE_INDEX_INVALID",
    ),
  );
  it("rejects a valid-looking seal missing a required helper before any authority is created", () => {
    const value = fixture();
    value.entries.splice(0, 1);
    expect(() => receive(value)).toThrow("STORE_RESOURCE_INDEX_INVALID");
  });
  it.each([
    "runtime/runtime-metadata.json",
    "runtime/runtime-source.json",
    "update-channel.json",
    "app-update-identity.json",
    "native/account-authority-manifest.json",
    "store-code-inventory.json",
  ])("rejects legacy/circular authority resource %s", (path) => {
    const value = fixture();
    value.entries.push({
      placement: "resources",
      path,
      bytes: 32,
      sha256: "1".repeat(64),
    });
    expect(() => receive(value)).toThrow("STORE_RESOURCE_INDEX_INVALID");
  });
  it.each([
    "../helper.exe",
    "native//helper.exe",
    "native/CON.json",
    "native/helper.json.",
    "native\\helper.json",
    "/helper.exe",
    "native/helper:stream",
  ])("denies escaping or ambiguous resource path %s", (path) => {
    const value = fixture();
    value.entries.push({
      placement: "resources",
      path,
      bytes: 32,
      sha256: "1".repeat(64),
    });
    expect(() => receive(value)).toThrow("STORE_RESOURCE_INDEX_INVALID");
  });
  it("rejects duplicate names ignoring Windows case", () => {
    const value = fixture();
    value.entries.push({
      ...value.entries[0]!,
      path: value.entries[0]!.path.toUpperCase(),
    });
    expect(() => receive(value)).toThrow("STORE_RESOURCE_INDEX_INVALID");
  });
  it("rejects duplicate JSON keys in actual incoming bytes", () => {
    const text = JSON.stringify(fixture()).replace(
      '"version":2',
      '"version":1,"version":2',
    );
    expect(() => parseStoreResourceIndexBytes(Buffer.from(text))).toThrow(
      "STORE_RESOURCE_INDEX_INVALID",
    );
  });
  it.each([0, -1, 0.5, 2147483648])(
    "rejects invalid independent app build %s",
    (buildNumber) => {
      expect(() => receive({ ...fixture(), buildNumber })).toThrow(
        "STORE_RESOURCE_INDEX_INVALID",
      );
    },
  );
  it.each(["0.1.0.1", "0.1.1.0", "00.1.0.0", "0.1.0", "0.1.65536.0"])(
    "rejects invalid or unqualified submitted version %s",
    (packageVersion) => {
      const value = fixture();
      value.authority.packageVersion = packageVersion;
      expect(() => receive(value)).toThrow("STORE_RESOURCE_INDEX_INVALID");
    },
  );
  it("rejects a foreign product and mixed semantic version", () => {
    const value = fixture();
    expect(() => receive({ ...value, appVersion: "0.1.3" })).toThrow(
      "STORE_RESOURCE_INDEX_INVALID",
    );
    expect(() =>
      receive({
        ...value,
        authority: {
          ...value.authority,
          identity: {
            ...value.authority.identity,
            familyName: STORE_PRODUCTS.worker.familyName,
          },
        },
      }),
    ).toThrow("STORE_RESOURCE_INDEX_INVALID");
  });
  it("rejects invalid UTF8 and oversized metadata", () => {
    expect(() => parseStoreResourceIndexBytes(Buffer.from([0xff]))).toThrow(
      "STORE_RESOURCE_INDEX_INVALID",
    );
    expect(() => parseStoreResourceIndexBytes(Buffer.alloc(65537, 32))).toThrow(
      "STORE_RESOURCE_INDEX_INVALID",
    );
  });
});
