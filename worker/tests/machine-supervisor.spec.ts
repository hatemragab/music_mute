import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { WorkerChildProcess } from "../src/agent/child-process.js";
import { MachineSupervisor } from "../src/agent/machine-supervisor.js";

const child = { command: "unused", args: [], cwd: "." };
const workerRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const hangingFixture = resolve(workerRoot, "tests/fixtures/hanging-child.mjs");

describe("machine supervisor capacity", () => {
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
