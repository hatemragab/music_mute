import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MachineSupervisor } from "../src/agent/machine-supervisor.js";

const child = { command: "unused", args: [], cwd: "." };

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
});
