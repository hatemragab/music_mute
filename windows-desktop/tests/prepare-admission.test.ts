import { expect, it, vi } from "vitest";
import {
  PrepareController,
  PrepareFailure,
  type PreparationOperations,
  type PrepareJournal,
} from "../src/main/prepare/controller.js";
import { PREPARE_STAGES } from "../src/shared/prepare-contracts.js";
import { target } from "./fixtures/prepare.js";
function fixture() {
  const events: string[] = [];
  let record: PrepareJournal | null = null,
    cleanup = false,
    proof = false;
  const setupRelease = vi.fn(async () => {
    events.push("prepare-release");
  });
  const mutationRelease = vi.fn(async () => {
    events.push("mutation-release");
  });
  const beforeMutation = vi.fn(async () => {
    events.push("mutation-enter");
    return { release: mutationRelease };
  });
  const operations: PreparationOperations = {
    target: async () => {
      events.push("target");
      return target;
    },
    lock: async () => {
      events.push("prepare-lock");
      return { release: setupRelease };
    },
    space: async () => ({ requiredBytes: 1, availableBytes: 100 }),
    reuse: async () => false,
    cachedReady: vi.fn(async () => false),
    perform: vi.fn(async (stage) => {
      events.push(stage);
    }),
    verifyReady: async () => true,
    registerBrowser: async () => {
      events.push("browser");
      return true;
    },
    cancelOwned: async () => {},
    repair: async () => {
      events.push("repair");
    },
    cleanupPending: () => cleanup,
    recoverCleanup: async () => {
      events.push("exact-cleanup-query");
      if (!proof) throw new Error("cleanup unconfirmed");
      cleanup = false;
    },
  };
  const controller = new PrepareController(
    operations,
    {
      read: async () => (record ? structuredClone(record) : null),
      write: async (next) => {
        events.push("journal");
        record = structuredClone(next);
      },
    },
    { beforeMutation },
  );
  return {
    controller,
    operations,
    events,
    setupRelease,
    mutationRelease,
    beforeMutation,
    setRecord: (value: PrepareJournal) => {
      record = value;
    },
    setCleanup: (value: boolean) => {
      cleanup = value;
    },
    setProof: (value: boolean) => {
      proof = value;
    },
  };
}
function complete(): PrepareJournal {
  return {
    version: 1,
    transaction: "121f38cf-1024-43d1-bd11-c45bf155250c",
    target: target.identity,
    sid: target.sid,
    state: "complete",
    completed: [...PREPARE_STAGES],
  };
}
it("valid warm Ready does not drain/restart consumers or run expensive stages", async () => {
  const f = fixture();
  f.setRecord(complete());
  f.operations.cachedReady = async () => true;
  expect((await f.controller.start()).state).toBe("ready");
  expect(f.beforeMutation).not.toHaveBeenCalled();
  expect(f.events).toEqual([
    "target",
    "prepare-lock",
    "browser",
    "prepare-release",
  ]);
});
it("changed warm proof enters maintenance exactly once before the first journal or filesystem mutation", async () => {
  const f = fixture();
  f.setRecord(complete());
  expect((await f.controller.start()).state).toBe("ready");
  expect(f.beforeMutation).toHaveBeenCalledOnce();
  expect(f.events.indexOf("mutation-enter")).toBeLessThan(
    f.events.indexOf("journal"),
  );
  expect(f.events.indexOf("mutation-enter")).toBeLessThan(
    f.events.indexOf("runtime"),
  );
  expect(f.events.slice(-2)).toEqual(["prepare-release", "mutation-release"]);
});
it("explicit Repair drains before repair even when ordinary cached Ready would pass", async () => {
  const f = fixture();
  f.setRecord(complete());
  f.operations.cachedReady = async () => true;
  expect((await f.controller.start({ repair: true })).state).toBe("ready");
  expect(f.events.indexOf("mutation-enter")).toBeLessThan(
    f.events.indexOf("repair"),
  );
  expect(f.events.indexOf("repair")).toBeLessThan(f.events.indexOf("journal"));
});
it("refused mutation admission writes nothing, performs no repair/stage and releases only its Prepare lease", async () => {
  const f = fixture();
  f.beforeMutation.mockRejectedValue(new PrepareFailure("BUSY"));
  expect(await f.controller.start({ repair: true })).toMatchObject({
    state: "error",
    errorCode: "BUSY",
  });
  expect(f.events).toEqual(["target", "prepare-lock", "prepare-release"]);
  expect(f.mutationRelease).not.toHaveBeenCalled();
});
it("unknown Job/guard cleanup retains both authorities and truthful activity until exact proof then ordered release", async () => {
  const f = fixture();
  f.operations.perform = async (stage) => {
    f.events.push(stage);
    if (stage === "gpu") {
      f.setCleanup(true);
      throw new Error("tree still running");
    }
  };
  expect((await f.controller.start()).state).toBe("error");
  expect(f.controller.isRunning()).toBe(true);
  expect(f.setupRelease).not.toHaveBeenCalled();
  expect(f.mutationRelease).not.toHaveBeenCalled();
  expect((await f.controller.start({ repair: true })).state).toBe("error");
  expect(f.beforeMutation).toHaveBeenCalledOnce();
  expect(f.setupRelease).not.toHaveBeenCalled();
  await expect(f.controller.cancel()).rejects.toThrow("cleanup unconfirmed");
  expect(f.controller.isRunning()).toBe(true);
  f.setProof(true);
  await f.controller.cancel();
  expect(f.events.slice(-3)).toEqual([
    "exact-cleanup-query",
    "prepare-release",
    "mutation-release",
  ]);
  expect(f.controller.isRunning()).toBe(false);
});
it("lost Prepare release ACK retains maintenance, and retry does not retire it ahead of positive release", async () => {
  const f = fixture();
  f.setupRelease.mockRejectedValueOnce(new Error("ACK lost"));
  expect((await f.controller.start()).state).toBe("error");
  expect(f.controller.isRunning()).toBe(true);
  expect(f.mutationRelease).not.toHaveBeenCalled();
  await f.controller.cancel();
  expect(f.setupRelease).toHaveBeenCalledTimes(2);
  expect(f.mutationRelease).toHaveBeenCalledOnce();
  expect(f.controller.isRunning()).toBe(false);
});
it("lost maintenance release ACK remains busy after Prepare has already released and never double releases it", async () => {
  const f = fixture();
  f.mutationRelease.mockRejectedValueOnce(new Error("ACK lost"));
  expect((await f.controller.start()).state).toBe("error");
  expect(f.controller.isRunning()).toBe(true);
  await f.controller.cancel();
  expect(f.setupRelease).toHaveBeenCalledOnce();
  expect(f.mutationRelease).toHaveBeenCalledTimes(2);
  expect(f.controller.isRunning()).toBe(false);
});
it("cancellation during held mutation admission releases the acquired authorities without stages or journal writes", async () => {
  const f = fixture();
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.beforeMutation.mockImplementation(async () => {
    await gate;
    return { release: f.mutationRelease };
  });
  const started = f.controller.start();
  while (!f.beforeMutation.mock.calls.length) await Promise.resolve();
  const cancelled = f.controller.cancel();
  entered();
  await cancelled;
  expect((await started).state).toBe("cancelled");
  expect(f.events).toEqual([
    "target",
    "prepare-lock",
    "prepare-release",
    "mutation-release",
  ]);
  expect(f.controller.isRunning()).toBe(false);
});
