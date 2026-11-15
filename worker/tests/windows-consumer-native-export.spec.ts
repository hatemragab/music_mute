import { describe, expect, it, vi } from "vitest";
import {
  WindowsConsumerNative,
  type ConsumerNativeTransport,
  type ConsumerNativeOperation,
  type ConsumerCreatedExportDiscard,
  createdExportDiscardToWire,
} from "../src/platform/windows/consumer-native.js";
const sid = "S-1-5-21-1-2-3-1001",
  requestId = "11111111-1111-4111-8111-111111111111",
  nonce = "a".repeat(64);
const pin = {
  sha256: "b".repeat(64),
  bytes: 42,
  publisherSha256: "c".repeat(64),
};
const request: ConsumerCreatedExportDiscard = {
  requestId,
  path: "C:\\Users\\Fixture\\Downloads\\voice.mp3",
  creator: { sid, sessionId: 1, pid: 20, creationTime: "200" },
  birth: { device: "1", fileId: "2", bornAt: "1700000000000000000" },
  bytes: 8,
  writtenAt: "1700000000000000000",
  changedAt: "1700000000000000000",
};
function fixture(
  reply: (
    op: ConsumerNativeOperation,
    args: Record<string, unknown>,
  ) => unknown,
) {
  const transport: ConsumerNativeTransport = {
    close: vi.fn(async () => {}),
    request: vi.fn(async (op, args) =>
      op === "identity"
        ? {
            sid,
            session_id: 1,
            pid: 10,
            creation_time: "100",
            logon_sid: "S-1-5-5-1-2",
            native_arch: "x64",
            process_arch: "x64",
            os_major: 10,
            os_build: 19045,
            local_app_data: "C:\\Users\\Fixture\\AppData\\Local",
          }
        : reply(op, args),
    ),
  };
  return { transport, native: new WindowsConsumerNative(transport) };
}
describe("Created export native transport, injected boundary only", () => {
  it("requires signed Main local-location preflight before creation and retains mapped-drive/reparse rejection", async () => {
    const { native, transport } = fixture(() => ({ validated: true }));
    await native.validateExportDestination("D:\\report.zip", pin);
    expect(transport.request).toHaveBeenCalledWith(
      "created_export_destination_validate",
      {
        path: "D:\\report.zip",
        app_sha256: pin.sha256,
        app_bytes: pin.bytes,
        publisher_sha256: pin.publisherSha256,
      },
      35000,
    );
    for (const path of ["Z:\\mapped\\report.zip", "C:\\junction\\report.zip"])
      await expect(
        fixture(() =>
          Promise.reject(new Error("PATH_UNSAFE")),
        ).native.validateExportDestination(path, pin),
      ).rejects.toThrow("PATH_UNSAFE");
    const denied = fixture(() => {
      throw new Error("UNEXPECTED_RPC");
    });
    await expect(
      denied.native.validateExportDestination(
        "\\\\server\\share\\report.zip",
        pin,
      ),
    ).rejects.toThrow("PATH_UNSAFE");
    expect(denied.transport.request).not.toHaveBeenCalled();
    await expect(
      fixture(() => ({
        validated: true,
        path: "private",
      })).native.validateExportDestination(request.path, pin),
    ).rejects.toThrow("PROTOCOL_MISMATCH");
  });
  it("Chrome Setup sends only its fixed action and approved Main app pin", async () => {
    const { native, transport } = fixture((op) =>
      op === "chrome_extensions_open" ? { started: true } : { state: "absent" },
    );
    await native.openChromeExtensions(pin);
    expect(transport.request).toHaveBeenCalledWith(
      "chrome_extensions_open",
      {
        app_sha256: pin.sha256,
        app_bytes: pin.bytes,
        publisher_sha256: pin.publisherSha256,
      },
      35000,
    );
    expect(vi.mocked(transport.request).mock.calls[0]![1]).not.toHaveProperty(
      "url",
    );
    await expect(
      fixture(() => ({
        started: true,
        url: "private-unapproved",
      })).native.openChromeExtensions(pin),
    ).rejects.toThrow("PROTOCOL_MISMATCH");
  });
  it("sends stable full closed-FD identity and signed Main pin; ACK never repeats deletion", async () => {
    const { native, transport } = fixture((op) =>
      op === "created_export_discard_ack"
        ? { acknowledged: true }
        : { state: "completed", request_id: requestId, nonce },
    );
    const result = await native.discardCreatedExport(request, pin);
    expect(result).toEqual({ state: "completed", requestId, nonce });
    expect(transport.request).toHaveBeenCalledWith(
      "created_export_discard",
      {
        request_id: requestId,
        path: request.path,
        creator: { sid, session_id: 1, pid: 20, creation_time: "200" },
        expected: {
          device: "1",
          file_id: "2",
          born_at: request.birth.bornAt,
          bytes: 8,
          written_at: request.writtenAt,
          changed_at: request.changedAt,
        },
        app_sha256: pin.sha256,
        app_bytes: pin.bytes,
        publisher_sha256: pin.publisherSha256,
      },
      35000,
    );
    await native.acknowledgeCreatedExportDiscard(requestId, nonce, pin);
    await native.acknowledgeCreatedExportDiscard(requestId, nonce, pin);
    expect(
      vi
        .mocked(transport.request)
        .mock.calls.filter(([op]) => op === "created_export_discard"),
    ).toHaveLength(1);
  });
  it("does not translate absent inspector/pending deletion into completion", async () => {
    const { native } = fixture((op) => ({
      state: op === "created_export_discard_inspect" ? "absent" : "pending",
    }));
    expect(await native.inspectCreatedExportDiscard(requestId, pin)).toEqual({
      state: "absent",
    });
    expect(await native.discardCreatedExport(request, pin)).toEqual({
      state: "pending",
    });
  });
  it("preserves lost ACK and rejects rebound/malformed completion", async () => {
    const { native } = fixture((op) =>
      op === "created_export_discard_ack"
        ? Promise.reject(new Error("HELPER_UNAVAILABLE"))
        : { state: "completed", request_id: requestId, nonce },
    );
    expect((await native.discardCreatedExport(request, pin)).state).toBe(
      "completed",
    );
    await expect(
      native.acknowledgeCreatedExportDiscard(requestId, nonce, pin),
    ).rejects.toThrow("HELPER_UNAVAILABLE");
    await expect(
      fixture(() => ({
        state: "completed",
        request_id: "22222222-2222-4222-8222-222222222222",
        nonce,
      })).native.discardCreatedExport(request, pin),
    ).rejects.toThrow("PROTOCOL_MISMATCH");
  });
  it("rejects foreign creator/session/helper and unsafe path before effect RPC", async () => {
    const { native, transport } = fixture(() => {
      throw new Error("unexpected-effect");
    });
    for (const creator of [
      { ...request.creator, sid: "S-1-5-21-1-2-3-1002" },
      { ...request.creator, sessionId: 2 },
      { ...request.creator, pid: 10 },
    ])
      await expect(
        native.discardCreatedExport({ ...request, creator }, pin),
      ).rejects.toThrow("PEER_DENIED");
    for (const path of [
      "\\\\server\\share\\file.mp3",
      "C:\\Users\\Fixture\\Downloads\\..\\file.mp3",
      "C:\\Users\\Fixture\\Downloads\\file.mp3:stream",
    ])
      expect(() => createdExportDiscardToWire({ ...request, path })).toThrow();
    expect(
      vi
        .mocked(transport.request)
        .mock.calls.filter(([op]) => op !== "identity"),
    ).toHaveLength(0);
  });
});
