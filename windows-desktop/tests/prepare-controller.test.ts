import { expect, it, vi } from "vitest";
import {
  PrepareController,
  PrepareFailure,
  preparationFailure,
  parsePrepareJournal,
  type PreparationOperations,
  type PrepareJournal,
} from "../src/main/prepare/controller.js";
import { PREPARE_STAGES } from "../src/shared/prepare-contracts.js";
const target = { identity: "a".repeat(64), sid: "S-1-5-21-1-2-3-1001" };
it("journal states require an exact string and cannot execute unknown coercion", () => {
  const row = {
      version: 1,
      transaction: "00000000-0000-4000-8000-000000000001",
      target: target.identity,
      sid: target.sid,
      state: "complete",
      completed: [...PREPARE_STAGES],
    },
    coerce = vi.fn(() => "complete");
  for (const state of [
    { toString: coerce, [Symbol.toPrimitive]: coerce },
    ["complete"],
    0,
    true,
    null,
  ])
    expect(() => parsePrepareJournal({ ...row, state }, target)).toThrow(
      "JOURNAL_CORRUPT",
    );
  expect(coerce).not.toHaveBeenCalled();
  for (const state of ["running", "failed", "cancelled", "complete"])
    expect(parsePrepareJournal({ ...row, state }, target)?.state).toBe(state);
});
it("readonly readiness on a cold PC stays missing without download, inference, activation, registration or journal writes", async () => {
  const f = fixture();
  f.operations.cachedReady = vi.fn(async () => true);
  f.operations.browserReady = vi.fn(async () => true);
  const register = vi.fn(async () => true);
  f.operations.registerBrowser = register;
  expect((await f.controller.check()).state).toBe("missing");
  expect(f.calls).toEqual([]);
  expect(f.saved()).toBeNull();
  expect(register).not.toHaveBeenCalled();
  expect(f.operations.cachedReady).not.toHaveBeenCalled();
});
it("readonly readiness uses a complete journal and actual cheap receipt, retaining it unchanged when Chrome registration needs attention", async () => {
  const f = fixture(),
    record = {
      version: 1,
      transaction: "00000000-0000-4000-8000-000000000001",
      target: target.identity,
      sid: target.sid,
      state: "complete",
      completed: [...PREPARE_STAGES],
    };
  f.setSaved(record);
  f.operations.cachedReady = vi.fn(async () => true);
  f.operations.browserReady = vi.fn(async () => false);
  expect(await f.controller.check()).toMatchObject({
    state: "ready",
    browser: "attention-needed",
  });
  expect(f.saved()).toEqual(record);
  expect(f.calls).toEqual([]);
  expect(f.release).toHaveBeenCalledOnce();
  f.operations.cachedReady = vi.fn(async () => false);
  expect((await f.controller.check()).state).toBe("missing");
  expect(f.saved()).toEqual(record);
});
function fixture() {
  let saved: unknown = null;
  const calls: string[] = [];
  const release = vi.fn(async () => {});
  const operations: PreparationOperations = {
    target: async () => target,
    lock: async () => ({ release }),
    space: async () => ({ requiredBytes: 100, availableBytes: 200 }),
    reuse: async () => false,
    perform: async (stage) => {
      calls.push(stage);
    },
    verifyReady: async () => true,
    registerBrowser: async () => true,
    cancelOwned: vi.fn(async () => {}),
    repair: vi.fn(async () => {}),
  };
  const controller = new PrepareController(operations, {
    read: async () => structuredClone(saved),
    write: async (value) => {
      saved = structuredClone(value);
    },
  });
  return {
    controller,
    operations,
    calls,
    release,
    saved: () => saved as PrepareJournal,
    setSaved: (value: unknown) => {
      saved = value;
    },
  };
}
it("serializes app/Chrome requests and records completion only after every prerequisite verifies", async () => {
  const f = fixture();
  const first = f.controller.start(),
    second = f.controller.start();
  expect(first).toBe(second);
  expect((await first).state).toBe("ready");
  expect(f.calls).toEqual(PREPARE_STAGES);
  expect(f.saved().state).toBe("complete");
  expect(f.release).toHaveBeenCalledOnce();
});
it("projects only an explicit trusted model failure and clears it on check, success, new work and cancellation", async () => {
  const f = fixture();
  f.operations.perform = async () => {
    throw new PrepareFailure("INTEGRITY_INVALID", "model");
  };
  expect(await f.controller.start()).toMatchObject({
    state: "error",
    errorComponent: "model",
  });
  await f.controller.cancel();
  expect(f.controller.view().errorComponent).toBeNull();
  expect(await f.controller.check()).toMatchObject({ errorComponent: null });
  f.operations.perform = async (stage) => {
    if (stage === "model") throw new PrepareFailure("INTEGRITY_INVALID");
  };
  expect(await f.controller.start({ repair: true })).toMatchObject({
    state: "error",
    errorComponent: null,
  });
  f.operations.perform = async () => {};
  expect(await f.controller.start({ repair: true })).toMatchObject({
    state: "ready",
    errorComponent: null,
  });
});
it("a late typed model rejection after cancellation cannot label the next successful preparation", async () => {
  const f = fixture();
  let reject!: (error: unknown) => void;
  const waiting = new Promise<void>((_resolve, r) => {
    reject = r;
  });
  f.operations.perform = async (stage) => {
    if (stage === "model") await waiting;
  };
  const task = f.controller.start();
  await vi.waitFor(() => expect(f.controller.view().stage).toBe("model"));
  const cancel = f.controller.cancel();
  reject(new PrepareFailure("INTEGRITY_INVALID", "model"));
  await cancel;
  expect(await task).toMatchObject({
    state: "cancelled",
    errorComponent: null,
  });
  f.operations.perform = async () => {};
  expect(await f.controller.start()).toMatchObject({
    state: "ready",
    errorComponent: null,
  });
});
it("unknown error-code objects/accessors cannot run coercion or become a native/model cause", () => {
  const coerce = vi.fn(() => "EACCES"),
    getter = vi.fn(() => "EPERM");
  expect(preparationFailure({ code: { toString: coerce } })).toMatchObject({
    code: "OPERATION_FAILED",
  });
  expect(
    preparationFailure(Object.defineProperty({}, "code", { get: getter })),
  ).toMatchObject({ code: "OPERATION_FAILED" });
  expect(coerce).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
});
it.each(PREPARE_STAGES)(
  "records failure at %s and never emits Ready",
  async (failedStage) => {
    const f = fixture();
    const observed: string[] = [];
    f.controller.subscribe((view) => observed.push(view.state));
    f.operations.perform = async (stage) => {
      f.calls.push(stage);
      if (stage === failedStage) throw new PrepareFailure("INTEGRITY_INVALID");
    };
    expect((await f.controller.start()).errorCode).toBe("INTEGRITY_INVALID");
    expect(observed).not.toContain("ready");
    expect(f.saved().state).toBe("failed");
    expect(f.release).toHaveBeenCalledOnce();
  },
);
it("rechecks completed crash stages and invalidates downstream reuse after changed runtime", async () => {
  const f = fixture();
  f.setSaved({
    version: 1,
    transaction: "00000000-0000-4000-8000-000000000001",
    target: target.identity,
    sid: target.sid,
    state: "running",
    completed: [...PREPARE_STAGES],
  });
  const reused: string[] = [];
  f.operations.reuse = async (stage) => {
    reused.push(stage);
    return stage !== "runtime";
  };
  expect((await f.controller.start()).state).toBe("ready");
  expect(reused).toEqual(["inspect", "space", "runtime"]);
  expect(f.calls).toEqual(["runtime", "model", "gpu", "activate"]);
});
it("reuses valid completed stages while still rechecking disk and final GPU readiness", async () => {
  const f = fixture();
  await f.controller.start();
  f.calls.length = 0;
  f.operations.reuse = async () => true;
  f.operations.verifyReady = async () => false;
  expect((await f.controller.start()).state).toBe("error");
  expect(f.calls).toEqual([]);
  expect(f.saved().state).toBe("failed");
});
it("keeps Chrome registration attention separate from verified local GPU readiness", async () => {
  const f = fixture();
  f.operations.registerBrowser = async () => {
    throw new Error("private native failure text");
  };
  expect(await f.controller.start()).toMatchObject({
    state: "ready",
    browser: "attention-needed",
    errorCode: null,
  });
});
it("rejects insufficient disk space before runtime/model/GPU activity", async () => {
  const f = fixture();
  f.operations.space = async () => ({
    requiredBytes: 200,
    availableBytes: 100,
  });
  expect(await f.controller.start()).toMatchObject({
    state: "error",
    errorCode: "LOW_DISK",
    requiredBytes: 200,
    availableBytes: 100,
  });
  expect(f.calls).toEqual(["inspect"]);
});
it("cancels owned work, fences late progress and releases the setup lease", async () => {
  const f = fixture();
  let resolve!: () => void,
    progress!: (completed: number, total: number) => void;
  f.operations.perform = async (stage, _target, signal, notify) => {
    if (stage === "runtime") {
      progress = notify;
      await new Promise<void>((done) => {
        resolve = done;
        signal.addEventListener("abort", () => done(), { once: true });
      });
    }
  };
  const active = f.controller.start();
  while (!resolve) await new Promise<void>((done) => setTimeout(done, 0));
  await f.controller.cancel();
  expect((await active).state).toBe("cancelled");
  expect(f.operations.cancelOwned).toHaveBeenCalledOnce();
  progress(100, 100);
  expect(f.controller.view().percent).toBeNull();
  expect(f.saved().state).toBe("cancelled");
  expect(f.release).toHaveBeenCalledOnce();
});
it("rejects foreign/corrupt journal without resetting identity and repairs only under its lease", async () => {
  const f = fixture();
  f.setSaved({
    version: 1,
    transaction: "00000000-0000-4000-8000-000000000001",
    target: target.identity,
    sid: "S-1-5-21-1-2-3-1002",
    state: "complete",
    completed: [...PREPARE_STAGES],
  });
  expect((await f.controller.start()).errorCode).toBe("JOURNAL_CORRUPT");
  expect(f.operations.repair).not.toHaveBeenCalled();
  expect(f.calls).toEqual([]);
  f.setSaved(null);
  expect((await f.controller.start({ repair: true })).state).toBe("ready");
  expect(f.operations.repair).toHaveBeenCalledOnce();
});
it("handles lease contention without changing the setup journal", async () => {
  const f = fixture();
  f.operations.lock = async () => null;
  expect((await f.controller.start()).errorCode).toBe("BUSY");
  expect(f.saved()).toBeNull();
  expect(f.calls).toEqual([]);
  expect(f.release).not.toHaveBeenCalled();
});
it("does not show transient Ready if the installation lease cannot be released", async () => {
  const f = fixture();
  const states: string[] = [];
  f.controller.subscribe((view) => states.push(view.state));
  f.operations.lock = async () => ({
    release: async () => {
      throw new Error("owned helper unavailable");
    },
  });
  expect((await f.controller.start()).state).toBe("error");
  expect(states).not.toContain("ready");
});
it("accepts an Azure AD user identity and rejects SID subauthority overflow", async () => {
  const f = fixture();
  f.operations.target = async () => ({
    ...target,
    sid: "S-1-12-1-1-2-3-4294967295",
  });
  expect((await f.controller.start()).state).toBe("ready");
  f.operations.target = async () => ({
    ...target,
    sid: "S-1-12-1-1-2-3-4294967296",
  });
  expect((await f.controller.start()).errorCode).toBe("INTEGRITY_INVALID");
});
it("repairs only the corrupt setup journal under the owned lease without resetting account identity", async () => {
  const f = fixture();
  f.setSaved({ invalid: "journal" });
  expect((await f.controller.start()).errorCode).toBe("JOURNAL_CORRUPT");
  expect((await f.controller.start({ repair: true })).state).toBe("ready");
  expect(f.operations.repair).toHaveBeenCalledWith(
    target,
    null,
    expect.any(AbortSignal),
  );
  expect(f.saved().sid).toBe(target.sid);
  expect(f.saved().completed).toEqual(PREPARE_STAGES);
});
it("uses a bounded verified receipt only for a complete journal and bypasses hashing, space planning and inference", async () => {
  const f = fixture();
  await f.controller.start();
  f.calls.length = 0;
  f.operations.space = vi.fn(async () => {
    throw new Error("UNEXPECTED_SPACE_READ");
  });
  f.operations.verifyReady = vi.fn(async () => {
    throw new Error("UNEXPECTED_FULL_VERIFY");
  });
  f.operations.cachedReady = vi.fn(async () => true);
  expect((await f.controller.start()).state).toBe("ready");
  expect(f.calls).toEqual([]);
  expect(f.operations.space).not.toHaveBeenCalled();
  expect(f.operations.verifyReady).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(2);
});
it("falls back after changed cached identities and never uses an interrupted journal as a receipt", async () => {
  const f = fixture();
  await f.controller.start();
  f.calls.length = 0;
  f.operations.cachedReady = vi.fn(async () => false);
  expect((await f.controller.start()).state).toBe("ready");
  expect(f.calls).toEqual(PREPARE_STAGES);
  f.setSaved({ ...f.saved(), state: "running" });
  vi.mocked(f.operations.cachedReady).mockClear();
  await f.controller.start();
  expect(f.operations.cachedReady).not.toHaveBeenCalled();
});
it("explicit repair skips the cached status receipt", async () => {
  const f = fixture();
  await f.controller.start();
  f.calls.length = 0;
  f.operations.cachedReady = vi.fn(async () => true);
  await f.controller.start({ repair: true });
  expect(f.operations.cachedReady).not.toHaveBeenCalled();
  expect(f.calls).toEqual(PREPARE_STAGES);
});
