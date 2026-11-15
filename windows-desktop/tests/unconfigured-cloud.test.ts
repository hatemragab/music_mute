import { describe, expect, it, vi } from "vitest";
import { UnconfiguredCloudPreference } from "../src/main/cloud/unconfigured.js";

describe("saved processing choice without public account configuration", () => {
  it("retains cloud and offers no billable confirmation or local authorization", async () => {
    const write = vi.fn();
    const preference = new UnconfiguredCloudPreference(
      { read: async () => "cloud", write },
      () => true,
    );
    await preference.restore();
    expect(preference.view()).toMatchObject({
      mode: "cloud",
      ready: false,
      reason: "CONFIGURATION_REQUIRED",
      confirmation: null,
      resultCapability: null,
    });
    expect(write).not.toHaveBeenCalled();
  });
  it("permits verified saved local work independently of account configuration", async () => {
    let prepared = false;
    const preference = new UnconfiguredCloudPreference(
      { read: async () => "local", write: async () => {} },
      () => prepared,
    );
    await preference.restore();
    expect(preference.view().ready).toBe(false);
    prepared = true;
    expect(preference.view().ready).toBe(true);
  });
  it("blocks unknown selection and changes only after an explicit durable write", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("VAULT_UNAVAILABLE"))
      .mockResolvedValue(undefined);
    const preference = new UnconfiguredCloudPreference(
      {
        read: async () => {
          throw new Error("CORRUPT");
        },
        write,
      },
      () => true,
    );
    await preference.restore();
    expect(preference.view()).toMatchObject({
      mode: "cloud",
      ready: false,
      reason: "PROCESSING_SELECTION_UNAVAILABLE",
    });
    await expect(preference.setMode("local")).rejects.toThrow(
      "VAULT_UNAVAILABLE",
    );
    expect(preference.view().ready).toBe(false);
    await preference.setMode("local");
    expect(preference.view()).toMatchObject({ mode: "local", ready: true });
  });
  it("reports preparation changes without resetting the choice", async () => {
    let prepared = false;
    const listener = vi.fn();
    const preference = new UnconfiguredCloudPreference(
      { read: async () => "local", write: async () => {} },
      () => prepared,
    );
    const off = preference.subscribe(listener);
    await preference.restore();
    prepared = true;
    preference.refresh();
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true, mode: "local" }),
    );
    off();
    preference.refresh();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
