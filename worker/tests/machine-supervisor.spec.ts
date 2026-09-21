import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

  it("rejects multiple initial children for one GPU", () => {
    expect(
      () =>
        new MachineSupervisor([
          { workerId: randomUUID(), gpuId: "gpu-0", child },
          { workerId: randomUUID(), gpuId: "gpu-0", child },
        ]),
    ).toThrow("one initial child per GPU");
  });

  it("replaces a terminated child even before its exit handler settles", async () => {
    const workerId = randomUUID();
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
          stopTimeoutMs: 100,
        },
      },
    ]);

    try {
      await supervisor.start();
      const terminated = supervisor.child(workerId);
      const pending = terminated.request("ping", {});
      terminated.terminateActive();
      await expect(pending).rejects.toThrow("terminated by the supervisor");

      const replacement = await supervisor.restart(workerId);
      expect(replacement).not.toBe(terminated);
      expect(supervisor.child(workerId)).toBe(replacement);
    } finally {
      await supervisor.stop();
    }
  });
});
