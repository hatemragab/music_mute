import { describe, expect, it } from "vitest";
import { StageClock } from "../src/runtime/stage-clock.js";

describe("attempt monotonic stage clock", () => {
  it("retains completed stages and snapshots an incomplete stage without double counting", () => {
    let now = 0;
    const clock = new StageClock(() => now);
    now = 10;
    clock.enter("input-download");
    now = 35;
    clock.enter("input-validation");
    now = 45;
    clock.enter("separation");
    now = 145;
    clock.enter("separation");
    expect(clock.snapshot()).toEqual([
      { stage: "resource-check", durationMs: 10, complete: true },
      { stage: "input-download", durationMs: 25, complete: true },
      { stage: "input-validation", durationMs: 10, complete: true },
      { stage: "separation", durationMs: 100, complete: false },
    ]);
    expect(clock.snapshot().at(-1)?.durationMs).toBe(100);
    now = 245;
    clock.enter("output-upload");
    expect(clock.snapshot()).toContainEqual({
      stage: "separation",
      durationMs: 200,
      complete: true,
    });
    expect(clock.snapshot().at(-1)).toEqual({
      stage: "output-upload",
      durationMs: 0,
      complete: false,
    });
  });
});
