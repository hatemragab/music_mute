import { describe, expect, it, vi } from "vitest";
import {
  WindowsConsumerNative,
  consumerShareArgs,
  parseConsumerShareReceipt,
  parseConsumerNativeEvent,
  shareReceiptAllowsCleanup,
  type ConsumerNativeTransport,
  type ConsumerShareSource,
} from "../src/platform/windows/consumer-native.js";
const sid = "S-1-5-21-1-2-3-1001",
  requestId = "fdcf10d8-20a1-4d3e-a3db-4eb86414955e",
  owner = { sid, sessionId: 1, pid: 42, creationTime: "133400000000000001" },
  wire = { sid, session_id: 1, pid: 42, creation_time: owner.creationTime };
const source: ConsumerShareSource = {
  requestId,
  windowHandle: "1234",
  windowOwner: owner,
  relativePath: `share\\requests\\${requestId}\\media.mp3`,
  sha256: "a".repeat(64),
  bytes: 123,
  title: "Selected voice",
  mime: "audio/mpeg",
};
const receipt = {
  version: 1,
  request_id: requestId,
  nonce: "c".repeat(64),
  helper: { ...wire, pid: 43 },
  window_owner: wire,
  relative_path: source.relativePath,
  sha256: source.sha256,
  bytes: source.bytes,
  file_identity: {
    volume_serial: 1,
    file_index: "123",
    creation_time: "133400000000000002",
  },
  state: "pending",
  shown: true,
  quiesced: false,
  callback: null,
};
describe("consumer Share SDK (native boundary injected)", () => {
  it("supports lost cleanup ACK recovery with only fixed bounded native metadata operations", async () => {
    const request = vi.fn(async (operation: string) =>
      operation === "share_cleanup_acknowledge"
        ? { removed: false }
        : { removed: 16, retained: 3 },
    );
    const native = new WindowsConsumerNative({
      request,
      close: async () => {},
    } satisfies ConsumerNativeTransport);
    expect(
      await native.acknowledgeShareCleanup({
        requestId,
        nonce: "c".repeat(64),
      }),
    ).toBe(false);
    expect(request).toHaveBeenCalledWith(
      "share_cleanup_acknowledge",
      { request_id: requestId, nonce: "c".repeat(64) },
      35000,
    );
    expect(await native.pruneCompletedShareReceipts()).toEqual({
      removed: 16,
      retained: 3,
    });
    request.mockImplementation(async () => ({ removed: 17, retained: 0 }));
    await expect(native.pruneCompletedShareReceipts()).rejects.toThrow(
      "PROTOCOL_MISMATCH",
    );
    request.mockImplementation(async () => ({
      removed: true,
      path: "arbitrary",
    }));
    await expect(
      native.acknowledgeShareCleanup({ requestId, nonce: "c".repeat(64) }),
    ).rejects.toThrow("PROTOCOL_MISMATCH");
  });
  it("allows only fixed staged audio with actual HWND identity and bounded source", () => {
    expect(consumerShareArgs(source)).toMatchObject({
      window_handle: "1234",
      window_owner: wire,
      relative_path: source.relativePath,
    });
    for (const bad of [
      { relativePath: "C:\\arbitrary.mp3" },
      { relativePath: `share\\requests\\${requestId}\\..\\media.mp3` },
      { mime: "text/html" },
      { windowHandle: "18446744073709551616" },
      { bytes: 256 * 1024 ** 2 + 1 },
      { title: "a".repeat(181) },
      { title: "voice\nsecret" },
    ])
      expect(() => consumerShareArgs({ ...source, ...bad })).toThrow();
  });
  it("never treats shown/target chosen/timeout/pending/helper death as terminal proof", () => {
    expect(shareReceiptAllowsCleanup(parseConsumerShareReceipt(receipt))).toBe(
      false,
    );
    expect(
      shareReceiptAllowsCleanup(
        parseConsumerShareReceipt({ ...receipt, state: "unconfirmed" }),
      ),
    ).toBe(false);
    expect(() =>
      parseConsumerShareReceipt({ ...receipt, quiesced: true }),
    ).toThrow();
    expect(() =>
      parseConsumerShareReceipt({
        ...receipt,
        state: "completed",
        callback: "ShareCanceled",
        quiesced: true,
      }),
    ).toThrow();
    expect(() =>
      parseConsumerShareReceipt({
        ...receipt,
        state: "completed",
        callback: "ShareCompleted",
        quiesced: true,
        target_chosen: true,
      }),
    ).toThrow();
  });
  it.each([
    ["completed", "ShareCompleted"],
    ["cancelled", "ShareCanceled"],
  ])("requires exact %s callback plus quiescence", (state, callback) => {
    const partial = parseConsumerShareReceipt({ ...receipt, state, callback });
    expect(shareReceiptAllowsCleanup(partial)).toBe(false);
    const complete = parseConsumerShareReceipt({
      ...receipt,
      state,
      callback,
      quiesced: true,
    });
    expect(shareReceiptAllowsCleanup(complete)).toBe(true);
    expect(
      parseConsumerNativeEvent({
        kind: "share",
        sequence: 1,
        receipt: { ...receipt, state, callback, quiesced: true },
      }),
    ).toMatchObject({ kind: "share", receipt: complete });
  });
  it("checks receipt source/owner binding and permits restart lookup without requiring prior helper alive", async () => {
    let response: unknown = receipt;
    const request = vi.fn(async (operation: string) =>
      operation === "identity"
        ? {
            ...wire,
            pid: 43,
            logon_sid: "S-1-5-5-1-2",
            native_arch: "x64",
            process_arch: "x64",
            os_major: 10,
            os_build: 19045,
            local_app_data: "C:\\Users\\Fixture\\AppData\\Local",
          }
        : response,
    );
    const native = new WindowsConsumerNative({
        request,
        close: async () => {},
      } satisfies ConsumerNativeTransport),
      pin = {
        sha256: "d".repeat(64),
        bytes: 123,
        publisherSha256: "e".repeat(64),
      };
    expect(await native.startShare(source, pin)).toMatchObject({
      requestId,
      state: "pending",
    });
    expect(request).toHaveBeenCalledWith(
      "share_start",
      expect.objectContaining({
        app_sha256: pin.sha256,
        request_id: requestId,
      }),
      35000,
    );
    response = { ...receipt, sha256: "b".repeat(64) };
    await expect(native.startShare(source, pin)).rejects.toThrow("PEER_DENIED");
    response = {
      ...receipt,
      window_owner: { ...wire, session_id: 2 },
      helper: { ...wire, pid: 99, session_id: 2 },
      state: "cancelled",
      callback: "ShareCanceled",
      quiesced: true,
    };
    expect(await native.inspectShare(requestId)).toMatchObject({
      windowOwner: { sessionId: 2 },
      state: "cancelled",
      quiesced: true,
    });
    response = null;
    expect(await native.inspectShare(requestId)).toBeNull();
    expect(request).not.toHaveBeenCalledWith(
      "process_identity",
      expect.anything(),
    );
  });
});
