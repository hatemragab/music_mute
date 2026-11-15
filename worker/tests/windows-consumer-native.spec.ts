import { describe, expect, it, vi } from "vitest";
import {
  assertConsumerPipePeer,
  assertConsumerRelativePath,
  CONSUMER_NATIVE_ERROR_CODES,
  ConsumerNativeError,
  consumerDataSddl,
  consumerPipeSddl,
  decodeConsumerBase64,
  isCurrentUserSid,
  processIdentityFromWire,
  WindowsConsumerNative,
  type ConsumerHostIdentity,
  type ConsumerNativeOperation,
  type ConsumerNativeTransport,
} from "../src/platform/windows/consumer-native.js";

const sid = "S-1-5-21-100-200-300-1001";
const logonSid = "S-1-5-5-100-300";
const peer = {
  sid,
  sessionId: 1,
  pid: 321,
  creationTime: "133000000000000001",
};
const owner: ConsumerHostIdentity = {
  ...peer,
  logonSid,
  nativeArch: "x64",
  processArch: "x64",
  osMajor: 10,
  osBuild: 19045,
  localAppData: "C:\\Users\\Fixture\\AppData\\Local",
};
const nonce = "a".repeat(64);
const hostWire = {
  sid,
  logon_sid: logonSid,
  session_id: 1,
  pid: 321,
  creation_time: peer.creationTime,
  native_arch: "x64",
  process_arch: "x64",
  os_major: 10,
  os_build: 19045,
  local_app_data: owner.localAppData,
};
const processWire = {
  sid,
  session_id: 1,
  pid: 321,
  creation_time: peer.creationTime,
};

function adapter(
  reply: (
    operation: ConsumerNativeOperation,
    args: Record<string, unknown>,
  ) => unknown,
): ConsumerNativeTransport & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(
      async (
        operation: ConsumerNativeOperation,
        args: Record<string, unknown>,
      ) => reply(operation, args),
    ),
    close: vi.fn(async () => {}),
  };
}

describe("Windows consumer native policy (injected adapter, no Win32 execution)", () => {
  it("installer verification and independent launch accept only fixed signed staging pins", async () => {
    const pin = {
      identity: nonce,
      sha256: "b".repeat(64),
      bytes: 64,
      publisherSha256: "c".repeat(64),
    };
    const transport = adapter((operation) =>
        operation === "identity"
          ? hostWire
          : operation === "installer_verify"
            ? { verified: true }
            : { started: true, identity: { ...processWire, pid: 322 } },
      ),
      native = new WindowsConsumerNative(transport);
    await native.verifyInstaller(pin);
    expect(transport.request).toHaveBeenCalledWith(
      "installer_verify",
      {
        identity: nonce,
        sha256: pin.sha256,
        bytes: 64,
        publisher_sha256: pin.publisherSha256,
      },
      35000,
    );
    expect((await native.launchInstaller(pin)).pid).toBe(322);
    await expect(
      native.verifyInstaller({ ...pin, identity: "..\\external.exe" }),
    ).rejects.toThrow("BAD_REQUEST");
    await expect(
      new WindowsConsumerNative(
        adapter((operation) =>
          operation === "identity" ? hostWire : { verified: false },
        ),
      ).verifyInstaller(pin),
    ).rejects.toThrow("HELPER_INTEGRITY_INVALID");
  });
  it("requires a current account SID, including Azure AD, rather than LocalService", () => {
    expect(isCurrentUserSid(sid)).toBe(true);
    expect(isCurrentUserSid("S-1-12-1-100-200-300-400")).toBe(true);
    for (const invalid of [
      "S-1-5-19",
      "S-1-5-18",
      "S-1-5-32-544",
      "S-1-1-0",
      "S-1-12-1-100-200-300-4294967296",
    ])
      expect(isCurrentUserSid(invalid)).toBe(false);
  });
  it("builds protected user data ACLs and session-specific pipe rights without generic write", () => {
    expect(consumerDataSddl(sid)).toBe(
      `O:${sid}D:P(A;OICI;FA;;;${sid})(A;OICI;FA;;;SY)`,
    );
    const pipe = consumerPipeSddl(sid, logonSid);
    expect(pipe).toContain(logonSid);
    expect(pipe).toContain("0x0012019b");
    expect(0x0012019b & 4).toBe(0);
    expect(pipe).not.toMatch(/;;;(?:WD|BU|BA)\)/u);
    expect(() => consumerDataSddl("S-1-5-19")).toThrow("ACL_UNSAFE");
    expect(() => consumerPipeSddl(sid, "S-1-1-0")).toThrow("ACL_UNSAFE");
  });
  it.each([
    "..\\vault",
    "C:\\vault",
    "\\\\server\\share",
    "\\\\?\\C:\\vault",
    "safe\\..\\vault",
    "safe\\\\vault",
    "vault:secret",
    "secret.",
    "secret ",
    "NUL.json",
    "COM¹.txt",
    "folder/secret",
    "vault\\secret\0",
    "secret\n",
    ".",
  ])("rejects unsafe path %j", (path) => {
    expect(() => assertConsumerRelativePath(path)).toThrow("PATH_UNSAFE");
  });
  it("preserves Unicode and spaces in safe relative paths", () => {
    expect(() =>
      assertConsumerRelativePath("runtime\\العربية files\\model.onnx"),
    ).not.toThrow();
    expect(() => assertConsumerRelativePath("", true)).not.toThrow();
  });
  it.each([
    { ...peer, creationTime: "133000000000000002" },
    { ...peer, sessionId: 2 },
    { ...peer, sid: "S-1-5-21-100-200-300-1002" },
    { ...peer, pid: 322 },
  ])("denies PID reuse, foreign sessions and changed peers", (actual) => {
    expect(() =>
      assertConsumerPipePeer(owner, peer, actual, nonce, nonce),
    ).toThrow("PEER_DENIED");
  });
  it("checks nonce and maintains the full 64-bit birth identity", () => {
    expect(() =>
      assertConsumerPipePeer(owner, peer, peer, nonce, "b".repeat(64)),
    ).toThrow("PEER_DENIED");
    expect(processIdentityFromWire(processWire).creationTime).toBe(
      peer.creationTime,
    );
    expect(() =>
      processIdentityFromWire({
        ...processWire,
        creation_time: Number(peer.creationTime),
      }),
    ).toThrow("PROTOCOL_MISMATCH");
    expect(() =>
      processIdentityFromWire({
        ...processWire,
        creation_time: "18446744073709551616",
      }),
    ).toThrow("PROTOCOL_MISMATCH");
  });
  it.each([
    { native_arch: "arm64" },
    { process_arch: "x86" },
    { os_build: 19044 },
    { os_major: 6 },
  ])("rejects emulation and pre-22H2 hosts", async (change) => {
    const native = new WindowsConsumerNative(
      adapter(() => ({ ...hostWire, ...change })),
    );
    await expect(native.identity()).rejects.toThrow("UNSUPPORTED_HOST");
  });
  it("returns actual supported host and rejects unknown process state", async () => {
    const transport = adapter((operation) =>
      operation === "identity" ? hostWire : null,
    );
    const native = new WindowsConsumerNative(transport);
    await expect(native.identity()).resolves.toEqual(owner);
    await expect(native.processIdentity(321)).resolves.toBeNull();
    transport.request.mockRejectedValueOnce(
      new ConsumerNativeError("IDENTITY_UNAVAILABLE"),
    );
    await expect(native.processIdentity(321)).rejects.toThrow(
      "IDENTITY_UNAVAILABLE",
    );
  });
  it("keeps account and fleet vault namespaces distinct and sends secrets only as native request bytes", async () => {
    const records = new Map<string, string>();
    const transport = adapter((operation, args) => {
      const key = `${String(args.namespace)}:${String(args.key)}`;
      if (operation === "vault_put") {
        records.set(key, args.bytes_base64 as string);
        return { version: 1, stored: true };
      }
      if (operation === "vault_get")
        return records.has(key)
          ? { version: 1, bytes_base64: records.get(key) }
          : null;
      records.delete(key);
      return { deleted: true };
    });
    const native = new WindowsConsumerNative(transport);
    await native.vaultWrite(
      "account",
      "session",
      Buffer.from("synthetic-account"),
    );
    await native.vaultWrite("fleet", "session", Buffer.from("synthetic-fleet"));
    expect((await native.vaultRead("account", "session"))?.toString()).toBe(
      "synthetic-account",
    );
    await native.vaultDelete("account", "session");
    await expect(native.vaultRead("account", "session")).resolves.toBeNull();
    expect((await native.vaultRead("fleet", "session"))?.toString()).toBe(
      "synthetic-fleet",
    );
  });
  it.each([
    { version: 2, bytes_base64: "YQ==" },
    { version: 1, bytes_base64: "invalid!" },
    { version: 1, bytes_base64: "" },
  ])(
    "fails closed on corrupt/version-mismatched vault responses",
    async (reply) => {
      await expect(
        new WindowsConsumerNative(adapter(() => reply)).vaultRead(
          "account",
          "session",
        ),
      ).rejects.toThrow("VAULT_CORRUPT");
    },
  );
  it("never falls back to plaintext on unavailable vault or failed atomic write", async () => {
    const transport = adapter(() => {
      throw new ConsumerNativeError("VAULT_UNAVAILABLE");
    });
    await expect(
      new WindowsConsumerNative(transport).vaultWrite(
        "fleet",
        "identity",
        Buffer.from("synthetic"),
      ),
    ).rejects.toThrow("VAULT_UNAVAILABLE");
    expect(transport.request).toHaveBeenCalledTimes(1);
    await expect(
      new WindowsConsumerNative(transport).vaultWrite(
        "fleet",
        "identity",
        Buffer.alloc(16_385),
      ),
    ).rejects.toThrow("BAD_REQUEST");
    await expect(
      new WindowsConsumerNative(transport).vaultWrite(
        "fleet",
        "..\\identity",
        Buffer.from("a"),
      ),
    ).rejects.toThrow("BAD_REQUEST");
    expect(transport.request).toHaveBeenCalledTimes(1);
  });
  it("uses bounded explicit vault recovery without enumerating or exporting secrets", async () => {
    const transport = adapter(() => ({
      removed: 12,
      skipped: 4,
      limited: true,
    }));
    await expect(
      new WindowsConsumerNative(transport).vaultRecover("fleet"),
    ).resolves.toEqual({ removed: 12, skipped: 4, limited: true });
    expect(transport.request).toHaveBeenCalledWith("vault_recover", {
      namespace: "fleet",
    });
    await expect(
      new WindowsConsumerNative(
        adapter(() => ({ removed: 17, skipped: 0, limited: false })),
      ).vaultRecover("fleet"),
    ).rejects.toThrow("PROTOCOL_MISMATCH");
  });
  it("requires signed inventory launch authorization and returns an owned identity", async () => {
    const transport = adapter((operation) =>
      operation === "identity"
        ? hostWire
        : { role: "fleet", nonce, identity: processWire },
    );
    const verify = vi.fn(async () => {});
    await expect(
      new WindowsConsumerNative(transport).launchOwned("fleet", "1.0.0"),
    ).rejects.toThrow("LAUNCH_VERIFICATION_REQUIRED");
    const native = new WindowsConsumerNative(transport, { verify });
    await expect(native.launchOwned("fleet", "1.0.0")).resolves.toEqual({
      role: "fleet",
      nonce,
      identity: peer,
    });
    expect(verify).toHaveBeenCalledWith("fleet", "1.0.0");
    await expect(native.launchOwned("fleet", "..\\escape")).rejects.toThrow(
      "BAD_REQUEST",
    );
  });
  it("does not launch when inventory authorization fails", async () => {
    const transport = adapter(() => hostWire);
    const native = new WindowsConsumerNative(transport, {
      verify: async () => {
        throw new Error("INVENTORY_MISMATCH");
      },
    });
    await expect(native.launchOwned("fleet", "1.0.0")).rejects.toThrow(
      "INVENTORY_MISMATCH",
    );
    expect(transport.request).not.toHaveBeenCalled();
  });
  it("binds stop requests to nonce plus SID/session/PID/birth, with no image-name shutdown", async () => {
    const transport = adapter(() => ({ stopped: true }));
    const native = new WindowsConsumerNative(transport);
    await native.stopOwned({ role: "fleet", nonce, identity: peer });
    expect(transport.request).toHaveBeenCalledWith(
      "stop_owned",
      {
        role: "fleet",
        nonce,
        identity: processWire,
      },
      15_000,
    );
  });
  it("authenticates bounded one-use pipe exchange responses", async () => {
    const transport = adapter((operation) =>
      operation === "identity"
        ? hostWire
        : {
            peer: processWire,
            payload_base64: Buffer.from("fixture").toString("base64"),
          },
    );
    const native = new WindowsConsumerNative(transport);
    expect(
      (
        await native.pipeExchange({
          channel: nonce,
          nonce,
          peer,
          response: Buffer.from("ack"),
        })
      ).toString(),
    ).toBe("fixture");
    await expect(
      native.pipeExchange({
        channel: nonce,
        nonce,
        peer: { ...peer, sessionId: 2 },
        response: Buffer.alloc(0),
      }),
    ).rejects.toThrow("PEER_DENIED");
    await expect(
      native.pipeExchange({
        channel: nonce,
        nonce,
        peer,
        response: Buffer.alloc(32769),
      }),
    ).rejects.toThrow("BAD_REQUEST");
    await expect(
      native.pipeExchange({
        channel: nonce,
        nonce,
        peer,
        response: Buffer.from("replay"),
      }),
    ).rejects.toThrow("PEER_DENIED");
  });
  it("authenticates the native client response and rejects server PID reuse", async () => {
    const transport = adapter((operation) =>
      operation === "identity"
        ? hostWire
        : { peer: processWire, payload_base64: "YW5zd2Vy" },
    );
    const native = new WindowsConsumerNative(transport);
    expect(
      (
        await native.pipeConnect({
          channel: nonce,
          nonce,
          peer,
          payload: Buffer.from("question"),
        })
      ).toString(),
    ).toBe("answer");
    const changed = adapter((operation) =>
      operation === "identity"
        ? hostWire
        : {
            peer: { ...processWire, creation_time: "133000000000000002" },
            payload_base64: "YW5zd2Vy",
          },
    );
    await expect(
      new WindowsConsumerNative(changed).pipeConnect({
        channel: nonce,
        nonce,
        peer,
        payload: Buffer.from("question"),
      }),
    ).rejects.toThrow("PEER_DENIED");
  });
  it("accepts authenticated payload before computing and sending a dynamic reply", async () => {
    const token = "c".repeat(64);
    const transport = adapter((operation) => {
      if (operation === "identity") return hostWire;
      if (operation === "pipe_accept")
        return {
          connection: { token, nonce, peer: processWire },
          payload_base64: "cXVlc3Rpb24=",
        };
      return { replied: true };
    });
    const native = new WindowsConsumerNative(transport);
    const accepted = await native.pipeAccept({
      channel: nonce,
      nonce,
      peer: null,
      timeoutMs: 1000,
    });
    expect(accepted.payload.toString()).toBe("question");
    expect(
      transport.request.mock.calls.some(
        ([operation]) => operation === "pipe_reply",
      ),
    ).toBe(false);
    await native.pipeReply(accepted.connection, Buffer.from("computed-answer"));
    expect(transport.request).toHaveBeenLastCalledWith("pipe_reply", {
      token,
      nonce,
      peer: processWire,
      payload_base64: Buffer.from("computed-answer").toString("base64"),
    });
    await expect(
      native.pipeReply(accepted.connection, Buffer.from("replay")),
    ).rejects.toThrow("PIPE_UNAVAILABLE");
  });
  it("rejects foreign/capability-changed reply ownership and closes only an accepted connection", async () => {
    const token = "c".repeat(64);
    const transport = adapter((operation) =>
      operation === "identity"
        ? hostWire
        : operation === "pipe_accept"
          ? {
              connection: { token, nonce, peer: processWire },
              payload_base64: "",
            }
          : { closed: true },
    );
    const native = new WindowsConsumerNative(transport);
    const { connection } = await native.pipeAccept({
      channel: nonce,
      nonce,
      peer,
      timeoutMs: 1000,
    });
    await expect(
      native.pipeReply(
        {
          ...connection,
          peer: { ...peer, creationTime: "133000000000000002" },
        },
        Buffer.from("forged"),
      ),
    ).rejects.toThrow("PEER_DENIED");
    await native.pipeClose(connection);
    await expect(native.pipeClose(connection)).rejects.toThrow(
      "PIPE_UNAVAILABLE",
    );
    expect(transport.request).toHaveBeenLastCalledWith("pipe_close", {
      token,
      nonce,
      peer: processWire,
    });
  });
  it("does not expose an accepted capability when peer or nonce authentication fails", async () => {
    const native = new WindowsConsumerNative(
      adapter((operation) =>
        operation === "identity"
          ? hostWire
          : {
              connection: {
                token: "c".repeat(64),
                nonce: "b".repeat(64),
                peer: processWire,
              },
              payload_base64: "",
            },
      ),
    );
    await expect(
      native.pipeAccept({ channel: nonce, nonce, peer: null, timeoutMs: 1000 }),
    ).rejects.toThrow("PEER_DENIED");
  });
  it("keeps commands at4KiB while accepting authenticated32KiB snapshot replies", async () => {
    const response = Buffer.alloc(32768, 120);
    const native = new WindowsConsumerNative(
      adapter((operation) =>
        operation === "identity"
          ? hostWire
          : { peer: processWire, payload_base64: response.toString("base64") },
      ),
    );
    expect(
      await native.pipeConnect({
        channel: nonce,
        nonce,
        peer,
        payload: Buffer.from("snapshot"),
      }),
    ).toEqual(response);
    await expect(
      native.pipeConnect({
        channel: "b".repeat(64),
        nonce: "b".repeat(64),
        peer,
        payload: Buffer.alloc(4097),
      }),
    ).rejects.toThrow("BAD_REQUEST");
  });
  it.each(["acquisition", "metadata"] as const)(
    "%s mutex leases are fixed-scope and reject nonce/birth mismatches",
    async (scope) => {
      const transport = adapter((operation, args) =>
        operation === "identity"
          ? hostWire
          : operation === "acquire_mutex"
            ? {
                acquired: true,
                scope: args.scope,
                nonce,
                abandoned: false,
                identity: processWire,
              }
            : { released: true },
      );
      const native = new WindowsConsumerNative(transport);
      const lease = await native.acquireMutex(scope);
      expect(lease?.scope).toBe(scope);
      await expect(
        native.releaseMutex({ ...lease!, nonce: "b".repeat(64) }),
      ).rejects.toThrow("PEER_DENIED");
      await native.releaseMutex(lease!);
      expect(transport.request).toHaveBeenCalledWith("release_mutex", {
        scope,
        nonce,
        identity: processWire,
      });
      await expect(native.releaseMutex(lease!)).rejects.toThrow("PEER_DENIED");
    },
  );
  it.each(["cache", "metadata"] as const)(
    "%s contention keeps the original lease until exact release without recursive ownership",
    async (scope) => {
      let held: string | null = null,
        acquisitions = 0;
      const transport = adapter((operation, args) => {
        if (operation === "identity") return hostWire;
        if (operation === "acquire_mutex") {
          if (held) return { acquired: false };
          held = (++acquisitions === 1 ? "a" : "b").repeat(64);
          return {
            acquired: true,
            scope: args.scope,
            nonce: held,
            abandoned: false,
            identity: processWire,
          };
        }
        if (operation === "release_mutex") {
          expect(args.nonce).toBe(held);
          expect(args.identity).toEqual(processWire);
          held = null;
          return { released: true };
        }
        throw new Error("UNEXPECTED_NATIVE_OPERATION");
      });
      const native = new WindowsConsumerNative(transport);
      const first = await native.acquireMutex(scope);
      expect(first?.nonce).toBe(nonce);
      expect(await native.acquireMutex(scope)).toBeNull();
      expect(await native.acquireMutex(scope)).toBeNull();
      await expect(
        native.releaseMutex({ ...first!, nonce: "f".repeat(64) }),
      ).rejects.toThrow("PEER_DENIED");
      expect(held).toBe(nonce);
      await native.releaseMutex(first!);
      const next = await native.acquireMutex(scope);
      expect(next?.nonce).toBe("b".repeat(64));
      await expect(native.releaseMutex(first!)).rejects.toThrow("PEER_DENIED");
      expect(held).toBe(next!.nonce);
      await native.releaseMutex(next!);
      expect(held).toBeNull();
      expect(acquisitions).toBe(2);
    },
  );
  it("SID-wide singleton inspection retains foreign-logon birth while publication requires native authorization", async () => {
    const transport = adapter((operation) =>
      operation === "identity"
        ? hostWire
        : operation === "singleton_inspect"
          ? {
              state: "active",
              owner: { ...processWire, session_id: 2 },
              same_session: false,
            }
          : { authorized: true },
    );
    const native = new WindowsConsumerNative(transport);
    expect(await native.inspectSingletonOwner("account")).toEqual({
      state: "active",
      owner: { ...peer, sessionId: 2 },
      sameSession: false,
    });
    await native.assertSingletonPublication("account");
    expect(transport.request).toHaveBeenCalledWith(
      "singleton_assert_publication",
      { scope: "account" },
    );
    await expect(native.acquireMutex("arbitrary" as never)).rejects.toThrow(
      "BAD_REQUEST",
    );
    const inconsistent = new WindowsConsumerNative(
      adapter((operation) =>
        operation === "identity"
          ? hostWire
          : { state: "active", owner: processWire, same_session: false },
      ),
    );
    await expect(inconsistent.inspectSingletonOwner("session")).rejects.toThrow(
      "PEER_DENIED",
    );
  });
  it("GPU leases bind exact physical LUID and native helper creation identity", async () => {
    const gpu = {
      source: "DXGI EnumAdapters1/GetDesc1",
      deviceIndex: 2,
      name: "Fixture GPU",
      vendorId: 4098,
      deviceId: 29631,
      subsystemId: 1,
      revision: 1,
      driverVersion: "32.0.1.2",
      luid: "0000000000001234",
      dedicatedVideoMemoryBytes: 8 * 1024 ** 3,
      sharedSystemMemoryLimitBytes: 4 * 1024 ** 3,
    };
    const transport = adapter((operation) =>
      operation === "identity"
        ? hostWire
        : operation === "gpu_inventory"
          ? { gpus: [gpu] }
          : operation === "acquire_gpu_guard"
            ? {
                acquired: true,
                luid: gpu.luid,
                nonce,
                identity: processWire,
                abandoned: false,
                gpu,
              }
            : { released: true },
    );
    const native = new WindowsConsumerNative(transport);
    expect(await native.enumerateGpus()).toEqual([gpu]);
    const lease = await native.acquireGpuGuard(gpu as never);
    expect(lease?.gpu.luid).toBe(gpu.luid);
    await expect(
      native.releaseGpuGuard({
        ...lease!,
        identity: { ...peer, creationTime: "133000000000000009" },
      }),
    ).rejects.toThrow("PEER_DENIED");
    await native.releaseGpuGuard(lease!);
    expect(transport.request).toHaveBeenCalledWith(
      "release_gpu_guard",
      {
        luid: gpu.luid,
        nonce,
        identity: processWire,
      },
      15_000,
    );
    await expect(
      new WindowsConsumerNative(
        adapter(() => ({ gpus: [{ ...gpu, luid: "00000000:00001234" }] })),
      ).enumerateGpus(),
    ).rejects.toThrow("GPU_INVENTORY_UNAVAILABLE");
  });
  it("native ticket claims and parent-peer binding accept only explicit booleans", async () => {
    const transport = adapter((operation) =>
      operation === "claim_session_ticket"
        ? { claimed: false }
        : { same: true },
    );
    const native = new WindowsConsumerNative(transport);
    expect(await native.claimSessionTicket(nonce)).toBe(false);
    expect(await native.sameParentProcess(peer, { ...peer, pid: 322 })).toBe(
      true,
    );
    expect(transport.request).toHaveBeenCalledWith("same_parent_process", {
      first: processWire,
      second: { ...processWire, pid: 322 },
    });
    await expect(
      new WindowsConsumerNative(
        adapter(() => ({ claimed: 1 })),
      ).claimSessionTicket(nonce),
    ).rejects.toThrow("PROTOCOL_MISMATCH");
  });
  it("decodes canonical bounded base64 only", () => {
    expect(decodeConsumerBase64("YQ==", 1).toString()).toBe("a");
    for (const value of ["YQ=", "YQ==\n", "YR==", "YWJj", 7])
      expect(() => decodeConsumerBase64(value, 1)).toThrow("PROTOCOL_MISMATCH");
  });
  it("requires a native exact-owner whole-tree certificate instead of PID absence", async () => {
    const owner = { role: "fleet" as const, nonce, identity: peer };
    const transport = adapter(() => ({ exited: false }));
    const native = new WindowsConsumerNative(transport);
    expect(await native.ownedTreeExited(owner)).toBe(false);
    expect(transport.request).toHaveBeenCalledWith("owned_tree_exited", {
      owner: { role: "fleet", nonce, identity: processWire },
    });
    expect(transport.request).not.toHaveBeenCalledWith(
      "process_identity",
      expect.anything(),
    );
    await expect(
      new WindowsConsumerNative(
        adapter(() => ({ exited: "yes" })),
      ).ownedTreeExited(owner),
    ).rejects.toThrow("PROTOCOL_MISMATCH");
  });
  it.each(CONSUMER_NATIVE_ERROR_CODES)(
    "exports a bounded safe %s error record",
    (code) => {
      const error = new ConsumerNativeError(code);
      expect(JSON.stringify(error)).toBe(JSON.stringify({ code }));
      expect(error.message).toBe(code);
    },
  );
});
