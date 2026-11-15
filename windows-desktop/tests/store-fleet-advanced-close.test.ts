import { beforeEach, expect, it, vi } from "vitest";
import type { StoreFleetAdvancedOptions } from "../src/main/fleet/advanced/store-factory.js";

// Synthetic private-module boundaries exercise the actual Store close sequence.
// These values are not native process, Store, backend or cleanup authority.
const boundary = vi.hoisted(() => {
  class Runtime {
    #held = false;
    setHeld(value: boolean) {
      this.#held = value;
    }
    mutationActive() {
      return this.#held;
    }
    async close() {
      if (this.#held) throw Error("ADVANCED_RECOVERY_REQUIRED");
      events.push("runtime-close");
    }
    static open() {
      return runtime;
    }
  }
  const runtime = new Runtime(),
    events: string[] = [],
    begin = vi.fn(async () => {
      events.push("fence");
    }),
    recover = vi.fn(async () => {
      events.push("recover");
      runtime.setHeld(false);
    }),
    businessClose = vi.fn(async () => {
      events.push("business-close");
    });
  return { Runtime, runtime, events, begin, recover, businessClose };
});
vi.mock("../src/main/fleet/advanced/store-runtime.js", () => ({
  StoreFleetAdvancedRuntime: boundary.Runtime,
}));
vi.mock("../src/main/fleet/advanced/factory.js", () => ({
  createFleetAdvancedBusiness: async () => ({
    controller: {
      beginRetirement: boundary.begin,
      execute: boundary.recover,
    },
    close: boundary.businessClose,
  }),
}));
import { createStoreFleetAdvanced } from "../src/main/fleet/advanced/store-factory.js";
import { DesktopShutdownCoordinator } from "../src/main/shutdown/coordinator.js";
const options = {
  host: {},
  operations: {},
  connection: { client: {} },
  maintenance: {},
  rebind: async () => {},
} as unknown as StoreFleetAdvancedOptions;
beforeEach(() => {
  vi.clearAllMocks();
  boundary.events.length = 0;
  boundary.runtime.setHeld(false);
  boundary.recover.mockImplementation(async () => {
    boundary.events.push("recover");
    boundary.runtime.setHeld(false);
  });
});
it("joins the original close and fences before disposal when no private Holding remains", async () => {
  const advanced = await createStoreFleetAdvanced(options);
  const original = advanced.close();
  expect(advanced.close()).toBe(original);
  await original;
  expect(boundary.events).toEqual(["fence", "business-close", "runtime-close"]);
  expect(advanced.close()).toBe(original);
  expect(boundary.recover).not.toHaveBeenCalled();
});
it("retains the failed close and performs exact existing recovery before disposing on an explicit retry", async () => {
  boundary.runtime.setHeld(true);
  const advanced = await createStoreFleetAdvanced(options),
    original = advanced.close();
  await expect(original).rejects.toThrow("ADVANCED_RECOVERY_REQUIRED");
  expect(boundary.businessClose).not.toHaveBeenCalled();
  expect(boundary.recover).not.toHaveBeenCalled();
  const retry = advanced.recoverClose();
  expect(advanced.close()).toBe(retry);
  await retry;
  expect(boundary.recover).toHaveBeenCalledExactlyOnceWith({ type: "RECOVER" });
  expect(boundary.events).toEqual([
    "fence",
    "fence",
    "recover",
    "business-close",
    "runtime-close",
  ]);
  await expect(original).rejects.toThrow("ADVANCED_RECOVERY_REQUIRED");
});
it("keeps recovery reachable after its original backend acknowledgement remains unknown", async () => {
  boundary.runtime.setHeld(true);
  const advanced = await createStoreFleetAdvanced(options),
    original = advanced.close(),
    unknown = Error("BACKEND_ACK_STILL_UNKNOWN");
  await expect(original).rejects.toThrow("ADVANCED_RECOVERY_REQUIRED");
  boundary.recover.mockRejectedValueOnce(unknown);
  await expect(advanced.recoverClose()).rejects.toBe(unknown);
  expect(boundary.businessClose).not.toHaveBeenCalled();
  expect(boundary.runtime.mutationActive()).toBe(true);
  await advanced.recoverClose();
  expect(boundary.recover).toHaveBeenCalledTimes(2);
  expect(boundary.businessClose).toHaveBeenCalledOnce();
});
it("does not dispose when recovery returns without settling the same Holding", async () => {
  boundary.runtime.setHeld(true);
  const advanced = await createStoreFleetAdvanced(options);
  await expect(advanced.close()).rejects.toThrow("ADVANCED_RECOVERY_REQUIRED");
  boundary.recover.mockResolvedValueOnce(undefined);
  await expect(advanced.recoverClose()).rejects.toThrow(
    "ADVANCED_RECOVERY_REQUIRED",
  );
  expect(boundary.businessClose).not.toHaveBeenCalled();
});
it("keeps genuine control dependencies alive across pending business cleanup before ordered shutdown release", async () => {
  boundary.runtime.setHeld(true);
  const advanced = await createStoreFleetAdvanced(options),
    controlClose = vi.fn(async () => {
      boundary.events.push("control-close");
    }),
    codeClose = vi.fn(async () => {
      boundary.events.push("code-close");
    }),
    shutdown = new DesktopShutdownCoordinator({
      fence: () => {},
      cancel: () => [],
      settle: async () => {},
      cleanup: () => [advanced.close],
      assertIdle: () => {
        if (boundary.runtime.mutationActive()) throw Error("NOT_RETIRED");
      },
      release: () => [controlClose, codeClose],
    });
  expect((await shutdown.begin()).phase).toBe("pending");
  expect(controlClose).not.toHaveBeenCalled();
  expect(codeClose).not.toHaveBeenCalled();
  expect((await shutdown.retry()).phase).toBe("complete");
  expect(boundary.events).toEqual([
    "fence",
    "fence",
    "recover",
    "business-close",
    "runtime-close",
    "control-close",
    "code-close",
  ]);
  expect(controlClose).toHaveBeenCalledOnce();
  expect(codeClose).toHaveBeenCalledOnce();
});
