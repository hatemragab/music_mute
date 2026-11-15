import { expect, it, vi } from "vitest";
import {
  parseStoreShareInput,
  parseStoreShareResult,
  StoreShareNative,
} from "../src/main/share/store-share-native.js";
import { consumerShareArgs } from "../../worker/src/platform/windows/consumer-native-share.js";
import type { StoreBootReceipt } from "../src/shared/store-boot-receipt.js";
const id = "12345678-1234-4234-8234-123456789012",
  sid = "S-1-5-21-1-2-3-1001";
const gui = { sid, sessionId: 1, pid: 100, creationTime: "10" },
  helper = { ...gui, pid: 101, creationTime: "20" };
const source = {
  requestId: id,
  windowHandle: "500",
  windowOwner: gui,
  relativePath: `share\\requests\\${id}\\media.mp3`,
  sha256: "a".repeat(64),
  bytes: 100,
  title: "Synthetic audio",
  mime: "audio/mpeg",
};
const input = consumerShareArgs(source),
  receipt = { parent: gui, helper } as StoreBootReceipt;
const peer = (value: typeof gui) => ({
  sid: value.sid,
  session_id: value.sessionId,
  pid: value.pid,
  creation_time: value.creationTime,
});
function wire() {
  return {
    version: 1,
    request_id: id,
    nonce: "b".repeat(64),
    helper: peer(helper),
    window_owner: peer(gui),
    relative_path: source.relativePath,
    sha256: source.sha256,
    bytes: 100,
    file_identity: { volume_serial: 1, file_index: "3", creation_time: "4" },
    state: "pending",
    shown: false,
    quiesced: false,
    callback: null,
  };
}
it("keeps Store Share source and OS receipt data separate from legacy signing pins", () => {
  expect(parseStoreShareInput("store_share_start", input)).toEqual(input);
  expect(
    parseStoreShareResult("store_share_start", wire(), input, receipt),
  ).toMatchObject({
    requestId: id,
    helper,
    windowOwner: gui,
    state: "pending",
  });
  for (const field of [
    "app_sha256",
    "publisher_sha256",
    "app_bytes",
    "file_identity",
    "allow_unsigned",
    "authority",
  ])
    expect(() =>
      parseStoreShareInput("store_share_start", {
        ...input,
        [field]: "caller",
      }),
    ).toThrow();
});
it("rejects a foreign helper/window birth, wrong scratch bytes and mismatched cancel nonce", () => {
  for (const change of [
    { helper: peer({ ...helper, creationTime: "21" }) },
    { window_owner: peer({ ...gui, pid: 102 }) },
    { sha256: "c".repeat(64) },
    { bytes: 101 },
    { relative_path: source.relativePath.replace("mp3", "wav") },
  ])
    expect(() =>
      parseStoreShareResult(
        "store_share_start",
        { ...wire(), ...change },
        input,
        receipt,
      ),
    ).toThrow();
  expect(() =>
    parseStoreShareResult(
      "store_share_cancel",
      wire(),
      { request_id: id, nonce: "c".repeat(64) },
      receipt,
    ),
  ).toThrow();
});
it("permits original same-user receipt recovery without inventing a live old helper", () => {
  const old = wire();
  old.helper = peer({ ...helper, pid: 900 });
  old.window_owner = peer({ ...gui, pid: 901 });
  expect(
    parseStoreShareResult(
      "store_share_inspect",
      old,
      { request_id: id },
      receipt,
    ),
  ).toMatchObject({ helper: { pid: 900 }, windowOwner: { pid: 901 } });
  expect(
    parseStoreShareResult(
      "store_share_inspect",
      null,
      { request_id: id },
      receipt,
    ),
  ).toBeNull();
  old.window_owner = { ...old.window_owner, sid: "S-1-5-21-1-2-3-1002" };
  expect(() =>
    parseStoreShareResult(
      "store_share_inspect",
      old,
      { request_id: id },
      receipt,
    ),
  ).toThrow();
});
it("validates exact bounded cleanup replies without treating cancel as OS completion", () => {
  expect(
    parseStoreShareResult(
      "store_share_cleanup_acknowledge",
      { removed: false },
      { request_id: id, nonce: "b".repeat(64) },
      receipt,
    ),
  ).toBe(false);
  expect(
    parseStoreShareResult(
      "store_share_cleanup_completed",
      { removed: 16, retained: 64 },
      {},
      receipt,
    ),
  ).toEqual({ removed: 16, retained: 64 });
  for (const value of [
    { removed: 17, retained: 0 },
    { removed: 0, retained: 65 },
    { removed: true, retained: 0 },
    { removed: 0, retained: 0, quiesced: true },
  ])
    expect(() =>
      parseStoreShareResult(
        "store_share_cleanup_completed",
        value,
        {},
        receipt,
      ),
    ).toThrow();
  expect(
    parseStoreShareResult(
      "store_share_cancel",
      wire(),
      { request_id: id, nonce: "b".repeat(64) },
      receipt,
    ),
  ).toMatchObject({ state: "pending", quiesced: false, callback: null });
});
it("rejects caller paths, arbitrary operations, getters and forged executable authorities", async () => {
  expect(() =>
    parseStoreShareInput("store_share_inspect", {
      request_id: id,
      path: "C:\\caller",
    }),
  ).toThrow();
  expect(() =>
    Reflect.apply(parseStoreShareInput, undefined, ["execute", {}]),
  ).toThrow();
  const getter = vi.fn(() => "500"),
    row = { ...input };
  Object.defineProperty(row, "window_handle", {
    enumerable: true,
    get: getter,
  });
  expect(() => parseStoreShareInput("store_share_start", row)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    Reflect.construct(StoreShareNative, [Symbol("fake"), receipt]),
  ).toThrow("STORE_SHARE_DENIED");
  await expect(
    StoreShareNative.open({
      storeAuthority: { creatorProof: () => receipt },
      native: {},
    } as never),
  ).rejects.toThrow();
});
