import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  freshSessionState,
  SessionSupervisor,
  type FleetSessionPort,
  type PersonalSessionPort,
  type SessionNativePort,
  type SessionPersistentState,
} from "../src/main/session/supervisor.js";
import { parseSessionState } from "../src/main/session/state-store.js";
import type { ConsumerHostIdentity } from "../../worker/src/platform/windows/consumer-native.js";
import type {
  FleetIntent,
  SessionCommand,
  SessionRole,
} from "../src/shared/session-contracts.js";
import { parseSessionCommand } from "../src/shared/session-contracts.js";

const host: ConsumerHostIdentity = {
  sid: "S-1-5-21-1-2-3-1001",
  sessionId: 2,
  pid: 10,
  creationTime: "133700000000001",
  logonSid: "S-1-5-5-1-2",
  nativeArch: "x64",
  processArch: "x64",
  osMajor: 10,
  osBuild: 19045,
  localAppData: "C:\\Users\\fixture\\AppData\\Local",
};
const peer = {
  sid: host.sid,
  sessionId: host.sessionId,
  pid: 20,
  creationTime: "133700000000002",
};
const request = (
  action: "fleet_intent",
  intent: FleetIntent,
): SessionCommand => ({ version: 1, request_id: randomUUID(), action, intent });
function fixture(intent: FleetIntent = "stopped", shutdownMs?: number) {
  let now = 10000;
  let saved: SessionPersistentState | null = {
    ...freshSessionState(host.sid),
    fleetIntent: intent,
  };
  const timers: { action: () => void; delay: number; cancelled: boolean }[] =
    [];
  const native: SessionNativePort = {
    identity: vi.fn(async () => host),
    acquireSessionLock: vi.fn(async () => ({
      nonce: "a".repeat(64),
      identity: {
        sid: host.sid,
        sessionId: host.sessionId,
        pid: host.pid,
        creationTime: host.creationTime,
      },
      abandoned: false,
    })),
    releaseSessionLock: vi.fn(async () => {}),
    processIdentity: vi.fn(async () => null),
    launchOwned: vi.fn(async (role: SessionRole) => ({
      role,
      nonce: (role === "fleet" ? "b" : "c").repeat(64),
      identity: { ...peer, pid: role === "fleet" ? 30 : 40 },
    })),
    stopOwned: vi.fn(async () => {}),
    ownedTreeExited: vi.fn(async () => true),
    inspectStartup: vi.fn(async () => "registered" as const),
    legacyWorkerConflict: vi.fn(async () => false),
    close: vi.fn(async () => {}),
  };
  const fleet: FleetSessionPort = {
    eligibility: vi.fn(async () => ({
      enrolled: true,
      approved: true,
      prepared: true,
    })),
    reconcile: vi.fn(async () => {}),
    setIntent: vi.fn(async () => {}),
    gracefulStop: vi.fn(async () => {}),
    pauseForSleep: vi.fn(async () => {}),
  };
  const personal: PersonalSessionPort = {
    prepared: vi.fn(async () => true),
    reconcile: vi.fn(async () => {}),
    detachOwner: vi.fn(async () => {}),
    applyAccountScope: vi.fn(async () => {}),
    gracefulStop: vi.fn(async () => {}),
  };
  const state = {
    read: vi.fn(async () => structuredClone(saved)),
    write: vi.fn(async (value: SessionPersistentState) => {
      saved = structuredClone(value);
    }),
  };
  const forceAuthority = {
    verifyPeer: vi.fn(async () => true),
    identity: vi.fn(async () => ({
      machineId: "bdd28875-ab09-4eb3-9f8c-1e599e76870b",
      authority: "a".repeat(64),
    })),
  };
  const supervisor = new SessionSupervisor({
    release: "f".repeat(64),
    native,
    state,
    fleet,
    personal,
    forceAuthority,
    ...(shutdownMs === undefined ? {} : { shutdownMs }),
    maintenanceReady: async () => true,
    clock: {
      now: () => now,
      random: () => 0,
      schedule: (action, delay) => {
        const timer = { action, delay, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
  });
  return {
    supervisor,
    native,
    fleet,
    personal,
    state,
    timers,
    forceAuthority,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    saved: () => saved,
    setSaved: (value: SessionPersistentState) => {
      saved = value;
    },
  };
}
describe("Store processing fence observation (synthetic native ports)", () => {
  it.each(["held", "unknown"])(
    "defers %s prepare state before consuming role restart budgets",
    async (state) => {
      const f = fixture("running");
      f.native.processingAdmissionReady =
        state === "held"
          ? vi.fn(async () => false)
          : vi.fn(async () => {
              throw new Error("FENCE_UNAVAILABLE");
            });
      await f.supervisor.start();
      await f.supervisor.command(
        {
          version: 1,
          request_id: randomUUID(),
          action: "personal_attach",
          owner_id: randomUUID(),
          owner_kind: "chrome",
        },
        peer,
      );
      expect(f.native.launchOwned).not.toHaveBeenCalled();
      expect(f.saved()!.budgets.fleet.attempts).toBe(0);
      expect(f.saved()!.budgets.personal.attempts).toBe(0);
      expect(f.timers).toHaveLength(0);
      expect(f.supervisor.snapshot().fleet.problem).toBe("PREPARE_REQUIRED");
      expect(f.supervisor.snapshot().personal.problem).toBe("PREPARE_REQUIRED");
    },
  );
  it("acknowledges maintenance end under the retained WAL and waits for an explicit unfenced wake", async () => {
    const f = fixture("running"),
      ownerId = randomUUID(),
      transaction = randomUUID(),
      inspect = vi.fn(async () => true);
    f.native.processingAdmissionReady = inspect;
    f.personal.idle = vi.fn(async () => true);
    const attach: SessionCommand = {
      version: 1,
      request_id: randomUUID(),
      action: "personal_attach",
      owner_id: ownerId,
      owner_kind: "chrome",
    };
    await f.supervisor.start();
    await f.supervisor.command(attach, peer);
    expect(f.native.launchOwned).toHaveBeenCalledTimes(2);
    const drained = await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "maintenance_begin",
        transaction,
      },
      peer,
    );
    expect(drained.maintenance?.phase).toBe("idle");
    inspect.mockResolvedValue(false);
    const ended = await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "maintenance_end",
        transaction,
      },
      peer,
    );
    expect(ended.maintenance).toBeNull();
    expect(f.native.launchOwned).toHaveBeenCalledTimes(2);
    expect(f.saved()!.budgets.fleet.attempts).toBe(0);
    expect(f.saved()!.budgets.personal.attempts).toBe(0);
    const resume: SessionCommand = {
      version: 1,
      request_id: randomUUID(),
      action: "maintenance_resume",
      transaction,
      instance_id: ended.instance_id,
    };
    await expect(f.supervisor.command(resume, peer)).rejects.toThrow(
      "UPDATE_BUSY",
    );
    await expect(
      f.supervisor.command({ ...resume, instance_id: randomUUID() }, peer),
    ).rejects.toThrow("PEER_DENIED");
    await expect(
      f.supervisor.command({ ...resume, transaction: randomUUID() }, peer),
    ).rejects.toThrow("PEER_DENIED");
    await expect(
      f.supervisor.command(resume, { ...peer, pid: peer.pid + 1 }),
    ).rejects.toThrow("PEER_DENIED");
    expect(f.native.launchOwned).toHaveBeenCalledTimes(2);
    inspect.mockResolvedValue(true);
    await f.supervisor.command(resume, peer);
    expect(f.native.launchOwned).toHaveBeenCalledTimes(4);
    expect(f.supervisor.snapshot().fleet.phase).toBe("running");
    expect(f.supervisor.snapshot().personal.phase).toBe("running");
    const budgets = structuredClone(f.saved()!.budgets);
    await f.supervisor.command({ ...resume, request_id: randomUUID() }, peer);
    expect(f.native.launchOwned).toHaveBeenCalledTimes(4);
    expect(f.saved()!.budgets).toEqual(budgets);
  });
  it("a legacy Session cannot accept Store resume observations or caller intent", async () => {
    const f = fixture();
    await f.supervisor.start();
    const resume = {
      version: 1,
      request_id: randomUUID(),
      action: "maintenance_resume",
      transaction: randomUUID(),
      instance_id: f.supervisor.snapshot().instance_id,
    };
    expect(parseSessionCommand(Buffer.from(JSON.stringify(resume)))).toEqual(
      resume,
    );
    for (const changed of [
      { ...resume, instance_id: undefined },
      { ...resume, intent: "running" },
      { ...resume, idle: true },
      { ...resume, transaction: "bad" },
      { ...resume, instance_id: "bad" },
    ])
      expect(() =>
        parseSessionCommand(Buffer.from(JSON.stringify(changed))),
      ).toThrow("INVALID_COMMAND");
    await expect(
      f.supervisor.command(resume as SessionCommand, peer),
    ).rejects.toThrow("PEER_DENIED");
    expect(f.native.launchOwned).not.toHaveBeenCalled();
  });
});
describe("current-user session authority", () => {
  it("ordinary drain deadline preserves the exact accepted fleet tree; confirmed logout alone escalates it", async () => {
    const f = fixture("running", 10);
    await f.supervisor.start();
    const owner = f.supervisor.roleOwner("fleet")!;
    vi.mocked(f.fleet.gracefulStop).mockImplementation(
      (_owner, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const stopped = await f.supervisor.command(
      request("fleet_intent", "stopped"),
      peer,
    );
    expect(stopped.fleet.problem).toBe("CHILD_SHUTDOWN_PENDING");
    expect(f.supervisor.roleOwner("fleet")).toEqual(owner);
    expect(f.native.stopOwned).not.toHaveBeenCalled();
    expect(f.saved()?.fleetIntent).toBe("stopped");
    await f.supervisor.logout();
    expect(f.native.stopOwned).toHaveBeenCalledExactlyOnceWith(owner);
    expect(f.saved()?.fleetIntent).toBe("stopped");
  });
  it("child creation crash loop is durably bounded and network wake cannot reset its exhausted budget", async () => {
    const f = fixture("running");
    vi.mocked(f.native.launchOwned).mockRejectedValue(
      new Error("FIXTURE_CHILD_FAILURE"),
    );
    await f.supervisor.start();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const timer = f.timers.find((item) => !item.cancelled);
      if (!timer) break;
      timer.cancelled = true;
      f.advance(timer.delay);
      timer.action();
      await f.supervisor.command(
        { version: 1, request_id: randomUUID(), action: "status" },
        peer,
      );
    }
    expect(f.native.launchOwned).toHaveBeenCalledTimes(5);
    expect(f.saved()?.budgets.fleet.attempts).toBe(5);
    await f.supervisor.sessionEvent("network");
    expect(f.supervisor.snapshot().fleet.problem).toBe(
      "RESTART_BUDGET_EXHAUSTED",
    );
    expect(f.native.launchOwned).toHaveBeenCalledTimes(5);
    expect(f.native.stopOwned).not.toHaveBeenCalled();
  });
  it("legacy service conflict and uncertain claim reconciliation never imply running or legacy cleanup", async () => {
    const f = fixture();
    await f.supervisor.start();
    vi.mocked(f.native.legacyWorkerConflict).mockResolvedValue(true);
    const conflict = await f.supervisor.command(
      request("fleet_intent", "running"),
      peer,
    );
    expect(conflict.fleet.problem).toBe("LEGACY_WORKER_CONFLICT");
    expect(f.native.launchOwned).not.toHaveBeenCalled();
    expect(f.native.stopOwned).not.toHaveBeenCalled();
    vi.mocked(f.native.legacyWorkerConflict).mockResolvedValue(false);
    vi.mocked(f.fleet.reconcile).mockRejectedValueOnce(
      new Error("UNCERTAIN_CLAIMS"),
    );
    await f.supervisor.sessionEvent("network");
    expect(f.supervisor.snapshot().fleet.problem).toBe(
      "CLAIM_RECONCILIATION_FAILED",
    );
    expect(f.fleet.setIntent).not.toHaveBeenCalled();
    await f.supervisor.sessionEvent("network");
    expect(f.supervisor.snapshot().fleet.phase).toBe("running");
    expect(f.fleet.setIntent).toHaveBeenCalledTimes(1);
  });
  const force = (
    f: ReturnType<typeof fixture>,
    reason: "stop" | "restart" | "update" | "revoke",
  ) => {
    const confirmation = randomUUID();
    return {
      version: 1 as const,
      action: "fleet_force" as const,
      request_id: confirmation,
      confirmation,
      reason,
      machine_id: "bdd28875-ab09-4eb3-9f8c-1e599e76870b",
      authority: "a".repeat(64),
      expected_revision: f.supervisor.snapshot().revision,
    };
  };
  it("reviewed Force Stop persists stopped intent before killing only the exact fleet tree and never waits for graceful accepted work", async () => {
    const f = fixture("running");
    await f.supervisor.start();
    vi.mocked(f.fleet.gracefulStop).mockRejectedValue(
      new Error("FLEET_DRAIN_PENDING"),
    );
    const owner = f.supervisor.roleOwner("fleet")!;
    vi.mocked(f.native.stopOwned).mockImplementation(async (actual) => {
      expect(actual).toEqual(owner);
      expect(f.saved()?.fleetIntent).toBe("stopped");
      expect(f.saved()?.maintenance?.force?.owner).toEqual(owner);
    });
    const result = await f.supervisor.command(force(f, "stop"), peer);
    expect(result.fleet.phase).toBe("stopped");
    expect(result.maintenance).toBeNull();
    expect(f.fleet.gracefulStop).not.toHaveBeenCalled();
    expect(f.native.ownedTreeExited).toHaveBeenCalledExactlyOnceWith(owner);
    expect(f.personal.gracefulStop).not.toHaveBeenCalled();
  });
  it("reviewed Force Restart preserves paused/draining intent and starts a replacement only after the exact old Job exit certificate", async () => {
    for (const intent of ["paused", "draining"] as const) {
      const f = fixture(intent);
      await f.supervisor.start();
      const old = f.supervisor.roleOwner("fleet")!;
      const command = force(f, "restart");
      const result = await f.supervisor.command(command, peer);
      expect(f.native.stopOwned).toHaveBeenCalledExactlyOnceWith(old);
      expect(f.saved()?.fleetIntent).toBe(intent);
      expect(result.fleet.phase).toBe(intent);
      expect(f.native.launchOwned).toHaveBeenCalledTimes(2);
      await f.supervisor.command(command, peer);
      expect(f.native.stopOwned).toHaveBeenCalledTimes(1);
      expect(f.native.launchOwned).toHaveBeenCalledTimes(2);
    }
  });
  it("lost Force ACK may adopt only positive old Job proof; false proof retains durable fence through replay/network/ordinary maintenance release", async () => {
    const f = fixture("running");
    await f.supervisor.start();
    const command = force(f, "stop");
    const beforeWrites = vi.mocked(f.state.write).mock.calls.length;
    await expect(
      f.supervisor.command(
        { ...command, expected_revision: command.expected_revision - 1 },
        peer,
      ),
    ).rejects.toThrow("FORCE_CONFIRMATION_STALE");
    expect(f.state.write).toHaveBeenCalledTimes(beforeWrites);
    expect(f.saved()?.receipts).toHaveLength(0);
    vi.mocked(f.native.stopOwned).mockRejectedValue(new Error("ACK_LOST"));
    vi.mocked(f.native.ownedTreeExited!).mockResolvedValue(false);
    await expect(f.supervisor.command(command, peer)).rejects.toThrow(
      "CHILD_SHUTDOWN_PENDING",
    );
    expect(parseSessionState(f.saved())).toEqual(f.saved());
    await f.supervisor.sessionEvent("network");
    await expect(
      f.supervisor.command(
        {
          version: 1,
          request_id: randomUUID(),
          action: "maintenance_end",
          transaction: command.confirmation,
        },
        peer,
      ),
    ).rejects.toThrow("CHILD_SHUTDOWN_PENDING");
    await expect(f.supervisor.command(command, peer)).rejects.toThrow(
      "CHILD_SHUTDOWN_PENDING",
    );
    expect(f.saved()?.maintenance?.force?.owner).not.toBeNull();
    expect(f.native.launchOwned).toHaveBeenCalledTimes(1);
    vi.mocked(f.native.ownedTreeExited!).mockResolvedValue(true);
    expect((await f.supervisor.command(command, peer)).fleet.phase).toBe(
      "stopped",
    );
    expect(f.native.stopOwned).toHaveBeenCalledTimes(1);
    expect(f.saved()?.maintenance).toBeNull();
  });
  it("Force requires signed sole-authority peer, exact original machine authority and current reviewed snapshot revision", async () => {
    const f = fixture("running");
    await f.supervisor.start();
    const command = force(f, "stop");
    vi.mocked(f.forceAuthority.verifyPeer).mockResolvedValueOnce(false);
    await expect(f.supervisor.command(command, peer)).rejects.toThrow(
      "PEER_DENIED",
    );
    for (const changed of [
      { machine_id: randomUUID() },
      { authority: "b".repeat(64) },
      { expected_revision: command.expected_revision - 1 },
    ])
      await expect(
        f.supervisor.command({ ...command, ...changed }, peer),
      ).rejects.toThrow();
    expect(f.native.stopOwned).not.toHaveBeenCalled();
    expect(f.saved()?.maintenance).toBeNull();
  });
  it("Force Update/Revoke cannot force personal work and retains saved fleet intent under ordinary maintenance proof", async () => {
    for (const reason of ["update", "revoke"] as const) {
      const f = fixture("running");
      await f.supervisor.start();
      await f.supervisor.command(
        {
          version: 1,
          request_id: randomUUID(),
          action: "personal_attach",
          owner_id: randomUUID(),
          owner_kind: "chrome",
        },
        peer,
      );
      f.personal.idle = vi.fn(async () => false);
      await expect(
        f.supervisor.command(force(f, reason), peer),
      ).rejects.toThrow("UPDATE_BUSY");
      expect(f.native.stopOwned).not.toHaveBeenCalled();
      f.personal.idle = vi.fn(async () => true);
      const result = await f.supervisor.command(force(f, reason), peer);
      expect(result.fleet.intent).toBe("running");
      expect(result.maintenance?.phase).toBe("idle");
      expect(f.personal.gracefulStop).toHaveBeenCalledTimes(1);
    }
  });
  it("Force grammar denies alternate request IDs, duplicate/unknown fields and reuse for a changed action", async () => {
    const f = fixture("running");
    await f.supervisor.start();
    const command = force(f, "stop");
    expect(parseSessionCommand(Buffer.from(JSON.stringify(command)))).toEqual(
      command,
    );
    for (const bad of [
      { ...command, request_id: randomUUID() },
      { ...command, extra: true },
    ])
      expect(() =>
        parseSessionCommand(Buffer.from(JSON.stringify(bad))),
      ).toThrow("INVALID_COMMAND");
    expect(() =>
      parseSessionCommand(
        Buffer.from(
          JSON.stringify(command).replace(
            '"reason":"stop"',
            '"reason":"stop","reason":"restart"',
          ),
        ),
      ),
    ).toThrow("INVALID_COMMAND");
    await f.supervisor.command(command, peer);
    await expect(
      f.supervisor.command({ ...command, reason: "restart" }, peer),
    ).rejects.toThrow("REQUEST_ID_REUSED");
    expect(f.native.stopOwned).toHaveBeenCalledTimes(1);
  });
  it("real graceful fleet drain completion publishes durable maintenance idle without another BEGIN", async () => {
    const f = fixture("running"),
      transaction = randomUUID();
    await f.supervisor.start();
    vi.mocked(f.fleet.gracefulStop).mockRejectedValueOnce(
      new Error("FLEET_DRAIN_PENDING"),
    );
    const first = await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "maintenance_begin",
        transaction,
      },
      peer,
    );
    expect(first.maintenance?.phase).toBe("draining");
    const snapshots: ReturnType<SessionSupervisor["snapshot"]>[] = [];
    const stop = f.supervisor.subscribe((s) => snapshots.push(s));
    const retry = f.timers.find(
      (timer) => timer.delay === 5000 && !timer.cancelled,
    )!;
    retry.action();
    await vi.waitFor(() =>
      expect(f.supervisor.snapshot().maintenance?.phase).toBe("idle"),
    );
    expect(f.saved()?.maintenance?.idle).toBe(true);
    expect(f.saved()?.fleetIntent).toBe("running");
    expect(snapshots.at(-1)?.revision).toBeGreaterThan(first.revision);
    expect(f.native.stopOwned).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ role: "fleet" }),
    );
    stop();
  });
  it("personal activity wakes only its exact current owner and queries real idle before stopping", async () => {
    const f = fixture(),
      transaction = randomUUID();
    await f.supervisor.start();
    await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "personal_attach",
        owner_id: randomUUID(),
        owner_kind: "chrome",
      },
      peer,
    );
    const owner = f.supervisor.roleOwner("personal")!;
    f.personal.idle = vi.fn(async () => false);
    await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "maintenance_begin",
        transaction,
      },
      peer,
    );
    expect(
      (await f.supervisor.refreshMaintenance(owner)).maintenance?.phase,
    ).toBe("draining");
    expect(f.native.stopOwned).not.toHaveBeenCalled();
    await expect(
      f.supervisor.refreshMaintenance({ ...owner, nonce: "a".repeat(64) }),
    ).rejects.toThrow("PEER_DENIED");
    f.personal.idle = vi.fn(async () => true);
    expect(
      (await f.supervisor.refreshMaintenance(owner)).maintenance?.phase,
    ).toBe("idle");
    expect(f.saved()?.maintenance?.idle).toBe(true);
    expect(f.personal.gracefulStop).toHaveBeenCalledOnce();
    expect(f.native.stopOwned).toHaveBeenCalledExactlyOnceWith(owner);
  });
  it("positive exact native child-tree exit advances maintenance without scheduling a replacement", async () => {
    const f = fixture(),
      transaction = randomUUID();
    await f.supervisor.start();
    await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "personal_attach",
        owner_id: randomUUID(),
        owner_kind: "chrome",
      },
      peer,
    );
    f.personal.idle = vi.fn(async () => false);
    const owner = f.supervisor.roleOwner("personal")!;
    await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "maintenance_begin",
        transaction,
      },
      peer,
    );
    expect((await f.supervisor.childExited(owner)).maintenance?.phase).toBe(
      "idle",
    );
    expect(f.native.stopOwned).toHaveBeenCalledExactlyOnceWith(owner);
    expect(f.timers).toEqual([]);
    expect(f.saved()?.maintenance?.idle).toBe(true);
  });
  it("durably fences maintenance, preserves intent, and does not kill accepted fleet work", async () => {
    const f = fixture("running"),
      transaction = randomUUID();
    await f.supervisor.start();
    vi.mocked(f.fleet.gracefulStop).mockRejectedValueOnce(
      new Error("FLEET_DRAIN_PENDING"),
    );
    const draining = await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "maintenance_begin",
        transaction,
      },
      peer,
    );
    expect(draining.maintenance).toEqual({ transaction, phase: "draining" });
    expect(f.saved()?.fleetIntent).toBe("running");
    expect(f.saved()?.maintenance?.transaction).toBe(transaction);
    expect(f.native.stopOwned).not.toHaveBeenCalled();
    const idle = await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "maintenance_begin",
        transaction,
      },
      peer,
    );
    expect(idle.maintenance?.phase).toBe("idle");
    expect(f.supervisor.roleOwner("fleet")).toBeUndefined();
    await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "maintenance_end",
        transaction,
      },
      peer,
    );
    expect(f.saved()?.maintenance).toBeNull();
    expect(f.saved()?.fleetIntent).toBe("running");
    expect(f.native.launchOwned).toHaveBeenCalledTimes(2);
  });
  it("waits for state publications without blocking a mutating command and resets on new instance", async () => {
    const f = fixture();
    const first = await f.supervisor.start();
    const waiting = f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "wait_state",
        after_revision: first.revision,
        instance_id: first.instance_id,
      },
      peer,
    );
    let published = false;
    void waiting.then(() => {
      published = true;
    });
    await Promise.resolve();
    expect(published).toBe(false);
    const paused = await f.supervisor.command(
      request("fleet_intent", "paused"),
      peer,
    );
    expect(await waiting).toEqual(paused);
    expect(paused.revision).toBeGreaterThan(first.revision);
    expect(
      await f.supervisor.command(
        {
          version: 1,
          request_id: randomUUID(),
          action: "wait_state",
          after_revision: 99999,
          instance_id: randomUUID(),
        },
        peer,
      ),
    ).toEqual(paused);
  });
  it("fresh stopped state opens no processing role", async () => {
    const f = fixture();
    await f.supervisor.start();
    expect(f.native.launchOwned).not.toHaveBeenCalled();
    expect(f.saved()?.owner?.identity).toEqual({
      sid: host.sid,
      sessionId: host.sessionId,
      pid: host.pid,
      creationTime: host.creationTime,
    });
  });
  it.each(["running", "paused", "draining"] as const)(
    "restores saved %s fleet intent after reconciliation",
    async (intent) => {
      const f = fixture(intent);
      await f.supervisor.start();
      expect(f.fleet.reconcile).toHaveBeenCalledOnce();
      expect(f.fleet.setIntent).toHaveBeenCalledWith(
        expect.objectContaining({ role: "fleet" }),
        intent,
        expect.any(AbortSignal),
      );
      expect(f.saved()?.fleetIntent).toBe(intent);
    },
  );
  it("saves deliberate Stop before asking the fleet to drain", async () => {
    const f = fixture("running");
    await f.supervisor.start();
    vi.mocked(f.fleet.gracefulStop).mockImplementation(async () => {
      expect(f.saved()?.fleetIntent).toBe("stopped");
      throw new Error("FLEET_DRAIN_PENDING");
    });
    const snapshot = await f.supervisor.command(
      request("fleet_intent", "stopped"),
      peer,
    );
    expect(snapshot.fleet.phase).toBe("recovering");
    expect(snapshot.fleet.problem).toBe("CHILD_SHUTDOWN_PENDING");
    expect(f.native.stopOwned).not.toHaveBeenCalled();
    expect(f.supervisor.roleOwner("fleet")).toBeDefined();
    expect(f.timers.at(-1)?.delay).toBe(5000);
  });
  it("restart retains old accepted work and launches replacement only after drain confirmation", async () => {
    const f = fixture("running");
    await f.supervisor.start();
    vi.mocked(f.fleet.gracefulStop).mockRejectedValueOnce(
      new Error("FLEET_DRAIN_PENDING"),
    );
    await f.supervisor.command(
      { version: 1, request_id: randomUUID(), action: "fleet_restart" },
      peer,
    );
    expect(f.saved()?.restartPending).toBe(true);
    expect(f.native.launchOwned).toHaveBeenCalledOnce();
    expect(f.native.stopOwned).not.toHaveBeenCalled();
    await f.supervisor.sessionEvent("network");
    expect(f.saved()?.restartPending).toBe(false);
    expect(f.native.stopOwned).toHaveBeenCalledOnce();
    expect(f.native.launchOwned).toHaveBeenCalledTimes(2);
  });
  it("logout forces exact owned tree after failed graceful drain and preserves next-login intent", async () => {
    const f = fixture("running");
    await f.supervisor.start();
    vi.mocked(f.fleet.gracefulStop).mockRejectedValue(
      new Error("FLEET_DRAIN_PENDING"),
    );
    await f.supervisor.logout();
    expect(f.native.stopOwned).toHaveBeenCalledWith(
      expect.objectContaining({ role: "fleet", nonce: "b".repeat(64) }),
    );
    expect(f.saved()?.fleetIntent).toBe("running");
    expect(f.saved()?.owner).toBeNull();
    expect(f.native.releaseSessionLock).toHaveBeenCalledWith("a".repeat(64));
  });
  it("window detach and Google sign-out leave fleet ownership and intent intact", async () => {
    const f = fixture("running");
    await f.supervisor.start();
    const ownerId = randomUUID();
    await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "personal_attach",
        owner_id: ownerId,
        owner_kind: "desktop",
      },
      peer,
    );
    await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "account_scope",
        scope: null,
      },
      peer,
    );
    await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "personal_detach",
        owner_id: ownerId,
      },
      peer,
    );
    expect(f.personal.detachOwner).toHaveBeenCalledWith(
      ownerId,
      expect.any(AbortSignal),
    );
    expect(f.supervisor.roleOwner("personal")).toBeDefined();
    expect(f.native.stopOwned).not.toHaveBeenCalledWith(
      expect.objectContaining({ role: "personal" }),
    );
    expect(
      vi
        .mocked(f.native.stopOwned)
        .mock.calls.some(([owner]) => owner.role === "fleet"),
    ).toBe(false);
    expect(f.saved()?.fleetIntent).toBe("running");
  });
  it("rejects reusing a personal owner after caller PID birth changes", async () => {
    const f = fixture();
    await f.supervisor.start();
    const command: SessionCommand = {
      version: 1,
      request_id: randomUUID(),
      action: "personal_attach",
      owner_id: randomUUID(),
      owner_kind: "chrome",
    };
    await f.supervisor.command(command, peer);
    await expect(
      f.supervisor.command(
        { ...command, request_id: randomUUID() },
        { ...peer, creationTime: "133700000000099" },
      ),
    ).rejects.toThrow("PEER_DENIED");
  });
  it("a failed atomic intent write cannot start claims or a child", async () => {
    const f = fixture();
    await f.supervisor.start();
    vi.mocked(f.state.write).mockRejectedValueOnce(new Error("DISK_FULL"));
    await expect(
      f.supervisor.command(request("fleet_intent", "running"), peer),
    ).rejects.toThrow("STATE_UNAVAILABLE");
    expect(f.native.launchOwned).not.toHaveBeenCalled();
    expect(f.fleet.setIntent).not.toHaveBeenCalled();
    expect(f.saved()?.fleetIntent).toBe("stopped");
  });
  it("an existing exact owner denies duplicate authority while reused PID can recover", async () => {
    const f = fixture();
    const previous = {
      ...freshSessionState(host.sid),
      owner: { nonce: "d".repeat(64), identity: peer },
    };
    f.setSaved(previous);
    vi.mocked(f.native.processIdentity).mockResolvedValue(peer);
    await expect(f.supervisor.start()).rejects.toThrow(
      "SESSION_IDENTITY_CONFLICT",
    );
    const g = fixture();
    g.setSaved(previous);
    vi.mocked(g.native.processIdentity).mockResolvedValue({
      ...peer,
      creationTime: "133700000000099",
    });
    await expect(g.supervisor.start()).resolves.toMatchObject({
      phase: "running",
    });
  });
  it("sleep closes fleet admission, wake reconciles before saved intent, and lock does not stop", async () => {
    const f = fixture("paused");
    await f.supervisor.start();
    await f.supervisor.sessionEvent("lock");
    expect(f.native.stopOwned).not.toHaveBeenCalled();
    await f.supervisor.sessionEvent("suspend");
    expect(f.fleet.pauseForSleep).toHaveBeenCalledOnce();
    await f.supervisor.sessionEvent("resume");
    expect(f.fleet.reconcile).toHaveBeenCalledTimes(2);
    expect(f.saved()?.fleetIntent).toBe("paused");
  });
  it("ignores forged child exit receipt and isolates actual personal child failure", async () => {
    const f = fixture("running");
    await f.supervisor.start();
    await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "personal_attach",
        owner_id: randomUUID(),
        owner_kind: "desktop",
      },
      peer,
    );
    const personal = f.supervisor.roleOwner("personal")!;
    await f.supervisor.childExited({ ...personal, nonce: "e".repeat(64) });
    expect(f.native.stopOwned).not.toHaveBeenCalled();
    await f.supervisor.childExited(personal);
    expect(f.native.stopOwned).toHaveBeenCalledWith(personal);
    expect(f.supervisor.roleOwner("fleet")).toBeDefined();
  });
  it("strict protected state rejects invalid budgets, missing intent fence and duplicate receipts", () => {
    const state = freshSessionState(host.sid);
    expect(parseSessionState(state)).toEqual(state);
    expect(() =>
      parseSessionState({ ...state, restartPending: undefined }),
    ).toThrow("STATE_UNAVAILABLE");
    expect(() =>
      parseSessionState({
        ...state,
        budgets: {
          ...state.budgets,
          fleet: { attempts: 6, nextStartAt: 0, blocked: true },
        },
      }),
    ).toThrow("STATE_UNAVAILABLE");
    const receipt = { requestId: randomUUID(), digest: "f".repeat(64) };
    expect(() =>
      parseSessionState({ ...state, receipts: [receipt, receipt] }),
    ).toThrow("STATE_UNAVAILABLE");
  });
});
