import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ChildStopError,
  type WorkerChildProcess,
} from "../src/agent/child-process.js";
import { MachineSupervisor } from "../src/agent/machine-supervisor.js";

const child = { command: "unused", args: [], cwd: "." };
const workerRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hangingFixture = resolve(workerRoot, "tests/fixtures/hanging-child.mjs");

describe("machine supervisor capacity", () => {
  function failedSupervisor(errors: unknown[]) {
    const slots = errors.map(() => ({
      workerId: randomUUID(),
      gpuId: randomUUID(),
      child,
    }));
    const supervisor = new MachineSupervisor(slots);
    const children = errors.map((error) => ({
      stop: vi.fn().mockRejectedValue(error),
    }));
    Object.assign(supervisor, {
      children: new Map(
        slots.map((slot, index) => [slot.workerId, children[index]]),
      ),
    });
    return { supervisor, slots, children };
  }

  it("retains safe child-stop failure stages while keeping all failed children fenced", async () => {
    const { supervisor, slots, children } = failedSupervisor([
      new ChildStopError("PROCESS_GROUP_EXIT_UNCONFIRMED", "EPERM"),
      new ChildStopError("CHILD_EXIT_UNCONFIRMED"),
      new ChildStopError("CHILD_EXIT_UNCONFIRMED"),
    ]);
    await expect(supervisor.stop()).rejects.toThrow(
      "Worker children could not be stopped safely (CHILD_EXIT_UNCONFIRMED, PROCESS_GROUP_EXIT_UNCONFIRMED:EPERM)",
    );
    for (let index = 0; index < children.length; index++) {
      expect(children[index]!.stop).toHaveBeenCalledOnce();
      expect(supervisor.child(slots[index]!.workerId)).toBe(children[index]);
    }
  });

  it("never copies arbitrary error fields, raw output or causes into the stop summary", async () => {
    const raw =
      "fixture-sensitive https://user:password@example.invalid/private.wav";
    const typed = new ChildStopError("PROCESS_GROUP_EXIT_UNCONFIRMED", raw);
    typed.message = raw;
    const forged = new ChildStopError("CHILD_EXIT_UNCONFIRMED");
    Object.defineProperty(forged, "code", { value: raw });
    const { supervisor } = failedSupervisor([
      Object.assign(new Error(raw), { code: "EPERM", cause: new Error(raw) }),
      typed,
      forged,
    ]);
    const error = await supervisor.stop().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Worker children could not be stopped safely (CHILD_STOP_UNCONFIRMED, PROCESS_GROUP_EXIT_UNCONFIRMED)",
    );
    expect((error as Error).message).not.toContain(raw);
    expect(error).not.toHaveProperty("cause");
  });

  it("starts with one logical child per unique GPU", () => {
    expect(
      () =>
        new MachineSupervisor([
          { workerId: randomUUID(), gpuId: "gpu-0", child },
          { workerId: randomUUID(), gpuId: "gpu-1", child },
        ]),
    ).not.toThrow();
  });

  it("rejects multiple children without validated capacity", () => {
    expect(
      () =>
        new MachineSupervisor([
          { workerId: randomUUID(), gpuId: "gpu-0", child },
          { workerId: randomUUID(), gpuId: "gpu-0", child },
        ]),
    ).toThrow("exceeds validated GPU capacity");
  });

  it("allows at most two children after capacity validation", () => {
    const slots = [
      { workerId: randomUUID(), gpuId: "gpu-0", child },
      { workerId: randomUUID(), gpuId: "gpu-0", child },
    ];
    expect(() => new MachineSupervisor(slots, 2)).not.toThrow();
    expect(
      () =>
        new MachineSupervisor(
          [...slots, { workerId: randomUUID(), gpuId: "gpu-0", child }],
          2,
        ),
    ).toThrow("exceeds validated GPU capacity");
  });

  it("replaces a terminated child even before its exit handler settles", async () => {
    const workerId = randomUUID();
    const stopErrors: unknown[] = [];
    let replacement: WorkerChildProcess | undefined;
    const supervisor = new MachineSupervisor([
      {
        workerId,
        gpuId: "gpu-0",
        child: {
          command: process.execPath,
          args: [hangingFixture],
          cwd: workerRoot,
          startTimeoutMs: 2_000,
          requestTimeoutMs: 2_000,
          // This replacement-race fixture must await positive group exit even
          // under full-suite load; keep the production stop bound unchanged.
          stopTimeoutMs: 1_000,
        },
      },
    ]);

    try {
      await supervisor.start();
      const terminated = supervisor.child(workerId);
      const pending = terminated.request("ping", {});
      terminated.terminateActive();
      await expect(pending).rejects.toThrow("terminated by the supervisor");

      replacement = await supervisor.restart(workerId);
      expect(replacement).not.toBe(terminated);
      expect(supervisor.child(workerId)).toBe(replacement);
      expect(terminated.isAlive()).toBe(false);
      const stop = replacement.stop.bind(replacement);
      vi.spyOn(replacement, "stop").mockImplementation(async () => {
        try {
          await stop();
        } catch (error) {
          stopErrors.push(error);
          throw error;
        }
      });
    } finally {
      // Stop the intentionally resident fixture before waiting for cleanup;
      // stop must still prove the real process group has disappeared.
      replacement?.terminateActive();
      await supervisor
        .stop()
        .catch((error: unknown) => {
          // Preserve real child-stop failures hidden by the supervisor's summary.
          throw new AggregateError(
            [error, ...stopErrors],
            "Supervisor cleanup failed",
          );
        })
        .finally(() => vi.restoreAllMocks());
      if (replacement) expect(replacement.isAlive()).toBe(false);
    }
  });
});
