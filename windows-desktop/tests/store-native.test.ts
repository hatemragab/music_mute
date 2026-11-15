import { describe, expect, it } from "vitest";
import {
  parseStoreBootReceipt,
  StoreNativeAuthority,
} from "../src/main/browser/store-native.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";

function fixture() {
  const product = STORE_PRODUCTS.gui;
  const fullName = `${product.identityName}_0.1.0.2_x64__${product.publisherId}`;
  return {
    version: 1,
    package: {
      identityName: product.identityName,
      publisher: product.publisher,
      publisherId: product.publisherId,
      familyName: product.familyName,
      fullName,
      packageVersion: "0.1.0.2",
      architecture: "x64",
      signatureKind: 3,
      healthy: true,
      current: true,
      installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
    },
    helper: {
      sid: "S-1-5-21-1-2-3-1001",
      session_id: 1,
      pid: 1235,
      creation_time: "1337133713371337",
    },
    parent: {
      sid: "S-1-5-21-1-2-3-1001",
      session_id: 1,
      pid: 1234,
      creation_time: "1337133713371000",
    },
    logon_sid: "S-1-5-5-1-42",
  };
}
describe("native Store receipt receiving boundary", () => {
  it("parses a native-shaped receipt without making it an executable authority", () => {
    const value = parseStoreBootReceipt("gui", fixture(), 1234, 1235);
    expect(value.package.signatureKind).toBe(3);
    expect(value.package.packageVersion).toBe("0.1.0.2");
    expect(value.parent.pid).toBe(1234);
    expect(value).not.toHaveProperty("readResource");
  });
  it.each([0, 1, 2, 4])(
    "rejects unsigned/developer/system/enterprise origin %s",
    (signatureKind) => {
      const value = fixture();
      value.package.signatureKind = signatureKind;
      expect(() => parseStoreBootReceipt("gui", value, 1234, 1235)).toThrow(
        "STORE_AUTHORITY_DENIED",
      );
    },
  );
  it.each(["healthy", "current"] as const)(
    "rejects false OS %s proof",
    (key) => {
      const value = fixture();
      value.package[key] = false;
      expect(() => parseStoreBootReceipt("gui", value, 1234, 1235)).toThrow(
        "STORE_AUTHORITY_DENIED",
      );
    },
  );
  it.each(["arm64", "x86", "AMD64"])(
    "rejects unsupported package architecture %s",
    (architecture) => {
      const value = fixture();
      value.package.architecture = architecture;
      expect(() => parseStoreBootReceipt("gui", value, 1234, 1235)).toThrow(
        "STORE_AUTHORITY_DENIED",
      );
    },
  );
  it("rejects an unregistered/copied root and foreign product receipt", () => {
    const value = fixture();
    value.package.installedLocation = "C:\\Users\\fixture\\copy";
    expect(() => parseStoreBootReceipt("gui", value, 1234, 1235)).toThrow(
      "STORE_AUTHORITY_DENIED",
    );
    expect(() =>
      parseStoreBootReceipt("worker", fixture(), 1234, 1235),
    ).toThrow("STORE_AUTHORITY_DENIED");
  });
  it("rejects wrong actual parent PID, cross-user, cross-login and self-parent claims", () => {
    const value = fixture();
    expect(() => parseStoreBootReceipt("gui", value, 1236, 1235)).toThrow(
      "STORE_AUTHORITY_DENIED",
    );
    expect(() =>
      parseStoreBootReceipt(
        "gui",
        { ...value, parent: { ...value.parent, sid: "S-1-5-21-1-2-3-1002" } },
        1234,
        1235,
      ),
    ).toThrow("STORE_AUTHORITY_DENIED");
    expect(() =>
      parseStoreBootReceipt(
        "gui",
        { ...value, parent: { ...value.parent, session_id: 2 } },
        1234,
        1235,
      ),
    ).toThrow("STORE_AUTHORITY_DENIED");
    expect(() =>
      parseStoreBootReceipt(
        "gui",
        { ...value, helper: { ...value.helper, pid: 1234 } },
        1234,
        1235,
      ),
    ).toThrow("STORE_AUTHORITY_DENIED");
  });
  it.each(["0", "-1", "001", "18446744073709551616"])(
    "rejects invalid birth %s",
    (creation_time) => {
      const value = fixture();
      value.parent.creation_time = creation_time;
      expect(() => parseStoreBootReceipt("gui", value, 1234, 1235)).toThrow(
        "STORE_AUTHORITY_DENIED",
      );
    },
  );
  it("rejects extra fields/getters instead of accepting self-authorizing bypasses", () => {
    const value = fixture();
    expect(() =>
      parseStoreBootReceipt(
        "gui",
        { ...value, allowUnsigned: true },
        1234,
        1235,
      ),
    ).toThrow("STORE_AUTHORITY_DENIED");
    expect(() =>
      parseStoreBootReceipt(
        "gui",
        { ...value, parent: { ...value.parent, role: "gui" } },
        1234,
        1235,
      ),
    ).toThrow("STORE_AUTHORITY_DENIED");
    let executed = false;
    Object.defineProperty(value, "version", {
      enumerable: true,
      get() {
        executed = true;
        return 1;
      },
    });
    expect(() => parseStoreBootReceipt("gui", value, 1234, 1235)).toThrow(
      "STORE_AUTHORITY_DENIED",
    );
    expect(executed).toBe(false);
  });
  it("refuses to create native Store authority on a non-Windows host", async () => {
    if (process.platform === "win32") return;
    await expect(StoreNativeAuthority.open()).rejects.toThrow(
      "STORE_AUTHORITY_DENIED",
    );
  });
  it("rejects runtime constructor and caller-selected helper/receipt injection", async () => {
    expect(() =>
      Reflect.construct(StoreNativeAuthority, [
        Symbol("forged"),
        {},
        fixture(),
        {},
      ]),
    ).toThrow("STORE_AUTHORITY_DENIED");
    await expect(
      Reflect.apply(StoreNativeAuthority.open, StoreNativeAuthority, [
        {
          role: "gui",
          helperPath: "C:\\fixture\\fake.exe",
          receipt: fixture(),
        },
      ]),
    ).rejects.toThrow("STORE_AUTHORITY_DENIED");
    const forged = Object.create(
      StoreNativeAuthority.prototype,
    ) as StoreNativeAuthority;
    await expect(
      forged.readResource("app/fake", { bytes: 1, sha256: "a".repeat(64) }, 1),
    ).rejects.toThrow();
  });
});
