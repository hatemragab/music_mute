import { expect, it, vi } from "vitest";
import { isStoreSessionCleanupCommand } from "../src/shared/store-session-cleanup.js";
import {
  StoreNativeAuthority,
  StoreWorkerCodeAuthority,
} from "../src/main/browser/store-native.js";
const requestId = "12345678-1234-4234-8234-123456789012";
it.each([
  ["prepare_cancel", "launch"],
  ["cpu_cancel", "launch"],
  ["cpu_recover", "request"],
  ["cpu_operation_inspect", "expectation"],
  ["benchmark_cancel", "launch"],
  ["benchmark_recover", "request"],
])(
  "classifies only the closed %s cleanup envelope, never its data as authority",
  (action, field) => {
    const command = { version: 1, requestId, action, [field]: {} };
    expect(isStoreSessionCleanupCommand(command)).toBe(true);
    expect(
      isStoreSessionCleanupCommand({ ...command, ignore_watch: true }),
    ).toBe(false);
    expect(isStoreSessionCleanupCommand({ ...command, [field]: null })).toBe(
      false,
    );
    expect(isStoreSessionCleanupCommand({ ...command, [field]: [] })).toBe(
      false,
    );
    expect(
      isStoreSessionCleanupCommand({ ...command, requestId: "caller" }),
    ).toBe(false);
  },
);
it("keeps new work and public internal-forget attempts outside cleanup classification", () => {
  for (const action of [
    "prepare_launch",
    "prepare_recover",
    "cpu_launch",
    "cpu_start",
    "cpu_ready",
    "benchmark_launch",
    "session_forward",
    "cpu_operation_forget",
    "cpu_operation_release",
  ])
    expect(
      isStoreSessionCleanupCommand({
        version: 1,
        requestId,
        action,
        request: {},
      }),
    ).toBe(false);
  expect(
    isStoreSessionCleanupCommand({
      version: 1,
      requestId,
      action: "session_forward_ack",
    }),
  ).toBe(true);
  expect(
    isStoreSessionCleanupCommand({
      version: 1,
      requestId,
      action: "session_forward_ack",
      payload_base64: "e30=",
    }),
  ).toBe(false);
});
it("refuses accessor or inherited command data without invoking the accessor", () => {
  const getter = vi.fn(() => "cpu_cancel"),
    command = { version: 1, requestId, launch: {} };
  Object.defineProperty(command, "action", { enumerable: true, get: getter });
  expect(isStoreSessionCleanupCommand(command)).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  expect(
    isStoreSessionCleanupCommand(
      Object.create({ version: 1, requestId, action: "session_forward_ack" }),
    ),
  ).toBe(false);
});
it("cannot revalidate cleanup through a forged code owner, authority or caller override", async () => {
  const check = vi.fn(async () => {}),
    authority = Object.assign(Object.create(StoreNativeAuthority.prototype), {
      checkWorkerCodeCleanup: check,
    }),
    code = Object.assign(Object.create(StoreWorkerCodeAuthority.prototype), {
      revalidateCleanup: check,
    });
  await expect(
    StoreWorkerCodeAuthority.prototype.revalidateCleanup.call(code),
  ).rejects.toThrow();
  await expect(
    StoreNativeAuthority.prototype.checkWorkerCodeCleanup.call(authority, code),
  ).rejects.toThrow();
  expect(check).not.toHaveBeenCalled();
});
