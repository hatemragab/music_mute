import { expect, it, vi } from "vitest";
import {
  WindowsConsumerNative,
  type ConsumerNativeTransport,
} from "../src/platform/windows/consumer-native.js";
const pins = {
  extensionId: "a".repeat(32),
  hostSha256: "b".repeat(64),
  hostBytes: 12,
  entrySha256: "c".repeat(64),
  entryBytes: 14,
};
function fixture(result: unknown) {
  const transport: ConsumerNativeTransport = {
    request: vi.fn(async () => result),
    close: vi.fn(async () => {}),
  };
  return { native: new WindowsConsumerNative(transport), transport };
}
it("registration and removal leave time for bounded native transaction recovery without replaying secret or file effects", async () => {
  const register = fixture({ registered: true, views: [32, 64] });
  await register.native.registerBrowser(pins);
  expect(register.transport.request).toHaveBeenCalledWith(
    "browser_register",
    {
      extension_id: pins.extensionId,
      host_sha256: pins.hostSha256,
      host_bytes: 12,
      entry_sha256: pins.entrySha256,
      entry_bytes: 14,
    },
    35000,
  );
  const remove = fixture({ removed: true });
  await remove.native.unregisterBrowser();
  expect(remove.transport.request).toHaveBeenCalledWith(
    "browser_unregister",
    {},
    35000,
  );
  const uncertain = fixture(null);
  await expect(uncertain.native.unregisterBrowser()).rejects.toThrow();
  expect(uncertain.transport.request).toHaveBeenCalledOnce();
});
it("exact browser snapshots reject forged success, extra state and invalid resource pins before effect", async () => {
  await expect(
    fixture({ registered: true, views: [64] }).native.registerBrowser(pins),
  ).rejects.toThrow("BROWSER_REGISTRATION_CONFLICT");
  await expect(
    fixture({ removed: true, foreign: true }).native.unregisterBrowser(),
  ).rejects.toThrow("BROWSER_REGISTRATION_CONFLICT");
  await expect(
    fixture({ registered: false, repair: true }).native.verifyBrowser(pins),
  ).rejects.toThrow("PROTOCOL_MISMATCH");
  expect(await fixture({ registered: false }).native.verifyBrowser(pins)).toBe(
    false,
  );
  const bad = fixture({ registered: true, views: [32, 64] });
  await expect(
    bad.native.registerBrowser({ ...pins, extensionId: "other" }),
  ).rejects.toThrow("BAD_REQUEST");
  expect(bad.transport.request).not.toHaveBeenCalled();
});
