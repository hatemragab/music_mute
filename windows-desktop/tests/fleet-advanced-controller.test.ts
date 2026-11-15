import { describe, it, expect, vi } from "vitest";
import {
  WindowsFleetAdvancedController,
  parseAdvancedJournal,
  sanitizeAdvancedData,
  type AdvancedJournal,
  type FleetAdvancedPorts,
} from "../src/main/fleet/advanced/controller.js";
import { parseFleetAdvancedCommand } from "../src/shared/fleet-advanced-contracts.js";
import { fleetNow, fleetSid } from "./fleet-fixtures.js";
import { advancedRequest } from "./fleet-advanced-fixtures.js";
function fixture() {
  let state: AdvancedJournal | null = null,
    actual = {
      sid: fleetSid,
      machineId: advancedRequest,
      revision: 1,
      digest: "a".repeat(64),
    },
    clock = fleetNow;
  const order: string[] = [],
    release = vi.fn(async () => {
      order.push("release");
    });
  const ports: FleetAdvancedPorts = {
    identity: vi.fn(async () => ({ ...actual })),
    journal: {
      read: vi.fn(async () => (state ? structuredClone(state) : null)),
      write: vi.fn(async (value) => {
        order.push(value.phase);
        state = structuredClone(value);
      }),
    },
    maintenance: {
      acquire: vi.fn(async () => {
        order.push("acquire");
        return { release };
      }),
      cancel: vi.fn(async () => {
        order.push("cancel");
      }),
    },
    read: vi.fn(async () => ({
      token: "secret",
      events: [
        {
          detail:
            "Bearer secret https://signed.example.invalid/grant C:\\Users\\fixture\\private",
          code: "GPU_OOM",
        },
      ],
    })),
    previewCleanup: vi.fn(async () => ({ bytes: 123 })),
    updateCheck: vi.fn(async () => ({ available: false })),
    mutate: vi.fn(
      async (_mutation, _identity, _transaction, _signal, confirmed) => {
        order.push("effect");
        await confirmed();
        return { changed: true };
      },
    ),
    recover: vi.fn(async () => {
      order.push("recover");
      return { recovered: true };
    }),
    export: vi.fn(async () => {}),
    now: () => clock,
  };
  const controller = new WindowsFleetAdvancedController(ports);
  return {
    controller,
    ports,
    order,
    release,
    state: () => state,
    replace: () => {
      actual = { ...actual, digest: "b".repeat(64) };
    },
    expire: () => {
      clock += 300001;
    },
    journal: (value: AdvancedJournal) => {
      state = value;
    },
  };
}
async function confirm(
  f: ReturnType<typeof fixture>,
  action: "cleanup" | "revoke" | "update" = "cleanup",
) {
  await f.controller.execute({ type: "CONFIRM", mutation: { action } });
  return f.controller.snapshot().confirmation!.token;
}
describe("consumer Advanced command boundary", () => {
  it("withdraws a failed confirmation release and retains that same resource for retirement retry", async () => {
    const f = fixture(),
      unknown = Error("DESTINATION_CLOSE_UNKNOWN"),
      release = vi.fn<() => Promise<void>>();
    release.mockRejectedValueOnce(unknown).mockResolvedValue(undefined);
    f.ports.prepareConfirmation = vi.fn(async () => ({ release }));
    const token = await confirm(f);
    await expect(f.controller.execute({ type: "CANCEL" })).rejects.toBe(
      unknown,
    );
    await expect(
      f.controller.execute({ type: "RUN", confirmation: token }),
    ).rejects.toThrow("ADVANCED_CONFIRMATION_EXPIRED");
    await expect(
      f.controller.execute({
        type: "CONFIRM",
        mutation: { action: "cleanup" },
      }),
    ).rejects.toThrow("ADVANCED_RECOVERY_REQUIRED");
    expect(f.ports.mutate).not.toHaveBeenCalled();
    await f.controller.beginRetirement();
    expect(release).toHaveBeenCalledTimes(2);
    expect(f.ports.prepareConfirmation).toHaveBeenCalledOnce();
    await f.controller.dispose();
    expect(release).toHaveBeenCalledTimes(2);
  });
  it("fences Store retirement intake while preserving recovery of the original uncertain effect", async () => {
    const f = fixture(),
      token = await confirm(f);
    vi.mocked(f.ports.mutate).mockRejectedValueOnce(Error("BACKEND_ACK_LOST"));
    await expect(
      f.controller.execute({ type: "RUN", confirmation: token }),
    ).rejects.toThrow("BACKEND_ACK_LOST");
    expect(f.controller.snapshot().phase).toBe("recovery");
    await f.controller.beginRetirement();
    await expect(
      f.controller.execute({
        type: "CONFIRM",
        mutation: { action: "cleanup" },
      }),
    ).rejects.toThrow("ADVANCED_CLOSED");
    await f.controller.execute({ type: "RECOVER" });
    expect(f.ports.recover).toHaveBeenCalledOnce();
    expect(f.state()?.phase).toBe("complete");
    expect(f.controller.snapshot().phase).toBe("complete");
    await f.controller.dispose();
    await expect(f.controller.execute({ type: "RECOVER" })).rejects.toThrow(
      "ADVANCED_CLOSED",
    );
  });
  it("withdraws issued confirmation on Cancel so a declined token cannot run", async () => {
    const f = fixture(),
      token = await confirm(f);
    await f.controller.execute({ type: "CANCEL" });
    expect(f.controller.snapshot().confirmation).toBeNull();
    await expect(
      f.controller.execute({ type: "RUN", confirmation: token }),
    ).rejects.toThrow("ADVANCED_CONFIRMATION_EXPIRED");
    expect(f.ports.mutate).not.toHaveBeenCalled();
  });
  it("does not issue late confirmation after cancellation during identity lookup", async () => {
    const f = fixture();
    let resolve!: (value: {
      sid: string;
      machineId: string;
      revision: number;
      digest: string;
    }) => void;
    vi.mocked(f.ports.identity).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const requesting = f.controller.execute({
      type: "CONFIRM",
      mutation: { action: "cleanup" },
    });
    await vi.waitFor(() => expect(f.ports.identity).toHaveBeenCalled());
    const requestRejected =
      expect(requesting).rejects.toThrow("ADVANCED_CANCELLED");
    const cancelled = f.controller.execute({ type: "CANCEL" });
    const cancelRejected =
      expect(cancelled).rejects.toThrow("ADVANCED_CANCELLED");
    resolve({
      sid: fleetSid,
      machineId: advancedRequest,
      revision: 1,
      digest: "a".repeat(64),
    });
    await Promise.all([requestRejected, cancelRejected]);
    expect(f.controller.snapshot().confirmation).toBeNull();
    expect(f.ports.mutate).not.toHaveBeenCalled();
  });
  it("rejects CLI, raw paths, missing job/code, inherited or over-limit parameter shapes", () => {
    for (const command of [
      { type: "READ", section: "job" },
      { type: "READ", section: "explain" },
      { type: "READ", section: "logs", filter: { lines: 1001 } },
      { type: "READ", section: "versions", filter: { full: true } },
      { type: "CONFIRM", mutation: { action: "revoke", force: "true" } },
      { type: "CONFIRM", mutation: { action: "stop", force: false } },
      { type: "CONFIRM", mutation: { action: "update", source: "untrusted" } },
      {
        type: "CONFIRM",
        mutation: { action: "benchmark_file", input: "C:\\private.wav" },
      },
      { type: "shell", command: "sc.exe stop" },
      { type: "CANCEL", path: "C:\\private" },
    ])
      expect(() => parseFleetAdvancedCommand(command)).toThrow(
        "ADVANCED_REQUEST_INVALID",
      );
  });
  it("redacts nested secrets, URLs and private paths before views and exports", async () => {
    const f = fixture();
    await f.controller.execute({ type: "READ", section: "logs" });
    expect(JSON.stringify(f.controller.snapshot())).not.toContain("secret");
    expect(JSON.stringify(f.controller.snapshot())).not.toContain(
      "signed.example",
    );
    expect(JSON.stringify(f.controller.snapshot())).not.toContain("fixture");
    await f.controller.execute({
      type: "EXPORT",
      destinationCapability: advancedRequest,
    });
    expect(f.ports.export).toHaveBeenCalledOnce();
    expect(() =>
      sanitizeAdvancedData({ v: Array.from({ length: 21000 }, () => ({})) }),
    ).not.toThrow();
    expect(() =>
      sanitizeAdvancedData({
        v: Object.fromEntries(
          Array.from({ length: 20001 }, (_, i) => [String(i), i]),
        ),
      }),
    ).toThrow("ADVANCED_RESULT_TOO_LARGE");
  });
});
describe("reviewed force/source confirmation", () => {
  it("freezes force and source in the one-use review while preserving ordinary command behavior", async () => {
    const f = fixture();
    f.ports.prepareConfirmation = async () => ({
      forceRevision: 7,
      release: async () => {},
    });
    const mutation = { action: "update", force: true, source: "catalog" };
    await f.controller.execute({ type: "CONFIRM", mutation });
    const issued = f.controller.snapshot().confirmation!;
    expect(issued).toMatchObject({ force: true, source: "catalog" });
    mutation.force = false;
    mutation.source = "app";
    await f.controller.execute({ type: "RUN", confirmation: issued.token });
    expect(f.state()).toMatchObject({
      forceRevision: 7,
      mutation: { action: "update", force: true, source: "catalog" },
    });
    expect(f.ports.maintenance.acquire).not.toHaveBeenCalled();
    await expect(
      f.controller.execute({ type: "RUN", confirmation: issued.token }),
    ).rejects.toThrow("ADVANCED_CONFIRMATION_EXPIRED");
  });
  it("cannot turn a force toggle into authority without captured current session state", async () => {
    const f = fixture();
    await f.controller.execute({
      type: "CONFIRM",
      mutation: { action: "stop", force: true },
    });
    await expect(
      f.controller.execute({
        type: "RUN",
        confirmation: f.controller.snapshot().confirmation!.token,
      }),
    ).rejects.toThrow("ADVANCED_JOURNAL_INVALID");
    expect(f.state()).toBeNull();
    expect(f.ports.mutate).not.toHaveBeenCalled();
  });
  it("retains exact force revision after an uncertain effect and requires original machine on recovery", async () => {
    const f = fixture();
    f.ports.prepareConfirmation = async () => ({
      forceRevision: 7,
      release: async () => {},
    });
    f.ports.mutate = vi.fn(async () => {
      throw new Error("FLEET_DRAIN_PENDING");
    });
    await f.controller.execute({
      type: "CONFIRM",
      mutation: { action: "restart", force: true },
    });
    await expect(
      f.controller.execute({
        type: "RUN",
        confirmation: f.controller.snapshot().confirmation!.token,
      }),
    ).rejects.toThrow("FLEET_DRAIN_PENDING");
    expect(f.state()).toMatchObject({ forceRevision: 7, phase: "running" });
    f.replace();
    await expect(f.controller.execute({ type: "RECOVER" })).rejects.toThrow(
      "ADVANCED_MACHINE_CHANGED",
    );
    expect(f.ports.recover).not.toHaveBeenCalled();
  });
});
describe("durable Advanced mutation authority", () => {
  it("requires one-use current-machine confirmation and preserves the exact maintenance sequence", async () => {
    const f = fixture(),
      token = await confirm(f);
    expect(f.ports.mutate).not.toHaveBeenCalled();
    await f.controller.execute({ type: "RUN", confirmation: token });
    expect(f.order).toEqual([
      "waiting",
      "acquire",
      "fenced",
      "running",
      "effect",
      "effect-confirmed",
      "effect-confirmed",
      "release",
      "complete",
    ]);
    expect(f.state()?.phase).toBe("complete");
    await expect(
      f.controller.execute({ type: "RUN", confirmation: token }),
    ).rejects.toThrow("ADVANCED_CONFIRMATION_EXPIRED");
  });
  it("refuses a replaced machine, changed generation and expired confirmation before writing", async () => {
    for (const replacement of [true, false]) {
      const f = fixture(),
        token = await confirm(f);
      if (replacement) f.replace();
      else f.expire();
      await expect(
        f.controller.execute({ type: "RUN", confirmation: token }),
      ).rejects.toThrow(
        replacement
          ? "ADVANCED_MACHINE_CHANGED"
          : "ADVANCED_CONFIRMATION_EXPIRED",
      );
      expect(f.ports.journal.write).not.toHaveBeenCalled();
      expect(f.ports.mutate).not.toHaveBeenCalled();
    }
  });
  it("keeps a failed drain durable without invoking a destructive effect or restoring running intent", async () => {
    const f = fixture(),
      token = await confirm(f);
    vi.mocked(f.ports.maintenance.acquire).mockRejectedValueOnce(
      new Error("FLEET_DRAIN_PENDING"),
    );
    await expect(
      f.controller.execute({ type: "RUN", confirmation: token }),
    ).rejects.toThrow("FLEET_DRAIN_PENDING");
    expect(f.state()?.phase).toBe("waiting");
    expect(f.controller.snapshot().phase).toBe("recovery");
    expect(f.release).not.toHaveBeenCalled();
    expect(f.ports.mutate).not.toHaveBeenCalled();
    await expect(
      f.controller.execute({ type: "CONFIRM", mutation: { action: "revoke" } }),
    ).rejects.toThrow("ADVANCED_RECOVERY_REQUIRED");
  });
  it("does not invoke effects when the running journal fails and keeps the acquired fence", async () => {
    const f = fixture(),
      token = await confirm(f),
      write = f.ports.journal.write;
    vi.mocked(write).mockImplementation(async (value) => {
      if (value.phase === "running") throw new Error("ADVANCED_DISK_FAILED");
      f.journal(value);
    });
    await expect(
      f.controller.execute({ type: "RUN", confirmation: token }),
    ).rejects.toThrow("ADVANCED_DISK_FAILED");
    expect(f.ports.mutate).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.state()?.phase).toBe("fenced");
  });
  it("requires real recovery proof before maintenance cancellation", async () => {
    const f = fixture(),
      token = await confirm(f);
    vi.mocked(f.ports.mutate).mockRejectedValueOnce(
      new Error("ADVANCED_BENCHMARK_TREE_UNCERTAIN"),
    );
    await expect(
      f.controller.execute({ type: "RUN", confirmation: token }),
    ).rejects.toThrow();
    vi.mocked(f.ports.recover).mockRejectedValueOnce(
      new Error("ADVANCED_BENCHMARK_TREE_UNCERTAIN"),
    );
    await expect(f.controller.execute({ type: "RECOVER" })).rejects.toThrow();
    expect(f.ports.maintenance.cancel).not.toHaveBeenCalled();
    await f.controller.execute({ type: "RECOVER" });
    expect(f.order.slice(-3)).toEqual(["recover", "cancel", "complete"]);
  });
  it("retains uncertainty after an acknowledgement failure and does not operate on a replacement during recovery", async () => {
    const f = fixture(),
      token = await confirm(f, "revoke");
    vi.mocked(f.ports.mutate).mockRejectedValueOnce(
      new Error("WORKER_CONFLICT"),
    );
    await expect(
      f.controller.execute({ type: "RUN", confirmation: token }),
    ).rejects.toThrow();
    f.replace();
    await expect(f.controller.execute({ type: "RECOVER" })).rejects.toThrow(
      "ADVANCED_MACHINE_CHANGED",
    );
    expect(f.ports.recover).not.toHaveBeenCalled();
    expect(f.ports.maintenance.cancel).not.toHaveBeenCalled();
  });
  it("cancels immediately but waits for operation teardown; rejects concurrent new work", async () => {
    const f = fixture(),
      token = await confirm(f);
    let finish!: () => void, started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.mocked(f.ports.mutate).mockImplementation(async (_m, _i, _t, signal) => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (signal.aborted) throw new Error("ADVANCED_CANCELLED");
      return {};
    });
    const run = f.controller.execute({ type: "RUN", confirmation: token });
    await ready;
    const cancel = f.controller.execute({ type: "CANCEL" });
    await expect(
      f.controller.execute({ type: "READ", section: "status" }),
    ).rejects.toThrow("ADVANCED_BUSY");
    finish();
    await expect(run).rejects.toThrow("ADVANCED_CANCELLED");
    await expect(cancel).rejects.toThrow("ADVANCED_CANCELLED");
    expect(f.release).not.toHaveBeenCalled();
    expect(f.state()?.phase).toBe("running");
  });
  it("delegates update maintenance to the existing updater without acquiring a conflicting second fence", async () => {
    const f = fixture(),
      token = await confirm(f, "update");
    await f.controller.execute({ type: "RUN", confirmation: token });
    expect(f.ports.maintenance.acquire).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  });
  it("initializes interrupted state honestly and validates current/Azure SID journal shapes", async () => {
    const f = fixture(),
      token = await confirm(f);
    vi.mocked(f.ports.mutate).mockRejectedValueOnce(
      new Error("ADVANCED_HELPER_LOST"),
    );
    await expect(
      f.controller.execute({ type: "RUN", confirmation: token }),
    ).rejects.toThrow();
    await f.controller.initialize();
    expect(f.controller.snapshot().phase).toBe("recovery");
    expect(
      parseAdvancedJournal({
        ...f.state(),
        identity: { ...f.state()!.identity, sid: "S-1-12-1-1-2-3-4" },
      }).identity.sid,
    ).toBe("S-1-12-1-1-2-3-4");
    expect(() =>
      parseAdvancedJournal({
        ...f.state(),
        identity: { ...f.state()!.identity, sid: "S-1-5-19" },
      }),
    ).toThrow();
  });
});
describe("claimed benchmark destination lifetime", () => {
  it("claims at confirmation before maintenance and lends exact resource only to the one-use mutation", async () => {
    const f = fixture(),
      resource = {
        release: vi.fn(async () => {
          f.order.push("destination-release");
        }),
      };
    f.ports.prepareConfirmation = vi.fn(async () => {
      f.order.push("destination-claim");
      return resource;
    });
    const token = await confirm(f);
    expect(f.order).toEqual(["destination-claim"]);
    await f.controller.execute({ type: "RUN", confirmation: token });
    expect(f.ports.mutate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.any(AbortSignal),
      expect.any(Function),
      resource,
    );
    expect(f.order.indexOf("destination-claim")).toBeLessThan(
      f.order.indexOf("acquire"),
    );
    expect(resource.release).toHaveBeenCalledOnce();
  });
  it("cancel, expiry and changed machine release claimed output without writing", async () => {
    for (const kind of ["cancel", "expiry", "machine"]) {
      const f = fixture(),
        release = vi.fn(async () => {});
      f.ports.prepareConfirmation = async () => ({ release });
      const token = await confirm(f);
      if (kind === "cancel") await f.controller.execute({ type: "CANCEL" });
      else if (kind === "expiry") f.expire();
      else f.replace();
      await expect(
        f.controller.execute({ type: "RUN", confirmation: token }),
      ).rejects.toThrow(
        kind === "machine"
          ? "ADVANCED_MACHINE_CHANGED"
          : "ADVANCED_CONFIRMATION_EXPIRED",
      );
      expect(release).toHaveBeenCalledOnce();
      expect(f.ports.mutate).not.toHaveBeenCalled();
    }
  });
  it("cancellation during destination claim cannot mint a late confirmation or leak the borrowed destination", async () => {
    const f = fixture(),
      release = vi.fn(async () => {});
    let accept!: (value: { release: typeof release }) => void;
    const pending = new Promise<{ release: typeof release }>((yes) => {
      accept = yes;
    });
    f.ports.prepareConfirmation = vi.fn(() => pending);
    const confirmTask = confirm(f);
    await vi.waitFor(() =>
      expect(f.ports.prepareConfirmation).toHaveBeenCalledOnce(),
    );
    const cancelling = f.controller.execute({ type: "CANCEL" });
    accept({ release });
    await expect(confirmTask).rejects.toThrow("ADVANCED_CANCELLED");
    await expect(cancelling).rejects.toThrow("ADVANCED_CANCELLED");
    expect(release).toHaveBeenCalledOnce();
    expect(f.controller.snapshot().confirmation).toBeNull();
  });
  it("dispose waits actual sink teardown before releasing active destination", async () => {
    const f = fixture(),
      release = vi.fn(async () => {});
    f.ports.prepareConfirmation = async () => ({ release });
    const token = await confirm(f);
    let finish!: (value: unknown) => void;
    const sink = new Promise<unknown>((yes) => {
      finish = yes;
    });
    f.ports.mutate = vi.fn(async () => sink);
    const run = f.controller.execute({ type: "RUN", confirmation: token });
    await vi.waitFor(() => expect(f.ports.mutate).toHaveBeenCalledOnce());
    let done = false;
    const close = f.controller.dispose().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(release).not.toHaveBeenCalled();
    finish({ exported: true });
    await run;
    await close;
    expect(release).toHaveBeenCalledOnce();
  });
});
