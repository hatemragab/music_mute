import { describe, expect, it, vi } from "vitest";
import {
  parseStoreBrowserAttachInput,
  parseStoreBrowserAttachment,
  parseStoreBrowserRegistration,
  registerStoreBrowserIntegration,
  removeStoreBrowserIntegration,
  verifyStoreBrowserIntegration,
  STORE_BROWSER_EXTENSION_ID,
  STORE_BROWSER_ORIGIN,
} from "../src/main/browser/store-registration.js";
import {
  parseStoreBootReceipt,
  type StoreBootReceipt,
  type StoreNativeAuthority,
} from "../src/main/browser/store-native.js";
import { STORE_PRODUCTS } from "../src/shared/store-contracts.js";
import {
  BrowserFrameDecoder,
  encodeBrowserFrame,
} from "../src/main/browser/framing.js";

function receipt(): StoreBootReceipt {
  const product = STORE_PRODUCTS.gui;
  const fullName = `${product.identityName}_0.1.0.2_x64__${product.publisherId}`;
  return parseStoreBootReceipt(
    "gui",
    {
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
    },
    1234,
    1235,
  );
}
function registration(state = "registered") {
  return {
    version: 1,
    registered: state === "registered",
    state,
    package_full_name: receipt().package.fullName,
    manifest_sha256: "a".repeat(64),
    launch_target: "current-package",
    alias_required: false,
    ordinary_registry_verified: state === "registered",
    extension_id: STORE_BROWSER_EXTENSION_ID,
  };
}
function attachment() {
  const value = receipt();
  const peer = (pid: number, creation_time: string) => ({
    sid: value.helper.sid,
    session_id: 1,
    pid,
    creation_time,
  });
  return {
    version: 1,
    accepted: true,
    host: peer(1233, "1337133713370000"),
    gui: peer(value.parent.pid, value.parent.creationTime),
    chrome: peer(1232, "1337133713360000"),
    origin: STORE_BROWSER_ORIGIN,
    package_full_name: value.package.fullName,
  };
}
describe("Store Chrome receiving boundary (synthetic, not Store/Chrome device proof)", () => {
  it.each(["registered", "absent", "repair-required", "conflict"])(
    "parses closed %s status without creating authority",
    (state) => {
      const result = parseStoreBrowserRegistration(
        registration(state),
        receipt(),
      );
      expect(result.state).toBe(state);
      expect(result.aliasRequired).toBe(false);
      expect(result).not.toHaveProperty("request");
      expect(Object.isFrozen(result)).toBe(true);
    },
  );
  it.each([
    { registered: false },
    { ordinary_registry_verified: false },
    { alias_required: true },
    { launch_target: "caller-alias" },
    { package_full_name: "claimed-store" },
    { manifest_sha256: "A".repeat(64) },
    { extension_id: "a".repeat(32) },
    { state: "serviced" },
    { allowUnsigned: true },
    { path: "C:\\caller.exe" },
  ])("rejects inconsistent/foreign registration %j", (change) => {
    expect(() =>
      parseStoreBrowserRegistration(
        { ...registration(), ...change },
        receipt(),
      ),
    ).toThrow("STORE_BROWSER_DENIED");
  });
  it.each([0, 1, 2, 4])(
    "rejects receipt signature origin %s",
    (signatureKind) => {
      const value = receipt();
      expect(() =>
        parseStoreBrowserRegistration(registration(), {
          ...value,
          package: { ...value.package, signatureKind },
        } as StoreBootReceipt),
      ).toThrow("STORE_BROWSER_DENIED");
    },
  );
  it("never executes receiving getters or accepts symbols/prototypes", () => {
    const value = registration();
    let executed = false;
    Object.defineProperty(value, "version", {
      enumerable: true,
      get() {
        executed = true;
        return 1;
      },
    });
    expect(() => parseStoreBrowserRegistration(value, receipt())).toThrow(
      "STORE_BROWSER_DENIED",
    );
    expect(executed).toBe(false);
    expect(() =>
      parseStoreBrowserRegistration(
        { ...registration(), [Symbol("authority")]: true },
        receipt(),
      ),
    ).toThrow("STORE_BROWSER_DENIED");
    expect(() =>
      parseStoreBrowserRegistration(Object.create(registration()), receipt()),
    ).toThrow("STORE_BROWSER_DENIED");
  });
  it("binds attach input to the production origin and bounded one-use nonce grammar", () => {
    expect(
      parseStoreBrowserAttachInput({
        hostPid: 1233,
        nonce: "a".repeat(64),
        origin: STORE_BROWSER_ORIGIN,
      }),
    ).toEqual({
      hostPid: 1233,
      nonce: "a".repeat(64),
      origin: STORE_BROWSER_ORIGIN,
    });
    for (const change of [
      { hostPid: 0 },
      { hostPid: 2147483648 },
      { nonce: "A".repeat(64) },
      { origin: "chrome-extension://npkabaieihgikeiahjojlkjjakajjnpa/" },
      { path: "caller" },
    ]) {
      expect(() =>
        parseStoreBrowserAttachInput({
          hostPid: 1233,
          nonce: "a".repeat(64),
          origin: STORE_BROWSER_ORIGIN,
          ...change,
        }),
      ).toThrow("STORE_BROWSER_DENIED");
    }
  });
  it("binds GUI PID/birth/current generation and all three peer sessions", () => {
    const good = attachment();
    const parsed = parseStoreBrowserAttachment(good, receipt());
    expect(parsed.gui.pid).toBe(receipt().parent.pid);
    expect(parsed.host.pid).toBe(1233);
    expect(Object.isFrozen(parsed.host)).toBe(true);
    for (const role of ["host", "gui", "chrome"] as const) {
      for (const change of [
        { sid: "S-1-5-21-1-2-3-1002" },
        { session_id: 2 },
        { pid: 1235 },
        { creation_time: "0" },
      ]) {
        expect(() =>
          parseStoreBrowserAttachment(
            { ...good, [role]: { ...good[role], ...change } },
            receipt(),
          ),
        ).toThrow("STORE_BROWSER_DENIED");
      }
    }
    expect(() =>
      parseStoreBrowserAttachment(
        { ...good, gui: { ...good.gui, creation_time: "1337133713371001" } },
        receipt(),
      ),
    ).toThrow("STORE_BROWSER_DENIED");
    expect(() =>
      parseStoreBrowserAttachment(
        {
          ...good,
          package_full_name: good.package_full_name.replace(
            "0.1.0.2",
            "0.1.0.3",
          ),
        },
        receipt(),
      ),
    ).toThrow("STORE_BROWSER_DENIED");
    expect(() =>
      parseStoreBrowserAttachment(
        { ...good, nonce: "a".repeat(64) },
        receipt(),
      ),
    ).toThrow("STORE_BROWSER_DENIED");
  });
  it("refuses fake native adapters and imported receipts at the executable service boundary", async () => {
    const callback = vi.fn(async () =>
      parseStoreBrowserRegistration(registration(), receipt()),
    );
    const fake = {
      receipt: receipt(),
      browserRegistration: callback,
    } as unknown as StoreNativeAuthority;
    await expect(registerStoreBrowserIntegration(fake)).rejects.toThrow();
    await expect(removeStoreBrowserIntegration(fake)).rejects.toThrow();
    await expect(verifyStoreBrowserIntegration(fake)).resolves.toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });
  it("keeps the existing shared Unicode/native framing and partial EOF boundary", () => {
    const value = {
      protocol_version: 1,
      request_id: "00000000-0000-0000-0000-000000000001",
      type: "HELLO",
      payload: { text: "مرحبا 🎵" },
    };
    const frame = encodeBrowserFrame(value),
      decoder = new BrowserFrameDecoder();
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([value]);
    expect(() => decoder.finish()).not.toThrow();
    for (const partial of [
      frame.subarray(0, 1),
      frame.subarray(0, frame.length - 1),
    ]) {
      const incomplete = new BrowserFrameDecoder();
      incomplete.push(partial);
      expect(() => incomplete.finish()).toThrow("FRAME_TRUNCATED");
    }
  });
});
