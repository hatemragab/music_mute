import { expect, it, vi } from "vitest";
import {
  WindowsConsumerNative,
  type ConsumerNativeTransport,
  shareCleanupFileToWire,
} from "../src/platform/windows/consumer-native.js";
const id = "11111111-1111-4111-8111-111111111111",
  nonce = "a".repeat(64);
const birth = { device: "1", fileId: "2", bornAt: "1700000000000000000" };
const file = {
  relativePath: `share\\requests\\${id}\\media.mp3`,
  sha256: "b".repeat(64),
  identity: {
    ...birth,
    bytes: 42,
    writtenAt: birth.bornAt,
    changedAt: birth.bornAt,
  },
};
function fixture(reply: unknown = { state: "completed" }) {
  const transport: ConsumerNativeTransport = {
    close: vi.fn(async () => {}),
    request: vi.fn(async (op, args) => {
      if (op === "identity")
        return {
          sid: "S-1-5-21-1-2-3-1001",
          session_id: 1,
          pid: 10,
          creation_time: "100",
          logon_sid: "S-1-5-5-1-2",
          native_arch: "x64",
          process_arch: "x64",
          os_major: 10,
          os_build: 19045,
          local_app_data: "C:\\Users\\Fixture\\AppData\\Local",
        };
      if (op === "acquire_mutex")
        return {
          acquired: true,
          scope: args.scope,
          nonce,
          identity: {
            sid: "S-1-5-21-1-2-3-1001",
            session_id: 1,
            pid: 10,
            creation_time: "100",
          },
          abandoned: false,
        };
      return reply;
    }),
  };
  return { transport, native: new WindowsConsumerNative(transport) };
}
it("binds Share cleanup to one exact created directory and leaf under the held cache lease, not an eviction path", async () => {
  const f = fixture();
  await expect(f.native.discardShareWorkspace(id, birth, file)).rejects.toThrow(
    "PEER_DENIED",
  );
  await f.native.acquireMutex("cache");
  expect(await f.native.discardShareWorkspace(id, birth, file)).toBe(
    "completed",
  );
  expect(f.transport.request).toHaveBeenCalledWith(
    "share_workspace_discard",
    {
      request_id: id,
      birth: { device: "1", file_id: "2", born_at: birth.bornAt },
      file: {
        relative_path: file.relativePath,
        sha256: file.sha256,
        expected: {
          device: "1",
          file_id: "2",
          born_at: birth.bornAt,
          bytes: 42,
          written_at: birth.bornAt,
          changed_at: birth.bornAt,
        },
      },
      cache_nonce: nonce,
    },
    35000,
  );
  expect(() =>
    shareCleanupFileToWire(id, {
      ...file,
      relativePath: "diagnostics\\reports\\arbitrary.json",
    }),
  ).toThrow("BAD_REQUEST");
  expect(() =>
    shareCleanupFileToWire(id, {
      ...file,
      relativePath: file.relativePath + "\\foreign",
    }),
  ).toThrow("BAD_REQUEST");
});
it("report deletion has no caller-controlled path/proof and pending never means completion", async () => {
  const f = fixture({ state: "pending" });
  await f.native.acquireMutex("cache");
  expect(await f.native.removeChromeDiagnosticReport(id)).toBe("pending");
  expect(f.transport.request).toHaveBeenCalledWith(
    "diagnostic_report_remove",
    { request_id: id, cache_nonce: nonce },
    35000,
  );
  const rebound = fixture({ state: "completed", privatePath: "secret" });
  await rebound.native.acquireMutex("cache");
  await expect(rebound.native.removeChromeDiagnosticReport(id)).rejects.toThrow(
    "PROTOCOL_MISMATCH",
  );
});
it("binds exact Library write and tree cleanup to fixed paths, immutable birth and bounded opaque receipts", async () => {
  const reply = { state: "completed", receipt_id: "c".repeat(64), nonce };
  const f = fixture(reply);
  await expect(
    f.native.discardLibraryArtifact(id, "runtime\\native.exe", file.identity),
  ).rejects.toThrow("BAD_REQUEST");
  const relative = `library\\media\\${"a".repeat(64)}\\${"b".repeat(24)}\\voice\\${"c".repeat(64)}\\media.mp3`;
  await expect(
    f.native.discardLibraryArtifact(id, relative, file.identity),
  ).rejects.toThrow("PEER_DENIED");
  await f.native.acquireMutex("cache");
  expect(
    await f.native.discardLibraryArtifact(id, relative, file.identity),
  ).toEqual({ state: "completed", receiptId: "c".repeat(64), nonce });
  expect(f.transport.request).toHaveBeenCalledWith(
    "library_artifact_discard",
    expect.objectContaining({
      request_id: id,
      relative_path: relative,
      expected: expect.objectContaining({ born_at: birth.bornAt }),
      cache_nonce: nonce,
    }),
    35000,
  );
  const tombstone = `personal\\results\\${id}.${id}.deleted`;
  await f.native.discardLibraryTree(tombstone, birth, id);
  expect(f.transport.request).toHaveBeenCalledWith(
    "library_tree_discard",
    {
      relative_path: tombstone,
      birth: { device: "1", file_id: "2", born_at: birth.bornAt },
      deletion_id: id,
      cache_nonce: nonce,
    },
    35000,
  );
  await expect(
    f.native.discardLibraryTree(`personal\\results\\${id}`, birth, null),
  ).rejects.toThrow("BAD_REQUEST");
  await expect(
    f.native.discardLibraryTree(
      tombstone,
      birth,
      "22222222-2222-4222-8222-222222222222",
    ),
  ).rejects.toThrow("BAD_REQUEST");
  const list = fixture({
    entries: [
      {
        relative_path: tombstone,
        birth: { device: "1", file_id: "2", born_at: birth.bornAt },
        deletion_id: id,
        receipt: reply,
      },
    ],
  });
  await list.native.acquireMutex("cache");
  expect(await list.native.listLibraryCleanups()).toEqual([
    {
      relativePath: tombstone,
      birth,
      deletionId: id,
      receipt: { state: "completed", receiptId: "c".repeat(64), nonce },
    },
  ]);
  const bad = fixture({ entries: Array(17).fill({}) });
  await bad.native.acquireMutex("cache");
  await expect(bad.native.listLibraryCleanups()).rejects.toThrow(
    "PROTOCOL_MISMATCH",
  );
  const ack = fixture({ acknowledged: true });
  await ack.native.acquireMutex("cache");
  await ack.native.acknowledgeLibraryTreeCleanup({
    state: "completed",
    receiptId: "c".repeat(64),
    nonce,
  });
  expect(ack.transport.request).toHaveBeenCalledWith(
    "library_tree_cleanup_ack",
    { receipt_id: "c".repeat(64), nonce, cache_nonce: nonce },
    35000,
  );
  const move = fixture({ moved: true });
  await move.native.acquireMutex("cache");
  await move.native.moveLocalLibraryDeletion(id, "tombstone");
  expect(move.transport.request).toHaveBeenCalledWith(
    "library_local_move",
    { request_id: id, direction: "tombstone", cache_nonce: nonce },
    35000,
  );
  await expect(
    move.native.moveLocalLibraryDeletion(id, "arbitrary" as "restore"),
  ).rejects.toThrow("BAD_REQUEST");
  const invalidMove = fixture({ moved: true, path: "private" });
  await invalidMove.native.acquireMutex("cache");
  await expect(
    invalidMove.native.moveLocalLibraryDeletion(id, "restore"),
  ).rejects.toThrow("PROTOCOL_MISMATCH");
});
it("bounded receipt recovery is metadata only and rejects invented or unbounded results", async () => {
  const f = fixture({ removed: 2, retained: 1 });
  await f.native.acquireMutex("cache");
  expect(await f.native.recoverPersonalCleanups()).toEqual({
    removed: 2,
    retained: 1,
  });
  expect(f.transport.request).toHaveBeenCalledWith(
    "personal_cleanup_recover",
    { cache_nonce: nonce },
    35000,
  );
  const bad = fixture({ removed: 21, retained: 0 });
  await bad.native.acquireMutex("cache");
  await expect(bad.native.recoverPersonalCleanups()).rejects.toThrow(
    "PROTOCOL_MISMATCH",
  );
});
it("Library publication uses journal selectors only and exposes readonly exact-generation inspection", async () => {
  const publish = fixture({ moved: true });
  await publish.native.acquireMutex("cache");
  await publish.native.publishLibraryArtifact(id, "media");
  expect(publish.transport.request).toHaveBeenCalledWith(
    "library_artifact_publish",
    { request_id: id, component: "media", cache_nonce: nonce },
    35000,
  );
  await expect(
    publish.native.publishLibraryArtifact(id, "file" as "media"),
  ).rejects.toThrow("BAD_REQUEST");
  const relative = `library\\media\\${"a".repeat(64)}\\${"b".repeat(24)}\\voice\\${"c".repeat(64)}\\media.mp3`;
  const inspect = fixture({
    relative_path: relative,
    identity: {
      device: "1",
      file_id: "2",
      born_at: birth.bornAt,
      bytes: 42,
      written_at: birth.bornAt,
      changed_at: birth.bornAt,
    },
  });
  await inspect.native.acquireMutex("cache");
  expect(
    await inspect.native.inspectLibraryArtifactPublication(id, "media"),
  ).toEqual({ relativePath: relative, identity: file.identity });
  const recover = fixture({ retained: 256 });
  await recover.native.acquireMutex("cache");
  expect(await recover.native.recoverStorageCleanups()).toEqual({
    retained: 256,
  });
  expect(recover.transport.request).toHaveBeenCalledWith(
    "storage_cleanup_recover",
    { cache_nonce: nonce },
    35000,
  );
  const invalid = fixture({ retained: 257 });
  await invalid.native.acquireMutex("cache");
  await expect(invalid.native.recoverStorageCleanups()).rejects.toThrow(
    "PROTOCOL_MISMATCH",
  );
});
it("partial and marker cleanup are distinct closed authorities with nonce-bound completion/ACK under the same cache lease", async () => {
  const f = fixture({
    state: "completed",
    receipt_id: "c".repeat(64),
    nonce: "d".repeat(64),
  });
  await expect(f.native.discardStoragePartial(id)).rejects.toThrow(
    "PEER_DENIED",
  );
  await f.native.acquireMutex("cache");
  const receipt = await f.native.discardStoragePartial(id);
  expect(receipt).toEqual({
    state: "completed",
    receiptId: "c".repeat(64),
    nonce: "d".repeat(64),
  });
  expect(f.transport.request).toHaveBeenCalledWith(
    "storage_partial_discard",
    { request_id: id, cache_nonce: nonce },
    35000,
  );
  const owner = {
    role: "prepare" as const,
    nonce,
    identity: {
      sid: "S-1-5-21-1-2-3-1001",
      sessionId: 1,
      pid: 10,
      creationTime: "100",
    },
  };
  await expect(
    f.native.retireStorageWorkspaceMarker("library\\media\\arbitrary", owner),
  ).rejects.toThrow("BAD_REQUEST");
  await f.native.retireStorageWorkspaceMarker(`prepare\\work\\${id}`, owner);
  await f.native.retireStorageWorkspaceMarker(
    `personal\\engine-session\\${id}`,
    owner,
  );
  expect(f.transport.request).toHaveBeenCalledWith(
    "storage_workspace_marker_retire",
    {
      relative_path: `prepare\\work\\${id}`,
      owner: {
        role: "prepare",
        nonce,
        identity: {
          sid: owner.identity.sid,
          session_id: 1,
          pid: 10,
          creation_time: "100",
        },
      },
      cache_nonce: nonce,
    },
    35000,
  );
  if (receipt.state !== "completed") throw new Error("FIXTURE");
  await expect(f.native.acknowledgeStorageCleanup(receipt)).rejects.toThrow(
    "PROTOCOL_MISMATCH",
  );
  const ack = fixture({ acknowledged: true });
  await ack.native.acquireMutex("cache");
  await ack.native.acknowledgeStorageCleanup(receipt);
  expect(ack.transport.request).toHaveBeenCalledWith(
    "storage_cleanup_ack",
    { receipt_id: receipt.receiptId, nonce: receipt.nonce, cache_nonce: nonce },
    35000,
  );
  const bad = fixture({ state: "completed", nonce: "d".repeat(64) });
  await bad.native.acquireMutex("cache");
  await expect(bad.native.discardStoragePartial(id)).rejects.toThrow(
    "PROTOCOL_MISMATCH",
  );
});
