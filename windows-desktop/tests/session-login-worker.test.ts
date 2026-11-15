import { expect, it, vi } from "vitest";
import { freshSessionState } from "../src/main/session/supervisor.js";
import {
  runLoginWorkerBootstrap,
  type LoginWorkerEligibility,
  type LoginWorkerPorts,
} from "../src/main/session/login-worker.js";
import { parseLoginWorkerRemoval } from "../src/main/session/login-worker-runtime.js";

const sid = "S-1-5-21-100-200-300-1001",
  machineId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function fixture() {
  let row: LoginWorkerEligibility | null = {
      state: { ...freshSessionState(sid), fleetIntent: "running" },
      authority: "a".repeat(64),
      removed: false,
    },
    current = true;
  const trace: string[] = [];
  const call = (name: string) =>
    vi.fn(async () => {
      trace.push(name);
    });
  const ports: LoginWorkerPorts = {
    authorize: call("authorize"),
    eligibility: vi.fn(async () => structuredClone(row)),
    existingOwner: vi.fn(async () => false),
    recoveryPending: vi.fn(async () => false),
    acquireActivation: vi.fn(async () => ({
      release: call("activation-release"),
    })),
    acquirePrepare: vi.fn(async () => ({ release: call("prepare-release") })),
    treesIdle: vi.fn(async () => true),
    prepareTreesIdle: vi.fn(async () => true),
    cleanupUncertain: vi.fn(
      (error) =>
        error instanceof Error &&
        error.message === "QUALIFICATION_CLEANUP_UNCONFIRMED",
    ),
    recoverUncertainCleanup: call("confirmed-prepare-cleanup"),
    currentQualification: vi.fn(async () => current),
    requalifyInstalled: call("personal-qualify"),
    refreshApprovedFleet: vi.fn(async () => {
      trace.push("approved-fleet-qualify");
      current = true;
    }),
    launch: vi.fn(async () => {
      trace.push("launch");
      return true;
    }),
  };
  return {
    ports,
    trace,
    row: () => row,
    change: (value: LoginWorkerEligibility | null) => {
      row = value;
    },
    stale: () => {
      current = false;
    },
  };
}
it.each(["stopped"] as const)(
  "saved %s never qualifies or starts a worker",
  async (intent) => {
    const f = fixture();
    f.change({
      ...f.row()!,
      state: { ...f.row()!.state, fleetIntent: intent },
    });
    f.stale();
    expect(
      await runLoginWorkerBootstrap(f.ports, new AbortController().signal),
    ).toEqual({ outcome: "noop", reason: "saved-intent" });
    expect(f.ports.acquireActivation).not.toHaveBeenCalled();
    expect(f.ports.requalifyInstalled).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  },
);
it.each(["paused", "draining"] as const)(
  "restores saved %s through the actual supervisor intent path after fresh guarded qualification",
  async (intent) => {
    const f = fixture();
    f.change({
      ...f.row()!,
      state: { ...f.row()!.state, fleetIntent: intent },
    });
    f.stale();
    expect(
      await runLoginWorkerBootstrap(f.ports, new AbortController().signal),
    ).toEqual({ outcome: "started", qualification: "requalified" });
    expect(f.ports.launch).toHaveBeenCalledWith(intent);
    expect(f.ports.refreshApprovedFleet).toHaveBeenCalledOnce();
  },
);
it("unenrolled, explicitly removed and restart-blocked never mint new approval", async () => {
  for (const mode of ["unenrolled", "removed", "blocked"]) {
    const f = fixture();
    if (mode === "unenrolled") f.change(null);
    else if (mode === "removed") f.change({ ...f.row()!, removed: true });
    else f.row()!.state.budgets.fleet.blocked = true;
    await runLoginWorkerBootstrap(f.ports, new AbortController().signal);
    expect(f.ports.acquireActivation).not.toHaveBeenCalled();
    expect(f.ports.refreshApprovedFleet).not.toHaveBeenCalled();
  }
});
it("current same-witness qualification releases the activation gate before launch and never runs the model fixture", async () => {
  const f = fixture();
  expect(
    await runLoginWorkerBootstrap(f.ports, new AbortController().signal),
  ).toEqual({ outcome: "started", qualification: "current" });
  expect(f.ports.acquirePrepare).not.toHaveBeenCalled();
  expect(f.trace.indexOf("activation-release")).toBeLessThan(
    f.trace.indexOf("launch"),
  );
});
it("stale qualification uses personal and original-approved fleet fixtures under real leases before launch", async () => {
  const f = fixture();
  f.stale();
  expect(
    await runLoginWorkerBootstrap(f.ports, new AbortController().signal),
  ).toEqual({ outcome: "started", qualification: "requalified" });
  expect(f.trace.filter((x) => !x.startsWith("authorize"))).toEqual([
    "personal-qualify",
    "approved-fleet-qualify",
    "prepare-release",
    "activation-release",
    "launch",
  ]);
});
it.each(["personal", "fleet", "release"])(
  "successful Stop/Remove/revision change at %s fence wins over qualification",
  async (boundary) => {
    const f = fixture();
    f.stale();
    const change = () =>
      f.change({
        ...f.row()!,
        state: {
          ...f.row()!.state,
          revision: f.row()!.state.revision + 1,
          fleetIntent: "stopped",
        },
      });
    if (boundary === "personal")
      f.ports.requalifyInstalled = vi.fn(async () => {
        change();
      });
    if (boundary === "fleet")
      f.ports.refreshApprovedFleet = vi.fn(async () => {
        change();
      });
    if (boundary === "release")
      f.ports.acquireActivation = vi.fn(async () => ({
        release: vi.fn(async () => {
          change();
        }),
      }));
    const result = await runLoginWorkerBootstrap(
      f.ports,
      new AbortController().signal,
    );
    expect(result).toEqual({ outcome: "noop", reason: "changed-intent" });
    expect(f.ports.launch).not.toHaveBeenCalled();
  },
);
it("existing owner and recovery journal are preserved without taking over or qualification", async () => {
  for (const mode of ["owner", "recovery"]) {
    const f = fixture();
    if (mode === "owner") f.ports.existingOwner = vi.fn(async () => true);
    else f.ports.recoveryPending = vi.fn(async () => true);
    expect(
      (await runLoginWorkerBootstrap(f.ports, new AbortController().signal))
        .outcome,
    ).toBe(mode === "owner" ? "noop" : "blocked");
    expect(f.ports.acquireActivation).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  }
});
it("absent whole-Job certificate and contested Prepare fail closed, then release owned activation", async () => {
  for (const mode of ["tree", "prepare"]) {
    const f = fixture();
    f.stale();
    if (mode === "tree") f.ports.treesIdle = vi.fn(async () => false);
    else f.ports.acquirePrepare = vi.fn(async () => null);
    expect(
      await runLoginWorkerBootstrap(f.ports, new AbortController().signal),
    ).toEqual({
      outcome: "blocked",
      reason: mode === "tree" ? "tree-proof" : "busy",
    });
    expect(f.trace).toContain("activation-release");
    expect(f.ports.requalifyInstalled).not.toHaveBeenCalled();
  }
});
it("parent proof loss and actual qualification failure never acknowledge a start; held leases release", async () => {
  const f = fixture();
  f.stale();
  f.ports.requalifyInstalled = vi.fn(async () => {
    throw new Error("GPU_BUSY");
  });
  await expect(
    runLoginWorkerBootstrap(f.ports, new AbortController().signal),
  ).rejects.toThrow("GPU_BUSY");
  expect(f.trace.slice(-2)).toEqual(["prepare-release", "activation-release"]);
  expect(f.ports.launch).not.toHaveBeenCalled();
  const lost = fixture();
  lost.ports.authorize = vi.fn(async () => {
    throw new Error("PEER_DENIED");
  });
  await expect(
    runLoginWorkerBootstrap(lost.ports, new AbortController().signal),
  ).rejects.toThrow("PEER_DENIED");
  expect(lost.ports.eligibility).not.toHaveBeenCalled();
});
it("lost cleanup ACK retains actual Prepare and session fences until exact cleanup proof succeeds", async () => {
  const f = fixture();
  f.stale();
  let confirmed!: () => void;
  f.ports.requalifyInstalled = vi.fn(async () => {
    throw new Error("QUALIFICATION_CLEANUP_UNCONFIRMED");
  });
  f.ports.recoverUncertainCleanup = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        confirmed = resolve;
      }),
  );
  const running = runLoginWorkerBootstrap(
      f.ports,
      new AbortController().signal,
    ),
    rejected = expect(running).rejects.toThrow(
      "QUALIFICATION_CLEANUP_UNCONFIRMED",
    );
  await vi.waitFor(() =>
    expect(f.ports.recoverUncertainCleanup).toHaveBeenCalledOnce(),
  );
  expect(f.trace).not.toContain("prepare-release");
  expect(f.trace).not.toContain("activation-release");
  confirmed();
  await rejected;
  expect(f.trace.slice(-2)).toEqual(["prepare-release", "activation-release"]);
  expect(f.ports.launch).not.toHaveBeenCalled();
});
it("unconfirmed recovery or new BUSY never releases a prior uncertain fence", async () => {
  const f = fixture();
  f.stale();
  f.ports.requalifyInstalled = vi.fn(async () => {
    throw new Error("QUALIFICATION_CLEANUP_UNCONFIRMED");
  });
  f.ports.recoverUncertainCleanup = vi.fn(async () => {
    throw new Error("BUSY");
  });
  await expect(
    runLoginWorkerBootstrap(f.ports, new AbortController().signal),
  ).rejects.toThrow("BUSY");
  expect(f.trace).not.toContain("prepare-release");
  expect(f.trace).not.toContain("activation-release");
  expect(f.ports.launch).not.toHaveBeenCalled();
});
it("unknown Prepare tree stays protected while a warm qualified worker can coexist with unrelated CPU media", async () => {
  const warm = fixture();
  warm.ports.prepareTreesIdle = vi.fn(async () => false);
  expect(
    (await runLoginWorkerBootstrap(warm.ports, new AbortController().signal))
      .outcome,
  ).toBe("started");
  expect(warm.ports.prepareTreesIdle).not.toHaveBeenCalled();
  const cold = fixture();
  cold.stale();
  cold.ports.prepareTreesIdle = vi.fn(async () => false);
  expect(
    await runLoginWorkerBootstrap(cold.ports, new AbortController().signal),
  ).toEqual({ outcome: "blocked", reason: "tree-proof" });
  expect(cold.ports.requalifyInstalled).not.toHaveBeenCalled();
  expect(cold.trace.slice(-2)).toEqual([
    "prepare-release",
    "activation-release",
  ]);
});
it("foreign-logon Account cannot claim while the authenticated temporary session owner holds activation", async () => {
  const f = fixture();
  f.stale();
  let temporary = false;
  f.ports.acquireActivation = vi.fn(async () => {
    temporary = true;
    return {
      release: async () => {
        temporary = false;
        f.trace.push("activation-release");
      },
    };
  });
  const claimForeign = () => {
    if (temporary) throw new Error("WINDOWS_SESSION_ALREADY_ACTIVE");
  };
  f.ports.requalifyInstalled = vi.fn(async () => {
    expect(temporary).toBe(true);
    expect(claimForeign).toThrow("WINDOWS_SESSION_ALREADY_ACTIVE");
  });
  expect(
    (await runLoginWorkerBootstrap(f.ports, new AbortController().signal))
      .outcome,
  ).toBe("started");
  expect(temporary).toBe(false);
  expect(f.ports.launch).toHaveBeenCalledOnce();
});
it("session-side concurrent Stop is reported as a no-op, not a restored running worker", async () => {
  const f = fixture();
  f.ports.launch = vi.fn(async () => false);
  expect(
    await runLoginWorkerBootstrap(f.ports, new AbortController().signal),
  ).toEqual({ outcome: "noop", reason: "changed-intent" });
});
it("removal marker binds exact original approval and machine, rejects malformed/foreign markers", () => {
  const row = {
    version: 1,
    machineId,
    authority: "a".repeat(64),
    removedAt: "2026-10-08T00:00:00Z",
  };
  expect(parseLoginWorkerRemoval(row, machineId, row.authority)).toBe(true);
  for (const bad of [
    { ...row, unknown: true },
    { ...row, machineId: "b" },
    { ...row, authority: "b".repeat(64) },
    { ...row, removedAt: "bad" },
  ])
    expect(() =>
      parseLoginWorkerRemoval(bad, machineId, row.authority),
    ).toThrow("FLEET_INTEGRITY_INVALID");
});
