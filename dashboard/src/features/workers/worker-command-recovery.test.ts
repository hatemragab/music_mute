import { describe, expect, it, vi } from "vitest";
import { OperationOutcomeUnknownError, type ApiClient } from "@/api/api-client";
import { requestWorkerDoctor } from "./worker-api";

const input = {
  operationId: "operation-one",
  expectedRevision: 1,
  checks: ["service", "storage"],
  reason: "Inspect runtime",
};

describe("worker command response recovery", () => {
  it("recovers a committed command without resending POST", async () => {
    const post = vi.fn().mockRejectedValue(new TypeError("network failure"));
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: "succeeded", resourceId: "command-one" })
      .mockResolvedValueOnce({ commands: [{ commandId: "command-one" }] });
    const result = await requestWorkerDoctor(
      { post, get } as unknown as ApiClient,
      "machine-one",
      input,
    );
    expect(result).toEqual({
      commandId: "command-one",
      deferred: null,
      replayed: true,
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenNthCalledWith(1, "/admin/operations/operation-one");
  });
  it("marks unavailable receipts unresolved without reissuing the command", async () => {
    const post = vi.fn().mockRejectedValue(new TypeError("network failure"));
    const get = vi.fn().mockRejectedValue(new TypeError("network failure"));
    await expect(
      requestWorkerDoctor(
        { post, get } as unknown as ApiClient,
        "machine-one",
        input,
      ),
    ).rejects.toBeInstanceOf(OperationOutcomeUnknownError);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
