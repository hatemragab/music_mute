import { describe, expect, it } from "vitest";
import {
  parseStoreCpuOperationExpectation,
  STORE_CPU_OPERATIONS,
} from "../../worker/src/platform/windows/consumer-store-cpu.js";
import {
  parseWorkspace,
  parseAnyWorkspace,
  parseStoreCpuWorkspace,
} from "../src/main/storage/inventory.js";
import { StoreCpuOperation } from "../src/main/session/store-cpu-operation.js";
import { StoreNodeIssuer } from "../src/main/session/store-node-issuer.js";
import { StoreGuiCpuOperation } from "../src/main/session/store-gui-media.js";
import {
  assertStoreCpuOwnerHost,
  isStoreCpuOwner,
  storeCpuOwnerExpectation,
  storeCpuOwnerRetired,
} from "../src/main/session/store-cpu-owner.js";
const sid = "S-1-5-21-1-2-3-1001",
  requestId = "01234567-89ab-4def-8123-456789abcdef",
  digest = "a".repeat(64);
function expectation(
  operation: (typeof STORE_CPU_OPERATIONS)[number] = "cloud_prepare",
  role: "personal" | "prepare" = "personal",
) {
  return {
    version: 1,
    distribution: "microsoft-store",
    kind: "cpu-tools",
    requestId,
    incarnation: "11234567-89ab-4def-8123-456789abcdef",
    operation,
    configurationSha256: digest,
    inventorySha256: digest,
    runtimeManifestSha256: digest,
    nodeOwner: {
      role,
      nonce: digest,
      identity: {
        sid,
        sessionId: 1,
        pid: 123,
        creationTime: "132000000000000001",
      },
    },
    token: digest,
  };
}
function workspace(
  operation: (typeof STORE_CPU_OPERATIONS)[number] = "cloud_prepare",
  role: "personal" | "prepare" = "personal",
) {
  return {
    version: 2,
    relativePath: `${operation === "silence_analyze" ? "prepare" : "cloud"}\\work\\${requestId}`,
    owner: expectation(operation, role),
    purpose: "processing",
    createdAt: 1,
  };
}
describe("Store CPU workspace receiving boundaries", () => {
  for (const operation of STORE_CPU_OPERATIONS)
    for (const role of ["personal", "prepare"] as const)
      it(`keeps ${operation}/${role} separate from whole-role legacy ownership`, () => {
        const original = workspace(operation, role),
          parsed = parseStoreCpuWorkspace(original, sid);
        expect(parsed.owner.nodeOwner.role).toBe(role);
        expect(parsed.version).toBe(2);
        expect(parseAnyWorkspace(original, sid)).toEqual(parsed);
        expect(() => parseWorkspace(original, sid)).toThrow();
        original.owner.nodeOwner.identity.pid = 999;
        expect(parsed.owner.nodeOwner.identity.pid).toBe(123);
      });
  it("rejects malformed, unrelated and extra ownership fields before adopting data", () => {
    const good = workspace();
    for (const field of Object.keys(good)) {
      const absent: Record<string, unknown> = { ...good };
      delete absent[field];
      expect(() => parseStoreCpuWorkspace(absent, sid)).toThrow();
    }
    for (const change of [
      { version: 1 },
      { purpose: "download" },
      { relativePath: `personal\\engine-session\\${requestId}` },
      { relativePath: `cloud\\work\\11234567-89ab-4def-8123-456789abcdef` },
      { createdAt: -1 },
      { retired: true },
    ])
      expect(() =>
        parseStoreCpuWorkspace({ ...good, ...change }, sid),
      ).toThrow();
    for (const field of Object.keys(good.owner)) {
      const bad: Record<string, unknown> = { ...good.owner };
      delete bad[field];
      expect(() => parseStoreCpuOperationExpectation(bad)).toThrow();
    }
    for (const change of [
      { distribution: "windows-user" },
      { kind: "prepare" },
      { token: "copied" },
      { operation: "execute" },
      { requestId: "../data" },
      { ready: true },
    ])
      expect(() =>
        parseStoreCpuOperationExpectation({ ...good.owner, ...change }),
      ).toThrow();
    expect(() => parseStoreCpuWorkspace(good, "S-1-5-21-1-2-3-1002")).toThrow();
  });
  it("does not invoke an owner accessor or treat a serialized row as a private operation", () => {
    let touched = false;
    const bad = { ...workspace() };
    Object.defineProperty(bad, "owner", {
      enumerable: true,
      get() {
        touched = true;
        throw new Error("should not run");
      },
    });
    expect(() => parseStoreCpuWorkspace(bad, sid)).toThrow();
    expect(touched).toBe(false);
    expect(() =>
      StoreCpuOperation.prototype.expectation.call(workspace().owner as never),
    ).toThrow();
    expect(() =>
      StoreCpuOperation.create(
        { native: {} } as never,
        Object.create(StoreNodeIssuer.prototype),
        {} as never,
      ),
    ).toThrow();
    expect(() =>
      StoreCpuOperation.prototype.assertHost.call(
        Object.create(StoreCpuOperation.prototype),
        {} as never,
      ),
    ).toThrow();
  });
  it("preserves strict legacy version-one receiving", () => {
    const owner = {
      role: "prepare",
      nonce: digest,
      identity: {
        sid,
        sessionId: 1,
        pid: 123,
        creationTime: "132000000000000001",
      },
    };
    const row = {
      version: 1,
      relativePath: `cloud\\work\\${requestId}`,
      owner,
      purpose: "processing",
      createdAt: 1,
    };
    expect(parseAnyWorkspace(row, sid)).toEqual(parseWorkspace(row, sid));
    expect(() => parseStoreCpuWorkspace(row, sid)).toThrow();
    expect(() =>
      parseWorkspace({ ...row, owner: expectation() }, sid),
    ).toThrow();
  });
  it("classification never grants a cloned GUI or Node operation workspace authority", async () => {
    expect(isStoreCpuOwner(workspace().owner)).toBe(false);
    for (const prototype of [
      StoreGuiCpuOperation.prototype,
      StoreCpuOperation.prototype,
    ]) {
      const clone = Object.assign(Object.create(prototype), {
        owner: expectation(),
        retired: true,
      });
      expect(isStoreCpuOwner(clone)).toBe(true);
      expect(() => assertStoreCpuOwnerHost(clone, {} as never)).toThrow();
      expect(() => storeCpuOwnerExpectation(clone)).toThrow();
      await expect(storeCpuOwnerRetired(clone)).rejects.toThrow();
    }
  });
});
