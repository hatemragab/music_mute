import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  parseStoreWorkerCodeObservation,
  parseStoreWorkerRuntimeManifest,
  parseStoreWorkerSessionActivation,
} from "../src/main/browser/store-worker-code.js";
import {
  StoreNativeAuthority,
  StoreWorkerCodeAuthority,
} from "../src/main/browser/store-native.js";
import {
  parseStoreInstalledPackage,
  STORE_PRODUCTS,
} from "../src/shared/store-contracts.js";
import { readStoreReadiness } from "../src/main/prepare/store-readiness.js";
import { prepareStoreModel } from "../src/main/prepare/store-model.js";
import type { HostContext } from "../src/main/host-context.js";
function installed(role: "gui" | "worker") {
  const product = STORE_PRODUCTS[role],
    fullName = `${product.identityName}_${product.packageVersion}_x64__${product.publisherId}`;
  return {
    identityName: product.identityName,
    publisher: product.publisher,
    publisherId: product.publisherId,
    familyName: product.familyName,
    fullName,
    packageVersion: product.packageVersion,
    architecture: "x64",
    signatureKind: 3,
    healthy: true,
    current: true,
    installedLocation: `C:\\Program Files\\WindowsApps\\${fullName}`,
  };
}
const gui = parseStoreInstalledPackage("gui", installed("gui"));
function fixture(count = 1) {
  const manifest = {
      schemaVersion: 1,
      platform: "win32",
      architecture: "x64",
      releaseVersion: "0.1.3",
      installationProfile: "windows-user",
      entries: Array.from({ length: count }, (_, index) => ({
        path: `app/dist/${index.toString().padStart(5, "0")}.js`,
        kind: "file",
        bytes: 1,
        sha256: "c".repeat(64),
      })),
    },
    bytes = Buffer.from(JSON.stringify(manifest)),
    wire = {
      version: 1,
      package: installed("worker"),
      inventory_sha256: "a".repeat(64),
      manifest: {
        path: "worker/release-manifest.json",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  return { manifest, bytes, wire };
}
describe("Store Worker code receiving boundary", () => {
  it("keeps a bounded compatible protected manifest separate from executable authority", () => {
    const f = fixture(6000),
      observation = parseStoreWorkerCodeObservation(f.wire, gui),
      manifest = parseStoreWorkerRuntimeManifest(f.bytes, observation);
    expect(manifest.entries).toHaveLength(6000);
    expect(observation.inventorySha256).not.toBe(observation.manifest.sha256);
    expect(Object.isFrozen(observation.manifest)).toBe(true);
    expect(observation).not.toHaveProperty("activateSession");
  });
  it.each([
    (f: ReturnType<typeof fixture>) => ({ ...f.wire, version: 2 }),
    (f: ReturnType<typeof fixture>) => ({ ...f.wire, allowUnsigned: true }),
    (f: ReturnType<typeof fixture>) => ({
      ...f.wire,
      package: installed("gui"),
    }),
    (f: ReturnType<typeof fixture>) => ({
      ...f.wire,
      package: { ...installed("worker"), signatureKind: 0 },
    }),
    (f: ReturnType<typeof fixture>) => ({
      ...f.wire,
      package: { ...installed("worker"), current: false },
    }),
    (f: ReturnType<typeof fixture>) => ({
      ...f.wire,
      inventory_sha256: "A".repeat(64),
    }),
    (f: ReturnType<typeof fixture>) => ({
      ...f.wire,
      manifest: { ...f.wire.manifest, path: "worker/../release-manifest.json" },
    }),
    (f: ReturnType<typeof fixture>) => ({
      ...f.wire,
      manifest: { ...f.wire.manifest, bytes: 0 },
    }),
    (f: ReturnType<typeof fixture>) => ({
      ...f.wire,
      manifest: { ...f.wire.manifest, bytes: 8 * 1024 ** 2 + 1 },
    }),
  ])(
    "rejects foreign, stale, mixed or unbounded code observations %#",
    (change) => {
      expect(() =>
        parseStoreWorkerCodeObservation(change(fixture()), gui),
      ).toThrow("STORE_WORKER_CODE_DENIED");
    },
  );
  it("does not execute a getter or accept a caller resource path", () => {
    const f = fixture(),
      getter = vi.fn(() => f.wire.manifest);
    Object.defineProperty(f.wire, "manifest", {
      enumerable: true,
      get: getter,
    });
    expect(() => parseStoreWorkerCodeObservation(f.wire, gui)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["digest", "duplicate", "version", "profile"])(
    "rejects a %s internal manifest without weakening the ordinary JSON limits",
    (change) => {
      const f = fixture();
      let bytes = f.bytes;
      if (change === "digest") bytes = Buffer.from(`${f.bytes.toString()} `);
      else {
        if (change === "duplicate")
          bytes = Buffer.from(
            f.bytes
              .toString()
              .replace(
                '"schemaVersion":1',
                '"schemaVersion":1,"schemaVersion":1',
              ),
          );
        else if (change === "version")
          bytes = Buffer.from(
            JSON.stringify({ ...f.manifest, releaseVersion: "0.1.4" }),
          );
        else
          bytes = Buffer.from(
            JSON.stringify({
              ...f.manifest,
              installationProfile: "windows-service",
            }),
          );
        f.wire.manifest.bytes = bytes.length;
        f.wire.manifest.sha256 = createHash("sha256")
          .update(bytes)
          .digest("hex");
      }
      expect(() =>
        parseStoreWorkerRuntimeManifest(
          bytes,
          parseStoreWorkerCodeObservation(f.wire, gui),
        ),
      ).toThrow("STORE_WORKER_CODE_DENIED");
    },
  );
  it("treats the bounded OS activation PID as an acknowledgement only", () => {
    const ack = parseStoreWorkerSessionActivation(
      { activated: true, pid: 123, package: installed("worker") },
      gui,
    );
    expect(ack.pid).toBe(123);
    expect(ack).not.toHaveProperty("creationTime");
    for (const pid of [0, -1, 1.5, 2147483648])
      expect(() =>
        parseStoreWorkerSessionActivation(
          { activated: true, pid, package: installed("worker") },
          gui,
        ),
      ).toThrow();
  });
  it("cannot import observations, override a method or construct a living code owner", async () => {
    const observed = parseStoreWorkerCodeObservation(fixture().wire, gui);
    expect(() =>
      Reflect.construct(StoreWorkerCodeAuthority, [
        Symbol("fake"),
        {},
        observed,
      ]),
    ).toThrow("STORE_AUTHORITY_DENIED");
    const open = vi.fn(async () => observed),
      activate = vi.fn(async () => ({
        activated: true,
        pid: 123,
        package: observed.package,
      })),
      forged = Object.assign(Object.create(StoreNativeAuthority.prototype), {
        openWorkerCode: open,
        activateWorkerSession: activate,
      });
    await expect(
      StoreNativeAuthority.prototype.openWorkerCode.call(forged),
    ).rejects.toThrow();
    await expect(
      StoreNativeAuthority.prototype.activateWorkerSession.call(
        forged,
        {} as StoreWorkerCodeAuthority,
      ),
    ).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    const readVault = vi.fn(async () => Buffer.from("{}"));
    await expect(
      readStoreReadiness(
        { native: { vaultRead: readVault } } as unknown as HostContext,
        Object.create(
          StoreWorkerCodeAuthority.prototype,
        ) as StoreWorkerCodeAuthority,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(readVault).not.toHaveBeenCalled();
    const transfer = vi.fn();
    await expect(
      prepareStoreModel(
        { native: { vaultRead: readVault } } as unknown as HostContext,
        Object.create(
          StoreWorkerCodeAuthority.prototype,
        ) as StoreWorkerCodeAuthority,
        new AbortController().signal,
        vi.fn(),
        { fetch: transfer },
      ),
    ).rejects.toThrow();
    expect(transfer).not.toHaveBeenCalled();
  });
});
