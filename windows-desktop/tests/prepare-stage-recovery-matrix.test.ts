import { expect, it, vi } from "vitest";
import {
  PrepareController,
  PrepareFailure,
  type PreparationOperations,
  type PrepareJournal,
} from "../src/main/prepare/controller.js";
import {
  PREPARE_STAGES,
  type PrepareStage,
} from "../src/shared/prepare-contracts.js";
import { target } from "./fixtures/prepare.js";

/** Controller protocol fixtures only. Native Job/GPU lifetime is separately
 * exercised by real Operations/runner composition with injected native ports. */
function fixture() {
  let saved: PrepareJournal | null = null;
  const verified = new Set<PrepareStage>(),
    performed: PrepareStage[] = [],
    reused: PrepareStage[] = [],
    release = vi.fn(async () => {}),
    cancelOwned = vi.fn(async () => {});
  const operations: PreparationOperations = {
    target: async () => target,
    lock: async () => ({ release }),
    space: async () => ({ requiredBytes: 1, availableBytes: 2 }),
    reuse: async (stage) => {
      reused.push(stage);
      return verified.has(stage);
    },
    perform: async (stage) => {
      performed.push(stage);
      verified.add(stage);
    },
    verifyReady: async () =>
      PREPARE_STAGES.every((stage) => verified.has(stage)),
    registerBrowser: async () => true,
    cancelOwned,
    repair: async () => {},
  };
  const journal = {
    read: async () => (saved ? structuredClone(saved) : null),
    write: vi.fn(async (next: PrepareJournal) => {
      saved = structuredClone(next);
    }),
  };
  return {
    operations,
    journal,
    verified,
    performed,
    reused,
    release,
    cancelOwned,
    saved: () => saved,
    controller: () => new PrepareController(operations, journal),
  };
}
it.each(PREPARE_STAGES)(
  "cancel at %s, refuse late success/progress and restart only from independently verified exact stage prefix",
  async (cancelStage) => {
    const f = fixture(),
      first = f.controller(),
      observed: string[] = [];
    first.subscribe((view) => observed.push(view.state));
    let entered!: () => void, proceed!: () => void;
    const atStage = new Promise<void>((r) => {
        entered = r;
      }),
      completion = new Promise<void>((r) => {
        proceed = r;
      });
    const normal = f.operations.perform;
    f.operations.perform = async (stage, target, signal, progress) => {
      if (stage !== cancelStage) return normal(stage, target, signal, progress);
      f.performed.push(stage);
      entered();
      await completion;
      // Simulate a late completion message, not a native exit certificate.
      progress(100, 100);
    };
    const task = first.start();
    await atStage;
    const cancellation = first.cancel();
    proceed();
    await cancellation;
    expect((await task).state).toBe("cancelled");
    expect(observed).not.toContain("ready");
    expect(f.saved()).toMatchObject({
      state: "cancelled",
      completed: PREPARE_STAGES.slice(0, PREPARE_STAGES.indexOf(cancelStage)),
    });
    expect(first.view().completedBytes).not.toBe(100);
    expect(f.cancelOwned).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    f.operations.perform = normal;
    f.performed.length = 0;
    const second = f.controller();
    expect((await second.start()).state).toBe("ready");
    expect(f.reused).toEqual(
      PREPARE_STAGES.slice(0, PREPARE_STAGES.indexOf(cancelStage)),
    );
    expect(f.performed).toEqual(
      PREPARE_STAGES.slice(PREPARE_STAGES.indexOf(cancelStage)),
    );
    expect(f.saved()).toMatchObject({
      state: "complete",
      completed: [...PREPARE_STAGES],
    });
    expect(f.release).toHaveBeenCalledTimes(2);
  },
);

const checkpoints = [
  { name: "initial running journal", state: "running", length: 0 },
  ...PREPARE_STAGES.map((stage, index) => ({
    name: `completed ${stage} journal`,
    state: "running",
    length: index + 1,
  })),
  {
    name: "final complete journal",
    state: "complete",
    length: PREPARE_STAGES.length,
  },
] as const;
for (const mode of ["write-refused", "committed-ack-lost"] as const)
  it.each(checkpoints)(
    `${mode} at $name refuses Ready and recovers only real exact stage proofs`,
    async (checkpoint) => {
      const f = fixture(),
        first = f.controller(),
        observed: string[] = [];
      first.subscribe((view) => observed.push(view.state));
      const write = f.journal.write.getMockImplementation()!;
      let fault = true;
      f.journal.write.mockImplementation(async (record) => {
        if (
          fault &&
          record.state === checkpoint.state &&
          record.completed.length === checkpoint.length
        ) {
          fault = false;
          if (mode === "committed-ack-lost") await write(record);
          throw new PrepareFailure("PERMISSION_DENIED");
        }
        await write(record);
      });
      expect((await first.start()).state).toBe("error");
      expect(observed).not.toContain("ready");
      expect(f.saved()?.state).toBe("failed");
      expect(f.release).toHaveBeenCalledOnce();
      const prior = new Set(f.verified);
      f.performed.length = 0;
      const second = f.controller();
      expect((await second.start()).state).toBe("ready");
      expect(f.reused.every((stage) => prior.has(stage))).toBe(true);
      expect(f.saved()).toMatchObject({
        state: "complete",
        completed: [...PREPARE_STAGES],
      });
    },
  );
it("a crash journal claiming completed stages cannot replace missing runtime/model/GPU proof on restart", async () => {
  const f = fixture();
  await f.journal.write({
    version: 1,
    transaction: "121f38cf-1024-43d1-bd11-c45bf155250c",
    target: target.identity,
    sid: target.sid,
    state: "running",
    completed: [...PREPARE_STAGES],
  });
  expect((await f.controller().start()).state).toBe("ready");
  expect(f.reused).toEqual(["inspect"]);
  expect(f.performed).toEqual(PREPARE_STAGES);
});
