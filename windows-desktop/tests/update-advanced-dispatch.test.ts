import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  WindowsFleetAdvancedController,
  type AdvancedJournal,
  type FleetAdvancedPorts,
} from "../src/main/fleet/advanced/controller.js";
import { createFleetAdvancedUpdateDispatch } from "../src/main/update/advanced-dispatch.js";
import { ConsumerUpdateLifecycle } from "../src/main/update/desktop-lifecycle.js";
import { fleetSid } from "./fleet-fixtures.js";
import type { ConsumerUpdateView } from "../src/shared/update-contracts.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let journal: AdvancedJournal | null = null;
  const view: ConsumerUpdateView = {
    phase: "complete",
    available: null,
    required: false,
    automaticDiscovery: false,
    problem: null,
  };
  const lifecycle = new ConsumerUpdateLifecycle(),
    methods = {
      check: vi.fn(async () => view),
      install: vi.fn(async (_signal: AbortSignal) => view),
      recover: vi.fn(async () => view),
    },
    resolve = vi.fn(async () => methods),
    dispatch = createFleetAdvancedUpdateDispatch({
      lifecycle,
      resolveUpdates: resolve,
    }),
    ports: FleetAdvancedPorts = {
      identity: async () => ({
        sid: fleetSid,
        machineId: "11111111-1111-4111-8111-111111111111",
        revision: 1,
        digest: "a".repeat(64),
      }),
      journal: {
        read: async () => journal,
        write: vi.fn(async (next) => {
          journal = structuredClone(next);
        }),
      },
      maintenance: {
        acquire: vi.fn(async () => ({ release: async () => {} })),
        cancel: vi.fn(async () => {}),
      },
      read: async () => ({ status: "available" }),
      previewCleanup: async () => ({ bytes: 0 }),
      export: async () => {},
      updateCheck: (signal) => dispatch.updates.check(signal),
      mutate: (_mutation, _identity, _transaction, signal) =>
        dispatch.updates.install(signal),
      recover: (_journal, signal) => dispatch.updates.recover(signal),
    },
    controller = new WindowsFleetAdvancedController(ports);
  const run = (command: unknown) =>
    dispatch.executeCommand(() => controller.execute(command));
  return {
    lifecycle,
    dispatch,
    methods,
    resolve,
    ports,
    controller,
    view,
    run,
    journal: () => journal,
  };
}
async function confirm(f: ReturnType<typeof fixture>) {
  await f.run({ type: "CONFIRM", mutation: { action: "update" } });
  return f.controller.snapshot().confirmation!.token;
}

it("waits Advanced durable completion before actual controller disposal/rebind and keeps one update reservation", async () => {
  const f = fixture(),
    install = deferred(),
    afterUpdater = deferred(),
    token = await confirm(f),
    originalWrite = f.ports.journal.write;
  let retirementDeferred = false;
  const onSessionRetired = vi.fn(async () => {
    if (f.dispatch.commandActive()) {
      retirementDeferred = true;
      return;
    }
    await f.controller.dispose();
  });
  f.methods.install.mockImplementationOnce(async () => {
    await install.promise;
    // Production updater already proves native retirement, but its Main callback
    // must defer app factory disposal while this outer controller is active.
    expect(f.dispatch.commandActive()).toBe(true);
    await onSessionRetired();
    return f.view;
  });
  f.ports.journal.write = vi.fn(async (journal) => {
    if (journal.phase === "effect-confirmed") await afterUpdater.promise;
    await originalWrite(journal);
  });
  const run = f.run({ type: "RUN", confirmation: token });
  await vi.waitFor(() => expect(f.methods.install).toHaveBeenCalledOnce());
  expect(f.lifecycle.busy()).toBe(true);
  const rebind = vi.fn(async () => {
    expect(f.controller.snapshot().phase).toBe("complete");
    expect(f.journal()?.phase).toBe("complete");
    expect(f.dispatch.commandActive()).toBe(false);
    expect(retirementDeferred).toBe(true);
    await f.controller.dispose();
  });
  const settled = f.dispatch.settle(rebind);
  install.resolve();
  await vi.waitFor(() => expect(f.lifecycle.commandActive()).toBe(false));
  expect(onSessionRetired).toHaveBeenCalledOnce();
  expect(f.lifecycle.busy()).toBe(true);
  expect(rebind).not.toHaveBeenCalled();
  afterUpdater.resolve();
  await run;
  await settled;
  expect(rebind).toHaveBeenCalledOnce();
  expect(f.lifecycle.busy()).toBe(false);
  expect(f.dispatch.needsSettlement()).toBe(false);
  expect(f.ports.maintenance.acquire).not.toHaveBeenCalled();
  expect(f.ports.maintenance.cancel).not.toHaveBeenCalled();
});

it("uses the same configured updater for check, explicit install and pending recovery without another Advanced maintenance lease", async () => {
  const f = fixture();
  await f.run({ type: "UPDATE_CHECK" });
  expect(f.methods.check).toHaveBeenCalledOnce();
  await f.dispatch.settle(async () => {});
  const token = await confirm(f);
  f.methods.install.mockRejectedValueOnce(
    new Error("UPDATE_RECOVERY_REQUIRED"),
  );
  await expect(f.run({ type: "RUN", confirmation: token })).rejects.toThrow(
    "UPDATE_RECOVERY_REQUIRED",
  );
  expect(f.controller.snapshot().phase).toBe("recovery");
  expect(f.lifecycle.busy()).toBe(true);
  await f.dispatch.settle(async () => {});
  await f.run({ type: "RECOVER" });
  await f.dispatch.settle(async () => {});
  expect(f.methods.recover).toHaveBeenCalledOnce();
  expect(f.journal()?.phase).toBe("complete");
  expect(f.ports.maintenance.acquire).not.toHaveBeenCalled();
  expect(f.ports.maintenance.cancel).not.toHaveBeenCalled();
});
it("CANCEL waits actual updater teardown and Advanced journal/finally before retirement; readonly commands never get the own-update exemption", async () => {
  const f = fixture(),
    cleanup = deferred(),
    token = await confirm(f);
  f.methods.install.mockImplementationOnce(async (signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await cleanup.promise;
    throw new Error("UPDATE_CANCELLED");
  });
  const running = f.run({ type: "RUN", confirmation: token });
  const failed = expect(running).rejects.toThrow("UPDATE_CANCELLED");
  await vi.waitFor(() => expect(f.methods.install).toHaveBeenCalledOnce());
  expect(f.dispatch.updateCommandActive()).toBe(true);
  const cancel = f.run({ type: "CANCEL" }),
    cancelled = expect(cancel).rejects.toThrow("UPDATE_CANCELLED"),
    retire = vi.fn(async () => {
      expect(f.dispatch.commandActive()).toBe(false);
      expect(f.journal()?.phase).toBe("running");
      expect(f.controller.snapshot().phase).toBe("recovery");
      await f.controller.dispose();
    });
  const settled = f.dispatch.settle(retire);
  await Promise.resolve();
  expect(retire).not.toHaveBeenCalled();
  expect(f.lifecycle.busy()).toBe(true);
  cleanup.resolve();
  await Promise.all([failed, cancelled, settled]);
  expect(retire).toHaveBeenCalledOnce();
  expect(f.dispatch.updateCommandActive()).toBe(false);
  const readonly = fixture();
  await readonly.run({ type: "READ", section: "status" });
  expect(readonly.dispatch.updateCommandActive()).toBe(false);
});

it("deduplicates settlement, retains failed retirement for retry and blocks another updater until settled", async () => {
  const f = fixture();
  await f.run({ type: "UPDATE_CHECK" });
  const retirement = deferred(),
    work = vi.fn(async () => {
      await retirement.promise;
      throw new Error("UPDATE_RECOVERY_REQUIRED");
    }),
    first = f.dispatch.settle(work),
    duplicate = f.dispatch.settle(async () => {
      throw new Error("DUPLICATE_REBIND");
    });
  expect(duplicate).toBe(first);
  const failed = expect(first).rejects.toThrow("UPDATE_RECOVERY_REQUIRED");
  retirement.resolve();
  await failed;
  expect(f.dispatch.needsSettlement()).toBe(true);
  await expect(
    f.dispatch.updates.check(new AbortController().signal),
  ).rejects.toThrow("UPDATE_BUSY");
  const retry = vi.fn(async () => {});
  await f.dispatch.settle(retry);
  expect(retry).toHaveBeenCalledOnce();
  expect(f.dispatch.needsSettlement()).toBe(false);
});

it("refuses unavailable configuration/aborted authorization and cannot settle an unrelated desktop reservation", async () => {
  const lifecycle = new ConsumerUpdateLifecycle(),
    resolveUpdates = vi.fn(async () => null),
    dispatch = createFleetAdvancedUpdateDispatch({ lifecycle, resolveUpdates }),
    signal = new AbortController().signal;
  await expect(dispatch.updates.check(signal)).rejects.toThrow(
    "UPDATE_UNAVAILABLE",
  );
  expect(dispatch.needsSettlement()).toBe(true);
  await dispatch.settle(async () => {});
  const abort = new AbortController();
  abort.abort(new Error("UPDATE_CANCELLED"));
  await expect(dispatch.updates.install(abort.signal)).rejects.toThrow(
    "UPDATE_CANCELLED",
  );
  expect(resolveUpdates).toHaveBeenCalledOnce();
  await dispatch.settle(async () => {});
  const held = deferred(),
    external = lifecycle.execute(() => held.promise);
  await expect(dispatch.updates.recover(signal)).rejects.toThrow("UPDATE_BUSY");
  const unrelatedRebind = vi.fn(async () => {});
  await dispatch.settle(unrelatedRebind);
  expect(unrelatedRebind).not.toHaveBeenCalled();
  expect(lifecycle.busy()).toBe(true);
  held.resolve();
  await external;
  await lifecycle.settle(async () => {});
});

it("readonly Advanced commands do not acquire or settle update authority", async () => {
  const f = fixture();
  await f.run({ type: "READ", section: "status" });
  await f.run({ type: "EXPORT", destinationCapability: randomUUID() });
  const rebind = vi.fn(async () => {});
  await f.dispatch.settle(rebind);
  expect(rebind).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.lifecycle.busy()).toBe(false);
});
