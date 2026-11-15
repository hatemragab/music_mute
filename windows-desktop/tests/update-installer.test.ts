import { expect, it, vi } from "vitest";
import {
  ConsumerInstallerCoordinator,
  consumerInstallerPin,
} from "../src/main/update/installer.js";
import type { ConsumerUpdateMetadata } from "../src/shared/update-contracts.js";
import type {
  ConsumerInstallerLaunchStatus,
  ConsumerInstallerPin,
} from "../../worker/src/platform/windows/consumer-native.js";
const metadata = {
  app: {
    version: "2.0.0",
    payloadSha256: "a".repeat(64),
    artifact: { sha256: "b".repeat(64), bytes: 50 },
  },
  publisherSha256: "c".repeat(64),
} as ConsumerUpdateMetadata;
const identity = {
  sid: "S-1-5-21-1-2-3-1001",
  sessionId: 1,
  pid: 123,
  creationTime: "133000000000000000",
};
function fixture() {
  let saved: Buffer | null = null,
    status: ConsumerInstallerLaunchStatus = {
      state: "absent",
      certificate: null,
    };
  const native = {
    verifyInstaller: vi.fn(async () => {}),
    removeCompletedInstallerMonitor: vi.fn(async () => true),
    inspectInstallerLaunch: vi.fn(async (_pin: ConsumerInstallerPin) => status),
    recoverInstallerLaunch: vi.fn(async (_pin: ConsumerInstallerPin) => status),
    launchInstaller: vi.fn(async (pin: ConsumerInstallerPin) => {
      status = {
        state: "running",
        certificate: {
          version: 1,
          nonce: "d".repeat(64),
          pin,
          monitor: { ...identity, pid: 124 },
          process: identity,
          exitCode: null,
          treeExited: false,
        },
      };
      return identity;
    }),
  };
  const vault = {
    vaultRead: vi.fn(async () => (saved ? Buffer.from(saved) : null)),
    vaultWrite: vi.fn(async (_ns: string, _key: string, bytes: Buffer) => {
      saved = Buffer.from(bytes);
    }),
  };
  return {
    native,
    vault,
    coordinator: new ConsumerInstallerCoordinator(vault, native),
    setStatus: (s: ConsumerInstallerLaunchStatus) => {
      status = s;
    },
    status: () => status,
    saved: () => saved,
  };
}
it("writes attempt before launch and blocks repeated known-running installation", async () => {
  const f = fixture();
  await f.coordinator.launch(metadata);
  expect(f.vault.vaultWrite.mock.invocationCallOrder[0]).toBeLessThan(
    f.native.launchInstaller.mock.invocationCallOrder[0]!,
  );
  await expect(f.coordinator.launch(metadata)).rejects.toThrow(
    "UPDATE_INSTALLER_RUNNING",
  );
  expect(f.native.launchInstaller).toHaveBeenCalledOnce();
  await expect(f.coordinator.assertCompleted(metadata)).rejects.toThrow(
    "UPDATE_INSTALLER_RUNNING",
  );
});
it("adopts lost launch ACK only from exact native certificate", async () => {
  const f = fixture(),
    launch = f.native.launchInstaller.getMockImplementation()!;
  f.native.launchInstaller.mockImplementation(async (pin) => {
    await launch(pin);
    throw new Error("ACK_LOST");
  });
  await f.coordinator.launch(metadata);
  expect(JSON.parse(f.saved()!.toString()).nonce).toBe("d".repeat(64));
  expect(f.native.launchInstaller).toHaveBeenCalledOnce();
});
it("missing native authority after attempted launch cannot cause another launch", async () => {
  const f = fixture();
  f.native.launchInstaller.mockRejectedValueOnce(new Error("ACK_LOST"));
  await expect(f.coordinator.launch(metadata)).rejects.toThrow(
    "UPDATE_INSTALLER_UNCONFIRMED",
  );
  await expect(f.coordinator.launch(metadata)).rejects.toThrow(
    "UPDATE_INSTALLER_UNCONFIRMED",
  );
  expect(f.native.launchInstaller).toHaveBeenCalledOnce();
});
it("requires completed whole-tree proof; zero exit never substitutes for current app health", async () => {
  const f = fixture();
  await f.coordinator.launch(metadata);
  const status = f.status();
  if (status.state === "absent") throw new Error();
  f.setStatus({
    state: "completed",
    certificate: { ...status.certificate, exitCode: 0, treeExited: true },
  });
  await f.coordinator.assertCompleted(metadata);
  await f.coordinator.launch(metadata);
  expect(f.native.launchInstaller).toHaveBeenCalledOnce();
});
it("confirmed installer failure is distinct from unknown completion", async () => {
  const f = fixture();
  await f.coordinator.launch(metadata);
  const status = f.status();
  if (status.state === "absent") throw new Error();
  f.setStatus({
    state: "completed",
    certificate: { ...status.certificate, exitCode: 1603, treeExited: true },
  });
  await expect(f.coordinator.assertCompleted(metadata)).rejects.toThrow(
    "UPDATE_INSTALLER_FAILED",
  );
});
it("certificate nonce replacement and unknown monitor never authorize recovery", async () => {
  const f = fixture();
  await f.coordinator.launch(metadata);
  const status = f.status();
  if (status.state === "absent") throw new Error();
  f.setStatus({ state: "unknown", certificate: status.certificate });
  await expect(f.coordinator.assertCompleted(metadata)).rejects.toThrow(
    "UPDATE_INSTALLER_UNCONFIRMED",
  );
  f.setStatus({
    state: "completed",
    certificate: {
      ...status.certificate,
      nonce: "e".repeat(64),
      exitCode: 0,
      treeExited: true,
    },
  });
  await expect(f.coordinator.assertCompleted(metadata)).rejects.toThrow(
    "UPDATE_INSTALLER_UNCONFIRMED",
  );
});
it("native certificate surviving app WAL loss is recovered without another launch", async () => {
  const f = fixture(),
    pin = consumerInstallerPin(metadata);
  f.setStatus({
    state: "running",
    certificate: {
      version: 1,
      nonce: "d".repeat(64),
      pin,
      monitor: { ...identity, pid: 124 },
      process: identity,
      exitCode: null,
      treeExited: false,
    },
  });
  await f.coordinator.launch(metadata);
  expect(f.native.launchInstaller).not.toHaveBeenCalled();
});
it("a different completed predecessor permits one new signed installer rather than permanently conflicting", async () => {
  const f = fixture();
  await f.coordinator.launch(metadata);
  const prior = f.status();
  if (prior.state === "absent") throw new Error();
  f.setStatus({
    state: "completed",
    certificate: { ...prior.certificate, exitCode: 0, treeExited: true },
  });
  f.native.inspectInstallerLaunch.mockImplementation(async (pin) => {
    const status = f.status();
    return status.state === "completed" &&
      status.certificate.pin.identity !== pin.identity
      ? { state: "absent", certificate: null }
      : status;
  });
  const next = {
    ...metadata,
    app: { ...metadata.app, version: "3.0.0", payloadSha256: "f".repeat(64) },
  };
  await f.coordinator.launch(next);
  expect(f.native.launchInstaller).toHaveBeenCalledTimes(2);
  expect(JSON.parse(f.saved()!.toString()).pin.identity).toBe(
    consumerInstallerPin(next).identity,
  );
});
it("a different noncompleted predecessor blocks both rollback and subsequent installers", async () => {
  const f = fixture();
  await f.coordinator.launch(metadata);
  const next = {
    ...metadata,
    app: { ...metadata.app, version: "3.0.0", payloadSha256: "f".repeat(64) },
  };
  await expect(f.coordinator.launch(next)).rejects.toThrow(
    "UPDATE_INSTALLER_RUNNING",
  );
  expect(f.native.launchInstaller).toHaveBeenCalledOnce();
});
it("completed installer cannot supersede certificate or resume runtime while its exact staging monitor remains live", async () => {
  const f = fixture();
  await f.coordinator.launch(metadata);
  const prior = f.status();
  if (prior.state === "absent") throw new Error();
  f.setStatus({
    state: "completed",
    certificate: { ...prior.certificate, exitCode: 0, treeExited: true },
  });
  f.native.removeCompletedInstallerMonitor.mockResolvedValue(false);
  await expect(f.coordinator.assertCompleted(metadata)).rejects.toThrow(
    "UPDATE_INSTALLER_RUNNING",
  );
  const next = {
    ...metadata,
    app: { ...metadata.app, version: "3.0.0", payloadSha256: "f".repeat(64) },
  };
  await expect(f.coordinator.launch(next)).rejects.toThrow(
    "UPDATE_INSTALLER_RUNNING",
  );
  expect(f.native.launchInstaller).toHaveBeenCalledOnce();
  f.native.removeCompletedInstallerMonitor.mockResolvedValue(true);
  await f.coordinator.assertCompleted(metadata);
});
