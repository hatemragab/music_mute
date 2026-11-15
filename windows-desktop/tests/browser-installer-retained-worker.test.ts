import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => {
  const native = {
    identity: vi.fn(async () => ({
      sid: "S-1-5-21-1-2-3-1001",
      sessionId: 1,
      pid: 32,
      creationTime: "133400000000000001",
    })),
    verifyInstallerMaintenancePeer: vi.fn(async () => ({
      issuer: { pid: 31 },
      certificateNonce: null,
    })),
    inspectSingletonOwner: vi.fn(async () => ({
      state: "absent",
      owner: null,
      sameSession: false,
    })),
    unregisterBrowser: vi.fn(async () => {}),
    removeStartup: vi.fn(async () => {}),
    unregisterProtocol: vi.fn(async () => {}),
    registerProtocol: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const gate = {
      state: "acquired",
      native,
      lease: {},
      close: vi.fn(async () => {}),
    },
    host = { close: vi.fn(async () => {}) };
  return { native, gate, host };
});
vi.mock("../src/main/browser/native.js", () => ({
  openPinnedBrowserNative: vi.fn(async () => f.native),
  acquireDesktopAccountAuthorityGate: vi.fn(async () => f.gate),
  loadBrowserAccountAppPin: vi.fn(async () => ({
    sha256: "a".repeat(64),
    bytes: 1,
    publisherSha256: "b".repeat(64),
  })),
  openBrowserNative: vi.fn(),
}));
vi.mock("../src/main/host-context.js", () => ({
  openWindowsHost: vi.fn(async () => f.host),
}));
vi.mock("../src/main/browser/package-trust.js", () => ({
  loadPackagedDesktopBuild: vi.fn(async () => ({
    version: 1,
    appVersion: "0.1.0",
    buildNumber: 42,
  })),
}));
vi.mock("../src/main/browser/registration.js", () => ({
  registerBrowserIntegration: vi.fn(async () => true),
}));
vi.mock("../src/main/session/desktop-client.js", () => ({
  openDesktopSessionClient: vi.fn(),
}));
import { runInstallerLifecycle } from "../src/main/browser/installer-maintenance.js";
beforeEach(() => vi.clearAllMocks());
it("standalone authenticated GUI uninstall preserves independent worker startup and never starts an absent worker", async () => {
  await runInstallerLifecycle("C:\\Fixture\\resources", "uninstall");
  expect(f.native.verifyInstallerMaintenancePeer).toHaveBeenCalledBefore(
    f.native.unregisterBrowser,
  );
  expect(f.native.unregisterBrowser).toHaveBeenCalledOnce();
  expect(f.native.unregisterProtocol).toHaveBeenCalledOnce();
  expect(f.native.removeStartup).not.toHaveBeenCalled();
  expect(f.host.close).toHaveBeenCalledOnce();
  expect(f.gate.close).toHaveBeenCalledOnce();
  const { openDesktopSessionClient } =
    await import("../src/main/session/desktop-client.js");
  expect(openDesktopSessionClient).not.toHaveBeenCalled();
});
it("failed actual installer lineage refuses unregister and cannot touch worker startup", async () => {
  f.native.verifyInstallerMaintenancePeer.mockRejectedValueOnce(
    new Error("PEER_DENIED"),
  );
  await expect(
    runInstallerLifecycle("C:\\Fixture\\resources", "uninstall"),
  ).rejects.toThrow("PEER_DENIED");
  expect(f.native.unregisterBrowser).not.toHaveBeenCalled();
  expect(f.native.removeStartup).not.toHaveBeenCalled();
  expect(f.native.close).toHaveBeenCalledOnce();
});
