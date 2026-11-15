import { expect, it, vi } from "vitest";
import {
  WindowsConsumerNative,
  type ConsumerNativeTransport,
} from "../src/platform/windows/consumer-native.js";
const hash = "a".repeat(64),
  resources =
    "C:\\Users\\Fixture\\AppData\\Local\\MusicMuteLocal\\login\\" +
    hash +
    "\\resources";
function fixture(reply: unknown) {
  const transport: ConsumerNativeTransport = {
    request: vi.fn(async () => reply),
    close: vi.fn(async () => {}),
  };
  return { transport, native: new WindowsConsumerNative(transport) };
}
it("retains only the fixed shim with exact sealed publisher and digest", async () => {
  const f = fixture({ retained: true });
  await f.native.retainSessionLauncher(hash, "b".repeat(64));
  expect(f.transport.request).toHaveBeenCalledWith("startup_retain", {
    launcher_sha256: hash,
    publisher_sha256: "b".repeat(64),
  });
  await expect(f.native.retainSessionLauncher("bad", hash)).rejects.toThrow(
    "HELPER_INTEGRITY_INVALID",
  );
});
it("accepts only bounded native signed-shim lineage and fixed capsule proof", async () => {
  const reply = {
    verified: true,
    release: hash,
    capsule_sha256: hash,
    launcher_sha256: hash,
    resources_root: resources,
  };
  const f = fixture(reply);
  expect(await f.native.verifyWorkerLoginPeer()).toEqual({
    release: hash,
    capsuleSha256: hash,
    launcherSha256: hash,
    resourcesRoot: resources,
  });
  expect(f.transport.request).toHaveBeenCalledWith(
    "worker_login_peer_verify",
    {},
  );
  for (const bad of [
    { ...reply, verified: false },
    { ...reply, unexpected: true },
    { ...reply, release: 7 },
    { ...reply, resources_root: "relative" },
  ])
    await expect(fixture(bad).native.verifyWorkerLoginPeer()).rejects.toThrow();
});
it("a role PID is never sufficient to pass the positive whole-tree idle port", async () => {
  expect(await fixture({ idle: false }).native.workerLoginIdle()).toBe(false);
  expect(await fixture({ idle: true }).native.workerLoginIdle()).toBe(true);
  const prepared = fixture({ idle: false });
  expect(await prepared.native.workerLoginIdle("prepare")).toBe(false);
  expect(prepared.transport.request).toHaveBeenCalledWith("worker_login_idle", {
    scope: "prepare",
  });
  await expect(
    prepared.native.workerLoginIdle("arbitrary" as never),
  ).rejects.toThrow("BAD_REQUEST");
  for (const bad of [{ idle: 1 }, { idle: true, pid: 123 }, null])
    await expect(fixture(bad).native.workerLoginIdle()).rejects.toThrow(
      "PROTOCOL_MISMATCH",
    );
});
