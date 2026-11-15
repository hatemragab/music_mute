import { expect, it, vi } from "vitest";
import {
  WindowsConsumerNative,
  parseStoreCpuOperationExpectation,
  type ConsumerNativeTransport,
  type ConsumerNativeOperation,
} from "../src/platform/windows/consumer-native.js";
const expectation = {
  version: 1 as const,
  distribution: "microsoft-store" as const,
  kind: "cpu-tools" as const,
  requestId: "12345678-1234-4234-8234-123456789012",
  incarnation: "87654321-1234-4234-8234-123456789012",
  operation: "cloud_probe" as const,
  configurationSha256: "a".repeat(64),
  inventorySha256: "b".repeat(64),
  runtimeManifestSha256: "c".repeat(64),
  nodeOwner: {
    role: "personal" as const,
    nonce: "d".repeat(64),
    identity: {
      sid: "S-1-5-21-1-2-3-1001",
      sessionId: 1,
      pid: 10,
      creationTime: "132000000000000000",
    },
  },
  token: "e".repeat(64),
};
const relative = `cloud\\work\\${expectation.requestId}`,
  wireIdentity = {
    sid: expectation.nodeOwner.identity.sid,
    session_id: 1,
    pid: 10,
    creation_time: expectation.nodeOwner.identity.creationTime,
  },
  completed = {
    state: "completed",
    receipt_id: "f".repeat(64),
    nonce: "0".repeat(64),
  };
function fixture(reply: (operation: ConsumerNativeOperation) => unknown) {
  const transport: ConsumerNativeTransport = {
    close: vi.fn(async () => {}),
    request: vi.fn(async (operation, args) => {
      if (operation === "identity")
        return {
          ...wireIdentity,
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
          nonce: "1".repeat(64),
          identity: wireIdentity,
          abandoned: false,
        };
      return reply(operation);
    }),
  };
  return { transport, native: new WindowsConsumerNative(transport) };
}
// Receiving/adapter tests only. These transports are not installed Store code
// and cannot create a Creator row, physical GPU or native retirement proof.
it("receives only a closed CPU observation and preserves the actual personal role rather than relabeling it Prepare", () => {
  const parsed = parseStoreCpuOperationExpectation(expectation);
  expect(parsed).toEqual(expectation);
  expect(parsed).not.toBe(expectation);
  expect(parsed.nodeOwner.role).toBe("personal");
  expect(Object.isFrozen(parsed.nodeOwner.identity)).toBe(true);
  for (const changed of [
    { distribution: "legacy" },
    { kind: "job-exit" },
    { command: "caller.exe" },
    { operation: "model-inference" },
    { token: "bad" },
    { configurationSha256: "bad" },
    { nodeOwner: { ...expectation.nodeOwner, role: "fleet" } },
    {
      nodeOwner: {
        ...expectation.nodeOwner,
        identity: { ...expectation.nodeOwner.identity, sessionId: 0 },
      },
    },
  ])
    expect(() =>
      parseStoreCpuOperationExpectation({ ...expectation, ...changed }),
    ).toThrow("PROTOCOL_MISMATCH");
});
it("rejects observation accessors before invoking them or a transport", async () => {
  const getter = vi.fn(() => expectation.token),
    forged = { ...expectation },
    { native, transport } = fixture(() => ({ retired: true }));
  Object.defineProperty(forged, "token", { enumerable: true, get: getter });
  await expect(native.inspectStoreCpuOperation(forged)).rejects.toThrow(
    "PROTOCOL_MISMATCH",
  );
  expect(getter).not.toHaveBeenCalled();
  expect(transport.request).not.toHaveBeenCalled();
});
it("forwards the complete original observation for readonly inspection and preserves a real pending response", async () => {
  const { native, transport } = fixture(() => ({ retired: false }));
  expect(await native.inspectStoreCpuOperation(expectation)).toBe(false);
  expect(transport.request).toHaveBeenCalledExactlyOnceWith(
    "store_cpu_operation_cleanup_inspect",
    { expectation },
    35000,
  );
});
it.each([
  {},
  { retired: 1 },
  { retired: "confirmed" },
  { retired: true, job: "confirmed" },
])("rejects ambiguous readonly cleanup replies %j", async (reply) => {
  const { native } = fixture(() => reply);
  await expect(native.inspectStoreCpuOperation(expectation)).rejects.toThrow(
    "PROTOCOL_MISMATCH",
  );
});
it("requires the actual SDK cache lease and exact operation workspace before any marker effect", async () => {
  const { native, transport } = fixture(() => completed);
  await expect(
    native.retireStoreCpuWorkspaceMarker(relative, expectation),
  ).rejects.toThrow("PEER_DENIED");
  await native.acquireMutex("cache");
  for (const path of [
    "C:\\caller",
    `prepare\\work\\${expectation.requestId}`,
    `${relative}\\child`,
    "cloud\\work\\..\\other",
  ])
    await expect(
      native.retireStoreCpuWorkspaceMarker(path, expectation),
    ).rejects.toThrow("BAD_REQUEST");
  expect(transport.request).not.toHaveBeenCalledWith(
    "store_cpu_workspace_marker_retire",
    expect.anything(),
    expect.anything(),
  );
});
it("uses separate Store marker retirement and acknowledged closure without stopping the warm Node or substituting a legacy exit record", async () => {
  const { native, transport } = fixture((operation) =>
    operation === "store_cpu_workspace_marker_retire"
      ? completed
      : operation === "store_cpu_workspace_marker_acknowledge"
        ? { acknowledged: true, ack_nonce: "2".repeat(64) }
        : { released: true },
  );
  await native.acquireMutex("cache");
  const receipt = await native.retireStoreCpuWorkspaceMarker(
    relative,
    expectation,
  );
  expect(receipt.state).toBe("completed");
  if (receipt.state !== "completed") throw Error("fixture");
  await native.acknowledgeStoreCpuWorkspaceMarker(receipt, expectation);
  expect(transport.request).toHaveBeenCalledWith(
    "store_cpu_workspace_marker_retire",
    { relative_path: relative, expectation, cache_nonce: "1".repeat(64) },
    35000,
  );
  expect(transport.request).toHaveBeenCalledWith(
    "store_cpu_workspace_marker_acknowledge",
    {
      receipt_id: completed.receipt_id,
      nonce: completed.nonce,
      expectation,
      cache_nonce: "1".repeat(64),
    },
    35000,
  );
  expect(transport.request).toHaveBeenCalledWith(
    "store_cpu_workspace_marker_release",
    {
      receipt_id: completed.receipt_id,
      nonce: completed.nonce,
      expectation,
      cache_nonce: "1".repeat(64),
      ack_nonce: "2".repeat(64),
    },
    35000,
  );
  const operations = vi
    .mocked(transport.request)
    .mock.calls.map(([operation]) => operation);
  expect(operations).not.toContain("owned_stop");
  expect(operations).not.toContain("owned_tree_exited");
  expect(operations).not.toContain("storage_cleanup_ack");
});
it.each([
  { acknowledged: true },
  { acknowledged: false, ack_nonce: "2".repeat(64) },
  { acknowledged: true, ack_nonce: "bad" },
  { acknowledged: true, ack_nonce: "2".repeat(64), released: true },
])(
  "does not collect Creator bookkeeping for an ambiguous ACK %j",
  async (reply) => {
    const { native, transport } = fixture(() => reply);
    await native.acquireMutex("cache");
    await expect(
      native.acknowledgeStoreCpuWorkspaceMarker(
        {
          state: "completed",
          receiptId: completed.receipt_id,
          nonce: completed.nonce,
        },
        expectation,
      ),
    ).rejects.toThrow("PROTOCOL_MISMATCH");
    expect(
      vi
        .mocked(transport.request)
        .mock.calls.some(
          ([operation]) => operation === "store_cpu_workspace_marker_release",
        ),
    ).toBe(false);
  },
);
it("retries only original completion collection after its reply is lost, even when another song finishes", async () => {
  let firstRelease = true;
  const { native, transport } = fixture((operation) => {
    if (operation === "store_cpu_workspace_marker_acknowledge")
      return { acknowledged: true, ack_nonce: "2".repeat(64) };
    if (firstRelease) {
      firstRelease = false;
      throw Error("RELEASE_REPLY_LOST");
    }
    return { released: true };
  });
  await native.acquireMutex("cache");
  const receipt = {
    state: "completed" as const,
    receiptId: completed.receipt_id,
    nonce: completed.nonce,
  };
  await expect(
    native.acknowledgeStoreCpuWorkspaceMarker(receipt, expectation),
  ).rejects.toThrow("RELEASE_REPLY_LOST");
  await native.acknowledgeStoreCpuWorkspaceMarker(
    { ...receipt, receiptId: "3".repeat(64) },
    { ...expectation, requestId: "abcdef12-1234-4234-8234-123456789012" },
  );
  await native.acknowledgeStoreCpuWorkspaceMarker(receipt, expectation);
  const acknowledgements = vi
    .mocked(transport.request)
    .mock.calls.filter(
      ([operation]) => operation === "store_cpu_workspace_marker_acknowledge",
    );
  expect(acknowledgements).toHaveLength(2);
  const releases = vi
    .mocked(transport.request)
    .mock.calls.filter(
      ([operation]) => operation === "store_cpu_workspace_marker_release",
    );
  expect(releases).toHaveLength(3);
  expect(releases[0]?.[1]).toEqual(releases[2]?.[1]);
});
it("denies rebinding an original pending ACK to another expectation", async () => {
  const { native, transport } = fixture(() => {
    throw Error("ACK_REPLY_LOST");
  });
  await native.acquireMutex("cache");
  const receipt = {
    state: "completed" as const,
    receiptId: completed.receipt_id,
    nonce: completed.nonce,
  };
  await expect(
    native.acknowledgeStoreCpuWorkspaceMarker(receipt, expectation),
  ).rejects.toThrow("ACK_REPLY_LOST");
  const calls = vi.mocked(transport.request).mock.calls.length;
  await expect(
    native.acknowledgeStoreCpuWorkspaceMarker(receipt, {
      ...expectation,
      token: "4".repeat(64),
    }),
  ).rejects.toThrow("PEER_DENIED");
  expect(transport.request).toHaveBeenCalledTimes(calls);
});
it("keeps a failed original native inspection visible rather than treating process absence as retired", async () => {
  const { native, transport } = fixture(() => {
    throw Error("ORIGINAL_CREATOR_UNAVAILABLE");
  });
  await expect(native.inspectStoreCpuOperation(expectation)).rejects.toThrow(
    "ORIGINAL_CREATOR_UNAVAILABLE",
  );
  expect(transport.request).toHaveBeenCalledTimes(1);
});
