import { expect, it, vi } from "vitest";
import { WindowsCreatedExportDiscards } from "../src/main/created-export-discard.js";
import {
  WindowsConsumerNative,
  type ConsumerNativeTransport,
  type ConsumerNativeOperation,
} from "../../worker/src/platform/windows/consumer-native.js";
const sid = "S-1-5-21-1-2-3-1001",
  requestId = "11111111-1111-4111-8111-111111111111",
  nonce = "a".repeat(64);
const pin = {
  sha256: "b".repeat(64),
  bytes: 42,
  publisherSha256: "c".repeat(64),
};
const request = Object.freeze({
  requestId,
  path: "C:\\Users\\Fixture\\Downloads\\voice.mp3",
  birth: Object.freeze({
    device: "1",
    fileId: "2",
    bornAt: "1700000000000000000",
  }),
  bytes: 8,
  writtenAt: "1700000000000000000",
  changedAt: "1700000000000000000",
});
function fixture(
  options: {
    response?(
      op: ConsumerNativeOperation,
      args: Record<string, unknown>,
    ): unknown | Promise<unknown>;
    close?(): Promise<void>;
  } = {},
) {
  const requests: {
    op: ConsumerNativeOperation;
    args: Record<string, unknown>;
  }[] = [];
  const transports: ConsumerNativeTransport[] = [];
  const appPin = vi.fn(async () => pin);
  const openNative = vi.fn(async () => {
    const transport: ConsumerNativeTransport = {
      close: vi.fn(options.close ?? (async () => {})),
      request: vi.fn(async (op, args) => {
        requests.push({ op, args });
        if (op === "identity")
          return {
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
          };
        if (options.response) return options.response(op, args);
        if (op === "created_export_destination_validate")
          return { validated: true };
        if (op === "process_identity")
          return { sid, session_id: 1, pid: 20, creation_time: "200" };
        if (op === "created_export_discard")
          return { state: "completed", request_id: requestId, nonce };
        if (op === "created_export_discard_ack") return { acknowledged: true };
        throw new Error("UNEXPECTED_NATIVE_OPERATION");
      }),
    };
    transports.push(transport);
    return new WindowsConsumerNative(transport);
  });
  return {
    cleanup: new WindowsCreatedExportDiscards({
      openNative,
      appPin,
      creatorPid: 20,
    }),
    requests,
    transports,
    openNative,
    appPin,
  };
}
it("binds the real SDK discard to its actual Main creator and sealed pin; ACK retries retain only the positive certificate", async () => {
  let ackLost = true;
  const f = fixture({
    response: (op) => {
      if (op === "process_identity")
        return { sid, session_id: 1, pid: 20, creation_time: "200" };
      if (op === "created_export_discard")
        return { state: "completed", request_id: requestId, nonce };
      if (op === "created_export_discard_ack") {
        if (ackLost) {
          ackLost = false;
          throw new Error("LOST_ACK");
        }
        return { acknowledged: true };
      }
      throw new Error("UNEXPECTED_NATIVE_OPERATION");
    },
  });
  const result = await f.cleanup.discard(request);
  expect(result.state).toBe("completed");
  if (result.state !== "completed") throw new Error("EXPECTED_CERTIFICATE");
  await expect(result.acknowledge()).rejects.toThrow("LOST_ACK");
  await result.acknowledge();
  expect(f.requests.filter((x) => x.op === "created_export_discard")).toEqual([
    {
      op: "created_export_discard",
      args: {
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
    },
  ]);
  const acknowledgments = f.requests.filter(
    (x) => x.op === "created_export_discard_ack",
  );
  expect(acknowledgments).toHaveLength(2);
  expect(acknowledgments[1]).toEqual(acknowledgments[0]);
  expect(f.appPin).toHaveBeenCalledOnce();
  expect(f.openNative).toHaveBeenCalledTimes(3);
  for (const t of f.transports) expect(t.close).toHaveBeenCalledOnce();
  expect(f.cleanup.activity().idle).toBe(true);
  await f.cleanup.close();
});
it("keeps actual helper exit inside the cleanup barrier and serializes later deletion admission", async () => {
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = fixture({ close: () => held });
  let completed = false;
  const first = f.cleanup.discard(request).then((result) => {
    completed = true;
    return result;
  });
  await vi.waitFor(() => expect(f.transports[0]?.close).toHaveBeenCalled());
  const second = f.cleanup.discard(request);
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(f.cleanup.activity()).toMatchObject({
    pending: 2,
    retained: 1,
    idle: false,
  });
  expect(f.openNative).toHaveBeenCalledOnce();
  finish();
  const a = await first,
    b = await second;
  expect(a.state).toBe("completed");
  expect(b.state).toBe("completed");
  await f.cleanup.close();
});
it("retains failed helper retirement and refuses reopening until the exact helper exits", async () => {
  let allowed = false;
  const f = fixture({
    close: async () => {
      if (!allowed) throw new Error("EXIT_UNKNOWN");
    },
  });
  await expect(f.cleanup.discard(request)).rejects.toThrow("EXIT_UNKNOWN");
  expect(f.cleanup.activity()).toMatchObject({
    pending: 0,
    retained: 1,
    idle: false,
  });
  await expect(f.cleanup.discard(request)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
  expect(f.openNative).toHaveBeenCalledOnce();
  allowed = true;
  expect((await f.cleanup.discard(request)).state).toBe("completed");
  expect(f.openNative).toHaveBeenCalledTimes(2);
  expect(
    f.requests
      .filter((x) => x.op === "created_export_discard")
      .map((x) => x.args.request_id),
  ).toEqual([requestId, requestId]);
  expect(f.cleanup.activity().idle).toBe(true);
  await f.cleanup.close();
});
it("refuses a missing actual creator before any deletion request and still awaits helper retirement", async () => {
  const f = fixture({
    response: (op) => {
      if (op === "process_identity") return null;
      throw new Error("UNEXPECTED_NATIVE_OPERATION");
    },
  });
  await expect(f.cleanup.discard(request)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
  expect(f.requests.map((x) => x.op)).toEqual(["process_identity"]);
  expect(f.transports[0]?.close).toHaveBeenCalledOnce();
  await f.cleanup.close();
});
it("returns genuine pending without manufacturing a completion or ACK from an absent path", async () => {
  const f = fixture({
    response: (op) => {
      if (op === "process_identity")
        return { sid, session_id: 1, pid: 20, creation_time: "200" };
      if (op === "created_export_discard") return { state: "pending" };
      throw new Error("UNEXPECTED_NATIVE_OPERATION");
    },
  });
  expect(await f.cleanup.discard(request)).toEqual({ state: "pending" });
  expect(
    f.requests.some(
      (x) =>
        x.op === "created_export_discard_ack" ||
        x.op === "created_export_discard_inspect",
    ),
  ).toBe(false);
  await f.cleanup.close();
});
it("does not launch an unapproved helper when the sealed app pin cannot be loaded", async () => {
  const f = fixture();
  f.appPin.mockRejectedValue(new Error("PIN_UNAVAILABLE"));
  await expect(f.cleanup.discard(request)).rejects.toThrow("PIN_UNAVAILABLE");
  expect(f.openNative).not.toHaveBeenCalled();
  await f.cleanup.close();
  await expect(f.cleanup.discard(request)).rejects.toThrow(
    "EXPORT_UNAVAILABLE",
  );
});
it("preflights a fixed user destination through the real SDK and awaits actual helper exit before allowing creation", async () => {
  let release!: () => void;
  const exit = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({ close: () => exit });
  let validated = false;
  const checking = f.cleanup.validateDestination(request.path).then(() => {
    validated = true;
  });
  await vi.waitFor(() => expect(f.transports[0]?.close).toHaveBeenCalled());
  expect(validated).toBe(false);
  expect(f.requests).toEqual([
    {
      op: "created_export_destination_validate",
      args: {
        path: request.path,
        app_sha256: pin.sha256,
        app_bytes: pin.bytes,
        publisher_sha256: pin.publisherSha256,
      },
    },
  ]);
  release();
  await checking;
  await f.cleanup.close();
});
