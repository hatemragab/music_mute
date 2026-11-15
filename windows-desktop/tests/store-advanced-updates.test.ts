import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
// Synthetic private module boundaries. No fixture proves a public product,
// installed Store package, Windows update or native deployment authority.
const boundary = vi.hoisted(() => {
  class Authority {
    #live = true;
    creatorProof() {
      if (!this.#live) throw Error("FIXTURE_CLOSED");
    }
    inspectWorker() {
      this.creatorProof();
      return inspect();
    }
    close() {
      this.#live = false;
    }
  }
  const inspect = vi.fn(async () => ({ version: 1, state: "missing" })),
    open = vi.fn(async (_destination: string) => {}),
    owners = new WeakMap<object, Authority>();
  return { Authority, inspect, open, owners };
});
vi.mock("../src/main/browser/store-native.js", () => ({
  StoreNativeAuthority: boundary.Authority,
  storeAuthorityForDataNative: (native: object) => boundary.owners.get(native),
}));
vi.mock("electron", () => ({ shell: { openExternal: boundary.open } }));
import { StoreFleetAdvancedUpdates } from "../src/main/update/store-advanced.js";
import { createFleetAdvancedUpdateDispatch } from "../src/main/update/advanced-dispatch.js";
import { ConsumerUpdateLifecycle } from "../src/main/update/desktop-lifecycle.js";

const electronDescriptor = Object.getOwnPropertyDescriptor(
    process.versions,
    "electron",
  ),
  product = "https://apps.microsoft.com/detail/9P4GXB0NRJDG";
beforeEach(() => {
  vi.clearAllMocks();
  boundary.open.mockResolvedValue(undefined);
  Object.defineProperty(process.versions, "electron", {
    value: "44.7.0",
    configurable: true,
  });
});
afterEach(() => {
  if (electronDescriptor)
    Object.defineProperty(process.versions, "electron", electronDescriptor);
  else Reflect.deleteProperty(process.versions, "electron");
});
function fixture() {
  const authority = new boundary.Authority(),
    native = {},
    host = { native, storeAuthority: authority } as unknown as HostContext;
  boundary.owners.set(native, authority);
  return {
    authority,
    host,
    native,
    updates: StoreFleetAdvancedUpdates.open(host),
  };
}
it("opens only the actual fixed Worker Store destination for check/install/recover without claiming an available or installed version", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  for (const view of [
    await f.updates.check(signal),
    await f.updates.install(signal, "catalog"),
    await f.updates.recover(signal),
  ]) {
    expect(view).toEqual({
      distribution: "microsoft-store",
      phase: "idle",
      available: null,
      required: false,
      automaticDiscovery: false,
      problem: null,
    });
    expect(view).not.toHaveProperty("scope");
  }
  expect(boundary.open.mock.calls).toEqual([[product], [product], [product]]);
  expect(boundary.inspect).toHaveBeenCalledTimes(3);
});
it("uses the same Advanced lifecycle and returns explicit Store management through the actual class prototype", async () => {
  const f = fixture(),
    lifecycle = new ConsumerUpdateLifecycle(),
    resolver = vi.fn(async () => f.updates),
    dispatch = createFleetAdvancedUpdateDispatch({
      lifecycle,
      resolveUpdates: resolver,
    }),
    override = vi.fn();
  expect(() =>
    Object.defineProperty(f.updates, "check", { value: override }),
  ).toThrow();
  // Production objects are frozen; prototype dispatch itself is tested below
  // through the real class rather than an injected success port.
  const checking = dispatch.updates.check(new AbortController().signal);
  await expect(checking).resolves.toMatchObject({
    distribution: "microsoft-store",
    available: null,
  });
  expect(override).not.toHaveBeenCalled();
  expect(lifecycle.busy()).toBe(true);
  await dispatch.settle(async () => {});
  expect(lifecycle.busy()).toBe(false);
});
it("refuses lost authority, forged class state, arbitrary source and forced installer reviews before external effects", async () => {
  const f = fixture(),
    signal = new AbortController().signal;
  expect(() =>
    StoreFleetAdvancedUpdates.open({ ...f.host, native: {} } as HostContext),
  ).toThrow("STORE_UPDATE_DENIED");
  expect(() =>
    StoreFleetAdvancedUpdates.prototype.check.call(
      Object.create(StoreFleetAdvancedUpdates.prototype),
      signal,
    ),
  ).toThrow();
  await expect(
    f.updates.check(signal, "https://evil.invalid" as never),
  ).rejects.toThrow("STORE_UPDATE_DENIED");
  expect(() =>
    f.updates.install(signal, "app", {
      transaction: "12345678-1234-4234-8234-123456789012",
      machineId: "23456789-1234-4234-8234-123456789012",
      authority: "a".repeat(64),
      force: true,
      expectedRevision: 1,
    }),
  ).toThrow("STORE_UPDATE_DENIED");
  f.authority.close();
  await expect(f.updates.recover(signal)).rejects.toThrow("FIXTURE_CLOSED");
  expect(boundary.open).not.toHaveBeenCalled();
});
it("retains an external-open failure for the Advanced caller instead of inventing update completion", async () => {
  const f = fixture(),
    original = Error("STORE_PRODUCT_OPEN_FAILED");
  boundary.open.mockRejectedValueOnce(original);
  await expect(f.updates.install(new AbortController().signal)).rejects.toBe(
    original,
  );
  expect(boundary.open).toHaveBeenCalledExactlyOnceWith(product);
});
