import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";

const ports = vi.hoisted(() => ({
  native: {} as object,
  configuration: Buffer.alloc(0),
  release: "a".repeat(64),
  status: vi.fn(),
}));
vi.mock(
  "../../worker/src/platform/windows/consumer-native.js",
  async (original) => {
    const actual =
      await original<
        typeof import("../../worker/src/platform/windows/consumer-native.js")
      >();
    return {
      ...actual,
      createConsumerNativeTransport: vi.fn(async () => ({})),
      WindowsConsumerNative: class {
        constructor() {
          return ports.native;
        }
      },
    };
  },
);
vi.mock("../src/main/prepare/private-files.js", async (original) => ({
  ...(await original<typeof import("../src/main/prepare/private-files.js")>()),
  readPrivateBytes: vi.fn(async () => Buffer.from(ports.configuration)),
}));
vi.mock("../src/main/session/control.js", async (original) => ({
  ...(await original<typeof import("../src/main/session/control.js")>()),
  SessionClient: class {
    command = ports.status;
  },
}));
import { openDesktopSessionClient } from "../src/main/session/desktop-client.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!,
  architecture = Object.getOwnPropertyDescriptor(process, "arch")!,
  sid = "S-1-5-21-1-2-3-1001",
  release = "a".repeat(64),
  launcher = "b".repeat(64),
  helper = "c".repeat(64),
  authority = { sid, sessionId: 9, pid: 777, creationTime: "123456" };
let root: string;
let running: boolean;
let reusePid: boolean;
const launch = vi.fn(async () => {}),
  boot = vi.fn(async () => "d".repeat(64)),
  close = vi.fn(async () => {}),
  vault = vi.fn();
beforeEach(async () => {
  // Portable orchestration fixture: all native transports/processes are injected; no Windows executable runs.
  Object.defineProperty(process, "platform", { value: "win32" });
  Object.defineProperty(process, "arch", { value: "x64" });
  running = true;
  reusePid = false;
  launch.mockClear();
  boot.mockClear();
  close.mockClear();
  vault.mockReset();
  ports.status.mockReset();
  root = await mkdtemp(join(tmpdir(), "musicmute-session-client-fixture-"));
  await mkdir(join(root, "native"));
  await writeFile(
    join(root, "native", "manifest.json"),
    JSON.stringify({ version: 1, sha256: helper }),
  );
  await writeFile(
    join(root, "native", "launcher-manifest.json"),
    JSON.stringify({ version: 1, sha256: launcher, bytes: 32 }),
  );
  const personalRoot = "C:\\Users\\Fixture\\MusicMuteLocal";
  ports.configuration = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: "session-agent",
      installationProfile: "windows-user",
      release,
      releaseRoot: win32.join(personalRoot, "runtime", "releases", release),
      nativeSha256: helper,
      personalRoot,
      fleetRoot: "C:\\Users\\Fixture\\MusicMuteWorker",
      launchFiles: {
        "runtime/node/node.exe": launcher,
        "runtime/native/musicmute-native.exe": helper,
        "agent/session-agent.cjs": launcher,
        "agent/personal.cjs": launcher,
        "agent/fleet.cjs": launcher,
      },
    }),
  );
  vault.mockImplementation(async (scope, key) => {
    if (scope === "fleet" && key === "agent_bootstrap")
      return Buffer.from(
        JSON.stringify({
          version: 1,
          installationProfile: "windows-user",
          sid,
          release,
          configSha256: createHash("sha256")
            .update(ports.configuration)
            .digest("hex"),
          nodeSha256: launcher,
          agentSha256: launcher,
          nativeSha256: helper,
          launcherSha256: launcher,
        }),
      );
    if (scope === "fleet" && key === "session_ticket" && running)
      return Buffer.from(
        JSON.stringify({
          version: 1,
          owner: {
            role: "session-agent",
            nonce: "e".repeat(64),
            identity: authority,
          },
          server: { ...authority, pid: 778 },
          channel: "f".repeat(64),
          nonce: "e".repeat(64),
          expiresAt: Date.now() + 15000,
        }),
      );
    return null;
  });
  ports.native = {
    identity: vi.fn(async () => ({ ...authority, pid: 1000 })),
    verifySessionLauncher: vi.fn(async () => {}),
    vaultRead: vault,
    processIdentity: vi.fn(async () => ({
      ...authority,
      creationTime: reusePid ? "654321" : authority.creationTime,
    })),
    bootIdentity: boot,
    launchSessionAgent: launch,
    close,
  };
  ports.status.mockResolvedValue({ release });
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "arch", architecture);
  if (root) await rm(root, { recursive: true, force: true });
});
const host = { identity: authority } as HostContext;
it("attaches authenticated existing controls without reading GPU Ready or launching another agent", async () => {
  const connection = await openDesktopSessionClient(host, root, {
    launchIfAbsent: false,
  });
  expect(ports.status).toHaveBeenCalledWith(
    expect.objectContaining({ action: "status" }),
  );
  expect(vault).not.toHaveBeenCalledWith("account", "ready_receipt");
  expect(boot).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
  await connection.close();
  expect(close).toHaveBeenCalledOnce();
});
it("refuses a missing authority passively without GPU work", async () => {
  running = false;
  await expect(
    openDesktopSessionClient(host, root, { launchIfAbsent: false }),
  ).rejects.toThrow("SESSION_UNAVAILABLE");
  expect(vault).not.toHaveBeenCalledWith("account", "ready_receipt");
  expect(launch).not.toHaveBeenCalled();
});
it("still requires strict Ready for new launch and does not trust a reused owner PID", async () => {
  reusePid = true;
  await expect(openDesktopSessionClient(host, root)).rejects.toThrow(
    "PREPARE_REQUIRED",
  );
  expect(vault).toHaveBeenCalledWith("account", "ready_receipt");
  expect(launch).not.toHaveBeenCalled();
});
it("refuses a mismatched actual existing release even with a valid process ticket", async () => {
  ports.status.mockResolvedValue({ release: "f".repeat(64) });
  await expect(
    openDesktopSessionClient(host, root, { launchIfAbsent: false }),
  ).rejects.toThrow("SESSION_INTEGRITY_INVALID");
  expect(launch).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
