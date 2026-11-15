import { describe, expect, it, vi } from "vitest";
import {
  WindowsConsumerNative,
  assertCacheDeletionPath,
  cacheIdentityToWire,
  parseCacheDeletion,
  type ConsumerNativeOperation,
  type ConsumerNativeTransport,
} from "../src/platform/windows/consumer-native.js";
const sid = "S-1-5-21-1-2-3-1001",
  nonce = "a".repeat(64),
  token = "b".repeat(64);
const wire = { sid, session_id: 1, pid: 10, creation_time: "123" };
const relative = `library\\media\\${"c".repeat(64)}\\${"d".repeat(24)}\\voice\\${"e".repeat(64)}\\media.mp3`;
const birth = { device: "1", fileId: "2", bornAt: "1700000000000000000" };
const identity = {
  ...birth,
  bytes: 42,
  writtenAt: "1700000000000000000",
  changedAt: "1700000000000000000",
};
function fixture(
  replies?: (
    operation: ConsumerNativeOperation,
    args: Record<string, unknown>,
  ) => unknown,
) {
  const transport: ConsumerNativeTransport = {
    close: vi.fn(async () => {}),
    request: vi.fn(async (operation, args) => {
      if (operation === "identity")
        return {
          ...wire,
          logon_sid: "S-1-5-5-1-2",
          native_arch: "x64",
          process_arch: "x64",
          os_major: 10,
          os_build: 19045,
          local_app_data: "C:\\Users\\Fixture\\AppData\\Local",
        };
      if (operation === "acquire_mutex")
        return {
          acquired: true,
          scope: args.scope,
          nonce,
          identity: wire,
          abandoned: false,
        };
      if (replies) return replies(operation, args);
      if (operation === "cache_delete_begin")
        return {
          request_id: args.request_id,
          relative_path: args.relative_path,
          kind: args.kind,
          nonce: token,
        };
      if (operation === "cache_delete_commit") return { state: "completed" };
      if (operation === "cache_delete_release") return { released: true };
      if (operation === "cache_delete_recover")
        return { completed: 1, pending: 0 };
      if (operation === "release_mutex") return { released: true };
      throw new Error("fixture-unexpected");
    }),
  };
  return { transport, native: new WindowsConsumerNative(transport) };
}
describe("Native closed cache-deletion SDK boundary, no Win32 execution", () => {
  it("keeps runtime quarantine retirement separate and binds the exact held Prepare lease", async () => {
    const target = "f".repeat(64),
      digest = "e".repeat(64);
    const { native, transport } = fixture((op) =>
      op === "runtime_repair_backup_remove"
        ? { state: "pending" }
        : { released: true },
    );
    await expect(
      native.removeRuntimeRepairBackup(target, digest),
    ).rejects.toThrow("PEER_DENIED");
    await native.acquireMutex("prepare");
    expect(await native.removeRuntimeRepairBackup(target, digest)).toEqual({
      state: "pending",
    });
    expect(transport.request).toHaveBeenCalledWith(
      "runtime_repair_backup_remove",
      { target, record_digest: digest, prepare_nonce: nonce },
      35000,
    );
    await expect(
      native.removeRuntimeRepairBackup("runtime\\other", digest),
    ).rejects.toThrow("HELPER_INTEGRITY_INVALID");
  });
  it("binds exact inventoried birth/mtime/ctime and the held cache lease before each effect", async () => {
    const { native, transport } = fixture();
    await expect(
      native.beginCacheDeletion(relative, "file", identity),
    ).rejects.toThrow("PEER_DENIED");
    const lease = await native.acquireMutex("cache");
    const candidate = await native.beginCacheDeletion(
      relative,
      "file",
      identity,
    );
    expect(candidate).not.toBeNull();
    expect(transport.request).toHaveBeenCalledWith(
      "cache_delete_begin",
      expect.objectContaining({
        cache_nonce: nonce,
        expected: {
          device: "1",
          file_id: "2",
          born_at: birth.bornAt,
          bytes: 42,
          written_at: identity.writtenAt,
          changed_at: identity.changedAt,
        },
      }),
    );
    expect(await native.commitCacheDeletion(candidate!)).toBe("completed");
    await native.releaseCacheDeletion(candidate!);
    expect(await native.recoverCacheDeletions()).toEqual({
      completed: 1,
      pending: 0,
    });
    await native.releaseMutex(lease!);
    await expect(native.commitCacheDeletion(candidate!)).rejects.toThrow(
      "PEER_DENIED",
    );
  });
  it.each([
    "runtime\\releases\\" + "a".repeat(64),
    "models\\model.onnx",
    "vault\\account\\token.dpapi",
    "personal\\exports\\voice.mp3",
    "selected.wav",
    "library\\media\\..\\outside",
    "library\\thumbnails\\" + "f".repeat(64) + ".image\\child",
    "personal\\engine-session\\arbitrary\\cache.bin",
    "personal\\engine-session\\11111111-1111-4111-8111-1111111111110\\cache.bin",
  ])("rejects foreign/protected namespaces: %s", (path) => {
    expect(() => assertCacheDeletionPath(path)).toThrow();
  });
  it("accepts only fixed UUID engine-session scratch paths under existing deletion authority", () => {
    expect(() =>
      assertCacheDeletionPath(
        "personal\\engine-session\\11111111-1111-4111-8111-111111111111",
      ),
    ).not.toThrow();
    expect(() =>
      assertCacheDeletionPath(
        "personal\\engine-session\\11111111-1111-4111-8111-111111111111\\engine.pid",
      ),
    ).not.toThrow();
  });
  it("does not interpret null admission or pending disposal as deleted bytes", async () => {
    const { native } = fixture((op) =>
      op === "cache_delete_begin"
        ? null
        : op === "cache_delete_commit"
          ? { state: "pending" }
          : op === "release_mutex"
            ? { released: true }
            : { released: false },
    );
    await native.acquireMutex("cache");
    expect(
      await native.beginCacheDeletion(relative, "file", identity),
    ).toBeNull();
    const candidate = {
      requestId: "11111111-1111-4111-8111-111111111111",
      relativePath: relative,
      kind: "file" as const,
      nonce: token,
    };
    expect(await native.commitCacheDeletion(candidate)).toBe("pending");
    await expect(native.releaseCacheDeletion(candidate)).rejects.toThrow(
      "PROTOCOL_MISMATCH",
    );
  });
  it("retains lost-ACK uncertainty and rejects malformed/rebound replies", async () => {
    const { native } = fixture((op, args) =>
      op === "cache_delete_begin"
        ? {
            request_id: args.request_id,
            relative_path: relative,
            kind: "file",
            nonce: token,
          }
        : Promise.reject(new Error("HELPER_UNAVAILABLE")),
    );
    await native.acquireMutex("cache");
    const candidate = await native.beginCacheDeletion(
      relative,
      "file",
      identity,
    );
    await expect(native.commitCacheDeletion(candidate!)).rejects.toThrow(
      "HELPER_UNAVAILABLE",
    );
    expect(() =>
      parseCacheDeletion({
        request_id: candidate!.requestId,
        relative_path: "models\\model.onnx",
        kind: "file",
        nonce: token,
      }),
    ).toThrow();
    expect(() =>
      cacheIdentityToWire({ ...birth, bornAt: "-1" }, "directory"),
    ).toThrow("BAD_REQUEST");
    expect(() =>
      cacheIdentityToWire({ ...identity, bytes: 1.1 }, "file"),
    ).toThrow("BAD_REQUEST");
    const extra = { ...birth, extra: "private" };
    expect(() => cacheIdentityToWire(extra, "directory")).toThrow(
      "BAD_REQUEST",
    );
  });
});
