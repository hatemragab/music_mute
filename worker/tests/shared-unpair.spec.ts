import { describe, expect, it, vi } from "vitest";
import { awaitUnpair } from "../src/platform/shared/unpair.js";
import { ControlPlaneError } from "../src/runtime/control-plane-client.js";
const confirmation = {
  confirmed: true as const,
  machineId: "32410a14-e85a-4a1d-bb99-61fa54b07eaa",
};
describe("shared unpair conflict recovery", () => {
  it("retries a graceful backend conflict and returns confirmation", async () => {
    let time = 0;
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        new ControlPlaneError("WORKER_CONFLICT", 409, false),
      )
      .mockResolvedValueOnce(confirmation);
    await expect(
      awaitUnpair(operation, false, {
        monotonicNow: () => time,
        wait: async (milliseconds) => {
          time += milliseconds;
        },
      }),
    ).resolves.toEqual(confirmation);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(time).toBe(5000);
  });
  it("does not retry after the monotonic deadline or retry forced conflicts", async () => {
    let time = 0;
    const conflict = new ControlPlaneError("WORKER_CONFLICT", 409, false);
    const operation = vi.fn().mockRejectedValue(conflict);
    await expect(
      awaitUnpair(operation, false, {
        timeoutMs: 100,
        monotonicNow: () => time,
        wait: async (milliseconds) => {
          time += milliseconds;
        },
      }),
    ).rejects.toBe(conflict);
    expect(operation).toHaveBeenCalledOnce();
    await expect(awaitUnpair(operation, true, {})).rejects.toBe(conflict);
    expect(operation).toHaveBeenCalledTimes(2);
  });
  it("preserves unrelated backend failures and rejects invalid timeouts before requesting", async () => {
    const failure = new ControlPlaneError("WORKER_UNAUTHENTICATED", 401, false);
    const operation = vi.fn().mockRejectedValue(failure);
    await expect(awaitUnpair(operation, false, {})).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledOnce();
    await expect(
      awaitUnpair(operation, false, { timeoutMs: Number.NaN }),
    ).rejects.toThrow("timeout");
    expect(operation).toHaveBeenCalledOnce();
  });
});
