import { describe, expect, it, vi } from "vitest";
import { acquireDesktopAccountAuthorityGate } from "../src/main/browser/native.js";
import type { WindowsConsumerNative } from "../../worker/src/platform/windows/consumer-native.js";
const owner = {
  sid: "S-1-5-21-1-2-3-1001",
  sessionId: 1,
  pid: 32,
  creationTime: "133400000000000001",
};
const lease = {
  scope: "account" as const,
  nonce: "a".repeat(64),
  identity: owner,
  abandoned: false,
};
function fixture(acquired: boolean, sameSession = true) {
  const order: string[] = [];
  const native = {
    acquireMutex: vi.fn(async () => {
      order.push("acquire");
      return acquired ? lease : null;
    }),
    inspectSingletonOwner: vi.fn(async () => {
      order.push("inspect");
      return {
        state: "active",
        owner: { ...owner, sessionId: sameSession ? 1 : 2 },
        sameSession,
      };
    }),
    releaseMutex: vi.fn(async () => {
      order.push("release");
    }),
    close: vi.fn(async () => {
      order.push("close");
    }),
  };
  return {
    native,
    order,
    open: () =>
      acquireDesktopAccountAuthorityGate(
        native as unknown as WindowsConsumerNative,
      ),
  };
}
describe("SID-wide account gate before Host/account/Electron startup (injected native boundary)", () => {
  it("holds the actual acquired lease until exact cleanup and releases once before helper close", async () => {
    const f = fixture(true),
      gate = await f.open();
    expect(gate.state).toBe("acquired");
    expect(f.order).toEqual(["acquire"]);
    if (gate.state !== "acquired") throw new Error("fixture");
    expect(gate.native).toBe(f.native);
    await Promise.all([gate.close(), gate.close()]);
    expect(f.order).toEqual(["acquire", "release", "close"]);
    expect(f.native.releaseMutex).toHaveBeenCalledWith(lease);
  });
  it("acquires before inspecting and permits only exact same-logon forwarding without an owner helper", async () => {
    const f = fixture(false),
      gate = await f.open();
    expect(gate).toEqual({ state: "same-session-existing", owner });
    expect(f.order).toEqual(["acquire", "inspect", "close"]);
    expect(f.native.releaseMutex).not.toHaveBeenCalled();
  });
  it("blocks a second same-SID logon and unknown kernel contention before any state publication", async () => {
    const f = fixture(false, false);
    await expect(f.open()).rejects.toThrow("WINDOWS_SESSION_ALREADY_ACTIVE");
    expect(f.order).toEqual(["acquire", "inspect", "close"]);
    const unknown = fixture(false);
    unknown.native.inspectSingletonOwner.mockResolvedValue({
      state: "absent",
      owner: null,
      sameSession: false,
    } as never);
    await expect(unknown.open()).rejects.toThrow(
      "WINDOWS_SESSION_ALREADY_ACTIVE",
    );
    expect(unknown.native.close).toHaveBeenCalledOnce();
  });
  it("handles an abandoned helper with live prior authority using the same exact-owner inspection", async () => {
    const f = fixture(false, false);
    f.native.acquireMutex.mockRejectedValue(
      new Error("WINDOWS_SESSION_ALREADY_ACTIVE"),
    );
    await expect(f.open()).rejects.toThrow("WINDOWS_SESSION_ALREADY_ACTIVE");
    expect(f.native.inspectSingletonOwner).toHaveBeenCalledOnce();
  });
  it("denies unproven owner access and closes inspection helper without guessing completion", async () => {
    const f = fixture(false);
    f.native.inspectSingletonOwner.mockRejectedValue(
      new Error("IDENTITY_UNAVAILABLE"),
    );
    await expect(f.open()).rejects.toThrow("IDENTITY_UNAVAILABLE");
    expect(f.native.close).toHaveBeenCalledOnce();
    expect(f.native.releaseMutex).not.toHaveBeenCalled();
  });
});
