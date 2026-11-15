import { expect, it, vi } from "vitest";
import { WindowsConsumerNative } from "../src/platform/windows/consumer-native.js";

it("returns only the bounded fixed volatile witness, without clock or logon fallback", async () => {
  const request = vi.fn(async () => ({
    boot_id: "a".repeat(64),
    source: "volatile-registry-witness-v1",
  }));
  const native = new WindowsConsumerNative({ request, close: async () => {} });
  expect(await native.bootIdentity()).toBe("a".repeat(64));
  expect(request).toHaveBeenCalledWith("boot_identity", {});
});

it.each([
  { boot_id: "a".repeat(64), source: "bcd-loader-guid" },
  { boot_id: "A".repeat(64), source: "volatile-registry-witness-v1" },
  { boot_id: "a".repeat(63), source: "volatile-registry-witness-v1" },
  { boot_id: 123, source: "volatile-registry-witness-v1" },
  {
    boot_id: "a".repeat(64),
    source: "volatile-registry-witness-v1",
    approximate: true,
  },
])("rejects an unbound or malformed boot reply %#", async (reply) => {
  const native = new WindowsConsumerNative({
    request: async () => reply,
    close: async () => {},
  });
  await expect(native.bootIdentity()).rejects.toThrow("PROTOCOL_MISMATCH");
});

it("propagates native witness failure instead of reusing a cached witness", async () => {
  const native = new WindowsConsumerNative({
    request: async () => {
      throw new Error("BOOT_IDENTITY_UNAVAILABLE");
    },
    close: async () => {},
  });
  await expect(native.bootIdentity()).rejects.toThrow(
    "BOOT_IDENTITY_UNAVAILABLE",
  );
});
