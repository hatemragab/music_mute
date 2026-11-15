import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseStoreTransferRequest,
  parseStoreTransferReply,
  snapshotStoreTransferRequest,
  STORE_TRANSFER_DIAGNOSTICS,
  STORE_TRANSFER_REQUEST_MAX_BYTES,
} from "../src/runtime/store-transfer-contracts.js";

const requestId = "12345678-1234-4234-8234-123456789012";
const attemptId = "87654321-1234-4234-9234-123456789012";
const workspace = `C:\\Users\\Fixture\\AppData\\Local\\MusicMuteLocal\\cloud\\work\\${attemptId}`;
const sha256 = createHash("sha256").update("fixture").digest("base64");
const expiresAt = "2027-01-01T00:00:00.000Z";
function download() {
  return {
    version: 1,
    requestId,
    operation: "download",
    attemptId,
    workspace,
    path: win32.join(workspace, "input.mp3"),
    grant: {
      url: "https://fixture.r2.cloudflarestorage.com/input?signature=PRIVATE",
      expiresAt,
    },
    expected: {
      key: "fixture/input.mp3",
      etag: '"input-etag"',
      bytes: 7,
      sha256,
      contentType: "audio/mpeg",
    },
    options: {},
  };
}
function upload() {
  return {
    ...download(),
    operation: "upload",
    path: win32.join(workspace, "output", "vocals.mp3"),
    expected: { bytes: 7, sha256, contentType: "audio/mpeg" },
    grant: {
      url: "https://fixture.r2.cloudflarestorage.com/output?signature=PRIVATE",
      expiresAt,
      method: "PUT",
      headers: {
        "Content-Type": "audio/mpeg",
        "If-None-Match": "*",
        "x-amz-checksum-sha256": sha256,
        "x-amz-meta-sha256": sha256,
      },
    },
  };
}
const frame = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const parse = (value: unknown) =>
  parseStoreTransferRequest(frame(value), workspace);
// Synthetic receiving data only: these tests provide no actual Store, private
// namespace, Native child, transfer grant or Job retirement authority.
describe("Store transfer receiving contract", () => {
  it("copies and freezes complete download/upload data without treating it as ownership proof", () => {
    for (const request of [download(), upload()]) {
      const result = parse(request);
      expect(result).toEqual(request);
      expect(result).not.toBe(request);
      expect(result.grant).not.toBe(request.grant);
      for (const object of [
        result,
        result.grant,
        result.expected,
        result.options,
      ])
        expect(Object.isFrozen(object)).toBe(true);
      if (result.operation === "upload")
        expect(Object.isFrozen(result.grant.headers)).toBe(true);
      expect("retired" in result).toBe(false);
    }
  });
  it.each([
    ["audio/aac", "aac"],
    ["audio/flac", "flac"],
    ["audio/m4a", "m4a"],
    ["audio/mp4", "m4a"],
    ["audio/mpeg", "mp3"],
    ["audio/ogg", "ogg"],
    ["audio/wav", "wav"],
    ["audio/webm", "webm"],
    ["audio/x-m4a", "m4a"],
    ["audio/x-wav", "wav"],
    ["video/mp4", "mp4"],
    ["video/webm", "webm"],
    ["application/octet-stream", "bin"],
  ])("keeps existing workspace mapping for %s", (contentType, extension) => {
    const request = download();
    request.expected.contentType = contentType;
    request.path = win32.join(workspace, `input.${extension}`);
    expect(parse(request).path).toBe(request.path);
  });
  it("supports ordinary Unicode in the actual Windows workspace", () => {
    const root = workspace.replace("Fixture", "مستخدم🙂");
    const request = {
      ...download(),
      workspace: root,
      path: win32.join(root, "input.mp3"),
    };
    expect(parseStoreTransferRequest(frame(request), root).workspace).toBe(
      root,
    );
  });
  it.each([
    { version: 2 },
    { operation: "delete" },
    { requestId: attemptId.replace("87654321", "ABCDEF12") },
    { attemptId: requestId },
    { path: win32.join(workspace, "..", "input.mp3") },
    { path: win32.join(workspace, "input.wav") },
    { path: win32.join(workspace, "input.mp3:extra") },
    { path: win32.join(workspace, "output", "vocals.mp3") },
    { workspace: workspace + "\\" },
    { workspace: workspace.replace("Fixture", "NUL") },
    { workspace: workspace.replace("Fixture", "Fixture.") },
    { workspace: workspace.replace("C:", "\\\\server\\share") },
    { workspace: workspace.replaceAll("\\", "/") },
    { workspace: workspace.replace("\\work\\", "\\work\\..\\work\\") },
    { workspace: workspace.replace("C:", "\\\\?\\C:") },
    { extra: true },
    { options: { fetch: null } },
    { options: { allowInsecureLoopback: false } },
    { options: { timeoutMs: 99 } },
    { options: { timeoutMs: 7_200_001 } },
    { options: { uploadIdleTimeoutMs: 1.5 } },
  ])("denies invalid operation/workspace/options %#", (changed) => {
    expect(() => parse({ ...download(), ...changed })).toThrow(
      "STORE_TRANSFER_INVALID",
    );
  });
  it("binds to the exact expected native CWD, not a case-folded or other attempt path", () => {
    expect(() =>
      parseStoreTransferRequest(
        frame(download()),
        workspace.replace("Fixture", "fixture"),
      ),
    ).toThrow();
    expect(() =>
      parseStoreTransferRequest(
        frame(download()),
        workspace.replace(attemptId, requestId),
      ),
    ).toThrow();
  });
  it.each([
    { bytes: 0 },
    { bytes: 1_000_000_001 },
    { bytes: NaN },
    { bytes: 1.5 },
    { sha256: "a".repeat(44) },
    { sha256: "/".repeat(43) + "=" },
    { etag: "unquoted" },
    { etag: '"with space"' },
    { contentType: "audio/mpeg; charset=UTF-8" },
    { key: "key\nsecret" },
    { extra: true },
  ])("denies malformed download identity %#", (changed) => {
    const request = download();
    expect(() =>
      parse({ ...request, expected: { ...request.expected, ...changed } }),
    ).toThrow();
  });
  it.each([
    { url: "http://fixture.r2.cloudflarestorage.com/input" },
    { url: "https://user:secret@fixture.r2.cloudflarestorage.com/input" },
    { url: "https://fixture.r2.cloudflarestorage.com/input#secret" },
    { url: "https://fixture.r2.cloudflarestorage.com/\\input" },
    { url: " https://fixture.r2.cloudflarestorage.com/input" },
    { expiresAt: "tomorrow" },
    { expiresAt: "2027-01-01T00:00:00Z" },
    { extra: true },
  ])(
    "denies unsafe/ambiguous grants without exposing their contents %#",
    (changed) => {
      const request = download();
      expect(() =>
        parse({ ...request, grant: { ...request.grant, ...changed } }),
      ).toThrow("STORE_TRANSFER_INVALID");
    },
  );
  it("keeps expired canonical grants as data for the existing client's retry handling", () => {
    const request = download();
    request.grant.expiresAt = "2020-01-01T00:00:00.000Z";
    expect(parse(request).grant.expiresAt).toBe(request.grant.expiresAt);
  });
  it("accepts exactly four case-insensitive signed headers while preserving bytes", () => {
    const request = upload();
    const headers = Object.fromEntries(
      Object.entries(request.grant.headers).map(([key, value]) => [
        key.toUpperCase(),
        value,
      ]),
    );
    const parsed = parse({ ...request, grant: { ...request.grant, headers } });
    expect(parsed.operation).toBe("upload");
    if (parsed.operation === "upload")
      expect(parsed.grant.headers).toEqual(headers);
  });
  it.each([
    { "Content-Type": "audio/wav" },
    { "If-None-Match": "etag" },
    { "x-amz-checksum-sha256": "a".repeat(43) + "=" },
    { "x-amz-meta-sha256": "a".repeat(43) + "=" },
    { Authorization: "Bearer secret" },
    { "content-type": "audio/mpeg" },
  ])("denies changed or duplicate upload headers %#", (changed) => {
    const request = upload();
    expect(() =>
      parse({
        ...request,
        grant: {
          ...request.grant,
          headers: { ...request.grant.headers, ...changed },
        },
      }),
    ).toThrow();
  });
  it.each([
    { bytes: 30_000_001 },
    { contentType: "audio/wav" },
    { key: "extra" },
  ])("keeps upload limits and expected shape %#", (changed) => {
    const request = upload();
    expect(() =>
      parse({ ...request, expected: { ...request.expected, ...changed } }),
    ).toThrow();
  });
  it("rejects missing upload header/method and alternate output filenames", () => {
    const request = upload(),
      headers = { ...request.grant.headers };
    delete (headers as Record<string, string>)["If-None-Match"];
    for (const item of [
      { ...request, grant: { ...request.grant, headers } },
      { ...request, grant: { ...request.grant, method: "POST" } },
      { ...request, path: win32.join(workspace, "output", "other.mp3") },
    ])
      expect(() => parse(item)).toThrow();
  });
  it("rejects duplicate decoded fields including escaped duplicates and nested duplicates", () => {
    const original = frame(download()).toString();
    for (const changed of [
      original.replace('"version":1', '"version":1,"version":1'),
      original.replace('"version":1', '"version":1,"ver\\u0073ion":1'),
      original.replace('"bytes":7', '"bytes":7,"bytes":7'),
    ])
      expect(() =>
        parseStoreTransferRequest(Buffer.from(changed), workspace),
      ).toThrow();
  });
  it("rejects BOM, malformed UTF8, CRLF, missing LF, extra lines, and scalars", () => {
    const original = frame(download());
    for (const bytes of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]),
      Buffer.from([0xff, 10]),
      original.subarray(0, -1),
      Buffer.from(original.toString().replace(/\n$/u, "\r\n")),
      Buffer.concat([original, original]),
      Buffer.from("null\n"),
      Buffer.from("[]\n"),
    ])
      expect(() => parseStoreTransferRequest(bytes, workspace)).toThrow(
        "STORE_TRANSFER_INVALID",
      );
  });
  it("uses actual view bounds and byte budget rather than the pooled buffer or byte hooks", () => {
    const original = frame(download()),
      padded = Buffer.concat([
        Buffer.from("bad"),
        original,
        Buffer.from("bad"),
      ]);
    expect(
      parseStoreTransferRequest(
        padded.subarray(3, 3 + original.length),
        workspace,
      ).requestId,
    ).toBe(requestId);
    const fitting = Buffer.concat([
      Buffer.from(
        " ".repeat(STORE_TRANSFER_REQUEST_MAX_BYTES - original.length),
      ),
      original,
    ]);
    expect(parseStoreTransferRequest(fitting, workspace).requestId).toBe(
      requestId,
    );
    expect(() =>
      parseStoreTransferRequest(
        Buffer.concat([Buffer.from(" "), fitting]),
        workspace,
      ),
    ).toThrow();
    const getter = vi.fn(() => original.length);
    Object.defineProperty(original, "byteLength", { get: getter });
    expect(() => parseStoreTransferRequest(original, workspace)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("denies structural bytes, proxies, subclasses, SharedArrayBuffer and custom metadata", () => {
    class ForeignBytes extends Uint8Array {}
    const original = frame(download()),
      shared = new Uint8Array(new SharedArrayBuffer(original.length));
    shared.set(original);
    for (const bytes of [
      { byteLength: original.length },
      new Proxy(original, {}),
      new ForeignBytes(original),
      shared,
    ])
      expect(() =>
        parseStoreTransferRequest(bytes as Uint8Array, workspace),
      ).toThrow();
  });
  it("snapshots object boundaries without invoking getters, coercion or proxy traps", () => {
    const getter = vi.fn(),
      trap = vi.fn();
    const request = download();
    for (const target of [
      request,
      request.expected,
      request.grant,
      request.options,
    ]) {
      const clone = { ...target };
      Object.defineProperty(clone, Object.keys(target)[0] ?? "timeoutMs", {
        enumerable: true,
        get: getter,
      });
      const field =
        target === request
          ? null
          : target === request.expected
            ? "expected"
            : target === request.grant
              ? "grant"
              : "options";
      expect(() =>
        snapshotStoreTransferRequest(
          field ? { ...request, [field]: clone } : clone,
          workspace,
        ),
      ).toThrow();
    }
    expect(() =>
      snapshotStoreTransferRequest(
        new Proxy(request, { ownKeys: trap }),
        workspace,
      ),
    ).toThrow();
    expect(() =>
      snapshotStoreTransferRequest(
        {
          ...request,
          expected: { ...request.expected, bytes: { valueOf: getter } },
        },
        workspace,
      ),
    ).toThrow();
    expect(() =>
      snapshotStoreTransferRequest(
        Object.assign(Object.create({}), request),
        workspace,
      ),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
  });
});
describe("Store transfer reply", () => {
  it("binds success to the original operation and request, preserving quoted ETag", () => {
    for (const [operation, result] of [
      ["download", null],
      ["upload", '"opaque-etag"'],
    ] as const) {
      const parsed = parseStoreTransferReply(
        frame({ version: 1, requestId, ok: true, result }),
        requestId,
        operation,
      );
      expect(parsed).toEqual({ version: 1, requestId, ok: true, result });
      expect(Object.isFrozen(parsed)).toBe(true);
    }
  });
  it.each(STORE_TRANSFER_DIAGNOSTICS)(
    "receives only closed safe diagnostic %s",
    (diagnostic) => {
      expect(
        parseStoreTransferReply(
          frame({
            version: 1,
            requestId,
            ok: false,
            retryable: false,
            diagnostic,
          }),
          requestId,
          "download",
        ),
      ).toEqual({
        version: 1,
        requestId,
        ok: false,
        retryable: false,
        diagnostic,
      });
    },
  );
  it.each([
    { requestId: attemptId },
    { version: 2 },
    { ok: "true" },
    { result: "etag" },
    { result: null, retired: true },
    { result: null, job: "confirmed" },
    { result: null, diagnostic: "extra" },
  ])("denies foreign/malformed success %#", (changed) =>
    expect(() =>
      parseStoreTransferReply(
        frame({
          version: 1,
          requestId,
          ok: true,
          result: '"etag"',
          ...changed,
        }),
        requestId,
        "upload",
      ),
    ).toThrow(),
  );
  it("does not accept download ETags or upload null as success", () => {
    expect(() =>
      parseStoreTransferReply(
        frame({ version: 1, requestId, ok: true, result: '"etag"' }),
        requestId,
        "download",
      ),
    ).toThrow();
    expect(() =>
      parseStoreTransferReply(
        frame({ version: 1, requestId, ok: true, result: null }),
        requestId,
        "upload",
      ),
    ).toThrow();
  });
  it.each([
    { retryable: "true" },
    { diagnostic: "https://secret" },
    { diagnostic: "transfer-http-500" },
    { result: null },
    { code: "DOWNLOAD_FAILED" },
  ])("denies open error payload %#", (changed) =>
    expect(() =>
      parseStoreTransferReply(
        frame({
          version: 1,
          requestId,
          ok: false,
          retryable: true,
          diagnostic: "transfer-process-failed",
          ...changed,
        }),
        requestId,
        "download",
      ),
    ).toThrow(),
  );
  it("bounds replies and refuses duplicate keys", () => {
    const original = frame({ version: 1, requestId, ok: true, result: null });
    expect(() =>
      parseStoreTransferReply(
        Buffer.concat([Buffer.from(" ".repeat(2048)), original]),
        requestId,
        "download",
      ),
    ).toThrow();
    expect(() =>
      parseStoreTransferReply(
        Buffer.from(
          original.toString().replace('"ok":true', '"ok":true,"ok":true'),
        ),
        requestId,
        "download",
      ),
    ).toThrow();
  });
});
