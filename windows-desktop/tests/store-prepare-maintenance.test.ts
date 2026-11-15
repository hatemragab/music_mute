import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { ConsumerProcessIdentity } from "../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../src/main/host-context.js";
import type {
  SessionCommand,
  SessionSnapshot,
} from "../src/shared/session-contracts.js";
import { DesktopMaintenanceGate } from "../src/main/maintenance-gate.js";
import { PREPARE_MAINTENANCE_KEY } from "../src/main/prepare/maintenance.js";

// Synthetic receiving/lifetime tests. Only the existing genuine native/client
// module boundary is mocked; these fixtures establish no physical Store proof.
const mocks = vi.hoisted(() => {
  class Authority {
    proof: unknown;
    closed = false;
    creatorProof() {
      if (!(this instanceof Authority) || this.closed) throw Error("FORGED");
      return this.proof;
    }
  }
  class Session {
    actual: unknown;
    commandImpl!: (command: unknown, signal?: AbortSignal) => Promise<unknown>;
    waitImpl!: (
      revision: number,
      instance: string,
      signal?: AbortSignal,
    ) => Promise<unknown>;
    currentAuthority() {
      if (!(this instanceof Session)) throw Error("FORGED");
      return this.actual;
    }
    command(command: unknown, signal?: AbortSignal) {
      return this.commandImpl(command, signal);
    }
    waitState(revision: number, instance: string, signal?: AbortSignal) {
      return this.waitImpl(revision, instance, signal);
    }
  }
  return { Authority, Session, owners: new WeakMap<object, Authority>() };
});
vi.mock("../src/main/browser/store-native.js", () => ({
  StoreNativeAuthority: mocks.Authority,
  storeAuthorityForDataNative: (native: object) => mocks.owners.get(native),
}));
vi.mock("../src/main/session/store-session-client.js", () => ({
  StoreSessionClient: mocks.Session,
}));
import { StorePrepareMaintenance } from "../src/main/prepare/store-maintenance.js";
import type { StoreSessionClient } from "../src/main/session/store-session-client.js";

const sid = "S-1-5-21-4161902177-57482701-1680932209-1000",
  owner: ConsumerProcessIdentity = {
    sid,
    sessionId: 1,
    pid: process.pid,
    creationTime: "100",
  },
  control: ConsumerProcessIdentity = {
    sid,
    sessionId: 1,
    pid: 440,
    creationTime: "200",
  },
  target = { sid, identity: "a".repeat(64) },
  instance = "121f38cf-1024-43d1-bd11-c45bf155250c";
function fixture() {
  const vault = new Map<string, Buffer>(),
    events: string[] = [],
    authority = new mocks.Authority(),
    session = new mocks.Session();
  let transaction: string | null = null,
    idle = true,
    revision = 0,
    beginLost = false,
    endLost = false,
    resumeLost = false,
    prepareHeld = false;
  authority.proof = {
    version: 1,
    gui: owner,
    helper: { ...owner, pid: 500 },
    packageFullName: "fixture-only",
  };
  session.actual = control;
  const snapshot = (): SessionSnapshot => ({
    version: 1,
    instance_id: instance,
    release: target.identity,
    revision: ++revision,
    phase: "running",
    fleet: { intent: "running", phase: "stopped", problem: null },
    personal: { owners: 0, phase: "stopped", problem: null },
    startup: "registered",
    maintenance: transaction
      ? { transaction, phase: idle ? "idle" : "draining" }
      : null,
  });
  const command = vi.fn(async (value: unknown, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const cmd = value as SessionCommand;
    events.push(cmd.action);
    if (cmd.action === "maintenance_begin") {
      transaction = cmd.transaction;
      if (beginLost) {
        beginLost = false;
        throw Error("BEGIN_ACK_LOST");
      }
    } else if (cmd.action === "maintenance_end") {
      expect(vault.has(PREPARE_MAINTENANCE_KEY)).toBe(true);
      transaction = null;
      if (endLost) {
        endLost = false;
        throw Error("END_ACK_LOST");
      }
    } else if (cmd.action === "maintenance_resume") {
      expect(cmd.instance_id).toBe(instance);
      expect(vault.has(PREPARE_MAINTENANCE_KEY)).toBe(false);
      expect(gate.reserved()).toBe(false);
      if (prepareHeld) throw Error("PREPARE_STILL_HELD");
      if (resumeLost) {
        resumeLost = false;
        throw Error("RESUME_ACK_LOST");
      }
    } else if (cmd.action === "maintenance_commit")
      throw Error("CONTROL_RETIREMENT_DENIED");
    return snapshot();
  });
  session.commandImpl = command;
  session.waitImpl = vi.fn(async () => {
    idle = true;
    events.push("drain_ack");
    return snapshot();
  });
  const native = {
    processIdentity: vi.fn(async (pid: number) =>
      pid === owner.pid ? owner : pid === control.pid ? control : null,
    ),
    vaultRead: vi.fn(async (_root: string, key: string) =>
      vault.has(key) ? Buffer.from(vault.get(key)!) : null,
    ),
    vaultWrite: vi.fn(async (_root: string, key: string, bytes: Buffer) => {
      vault.set(key, Buffer.from(bytes));
      events.push("wal:" + JSON.parse(bytes.toString()).phase);
    }),
    vaultDelete: vi.fn(async (_root: string, key: string) => {
      events.push("wal_delete");
      vault.delete(key);
    }),
  };
  mocks.owners.set(native, authority);
  const host = {
      native,
      storeAuthority: authority,
      identity: { sid, sessionId: 1 },
      processIdentity: native.processIdentity,
    } as unknown as HostContext,
    gate = new DesktopMaintenanceGate({
      idle: () => true,
      reserve: () => ({
        assertIdle() {},
        release() {
          events.push("intake_release");
        },
      }),
      changed() {},
    }),
    pause = vi.fn(async () => {
      events.push("pause_gui");
    }),
    open = vi.fn(async () => session as unknown as StoreSessionClient),
    maintenance = new StorePrepareMaintenance({
      host,
      gate,
      session: open,
      pauseConsumers: pause,
    });
  return {
    host,
    native,
    authority,
    session,
    vault,
    events,
    gate,
    pause,
    command,
    open,
    maintenance,
    drainLater() {
      idle = false;
    },
    loseBegin() {
      beginLost = true;
    },
    loseEnd() {
      endLost = true;
    },
    loseResume() {
      resumeLost = true;
    },
    holdPrepare(held: boolean) {
      prepareHeld = held;
    },
    wal() {
      return JSON.parse(
        vault.get(PREPARE_MAINTENANCE_KEY)!.toString(),
      ) as Record<string, unknown>;
    },
  };
}

it("passively restores with no Worker/client activation", async () => {
  const f = fixture();
  await f.maintenance.restore();
  expect(f.open).not.toHaveBeenCalled();
  expect(f.maintenance.busy()).toBe(false);
});
it("associates only the original live Host before a Store fleet factory can borrow maintenance", () => {
  const f = fixture();
  expect(() => f.maintenance.assertHost(f.host)).not.toThrow();
  expect(() =>
    f.maintenance.assertHost({ ...f.host } as HostContext),
  ).toThrow();
  expect(() =>
    StorePrepareMaintenance.prototype.assertHost.call(
      Object.create(StorePrepareMaintenance.prototype),
      f.host,
    ),
  ).toThrow();
  mocks.owners.delete(f.native);
  expect(() => f.maintenance.assertHost(f.host)).toThrow();
  mocks.owners.set(f.native, f.authority);
  f.authority.closed = true;
  f.authority.creatorProof = () => ({ confirmed: true });
  expect(() => f.maintenance.assertHost(f.host)).toThrow();
  expect(f.open).not.toHaveBeenCalled();
  expect(f.native.vaultRead).not.toHaveBeenCalled();
  expect(f.pause).not.toHaveBeenCalled();
});
it("drains actual role/GPU acknowledgement and keeps the control Session live", async () => {
  const f = fixture();
  f.drainLater();
  const lease = await f.maintenance.beforeMutation(
    target,
    AbortSignal.timeout(1000),
  );
  expect(f.events.indexOf("drain_ack")).toBeLessThan(
    f.events.indexOf("pause_gui"),
  );
  expect(f.wal()).toMatchObject({
    version: 2,
    distribution: "microsoft-store",
    phase: "drained",
    authority: control,
    instance,
  });
  await f.maintenance.assertMutation(target);
  await lease.release();
  const rebind = vi.fn(async () => {
    expect(f.maintenance.authorizesRebind()).toBe(true);
  });
  await f.maintenance.settle(Promise.resolve(), rebind);
  expect(f.events.indexOf("maintenance_end")).toBeLessThan(
    f.events.indexOf("wal_delete"),
  );
  expect(f.events.indexOf("wal_delete")).toBeLessThan(
    f.events.indexOf("maintenance_resume"),
  );
  expect(f.events).not.toContain("maintenance_commit");
  expect(f.session.actual).toEqual(control);
  expect(rebind).toHaveBeenCalledOnce();
  expect(f.gate.reserved()).toBe(false);
  expect(f.maintenance.busy()).toBe(false);
  expect(f.vault.size).toBe(0);
});
it("persists exact control owner before a lost maintenance_begin ACK", async () => {
  const f = fixture();
  f.loseBegin();
  await expect(
    f.maintenance.beforeMutation(target, AbortSignal.timeout(1000)),
  ).rejects.toThrow("BEGIN_ACK_LOST");
  expect(f.wal()).toMatchObject({
    phase: "draining",
    authority: control,
    instance,
  });
  expect(f.maintenance.cleanupPending()).toBe(true);
  await f.maintenance.cancelCleanup();
  expect(f.events).toContain("maintenance_end");
  expect(f.vault.size).toBe(0);
  expect(f.events).not.toContain("maintenance_resume");
  expect(f.maintenance.snapshot().drained).toBe(false);
  expect(f.maintenance.busy()).toBe(true);
  await f.maintenance.settle(Promise.resolve(), async () => {});
  expect(f.events).toContain("maintenance_resume");
  expect(f.maintenance.busy()).toBe(false);
});
it("retains WAL and intake after lost end ACK and retries only the original transaction", async () => {
  const f = fixture(),
    lease = await f.maintenance.beforeMutation(
      target,
      AbortSignal.timeout(1000),
    );
  await lease.release();
  f.loseEnd();
  await expect(
    f.maintenance.settle(Promise.resolve(), async () => {}),
  ).rejects.toThrow("END_ACK_LOST");
  expect(f.maintenance.cleanupPending()).toBe(true);
  expect(f.gate.reserved()).toBe(true);
  const original = f.wal();
  expect(original.phase).toBe("ending");
  await f.maintenance.settle(Promise.resolve(), async () => {});
  const ends = f.command.mock.calls
    .map(([cmd]) => cmd as SessionCommand)
    .filter((cmd) => cmd.action === "maintenance_end");
  expect(ends).toHaveLength(2);
  expect(ends[0]).toEqual(ends[1]);
  expect(f.open).toHaveBeenCalledOnce();
  expect(f.maintenance.busy()).toBe(false);
});
it("denies changed control birth during mutation and preserves recovery evidence", async () => {
  const f = fixture();
  await f.maintenance.beforeMutation(target, AbortSignal.timeout(1000));
  f.session.actual = { ...control, creationTime: "201" };
  await expect(f.maintenance.assertMutation(target)).rejects.toThrow(
    "RECOVERY_REQUIRED",
  );
  expect(f.vault.has(PREPARE_MAINTENANCE_KEY)).toBe(true);
  expect(f.gate.reserved()).toBe(true);
});
it("defers cancelled resume until the actual task releases its Prepare mutex", async () => {
  const f = fixture();
  f.loseBegin();
  await expect(
    f.maintenance.beforeMutation(target, AbortSignal.timeout(1000)),
  ).rejects.toThrow("BEGIN_ACK_LOST");
  f.holdPrepare(true);
  await f.maintenance.cancelCleanup();
  expect(f.maintenance.cleanupPending()).toBe(false);
  let release!: () => void;
  const task = new Promise<void>((resolve) => {
    release = resolve;
  });
  const rebind = vi.fn(async () => {
    expect(f.maintenance.authorizesRebind()).toBe(true);
    expect(f.maintenance.snapshot().drained).toBe(false);
  });
  const settling = f.maintenance.settle(task, rebind);
  await Promise.resolve();
  expect(f.events).not.toContain("maintenance_resume");
  f.holdPrepare(false);
  release();
  await settling;
  expect(rebind).toHaveBeenCalledOnce();
});
it("retains the exact resume request on unknown ACK without reopening WAL or ending again", async () => {
  const f = fixture(),
    lease = await f.maintenance.beforeMutation(
      target,
      AbortSignal.timeout(1000),
    );
  await lease.release();
  f.loseResume();
  const rebind = vi.fn(async () => {});
  await expect(f.maintenance.settle(Promise.resolve(), rebind)).rejects.toThrow(
    "RESUME_ACK_LOST",
  );
  expect(f.maintenance.recoveryPending()).toBe(true);
  expect(f.vault.size).toBe(0);
  expect(rebind).not.toHaveBeenCalled();
  await f.maintenance.settle(Promise.resolve(), rebind);
  const commands = f.command.mock.calls.map(([cmd]) => cmd as SessionCommand);
  const resumes = commands.filter((cmd) => cmd.action === "maintenance_resume");
  expect(resumes).toHaveLength(2);
  expect(resumes[0]).toEqual(resumes[1]);
  expect(
    commands.filter((cmd) => cmd.action === "maintenance_end"),
  ).toHaveLength(1);
});
it("keeps exact cancelled owner reachable when native admission remains held", async () => {
  const f = fixture();
  f.loseBegin();
  await expect(
    f.maintenance.beforeMutation(target, AbortSignal.timeout(1000)),
  ).rejects.toThrow("BEGIN_ACK_LOST");
  await f.maintenance.cancelCleanup();
  f.holdPrepare(true);
  const rebind = vi.fn(async () => {});
  await expect(f.maintenance.settle(Promise.resolve(), rebind)).rejects.toThrow(
    "PREPARE_STILL_HELD",
  );
  expect(f.maintenance.busy()).toBe(true);
  expect(rebind).not.toHaveBeenCalled();
  f.holdPrepare(false);
  await f.maintenance.settle(Promise.resolve(), rebind);
  expect(f.maintenance.busy()).toBe(false);
});
it.each(["ending", "ended"] as const)(
  "reclaims a dead GUI's %s WAL through a fresh actual drain before resuming",
  async (phase) => {
    const old = fixture(),
      lease = await old.maintenance.beforeMutation(
        target,
        AbortSignal.timeout(1000),
      );
    await lease.release();
    old.loseEnd();
    await expect(
      old.maintenance.settle(Promise.resolve(), async () => {}),
    ).rejects.toThrow("END_ACK_LOST");
    const record = {
      ...old.wal(),
      phase,
      owner: { ...owner, pid: 900, creationTime: "50" },
    };
    const f = fixture();
    f.vault.set(PREPARE_MAINTENANCE_KEY, Buffer.from(JSON.stringify(record)));
    const recovered = await f.maintenance.cancelRecovery(
      target,
      AbortSignal.timeout(1000),
    );
    expect(recovered).not.toBeNull();
    expect(
      f.command.mock.calls.map(([cmd]) => (cmd as SessionCommand).action),
    ).toContain("maintenance_begin");
    expect(f.wal()).toMatchObject({
      transaction: old.wal().transaction,
      owner,
      authority: control,
      instance,
      phase: "drained",
    });
    await recovered!.release();
    await f.maintenance.settle(Promise.resolve(), async () => {});
    expect(f.events.indexOf("maintenance_begin")).toBeLessThan(
      f.events.indexOf("maintenance_end"),
    );
    expect(f.events.indexOf("wal_delete")).toBeLessThan(
      f.events.indexOf("maintenance_resume"),
    );
    expect(f.maintenance.busy()).toBe(false);
  },
);
it("does not adopt a GUI owner when its actual death observation is unknown", async () => {
  const old = fixture(),
    lease = await old.maintenance.beforeMutation(
      target,
      AbortSignal.timeout(1000),
    );
  await lease.release();
  old.loseEnd();
  await expect(
    old.maintenance.settle(Promise.resolve(), async () => {}),
  ).rejects.toThrow("END_ACK_LOST");
  const f = fixture(),
    record = {
      ...old.wal(),
      owner: { ...owner, pid: 900, creationTime: "50" },
    },
    original = f.native.processIdentity.getMockImplementation()!;
  f.vault.set(PREPARE_MAINTENANCE_KEY, Buffer.from(JSON.stringify(record)));
  f.native.processIdentity.mockImplementation(async (pid) => {
    if (pid === 900) throw Error("KERNEL_DEATH_UNCONFIRMED");
    return original(pid);
  });
  await expect(
    f.maintenance.cancelRecovery(target, AbortSignal.timeout(1000)),
  ).rejects.toThrow("KERNEL_DEATH_UNCONFIRMED");
  expect(f.open).not.toHaveBeenCalled();
  expect(f.wal()).toEqual(record);
  expect(f.maintenance.recoveryPending()).toBe(true);
});
it("cancels an early dead-GUI record without activating an absent Worker", async () => {
  const old = fixture(),
    lease = await old.maintenance.beforeMutation(
      target,
      AbortSignal.timeout(1000),
    );
  await lease.release();
  old.loseEnd();
  await expect(
    old.maintenance.settle(Promise.resolve(), async () => {}),
  ).rejects.toThrow("END_ACK_LOST");
  const f = fixture(),
    record = {
      ...old.wal(),
      phase: "reserving",
      authority: null,
      instance: null,
      owner: { ...owner, pid: 900, creationTime: "50" },
    };
  f.vault.set(PREPARE_MAINTENANCE_KEY, Buffer.from(JSON.stringify(record)));
  expect(
    await f.maintenance.cancelRecovery(target, AbortSignal.timeout(1000)),
  ).toBeNull();
  await f.maintenance.settle(Promise.resolve(), async () => {});
  expect(f.open).not.toHaveBeenCalled();
  expect(f.vault.size).toBe(0);
  expect(f.maintenance.busy()).toBe(false);
});
it("retries a failed GUI rebind without reopening an acknowledged mutation", async () => {
  const f = fixture(),
    lease = await f.maintenance.beforeMutation(
      target,
      AbortSignal.timeout(1000),
    );
  await lease.release();
  const rebind = vi
    .fn()
    .mockRejectedValueOnce(Error("REBIND_FAILED"))
    .mockResolvedValue(undefined);
  await expect(f.maintenance.settle(Promise.resolve(), rebind)).rejects.toThrow(
    "REBIND_FAILED",
  );
  expect(f.vault.size).toBe(0);
  expect(f.gate.reserved()).toBe(false);
  expect(f.maintenance.recoveryPending()).toBe(true);
  const settledEvents = f.events.slice();
  await f.maintenance.settle(Promise.resolve(), rebind);
  expect(f.events).toEqual(settledEvents);
  expect(
    f.command.mock.calls.filter(
      ([cmd]) => (cmd as SessionCommand).action === "maintenance_end",
    ),
  ).toHaveLength(1);
  expect(f.maintenance.busy()).toBe(false);
});
it("does not adopt legacy, malformed or extra-field WAL as Store authority", async () => {
  for (const row of [
    { version: 1 },
    { version: 2, distribution: "microsoft-store" },
    { value: true },
  ]) {
    const f = fixture();
    f.vault.set(PREPARE_MAINTENANCE_KEY, Buffer.from(JSON.stringify(row)));
    await expect(f.maintenance.restore()).rejects.toThrow("RECOVERY_REQUIRED");
    expect(f.maintenance.busy()).toBe(true);
    expect(f.open).not.toHaveBeenCalled();
    expect(f.vault.has(PREPARE_MAINTENANCE_KEY)).toBe(true);
  }
});
it("requires the actual native-to-Store-authority association", () => {
  const f = fixture();
  mocks.owners.delete(f.native);
  expect(
    () =>
      new StorePrepareMaintenance({
        host: f.host,
        gate: f.gate,
        session: f.open,
        pauseConsumers: f.pause,
      }),
  ).toThrow("RECOVERY_REQUIRED");
});

it("adopts only a genuine current Session's exact acknowledged force drain without retiring that Session", async () => {
  const f = fixture(),
    transaction = "ab9c4c74-7e0d-4cbd-9f04-2d5ce37019a7",
    signal = new AbortController().signal;
  await f.command(
    {
      version: 1,
      request_id: randomUUID(),
      action: "maintenance_begin",
      transaction,
    },
    signal,
  );
  const lease = await f.maintenance.beforeForcedMutation(
    target,
    transaction,
    signal,
  );
  expect(f.wal().transaction).toBe(transaction);
  expect(f.wal().authority).toEqual(control);
  expect(f.wal().instance).toBe(instance);
  await lease.release();
  await f.maintenance.settle(Promise.resolve(), async () => {});
  expect(f.events).toContain("maintenance_end");
  expect(f.events).toContain("maintenance_resume");
  expect(f.events).not.toContain("maintenance_commit");
});
it("rejects absent, foreign or still-draining force observations before WAL or GUI retirement", async () => {
  const transaction = "ab9c4c74-7e0d-4cbd-9f04-2d5ce37019a7",
    signal = new AbortController().signal;
  for (const mode of ["absent", "foreign", "draining"]) {
    const f = fixture();
    if (mode !== "absent")
      await f.command(
        {
          version: 1,
          request_id: randomUUID(),
          action: "maintenance_begin",
          transaction:
            mode === "foreign"
              ? "cb9c4c74-7e0d-4cbd-9f04-2d5ce37019a7"
              : transaction,
        },
        signal,
      );
    if (mode === "draining") f.drainLater();
    await expect(
      f.maintenance.beforeForcedMutation(target, transaction, signal),
    ).rejects.toThrow("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
    expect(f.vault.has(PREPARE_MAINTENANCE_KEY)).toBe(false);
    expect(f.pause).not.toHaveBeenCalled();
  }
});
