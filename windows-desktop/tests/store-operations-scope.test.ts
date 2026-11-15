import { expect, it, vi } from "vitest";
import { StorePreparationOperations } from "../src/main/prepare/store-operations.js";
import { StoreNativeAuthority } from "../src/main/browser/store-native.js";
import type { HostContext } from "../src/main/host-context.js";

it("cannot turn caller observations or an overridden factory into living Store preparation authority", async () => {
  const injected = vi.fn(async () => ({ observation: { signatureKind: 3 } })),
    authority = Object.assign(Object.create(StoreNativeAuthority.prototype), {
      openWorkerCode: injected,
    }),
    host = { storeAuthority: authority, native: {} } as unknown as HostContext,
    options = {
      assertMutation: vi.fn(async () => {}),
      registerBrowser: vi.fn(async () => true),
      verifyBrowser: vi.fn(async () => true),
    };
  await expect(
    StorePreparationOperations.open(host, options),
  ).rejects.toThrow();
  expect(injected).not.toHaveBeenCalled();
  expect(options.assertMutation).not.toHaveBeenCalled();
  expect(() =>
    Reflect.construct(StorePreparationOperations, [
      Symbol("caller"),
      host,
      { observation: { signatureKind: 3 } },
      options,
    ]),
  ).toThrow("STORE_PREPARATION_DENIED");
});
it("refuses accessor callbacks and forged preparation instances before they can mutate data", async () => {
  const getter = vi.fn(() => async () => {}),
    options = {
      registerBrowser: async () => true,
      verifyBrowser: async () => true,
    };
  Object.defineProperty(options, "assertMutation", {
    enumerable: true,
    get: getter,
  });
  await expect(
    StorePreparationOperations.open(
      { storeAuthority: {} } as unknown as HostContext,
      options as never,
    ),
  ).rejects.toThrow("STORE_PREPARATION_DENIED");
  expect(getter).not.toHaveBeenCalled();
  const forged = Object.create(StorePreparationOperations.prototype);
  await expect(
    StorePreparationOperations.prototype.target.call(
      forged,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(() =>
    StorePreparationOperations.prototype.close.call(forged),
  ).toThrow();
});
it("refuses accessor activation options and forged control owners without running the accessor", async () => {
  const forged = Object.create(StorePreparationOperations.prototype),
    getter = vi.fn(() => true),
    options = {};
  Object.defineProperty(options, "launchIfAbsent", {
    enumerable: true,
    get: getter,
  });
  await expect(
    StorePreparationOperations.prototype.controlSession.call(
      forged,
      new AbortController().signal,
      options,
    ),
  ).rejects.toThrow("STORE_PREPARATION_DENIED");
  expect(getter).not.toHaveBeenCalled();
  await expect(
    StorePreparationOperations.prototype.controlSession.call(
      forged,
      new AbortController().signal,
      { launchIfAbsent: false },
    ),
  ).rejects.toThrow();
});
