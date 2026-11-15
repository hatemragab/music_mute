import { expect, it, vi } from "vitest";
import {
  DesktopPreparationLifecycle,
  desktopAutomaticPreparationAllowed,
  type DesktopAutomaticPrepareState,
  type DesktopPrepareOwner,
} from "../src/main/prepare/desktop-lifecycle.js";
import {
  PrepareController,
  type PreparationOperations,
  type PrepareJournal,
} from "../src/main/prepare/controller.js";
import {
  PrepareMaintenance,
  PREPARE_MAINTENANCE_KEY,
} from "../src/main/prepare/maintenance.js";
import { DesktopMaintenanceGate } from "../src/main/maintenance-gate.js";
import type { HostContext } from "../src/main/host-context.js";
import { PREPARE_STAGES } from "../src/shared/prepare-contracts.js";
import { target } from "./fixtures/prepare.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const allowedStartup: DesktopAutomaticPrepareState = {
  headless: false,
  closing: false,
  configured: true,
  updateBusy: false,
  fleetRecoveryBusy: false,
  updateBlocked: false,
  fleetRecoveryInvalid: false,
  maintenanceReserved: false,
  prepareBusy: false,
};
it.each(Object.keys(allowedStartup) as (keyof DesktopAutomaticPrepareState)[])(
  "uses the actual Main startup %s gate before any local Prepare effects",
  async (key) => {
    const f = fixture();
    const state = { ...allowedStartup, [key]: !allowedStartup[key] };
    expect(
      f.lifecycle.startAutomatic(f.owner, () =>
        desktopAutomaticPreparationAllowed(state),
      ),
    ).toBeNull();
    expect(f.owner.start).not.toHaveBeenCalled();
    expect(f.operations.perform).not.toHaveBeenCalled();
    expect(f.vault.size).toBe(0);
    await f.lifecycle.close();
  },
);
function fixture(warm = false) {
  const lifecycle = new DesktopPreparationLifecycle();
  const events: string[] = [],
    vault = new Map<string, Buffer>();
  let record: PrepareJournal | null = warm
    ? {
        version: 1,
        transaction: "11111111-1111-4111-8111-111111111111",
        target: target.identity,
        sid: target.sid,
        state: "complete",
        completed: [...PREPARE_STAGES],
      }
    : null;
  let current = true;
  const reservation = { assertIdle: vi.fn(), release: vi.fn() };
  const gate = new DesktopMaintenanceGate({
    idle: () => true,
    reserve: () => reservation,
    changed: () => {},
  });
  const host = {
    identity: { sid: target.sid, sessionId: 1 },
    native: {
      vaultRead: async (namespace: string, key: string) => {
        const value = vault.get(`${namespace}/${key}`);
        return value ? Buffer.from(value) : null;
      },
      vaultWrite: async (namespace: string, key: string, value: Buffer) => {
        events.push(`persist:${key}`);
        vault.set(`${namespace}/${key}`, Buffer.from(value));
      },
      vaultDelete: async (namespace: string, key: string) => {
        events.push(`retire:${key}`);
        vault.delete(`${namespace}/${key}`);
      },
    },
  } as unknown as HostContext;
  const maintenance = new PrepareMaintenance({
    host,
    gate,
    native: {
      inspectSingletonOwner: vi.fn(async () => ({
        state: "absent" as const,
        owner: null,
        sameSession: false as const,
      })),
      waitProcessExit: vi.fn(async () => true),
      processIdentity: async (pid) => ({
        sid: target.sid,
        sessionId: 1,
        pid,
        creationTime: "100",
      }),
    },
    attachExisting: async () => {
      throw new Error("NO_SESSION_EXPECTED");
    },
    retireHandles: async () => {
      events.push("retire-handles");
    },
  });
  const setupRelease = vi.fn(async () => {
    events.push("setup-release");
  });
  const operations: PreparationOperations = {
    target: async () => target,
    cachedReady: vi.fn(async () => warm),
    lock: async () => ({ release: setupRelease }),
    space: async () => ({ requiredBytes: 1, availableBytes: 10 }),
    reuse: async () => false,
    perform: vi.fn(async (stage) => {
      events.push(`stage:${stage}`);
    }),
    verifyReady: async () => true,
    registerBrowser: async () => true,
    cancelOwned: async () => {
      events.push("cancel-owned");
    },
    repair: async () => {},
  };
  const controller = new PrepareController(
    operations,
    {
      read: async () => (record ? structuredClone(record) : null),
      write: async (next) => {
        record = structuredClone(next);
      },
    },
    maintenance,
  );
  const owner: DesktopPrepareOwner = {
    current: () => current,
    start: vi.fn(() => controller.start()),
    cancel: () => controller.cancel(),
    settle: vi.fn((task, rebind) => maintenance.settle(task, rebind)),
    rebind: [
      async () => {
        expect(maintenance.authorizesRebind()).toBe(true);
        events.push("browser-rebind");
      },
      async () => {
        events.push("updater-rebind");
      },
    ],
    ready: vi.fn(() => {
      events.push("fleet-recovery-request");
    }),
    failed: vi.fn(),
    setup: vi.fn(() => {
      events.push("automatic-setup-view");
    }),
  };
  controller.subscribe((view) => lifecycle.project(owner, view));
  return {
    lifecycle,
    controller,
    maintenance,
    gate,
    vault,
    events,
    operations,
    owner,
    setupRelease,
    replace: () => {
      current = false;
    },
  };
}
it("joins actual Main lifecycle, Controller and maintenance gate once for cold automatic Prepare before recovery", async () => {
  const f = fixture();
  expect(f.lifecycle.startAutomatic(f.owner, () => false)).toBeNull();
  expect(f.owner.start).not.toHaveBeenCalled();
  const automatic = f.lifecycle.startAutomatic(f.owner, () => true);
  expect(automatic).not.toBeNull();
  expect(f.lifecycle.startAutomatic(f.owner, () => true)).toBeNull();
  await automatic;
  expect(f.owner.start).toHaveBeenCalledOnce();
  expect(f.owner.setup).toHaveBeenCalledOnce();
  expect(f.controller.view().state).toBe("ready");
  expect(f.events.filter((event) => event.startsWith("stage:"))).toEqual(
    PREPARE_STAGES.map((stage) => `stage:${stage}`),
  );
  expect(f.events.indexOf("setup-release")).toBeLessThan(
    f.events.indexOf("browser-rebind"),
  );
  expect(f.events.indexOf(`retire:${PREPARE_MAINTENANCE_KEY}`)).toBeLessThan(
    f.events.indexOf("browser-rebind"),
  );
  expect(f.events.slice(-3)).toEqual([
    "browser-rebind",
    "updater-rebind",
    "fleet-recovery-request",
  ]);
  expect(f.gate.reserved()).toBe(false);
  expect(f.maintenance.busy()).toBe(false);
  expect(f.lifecycle.activity().idle).toBe(true);
  await f.lifecycle.close();
});
it("warm automatic Ready performs no mutation/rebind and waits the real Setup release before recovery", async () => {
  const f = fixture(true),
    held = deferred();
  f.setupRelease.mockImplementation(async () => {
    f.events.push("setup-release-pending");
    await held.promise;
    f.events.push("setup-release");
  });
  const automatic = f.lifecycle.startAutomatic(f.owner, () => true);
  await vi.waitFor(() => expect(f.setupRelease).toHaveBeenCalledOnce());
  expect(f.controller.view().state).toBe("preparing");
  expect(f.owner.ready).not.toHaveBeenCalled();
  expect(f.lifecycle.activity().idle).toBe(false);
  expect(f.operations.perform).not.toHaveBeenCalled();
  expect(f.owner.setup).not.toHaveBeenCalled();
  expect(f.vault.has(`account/${PREPARE_MAINTENANCE_KEY}`)).toBe(false);
  held.resolve();
  await automatic;
  expect(f.owner.ready).toHaveBeenCalledOnce();
  expect(f.events).toEqual([
    "setup-release-pending",
    "setup-release",
    "fleet-recovery-request",
  ]);
  await f.lifecycle.close();
});
it("holds the real completion through asynchronous rebind and skips later effects for a replaced authority", async () => {
  const f = fixture(),
    held = deferred();
  f.owner.rebind = [
    async () => {
      f.events.push("browser-rebind-pending");
      await held.promise;
    },
    async () => {
      f.events.push("updater-rebind");
    },
  ];
  const automatic = f.lifecycle.startAutomatic(f.owner, () => true);
  await vi.waitFor(() => expect(f.events).toContain("browser-rebind-pending"));
  let settled = false;
  const waiting = f.lifecycle.wait().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.maintenance.authorizesRebind()).toBe(true);
  f.replace();
  held.resolve();
  await automatic;
  await waiting;
  expect(f.events).not.toContain("updater-rebind");
  expect(f.owner.ready).not.toHaveBeenCalled();
  expect(f.maintenance.busy()).toBe(false);
  await f.lifecycle.close();
});
it("shutdown fences startup and waits an admitted real Controller without a late rebind or recovery launch", async () => {
  const f = fixture(),
    held = deferred();
  f.operations.perform = vi.fn(async (stage, _target, signal) => {
    if (stage === "runtime") {
      f.events.push("runtime-held");
      await held.promise;
      signal.throwIfAborted();
    }
  });
  const automatic = f.lifecycle.startAutomatic(f.owner, () => true);
  await vi.waitFor(() => expect(f.events).toContain("runtime-held"));
  let closed = false;
  const closing = f.lifecycle.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(f.lifecycle.startAutomatic(f.owner, () => true)).toBeNull();
  held.resolve();
  await automatic;
  await closing;
  expect(f.owner.ready).not.toHaveBeenCalled();
  expect(f.events).not.toContain("browser-rebind");
  expect(f.lifecycle.activity().idle).toBe(true);
  expect(f.controller.isRunning()).toBe(false);
});
it("manual cancellation suppresses automatic intake and duplicate observation uses one captured helper", async () => {
  const f = fixture(true);
  f.lifecycle.suppressAutomatic();
  expect(f.lifecycle.startAutomatic(f.owner, () => true)).toBeNull();
  const task = f.controller.start();
  const first = f.lifecycle.observe(task, f.owner);
  expect(f.lifecycle.observe(task, f.owner)).toBe(first);
  await first;
  expect(f.owner.settle).toHaveBeenCalledOnce();
  expect(f.owner.ready).toHaveBeenCalledOnce();
  await f.lifecycle.close();
});
it("retains one exact failed owner across retries until positive cleanup, without rebind after shutdown", async () => {
  const f = fixture(true);
  let allowed = false;
  f.owner.settle = vi.fn(async (_task, rebind) => {
    if (!allowed) throw new Error("LEASE_RELEASE_UNKNOWN");
    await rebind();
  });
  for (let i = 0; i < 10; i++)
    await f.lifecycle.observe(Promise.resolve(f.controller.view()), f.owner);
  expect(f.lifecycle.activity()).toEqual({
    pending: 0,
    retained: 1,
    idle: false,
  });
  await expect(f.lifecycle.close()).rejects.toThrow("PREPARE_INTERRUPTED");
  expect(f.owner.ready).not.toHaveBeenCalled();
  allowed = true;
  await f.lifecycle.close();
  expect(f.events).not.toContain("browser-rebind");
  expect(f.lifecycle.activity().idle).toBe(true);
});
it("one cancellation throw cannot prevent another captured owner's actual cancellation", async () => {
  const lifecycle = new DesktopPreparationLifecycle(),
    a = fixture(true),
    b = fixture(true),
    hold = deferred();
  a.owner.cancel = () => {
    throw new Error("UNCONFIRMED");
  };
  b.owner.cancel = vi.fn(async () => {});
  const task = hold.promise.then(() => a.controller.view());
  lifecycle.observe(task, a.owner);
  const other = hold.promise.then(() => b.controller.view());
  lifecycle.observe(other, b.owner);
  await expect(lifecycle.cancel()).rejects.toThrow("PREPARE_INTERRUPTED");
  expect(b.owner.cancel).toHaveBeenCalledOnce();
  hold.resolve();
  await lifecycle.wait();
  a.owner.cancel = async () => {};
  await lifecycle.close();
});
