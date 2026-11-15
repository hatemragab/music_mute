import { expect, it, vi } from "vitest";
import type { ConsumerProcessIdentity } from "../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../src/main/host-context.js";
import { DesktopMaintenanceGate } from "../src/main/maintenance-gate.js";
import {
  PrepareMaintenance,
  PREPARE_MAINTENANCE_KEY,
} from "../src/main/prepare/maintenance.js";
import {
  PrepareController,
  type PreparationOperations,
  type PrepareJournal,
} from "../src/main/prepare/controller.js";
import type { SessionPersistentState } from "../src/main/session/supervisor.js";
import type {
  SessionCommand,
  SessionSnapshot,
} from "../src/shared/session-contracts.js";
import { PREPARE_STAGES } from "../src/shared/prepare-contracts.js";
import { target, sid } from "./fixtures/prepare.js";

const owner: ConsumerProcessIdentity = {
    sid,
    sessionId: 1,
    pid: process.pid,
    creationTime: "100",
  },
  authority: ConsumerProcessIdentity = {
    sid,
    sessionId: 1,
    pid: 440,
    creationTime: "200",
  };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture(active = false) {
  const vault = new Map<string, Buffer>(),
    events: string[] = [];
  let sessionActive = active,
    exactExit = !active,
    draining = false,
    oldOwner: ConsumerProcessIdentity | null = null;
  const state: SessionPersistentState = {
    version: 1,
    sid,
    revision: 1,
    fleetIntent: "running",
    restartPending: false,
    maintenance: null,
    owner: active ? { identity: authority, nonce: "d".repeat(64) } : null,
    budgets: {
      personal: { attempts: 0, nextStartAt: 0, blocked: false },
      fleet: { attempts: 0, nextStartAt: 0, blocked: false },
    },
    receipts: [],
  };
  const saveState = () =>
    vault.set("fleet/session_state", Buffer.from(JSON.stringify(state)));
  if (active) saveState();
  const snapshot = (): SessionSnapshot => ({
    version: 1,
    instance_id: "121f38cf-1024-43d1-bd11-c45bf155250c",
    release: target.identity,
    revision: state.revision,
    phase: sessionActive ? "running" : "logged-out",
    fleet: {
      intent: state.fleetIntent,
      phase: sessionActive ? "draining" : "stopped",
      problem: null,
    },
    personal: { owners: 0, phase: "stopped", problem: null },
    startup: "registered",
    maintenance: state.maintenance
      ? {
          transaction: state.maintenance.transaction,
          phase: state.maintenance.idle ? "idle" : "draining",
        }
      : null,
  });
  let wait = deferred();
  const command = vi.fn(async (cmd: SessionCommand, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    events.push(cmd.action);
    state.revision++;
    if (cmd.action === "maintenance_begin")
      state.maintenance = {
        transaction: cmd.transaction,
        peer: owner,
        idle: !draining,
      };
    if (cmd.action === "maintenance_end") state.maintenance = null;
    if (cmd.action === "maintenance_commit") {
      state.maintenance = null;
      state.owner = null;
      sessionActive = false;
    }
    saveState();
    return snapshot();
  });
  const waitState = vi.fn(
    async (_after: number, _instance?: string, signal?: AbortSignal) => {
      events.push("wait-change");
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        void wait.promise.then(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        });
        if (signal?.aborted) abort();
      });
      signal?.throwIfAborted();
      return snapshot();
    },
  );
  const close = vi.fn(async () => {
    events.push("passive-close");
  });
  const attachExisting = vi.fn(async () => ({
    client: { command, waitState, currentAuthority: () => authority },
    close,
  }));
  const vaultDelete = vi.fn(async (_scope: string, key: string) => {
    events.push(`delete:${key}`);
    vault.delete(`account/${key}`);
  });
  const native = {
    processIdentity: vi.fn(async (pid: number) =>
      pid === process.pid
        ? owner
        : pid === oldOwner?.pid
          ? oldOwner
          : pid === authority.pid && sessionActive
            ? authority
            : null,
    ),
    inspectSingletonOwner: vi.fn(async () =>
      sessionActive
        ? { state: "active" as const, owner: authority, sameSession: true }
        : {
            state: "absent" as const,
            owner: null,
            sameSession: false as const,
          },
    ),
    waitProcessExit: vi.fn(async (expected: ConsumerProcessIdentity) => {
      events.push("exact-exit");
      expect(expected).toEqual(authority);
      return exactExit;
    }),
  };
  const host = {
    identity: { sid, sessionId: 1 },
    native: {
      vaultRead: async (scope: string, key: string) =>
        vault.has(`${scope}/${key}`)
          ? Buffer.from(vault.get(`${scope}/${key}`)!)
          : null,
      vaultWrite: vi.fn(async (scope: string, key: string, bytes: Buffer) => {
        events.push(`write:${key}`);
        vault.set(`${scope}/${key}`, Buffer.from(bytes));
      }),
      vaultDelete,
    },
  } as unknown as HostContext;
  const reservation = { assertIdle: vi.fn(), release: vi.fn() },
    idle = vi.fn((_allowed: number) => true),
    gate = new DesktopMaintenanceGate({
      idle,
      reserve: () => reservation,
      changed: () => {},
    }),
    retireHandles = vi.fn(async () => {
      events.push("retire-handles");
    }),
    maintenance = new PrepareMaintenance({
      host,
      native,
      gate,
      attachExisting,
      retireHandles,
    });
  const stored = () =>
    JSON.parse(
      vault.get(`account/${PREPARE_MAINTENANCE_KEY}`)!.toString(),
    ) as Record<string, unknown>;
  return {
    host,
    native,
    gate,
    maintenance,
    vault,
    stored,
    events,
    command,
    waitState,
    close,
    attachExisting,
    retireHandles,
    reservation,
    idle,
    vaultDelete,
    setExit: (value: boolean) => {
      exactExit = value;
    },
    setDraining: (value: boolean) => {
      draining = value;
    },
    drain: () => {
      draining = false;
      state.revision++;
      state.maintenance!.idle = true;
      saveState();
      wait.resolve();
      wait = deferred();
    },
    seed: (
      phase: string,
      peer: ConsumerProcessIdentity,
      session: ConsumerProcessIdentity | null = active ? authority : null,
    ) => {
      vault.set(
        `account/${PREPARE_MAINTENANCE_KEY}`,
        Buffer.from(
          JSON.stringify({
            version: 1,
            sid,
            transaction: "241f38cf-1024-43d1-bd11-c45bf155250c",
            target: target.identity,
            owner: peer,
            authority: session,
            phase,
          }),
        ),
      );
    },
    setOldOwner: (value: ConsumerProcessIdentity | null) => {
      oldOwner = value;
    },
  };
}
const signal = () => new AbortController().signal;

it("cold mutation reserves exactly one intake slot and clears real Gate plus WAL before one authorized rebind", async () => {
  const f = fixture(),
    lease = await f.maintenance.beforeMutation(target, signal());
  expect(f.idle).toHaveBeenCalledWith(1);
  expect(f.attachExisting).not.toHaveBeenCalled();
  expect(f.stored().phase).toBe("retired");
  const task = deferred(),
    rebind = vi.fn(async () => {
      expect(f.gate.reserved()).toBe(false);
      expect(f.vault.has(`account/${PREPARE_MAINTENANCE_KEY}`)).toBe(false);
      expect(f.maintenance.busy()).toBe(true);
      expect(f.maintenance.authorizesRebind()).toBe(true);
    });
  const settled = f.maintenance.settle(task.promise, rebind);
  await lease.release();
  expect(f.gate.reserved()).toBe(true);
  expect(rebind).not.toHaveBeenCalled();
  task.resolve();
  await settled;
  expect(rebind).toHaveBeenCalledOnce();
  expect(f.maintenance.busy()).toBe(false);
});
it("mutation assertion requires the live exact target/Node, positive retired authority and held committed Gate", async () => {
  const f = fixture();
  await expect(f.maintenance.assertMutation(target)).rejects.toThrow(
    "PREPARE_MAINTENANCE_RECOVERY_REQUIRED",
  );
  const lease = await f.maintenance.beforeMutation(target, signal());
  await expect(f.maintenance.assertMutation(target)).resolves.toBeUndefined();
  f.idle.mockReturnValueOnce(false);
  await expect(f.maintenance.assertMutation(target)).rejects.toThrow(
    "UPDATE_BUSY",
  );
  await expect(
    f.maintenance.assertMutation({ ...target, identity: "f".repeat(64) }),
  ).rejects.toThrow("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
  f.native.processIdentity.mockResolvedValueOnce({
    ...owner,
    creationTime: "different-birth",
  });
  await expect(f.maintenance.assertMutation(target)).rejects.toThrow(
    "PREPARE_MAINTENANCE_RECOVERY_REQUIRED",
  );
  f.gate.finishCommitted();
  await expect(f.maintenance.assertMutation(target)).rejects.toThrow(
    "PREPARE_MAINTENANCE_RECOVERY_REQUIRED",
  );
  await expect(lease.release()).rejects.toThrow("UPDATE_FINALIZE_UNCONFIRMED");
  await expect(f.maintenance.assertMutation(target)).rejects.toThrow(
    "PREPARE_MAINTENANCE_RECOVERY_REQUIRED",
  );
  const g = fixture();
  const current = await g.maintenance.beforeMutation(target, signal());
  await current.release();
  await expect(g.maintenance.assertMutation(target)).rejects.toThrow(
    "PREPARE_MAINTENANCE_RECOVERY_REQUIRED",
  );
});
it("preserves saved running intent and accepted work until event-driven drain then exact old authority exit", async () => {
  const f = fixture(true);
  f.setDraining(true);
  const entering = f.maintenance.beforeMutation(target, signal());
  await vi.waitFor(() => expect(f.waitState).toHaveBeenCalledOnce());
  expect(f.retireHandles).not.toHaveBeenCalled();
  expect(f.command.mock.calls.map(([cmd]) => cmd.action)).toEqual([
    "maintenance_begin",
  ]);
  f.setExit(true);
  f.drain();
  const lease = await entering;
  expect(f.command.mock.calls.map(([cmd]) => cmd.action)).toEqual([
    "maintenance_begin",
    "maintenance_begin",
    "maintenance_commit",
  ]);
  expect(
    JSON.parse(f.vault.get("fleet/session_state")!.toString()).fleetIntent,
  ).toBe("running");
  expect(f.events.indexOf("exact-exit")).toBeLessThan(
    f.events.indexOf("retire-handles"),
  );
  await lease.release();
  await f.maintenance.settle(Promise.resolve(), async () => {});
});
it("cancelled uncommitted drain ends only its real transaction and preserves accepted Session authority", async () => {
  const f = fixture(true),
    abort = new AbortController();
  f.setDraining(true);
  const enter = f.maintenance.beforeMutation(target, abort.signal);
  await vi.waitFor(() => expect(f.waitState).toHaveBeenCalledOnce());
  abort.abort();
  await expect(enter).rejects.toThrow();
  expect(f.maintenance.cleanupPending()).toBe(true);
  expect(f.gate.reserved()).toBe(true);
  await f.maintenance.cancelCleanup();
  expect(f.command.mock.calls.map(([cmd]) => cmd.action)).toEqual([
    "maintenance_begin",
    "maintenance_end",
  ]);
  expect(f.retireHandles).not.toHaveBeenCalled();
  expect(f.native.waitProcessExit).not.toHaveBeenCalled();
  expect(f.gate.reserved()).toBe(false);
  expect(f.maintenance.busy()).toBe(false);
  expect(
    JSON.parse(f.vault.get("fleet/session_state")!.toString()).owner.identity,
  ).toEqual(authority);
});
it("lost maintenance_end ACK retains Gate/WAL and retries an idempotent acknowledged end before deletion", async () => {
  const f = fixture(true),
    abort = new AbortController();
  f.setDraining(true);
  const enter = f.maintenance.beforeMutation(target, abort.signal);
  await vi.waitFor(() => expect(f.waitState).toHaveBeenCalledOnce());
  abort.abort();
  await expect(enter).rejects.toThrow();
  f.command.mockRejectedValueOnce(new Error("END_ACK_LOST"));
  await expect(f.maintenance.cancelCleanup()).rejects.toThrow("END_ACK_LOST");
  expect(f.maintenance.cleanupPending()).toBe(true);
  expect(f.gate.reserved()).toBe(true);
  expect(f.vaultDelete).not.toHaveBeenCalled();
  await f.maintenance.cancelCleanup();
  expect(f.maintenance.busy()).toBe(false);
});
it("unknown committed retirement retains authority until exact old birth exit succeeds, not guardian absence", async () => {
  const f = fixture(true);
  await expect(f.maintenance.beforeMutation(target, signal())).rejects.toThrow(
    "RECOVERY_REQUIRED",
  );
  expect(f.stored().phase).toBe("retiring");
  expect(f.retireHandles).not.toHaveBeenCalled();
  expect(f.maintenance.cleanupPending()).toBe(true);
  expect(f.gate.reserved()).toBe(true);
  await expect(f.maintenance.cancelCleanup()).rejects.toThrow(
    "RECOVERY_REQUIRED",
  );
  expect(f.vaultDelete).not.toHaveBeenCalled();
  f.setExit(true);
  await f.maintenance.recoverCleanup();
  await f.maintenance.settle(Promise.resolve(), async () => {});
  expect(f.retireHandles).toHaveBeenCalledOnce();
  expect(f.maintenance.busy()).toBe(false);
});
it("a same-instance failed initial WAL write can cancel safely without mistaking its current Node for a foreign live writer", async () => {
  const f = fixture();
  f.host.native.vaultWrite = vi.fn(async () => {
    throw new Error("WRITE_ACK_LOST");
  });
  await expect(f.maintenance.beforeMutation(target, signal())).rejects.toThrow(
    "WRITE_ACK_LOST",
  );
  expect(f.maintenance.cleanupPending()).toBe(true);
  await f.maintenance.cancelCleanup();
  expect(f.maintenance.busy()).toBe(false);
});
it("failed passive close or WAL-delete ACK cannot permit rebind, and exact settlement retry clears the retained fence", async () => {
  const f = fixture(true);
  f.setExit(true);
  const lease = await f.maintenance.beforeMutation(target, signal());
  await lease.release();
  const rebind = vi.fn(async () => {});
  f.close.mockRejectedValueOnce(new Error("CLOSE_ACK_LOST"));
  await expect(f.maintenance.settle(Promise.resolve(), rebind)).rejects.toThrow(
    "CLOSE_ACK_LOST",
  );
  expect(f.gate.reserved()).toBe(true);
  expect(rebind).not.toHaveBeenCalled();
  f.vaultDelete.mockRejectedValueOnce(new Error("DELETE_ACK_LOST"));
  await expect(f.maintenance.settle(Promise.resolve(), rebind)).rejects.toThrow(
    "DELETE_ACK_LOST",
  );
  expect(f.gate.reserved()).toBe(false);
  expect(f.maintenance.busy()).toBe(true);
  expect(rebind).not.toHaveBeenCalled();
  await f.maintenance.settle(Promise.resolve(), rebind);
  expect(rebind).toHaveBeenCalledOnce();
  expect(f.maintenance.busy()).toBe(false);
});
it("failed post-retirement rebind keeps independent busy authority and retries only rebind without new mutation or launch", async () => {
  const f = fixture(),
    lease = await f.maintenance.beforeMutation(target, signal());
  await lease.release();
  const rebind = vi.fn(async () => {});
  rebind.mockRejectedValueOnce(new Error("REBIND_FAILED"));
  await expect(f.maintenance.settle(Promise.resolve(), rebind)).rejects.toThrow(
    "REBIND_FAILED",
  );
  expect(f.maintenance.busy()).toBe(true);
  expect(f.maintenance.recoveryPending()).toBe(true);
  expect(f.gate.reserved()).toBe(false);
  await expect(f.maintenance.beforeMutation(target, signal())).rejects.toThrow(
    "RECOVERY_REQUIRED",
  );
  const writes = f.events.filter((e) => e.startsWith("write:")).length;
  await f.maintenance.settle(Promise.resolve(), rebind);
  expect(f.events.filter((e) => e.startsWith("write:"))).toHaveLength(writes);
  expect(f.retireHandles).toHaveBeenCalledOnce();
  expect(f.maintenance.busy()).toBe(false);
});
it("restored live writer is refused without claiming cleanup, while exact dead old birth under Prepare can resume", async () => {
  const f = fixture(),
    previous = { ...owner, pid: 800, creationTime: "300" };
  f.seed("retired", previous, null);
  f.setOldOwner(previous);
  await f.maintenance.restore();
  await expect(
    f.maintenance.recoverBeforeReady(target, signal()),
  ).rejects.toThrow("BUSY");
  expect(f.maintenance.cleanupPending()).toBe(false);
  expect(f.retireHandles).not.toHaveBeenCalled();
  f.setOldOwner({ ...previous, creationTime: "301" });
  const lease = await f.maintenance.recoverBeforeReady(target, signal());
  await lease!.release();
  await f.maintenance.settle(Promise.resolve(), async () => {});
  expect(f.maintenance.busy()).toBe(false);
});
it("corrupt fixed WAL refuses overwrite/reset and remains a visible recovery fence", async () => {
  const f = fixture();
  f.vault.set(`account/${PREPARE_MAINTENANCE_KEY}`, Buffer.from("{}"));
  await expect(f.maintenance.restore()).rejects.toThrow("RECOVERY_REQUIRED");
  expect(f.maintenance.busy()).toBe(true);
  expect(f.maintenance.cleanupPending()).toBe(false);
  expect(f.vaultDelete).not.toHaveBeenCalled();
});
it("actual Controller recovers restored exact retired WAL BEFORE accepting valid warm Ready, with no runtime stages", async () => {
  const f = fixture();
  f.seed("retired", { ...owner, pid: 801, creationTime: "400" }, null);
  const operations: PreparationOperations = {
    target: async () => target,
    lock: async () => ({
      release: async () => {
        f.events.push("setup-release");
      },
    }),
    cachedReady: async () => {
      f.events.push("cached-ready");
      expect(f.stored().phase).toBe("retired");
      return true;
    },
    space: async () => ({ requiredBytes: 0, availableBytes: 1 }),
    reuse: async () => true,
    perform: vi.fn(async () => {}),
    verifyReady: async () => true,
    registerBrowser: async () => true,
    cancelOwned: async () => {},
    repair: async () => {},
  };
  const record: PrepareJournal = {
    version: 1,
    transaction: "121f38cf-1024-43d1-bd11-c45bf155250c",
    sid,
    target: target.identity,
    state: "complete",
    completed: [...PREPARE_STAGES],
  };
  const controller = new PrepareController(
    operations,
    { read: async () => record, write: async () => {} },
    f.maintenance,
  );
  const task = controller.start();
  await f.maintenance.settle(task, async () => {});
  expect((await task).state).toBe("ready");
  expect(operations.perform).not.toHaveBeenCalled();
  expect(f.events.indexOf("retire-handles")).toBeLessThan(
    f.events.indexOf("cached-ready"),
  );
  expect(f.events.indexOf("setup-release")).toBeLessThan(
    f.events.indexOf(`delete:${PREPARE_MAINTENANCE_KEY}`),
  );
  expect(f.maintenance.busy()).toBe(false);
});
function cancellingController(f: ReturnType<typeof fixture>) {
  const release = vi.fn(async () => {
      f.events.push("setup-release");
    }),
    perform = vi.fn(async () => {}),
    operations: PreparationOperations = {
      target: async () => target,
      lock: async () => ({ release }),
      space: async () => ({ requiredBytes: 0, availableBytes: 1 }),
      reuse: async () => false,
      perform,
      verifyReady: async () => true,
      registerBrowser: async () => true,
      cancelOwned: async () => {},
      repair: async () => {},
    },
    controller = new PrepareController(
      operations,
      { read: async () => null, write: async () => {} },
      f.maintenance,
    );
  return { controller, release, perform };
}
it("actual Controller recovers retained mutation authority before native cleanup after helper settlement failure, keeping Setup until both prove closure", async () => {
  const f = fixture();
  let pending = false;
  const release = vi.fn(async () => {
      f.events.push("setup-release");
    }),
    cleanup = vi.fn(async () => {
      await f.maintenance.assertMutation(target);
      f.events.push("native-cleanup-confirmed");
      pending = false;
    });
  const operations: PreparationOperations = {
    target: async () => target,
    lock: async () => ({ release }),
    space: async () => ({ requiredBytes: 0, availableBytes: 1 }),
    reuse: async () => false,
    perform: async (stage) => {
      if (stage === "runtime") {
        pending = true;
        throw new Error("NATIVE_CLEANUP_ACK_LOST");
      }
    },
    verifyReady: async () => true,
    registerBrowser: async () => true,
    cancelOwned: async () => {},
    cleanupPending: () => pending,
    recoverCleanup: cleanup,
    repair: async () => {},
  };
  const controller = new PrepareController(
      operations,
      { read: async () => null, write: async () => {} },
      f.maintenance,
    ),
    task = controller.start();
  expect((await task).state).toBe("error");
  await expect(f.maintenance.settle(task, async () => {})).rejects.toThrow(
    "PREPARE_MAINTENANCE_RECOVERY_REQUIRED",
  );
  expect(f.maintenance.cleanupPending()).toBe(true);
  expect(controller.isRunning()).toBe(true);
  expect(release).not.toHaveBeenCalled();
  await controller.cancel();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(controller.isRunning()).toBe(false);
  expect(f.events.indexOf("native-cleanup-confirmed")).toBeLessThan(
    f.events.indexOf("setup-release"),
  );
  await f.maintenance.settle(Promise.resolve(), async () => {});
  expect(f.maintenance.busy()).toBe(false);
  expect(f.gate.reserved()).toBe(false);
});
it("actual Controller Cancel retains Setup during uncertain admission then ends precommit drain before releasing it", async () => {
  const f = fixture(true),
    c = cancellingController(f);
  f.setDraining(true);
  const task = c.controller.start();
  await vi.waitFor(() => expect(f.waitState).toHaveBeenCalledOnce());
  await c.controller.cancel();
  expect((await task).state).toBe("error");
  expect(c.perform).not.toHaveBeenCalled();
  expect(c.release).toHaveBeenCalledOnce();
  expect(c.controller.isRunning()).toBe(false);
  expect(f.events.indexOf("maintenance_end")).toBeLessThan(
    f.events.indexOf("setup-release"),
  );
  expect(f.maintenance.busy()).toBe(false);
});
it("restored-dead precommit Cancel obtains a genuine Setup lock, acknowledges end, and never performs a stage", async () => {
  const f = fixture(true),
    c = cancellingController(f);
  f.seed("draining", { ...owner, pid: 803, creationTime: "401" });
  await f.maintenance.restore();
  await c.controller.cancel();
  expect(f.command.mock.calls.map(([cmd]) => cmd.action)).toEqual([
    "maintenance_end",
  ]);
  expect(c.perform).not.toHaveBeenCalled();
  expect(c.release).toHaveBeenCalledOnce();
  expect(c.controller.isRunning()).toBe(false);
  expect(f.maintenance.busy()).toBe(false);
  expect(f.retireHandles).not.toHaveBeenCalled();
});
it("restored committed Cancel proves exact original retirement and releases Setup before final authorized settlement", async () => {
  const f = fixture(),
    c = cancellingController(f);
  f.seed("retired", { ...owner, pid: 804, creationTime: "402" }, null);
  await f.maintenance.restore();
  await c.controller.cancel();
  expect(c.release).toHaveBeenCalledOnce();
  expect(c.perform).not.toHaveBeenCalled();
  expect(f.gate.reserved()).toBe(true);
  expect(f.maintenance.busy()).toBe(true);
  expect(f.maintenance.snapshot().controllerReleased).toBe(true);
  await f.maintenance.settle(Promise.resolve(), async () => {});
  expect(f.maintenance.busy()).toBe(false);
});
it("actual Controller can cancel shutdown after failed adapter rebind only with proven released retirement and no WAL", async () => {
  const f = fixture(),
    c = cancellingController(f),
    task = c.controller.start(),
    rebind = vi.fn(async () => {
      throw new Error("ADAPTER_REBIND_FAILED");
    });
  await expect(f.maintenance.settle(task, rebind)).rejects.toThrow(
    "ADAPTER_REBIND_FAILED",
  );
  expect((await task).state).toBe("ready");
  expect(f.vault.has(`account/${PREPARE_MAINTENANCE_KEY}`)).toBe(false);
  const mutations = c.perform.mock.calls.length;
  await c.controller.cancel();
  await f.maintenance.settle(Promise.resolve(), async () => {});
  expect(c.perform).toHaveBeenCalledTimes(mutations);
  expect(f.retireHandles).toHaveBeenCalledOnce();
  expect(c.release).toHaveBeenCalledTimes(2);
  expect(c.controller.isRunning()).toBe(false);
  expect(f.maintenance.busy()).toBe(false);
});
