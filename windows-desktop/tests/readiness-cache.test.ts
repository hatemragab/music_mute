import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  StartupReadinessCache,
  type ReadinessBinding,
  type ReadinessCachePort,
} from "../src/main/prepare/readiness-cache.js";
import { gpu, sid, bootIdentity } from "./fixtures/prepare.js";
const binding: ReadinessBinding = {
  bootIdentity,
  sid,
  installationId: "00000000-0000-4000-8000-000000000001",
  target: "a".repeat(64),
  sequence: 2,
  manifestSha256: "b".repeat(64),
  modelSha256: "c".repeat(64),
  fixtureSha256: "d".repeat(64),
  policy: "windows-user/directml/onnxruntime-1.24.4/no-cpu-v1",
};
function fixture() {
  let marker: Buffer | null = null;
  const files = new Map<string, Buffer>();
  const value = {
    device: "1",
    fileId: "2",
    bytes: 100,
    writtenAt: "123",
    changedAt: "456",
  };
  const port: ReadinessCachePort = {
    readMarker: vi.fn(async () => marker),
    writeMarker: async (bytes) => {
      marker = Buffer.from(bytes);
    },
    removeMarker: async () => {
      marker = null;
    },
    readCapsule: vi.fn(async (path) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error("ENOENT");
      return bytes;
    }),
    writeCapsule: async (path, bytes) => {
      files.set(path, Buffer.from(bytes));
    },
    fingerprint: vi.fn(async () => ({ ...value })),
    enumerateGpus: vi.fn(async () => [{ ...gpu }]),
    bootIdentity: vi.fn(async () => bootIdentity),
  };
  return {
    port,
    files,
    value,
    cache: new StartupReadinessCache(port, 100),
    signal: new AbortController().signal,
  };
}
afterEach(() => {
  vi.useRealTimers();
});
it("uses only one bounded capsule read and cheap file/GPU identities on an ordinary offline startup", async () => {
  const f = fixture();
  await f.cache.capture(
    binding,
    gpu,
    ["runtime\\node.exe", "models\\model.onnx"],
    f.signal,
  );
  vi.mocked(f.port.fingerprint).mockClear();
  const first = f.cache.check(binding, f.signal),
    second = f.cache.check(binding, f.signal);
  expect(first).not.toBe(second);
  expect(await first).toMatchObject({
    ready: true,
    reason: "verified",
    filesChecked: 2,
  });
  expect(await second).toMatchObject({ ready: true, filesChecked: 2 });
  expect(f.port.readCapsule).toHaveBeenCalledTimes(2);
  expect(f.port.fingerprint).toHaveBeenCalledTimes(4);
  expect(f.port.enumerateGpus).toHaveBeenCalledTimes(2);
});
it("one reader cancellation never cancels an independent current-binding reader or accepts its late result", async () => {
  const f = fixture();
  await f.cache.capture(binding, gpu, ["runtime\\node.exe"], f.signal);
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(f.port.fingerprint)
    .mockClear()
    .mockImplementationOnce(async () => {
      await wait;
      return { ...f.value };
    });
  const abort = new AbortController(),
    first = f.cache.check(binding, abort.signal);
  await vi.waitFor(() => expect(f.port.fingerprint).toHaveBeenCalledOnce());
  const second = f.cache.check(binding, f.signal);
  abort.abort();
  expect(await first).toMatchObject({ ready: false, reason: "cancelled" });
  expect(await second).toMatchObject({ ready: true, reason: "verified" });
  release();
});
it("covers more than8192 files with authenticated bounded chunks and exactly two reusable slots", async () => {
  const f = fixture(),
    paths = Array.from(
      { length: 9000 },
      (_, i) => `runtime\\releases\\${binding.target}\\python\\file${i}.py`,
    );
  const cache = new StartupReadinessCache(f.port, 8000);
  await cache.capture(binding, gpu, paths, f.signal);
  vi.mocked(f.port.fingerprint).mockClear();
  expect(await cache.check(binding, f.signal)).toMatchObject({
    ready: true,
    filesChecked: 9000,
  });
  expect(f.port.fingerprint).toHaveBeenCalledTimes(9000);
  const first = JSON.parse((await f.port.readMarker())!.toString());
  expect(first.version).toBe(3);
  await cache.capture(binding, gpu, paths, f.signal);
  const second = JSON.parse((await f.port.readMarker())!.toString());
  await cache.capture(binding, gpu, paths, f.signal);
  const third = JSON.parse((await f.port.readMarker())!.toString());
  expect(second.path).not.toBe(first.path);
  expect(third.path).toBe(first.path);
  expect(
    [...f.files.keys()].every((path) =>
      /\\slot[01]\\(?:index|chunk-\d{3})\.json$/u.test(path),
    ),
  ).toBe(true);
  expect(f.files.size).toBeLessThanOrEqual(66);
  for (const bytes of f.files.values())
    expect(bytes.length).toBeLessThanOrEqual(2 * 1024 ** 2);
});
it("large receipt rejects missing/tampered chunks and substituted index paths; interrupted inactive-slot capture preserves the prior marker", async () => {
  const f = fixture(),
    cache = new StartupReadinessCache(f.port, 8000),
    paths = Array.from(
      { length: 9000 },
      (_, i) => `runtime\\python\\file${i}.py`,
    );
  await cache.capture(binding, gpu, paths, f.signal);
  const markerBytes = Buffer.from((await f.port.readMarker())!),
    marker = JSON.parse(markerBytes.toString()),
    index = JSON.parse(f.files.get(marker.path)!.toString());
  const chunk = index.chunks[0],
    original = Buffer.from(f.files.get(chunk.path)!);
  f.files.delete(chunk.path);
  expect((await cache.check(binding, f.signal)).ready).toBe(false);
  f.files.set(chunk.path, Buffer.from("[]"));
  expect((await cache.check(binding, f.signal)).ready).toBe(false);
  f.files.set(chunk.path, original);
  const write = f.port.writeCapsule;
  f.port.writeCapsule = async (path, bytes) => {
    if (path.includes("\\slot1\\")) throw new Error("CHUNK_ACK_LOST");
    await write(path, bytes);
  };
  await expect(cache.capture(binding, gpu, paths, f.signal)).rejects.toThrow(
    "CHUNK_ACK_LOST",
  );
  expect(await f.port.readMarker()).toEqual(markerBytes);
  expect((await cache.check(binding, f.signal)).ready).toBe(true);
  index.chunks[0].path = "user-source.wav";
  const bytes = Buffer.from(JSON.stringify(index));
  f.files.set(marker.path, bytes);
  await f.port.writeMarker(
    Buffer.from(
      JSON.stringify({
        ...marker,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    ),
  );
  expect((await cache.check(binding, f.signal)).ready).toBe(false);
});
it.each([
  "sid",
  "bootIdentity",
  "installationId",
  "target",
  "sequence",
  "manifestSha256",
  "modelSha256",
  "policy",
] as const)("invalidates a changed %s binding", async (field) => {
  const f = fixture();
  await f.cache.capture(binding, gpu, ["runtime\\node.exe"], f.signal);
  expect(
    await f.cache.check(
      { ...binding, [field]: field === "sequence" ? 3 : "changed" },
      f.signal,
    ),
  ).toMatchObject({ ready: false, reason: "changed" });
});
it("rejects tampered capsules, replaced files, zero file IDs and missing files", async () => {
  for (const kind of ["capsule", "file", "zero", "missing"]) {
    const f = fixture();
    await f.cache.capture(binding, gpu, ["runtime\\node.exe"], f.signal);
    if (kind === "capsule")
      for (const path of f.files.keys()) f.files.set(path, Buffer.from("{}"));
    if (kind === "file") f.value.fileId = "3";
    if (kind === "zero") f.value.fileId = "0";
    if (kind === "missing")
      f.port.fingerprint = async () => {
        throw new Error("ENOENT");
      };
    expect(await f.cache.check(binding, f.signal)).toMatchObject({
      ready: false,
      reason: "changed",
    });
  }
});
it("accepts ordinal reorder for the same physical GPU and invalidates a changed driver", async () => {
  const f = fixture();
  await f.cache.capture(binding, gpu, ["runtime\\node.exe"], f.signal);
  f.port.enumerateGpus = async () => [{ ...gpu, deviceIndex: 0 }];
  expect((await f.cache.check(binding, f.signal)).ready).toBe(true);
  f.port.enumerateGpus = async () => [{ ...gpu, driverVersion: "32.0.2.0" }];
  expect((await f.cache.check(binding, f.signal)).ready).toBe(false);
});
it("invalidates a changed native boot witness even when the adapter LUID and all device/driver fields are reused", async () => {
  const f = fixture();
  await f.cache.capture(binding, gpu, ["runtime\\node.exe"], f.signal);
  vi.mocked(f.port.bootIdentity).mockResolvedValue("f".repeat(64));
  expect(await f.cache.check(binding, f.signal)).toMatchObject({
    ready: false,
    reason: "changed",
  });
  expect(f.port.readCapsule).not.toHaveBeenCalled();
});
it("refuses marker publication if its native boot witness changes while fingerprints are captured", async () => {
  const f = fixture();
  vi.mocked(f.port.bootIdentity)
    .mockResolvedValueOnce(bootIdentity)
    .mockResolvedValue("f".repeat(64));
  await expect(
    f.cache.capture(binding, gpu, ["runtime\\node.exe"], f.signal),
  ).rejects.toThrow("READINESS_INVALID");
  expect(await f.port.readMarker()).toBeNull();
});
it("publishes the protected marker last and rejects an interrupted capsule activation", async () => {
  const f = fixture();
  f.port.writeCapsule = async () => {
    throw new Error("DISK_FULL");
  };
  await expect(
    f.cache.capture(binding, gpu, ["runtime\\node.exe"], f.signal),
  ).rejects.toThrow("DISK_FULL");
  expect(await f.cache.check(binding, f.signal)).toMatchObject({
    ready: false,
    reason: "missing",
  });
});
it("bounds stuck readers and fences repair racing readiness", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.cache.capture(binding, gpu, ["runtime\\node.exe"], f.signal);
  f.port.fingerprint = async () => new Promise(() => {});
  const result = f.cache.check(binding, f.signal);
  await vi.advanceTimersByTimeAsync(100);
  expect(await result).toMatchObject({ ready: false, reason: "timeout" });
  f.port.fingerprint = async () => {
    await f.cache.invalidate();
    return { ...f.value };
  };
  expect(await f.cache.check(binding, f.signal)).toMatchObject({
    ready: false,
    reason: "changed",
  });
});
it("cancellation cannot publish readiness or schedule continued file checks", async () => {
  const f = fixture();
  await f.cache.capture(binding, gpu, ["runtime\\node.exe"], f.signal);
  const abort = new AbortController();
  abort.abort();
  vi.mocked(f.port.fingerprint).mockClear();
  expect(await f.cache.check(binding, abort.signal)).toMatchObject({
    ready: false,
    reason: "cancelled",
  });
  expect(f.port.fingerprint).not.toHaveBeenCalled();
});
