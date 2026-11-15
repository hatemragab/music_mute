import { expect, it, vi } from "vitest";
import {
  RuntimeStatusCache,
  type RuntimeStatusPort,
  type RuntimeStatusBinding,
} from "../src/main/prepare/runtime-status-cache.js";
import { CONSUMER_DLL_POLICY } from "../../worker/src/platform/windows/consumer-dlls.js";
const binding: RuntimeStatusBinding = {
  sid: "S-1-5-21-100-200-300-1001",
  installationId: "00000000-0000-4000-8000-000000000001",
  target: "a".repeat(64),
  sequence: 2,
  manifestSha256: "b".repeat(64),
  dllPolicy: CONSUMER_DLL_POLICY,
};
function fixture() {
  let marker: Buffer | null = null;
  const files = new Map<string, Buffer>(),
    fp = {
      device: "1",
      fileId: "2",
      bytes: 100,
      writtenAt: "3",
      changedAt: "4",
    };
  const port: RuntimeStatusPort = {
    readMarker: async () => marker,
    writeMarker: async (bytes) => {
      marker = Buffer.from(bytes);
    },
    readCapsule: async (path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error("ENOENT");
      return bytes;
    },
    writeCapsule: async (path, bytes) => {
      files.set(path, Buffer.from(bytes));
    },
    fingerprint: vi.fn(async () => ({ ...fp })),
  };
  const prefix = `runtime\\releases\\${binding.target}\\`,
    paths = [
      `${prefix}release-manifest.json`,
      ...Array.from({ length: 9000 }, (_, i) => `${prefix}python\\file${i}.py`),
    ];
  return {
    port,
    files,
    fp,
    paths,
    cache: new RuntimeStatusCache(port),
    signal: new AbortController().signal,
  };
}
it("checks complete runtime-only coverage above8192 files without model/GPU/boot ports or content reads", async () => {
  const f = fixture();
  await f.cache.capture(binding, f.paths, f.signal);
  vi.mocked(f.port.fingerprint).mockClear();
  expect(await f.cache.check(binding, f.signal)).toBe(true);
  expect(f.port.fingerprint).toHaveBeenCalledTimes(9001);
  expect(
    [...f.files.keys()].every((path) =>
      path.startsWith(`prepare\\runtime-status\\${binding.target}\\slot0\\`),
    ),
  ).toBe(true);
});
it("a changed runtime fingerprint, source/profile identity or missing manifest coverage never establishes status", async () => {
  const f = fixture();
  await f.cache.capture(binding, f.paths, f.signal);
  f.fp.fileId = "99";
  expect(await f.cache.check(binding, f.signal)).toBe(false);
  f.fp.fileId = "2";
  expect(
    await f.cache.check(
      { ...binding, manifestSha256: "f".repeat(64) },
      f.signal,
    ),
  ).toBe(false);
  await expect(
    f.cache.capture(binding, f.paths.slice(1), f.signal),
  ).rejects.toThrow("READINESS_INVALID");
  await expect(
    f.cache.capture(
      binding,
      [...f.paths, "models\\Kim_Vocal_2.onnx"],
      f.signal,
    ),
  ).rejects.toThrow("READINESS_INVALID");
});
it("late marker replacement or caller abort refuses stale status without mutating another reader", async () => {
  const f = fixture();
  await f.cache.capture(binding, f.paths.slice(0, 2), f.signal);
  const original = f.port.fingerprint;
  f.port.fingerprint = async (path) => {
    await f.port.writeMarker(Buffer.from("{}"));
    return original(path);
  };
  expect(await f.cache.check(binding, f.signal)).toBe(false);
  f.port.fingerprint = original;
  await f.cache.capture(binding, f.paths.slice(0, 2), f.signal);
  const abort = new AbortController();
  abort.abort();
  expect(await f.cache.check(binding, abort.signal)).toBe(false);
  expect(await f.cache.check(binding, f.signal)).toBe(true);
});
it("refuses legacy DLL policy evidence while preserving the current runtime cache", async () => {
  const f = fixture(),
    legacy = {
      ...binding,
      dllPolicy: "private-pe-imports-msvc-v2",
    } as unknown as RuntimeStatusBinding;
  await f.cache.capture(binding, f.paths.slice(0, 2), f.signal);
  await expect(
    f.cache.capture(legacy, f.paths.slice(0, 2), f.signal),
  ).rejects.toThrow("READINESS_INVALID");
  expect(await f.cache.check(legacy, f.signal)).toBe(false);
  expect(await f.cache.check(binding, f.signal)).toBe(true);
});
