import { describe, expect, it, vi } from "vitest";
import {
  MAX_INPUT_BYTES,
  parseMacAvailableMemory,
  RuntimeResourceGate,
  RuntimeResourceLimitError,
  type RuntimeResourceProbe,
} from "../src/runtime/resource-limits.js";

const gibibyte = 1024n * 1024n * 1024n;

function probe(diskBytes: bigint, memoryBytes: bigint): RuntimeResourceProbe {
  return {
    availableDiskBytes: vi.fn(async () => diskBytes),
    availableMemoryBytes: vi.fn(async () => memoryBytes),
  };
}

describe("runtime resource admission", () => {
  it("admits an input only when memory and input-sized disk reserve are available", async () => {
    const resources = probe(5n * gibibyte, 4n * gibibyte);
    const gate = new RuntimeResourceGate("/private/worker/attempts", resources);

    await expect(gate.assertAvailable(100_000_000)).resolves.toBeUndefined();
    expect(resources.availableDiskBytes).toHaveBeenCalledWith(
      "/private/worker/attempts",
    );
  });

  it("fails closed for memory and disk pressure", async () => {
    const memory = new RuntimeResourceGate(
      "/private/worker/attempts",
      probe(5n * gibibyte, gibibyte),
    );
    await expect(memory.assertAvailable(1)).rejects.toEqual(
      expect.objectContaining<Partial<RuntimeResourceLimitError>>({
        resource: "memory",
      }),
    );

    const disk = new RuntimeResourceGate(
      "/private/worker/attempts",
      probe(gibibyte, 4n * gibibyte),
    );
    await expect(disk.assertAvailable(1)).rejects.toEqual(
      expect.objectContaining<Partial<RuntimeResourceLimitError>>({
        resource: "disk",
      }),
    );
  });

  it("rejects input declarations outside the runtime byte boundary", async () => {
    const gate = new RuntimeResourceGate(
      "/private/worker/attempts",
      probe(5n * gibibyte, 4n * gibibyte),
    );
    await expect(gate.assertAvailable(0)).rejects.toThrow(
      "input byte count is outside runtime limits",
    );
    await expect(gate.assertAvailable(MAX_INPUT_BYTES + 1)).rejects.toThrow(
      "input byte count is outside runtime limits",
    );
  });

  it("fails closed when a host resource reading is unavailable", async () => {
    const gate = new RuntimeResourceGate("/private/worker/attempts", {
      availableMemoryBytes: async () => 4n * gibibyte,
      availableDiskBytes: async () => {
        throw new Error("probe unavailable");
      },
    });
    await expect(gate.assertAvailable(1)).rejects.toEqual(
      expect.objectContaining<Partial<RuntimeResourceLimitError>>({
        resource: "disk",
      }),
    );
  });

  it("counts reclaimable macOS pages without treating cache pressure as exhaustion", () => {
    const output = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 100.
Pages active: 999.
Pages inactive: 200.
Pages speculative: 50.
`;
    expect(parseMacAvailableMemory(output)).toBe(350n * 16_384n);
    expect(() => parseMacAvailableMemory("invalid")).toThrow(
      "page size is unavailable",
    );
  });
});
