/** Private transfer data only; these records confer no Creator or Job authority. */
import { win32 } from "node:path";
import { types } from "node:util";
import { parseStrictJson } from "../platform/windows/consumer-strict-json.js";
import type {
  ObjectIdentity,
  TransferGrant,
  UploadGrant,
} from "./contracts.js";
import { attemptInputExtension } from "./workspace.js";

export const STORE_TRANSFER_REQUEST_MAX_BYTES = 65_536;
export const STORE_TRANSFER_REPLY_MAX_BYTES = 2_048;
export const STORE_TRANSFER_DIAGNOSTICS = [
  "transfer-grant-expired",
  "transfer-http-failed",
  "transfer-integrity-failed",
  "transfer-idle-timeout",
  "transfer-total-timeout",
  "transfer-transport-failed",
  "transfer-file-close-failed",
  "transfer-process-failed",
] as const;
export type StoreTransferDiagnostic =
  (typeof STORE_TRANSFER_DIAGNOSTICS)[number];
export type StoreTransferOperation = "download" | "upload";
export interface StoreTransferOptions {
  readonly timeoutMs?: number;
  readonly downloadIdleTimeoutMs?: number;
  readonly uploadIdleTimeoutMs?: number;
}
interface RequestBase {
  readonly version: 1;
  readonly requestId: string;
  readonly attemptId: string;
  readonly workspace: string;
  readonly path: string;
  readonly options: StoreTransferOptions;
}
export type StoreTransferRequest =
  | (RequestBase & {
      readonly operation: "download";
      readonly grant: Readonly<TransferGrant>;
      readonly expected: Readonly<ObjectIdentity>;
    })
  | (RequestBase & {
      readonly operation: "upload";
      readonly grant: Readonly<Omit<UploadGrant, "headers">> & {
        readonly headers: Readonly<Record<string, string>>;
      };
      readonly expected: Readonly<{
        bytes: number;
        sha256: string;
        contentType: "audio/mpeg";
      }>;
    });
export type StoreTransferReply =
  | Readonly<{ version: 1; requestId: string; ok: true; result: null | string }>
  | Readonly<{
      version: 1;
      requestId: string;
      ok: false;
      retryable: boolean;
      diagnostic: StoreTransferDiagnostic;
    }>;

const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ETAG = /^"[\x21\x23-\x7e]{1,1022}"$/u;
function fail(): never {
  throw new TypeError("STORE_TRANSFER_INVALID");
}
function record(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] | null = [],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    types.isProxy(input) ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    fail();
  const keys = Reflect.ownKeys(input),
    descriptors = Object.getOwnPropertyDescriptors(input),
    result: Record<string, unknown> = Object.create(null);
  if (
    keys.length > 16 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        (optional !== null && ![...required, ...optional].includes(key)),
    ) ||
    required.some((key) => !Object.hasOwn(descriptors, key))
  )
    fail();
  for (const key of keys) {
    const descriptor = descriptors[key as string];
    if (!descriptor?.enumerable || !("value" in descriptor)) fail();
    result[key as string] = descriptor.value;
  }
  return result;
}
function text(input: unknown, max: number, pattern?: RegExp): string {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.length > max ||
    /\p{Surrogate}/u.test(input) ||
    Array.from(input).some((character) => {
      const point = character.codePointAt(0)!;
      return point < 32 || (point >= 127 && point <= 159);
    }) ||
    (pattern && !pattern.test(input))
  )
    fail();
  return input;
}
function uuid(input: unknown): string {
  return text(input, 36, UUID);
}
function integer(input: unknown, min: number, max: number): number {
  if (
    typeof input !== "number" ||
    !Number.isSafeInteger(input) ||
    Object.is(input, -0) ||
    input < min ||
    input > max
  )
    fail();
  return input;
}
function sha(input: unknown): string {
  const value = text(input, 44, /^[A-Za-z0-9+/]{43}=$/u);
  if (Buffer.from(value, "base64").toString("base64") !== value) fail();
  return value;
}
function workspace(input: unknown): string {
  const value = text(input, 1_024);
  if (
    !/^[A-Za-z]:\\/u.test(value) ||
    win32.normalize(value) !== value ||
    value.includes("/")
  )
    fail();
  const segments = value.slice(3).split("\\");
  if (
    segments.some(
      (segment) =>
        !segment ||
        /[<>:"|?*]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    )
  )
    fail();
  return value;
}
function grant(
  input: unknown,
  upload: false,
  expectedSha: string,
): Readonly<TransferGrant>;
function grant(
  input: unknown,
  upload: true,
  expectedSha: string,
): Extract<StoreTransferRequest, { operation: "upload" }>["grant"];
function grant(
  input: unknown,
  upload: boolean,
  expectedSha: string,
): Readonly<TransferGrant> | StoreTransferRequest["grant"] {
  const row = record(
    input,
    upload ? ["url", "expiresAt", "method", "headers"] : ["url", "expiresAt"],
  );
  const url = text(row.url, 16_384, /^[\x21-\x7e]+$/u);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !parsed.hostname ||
    url.includes("\\")
  )
    fail();
  const expiresAt = text(row.expiresAt, 24);
  const time = Date.parse(expiresAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== expiresAt)
    fail();
  if (!upload) return Object.freeze({ url, expiresAt });
  if (row.method !== "PUT") fail();
  const headers = record(row.headers, [], null);
  if (Object.keys(headers).length !== 4) fail();
  const copied: Record<string, string> = {},
    seen = new Set<string>();
  const values: Readonly<Record<string, string>> = {
    "content-type": "audio/mpeg",
    "if-none-match": "*",
    "x-amz-checksum-sha256": expectedSha,
    "x-amz-meta-sha256": expectedSha,
  };
  for (const [name, raw] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      seen.has(lower) ||
      !Object.hasOwn(values, lower) ||
      raw !== values[lower]
    )
      fail();
    seen.add(lower);
    copied[name] = raw as string;
  }
  if (seen.size !== 4) fail();
  return Object.freeze({
    url,
    expiresAt,
    method: "PUT",
    headers: Object.freeze(copied),
  });
}
function options(input: unknown): StoreTransferOptions {
  const row = record(
    input,
    [],
    ["timeoutMs", "downloadIdleTimeoutMs", "uploadIdleTimeoutMs"],
  );
  const result: Record<string, number> = {};
  for (const [name, raw] of Object.entries(row))
    result[name] = integer(raw, 100, 7_200_000);
  return Object.freeze(result);
}

/** Snapshot before async IO; own data descriptors are copied without executing caller hooks. */
export function snapshotStoreTransferRequest(
  input: unknown,
  expectedWorkspace: string,
): StoreTransferRequest {
  const row = record(input, [
    "version",
    "requestId",
    "operation",
    "attemptId",
    "workspace",
    "path",
    "grant",
    "expected",
    "options",
  ]);
  if (
    row.version !== 1 ||
    (row.operation !== "download" && row.operation !== "upload")
  )
    fail();
  const requestId = uuid(row.requestId),
    attemptId = uuid(row.attemptId),
    root = workspace(row.workspace);
  if (
    root !== workspace(expectedWorkspace) ||
    !root.endsWith(`\\work\\${attemptId}`)
  )
    fail();
  const upload = row.operation === "upload";
  const expectedRow = record(
    row.expected,
    upload
      ? ["bytes", "sha256", "contentType"]
      : ["key", "etag", "bytes", "sha256", "contentType"],
  );
  const bytes = integer(
      expectedRow.bytes,
      1,
      upload ? 30_000_000 : 1_000_000_000,
    ),
    sha256 = sha(expectedRow.sha256);
  const contentType = text(
    expectedRow.contentType,
    100,
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u,
  );
  const path = text(row.path, 1_100);
  if (
    path !==
    win32.join(
      root,
      upload
        ? "output\\vocals.mp3"
        : `input${attemptInputExtension(contentType)}`,
    )
  )
    fail();
  const base = {
    version: 1 as const,
    requestId,
    attemptId,
    workspace: root,
    path,
    options: options(row.options),
  };
  if (upload) {
    if (contentType !== "audio/mpeg") fail();
    return Object.freeze({
      ...base,
      operation: "upload",
      grant: grant(row.grant, true, sha256),
      expected: Object.freeze({ bytes, sha256, contentType }),
    });
  }
  return Object.freeze({
    ...base,
    operation: "download",
    grant: grant(row.grant, false, sha256),
    expected: Object.freeze({
      key: text(expectedRow.key, 1_024, /^[\x21-\x7e]+$/u),
      etag: text(expectedRow.etag, 1_024, ETAG),
      bytes,
      sha256,
      contentType,
    }),
  });
}

/** Copy an actual ordinary typed view without invoking caller buffer/length hooks. */
export function snapshotStoreTransferBytes(
  bytes: Uint8Array,
  max: number,
): Uint8Array {
  if (
    !Number.isSafeInteger(max) ||
    max < 0 ||
    max > STORE_TRANSFER_REQUEST_MAX_BYTES ||
    !ArrayBuffer.isView(bytes) ||
    types.isProxy(bytes) ||
    ![Uint8Array.prototype, Buffer.prototype].includes(
      Object.getPrototypeOf(bytes),
    )
  )
    fail();
  const prototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const length = Reflect.apply(
    Object.getOwnPropertyDescriptor(prototype, "byteLength")!.get!,
    bytes,
    [],
  ) as number;
  const offset = Reflect.apply(
    Object.getOwnPropertyDescriptor(prototype, "byteOffset")!.get!,
    bytes,
    [],
  ) as number;
  const buffer = Reflect.apply(
    Object.getOwnPropertyDescriptor(prototype, "buffer")!.get!,
    bytes,
    [],
  ) as ArrayBuffer;
  if (
    length < 0 ||
    length > max ||
    types.isSharedArrayBuffer(buffer) ||
    Reflect.ownKeys(bytes).some(
      (key) => typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key),
    )
  )
    fail();
  try {
    return new Uint8Array(new Uint8Array(buffer, offset, length));
  } catch {
    fail();
  }
}
function decode(bytes: Uint8Array, max: number): unknown {
  const copy = snapshotStoreTransferBytes(bytes, max),
    length = copy.length;
  if (
    length < 3 ||
    copy[length - 1] !== 10 ||
    copy.subarray(0, -1).some((byte) => byte === 10 || byte === 13) ||
    (copy[0] === 0xef && copy[1] === 0xbb && copy[2] === 0xbf)
  )
    fail();
  try {
    return parseStrictJson(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        copy.subarray(0, -1),
      ),
      max,
      256,
    );
  } catch {
    fail();
  }
}
export function parseStoreTransferRequest(
  bytes: Uint8Array,
  expectedWorkspace: string,
): StoreTransferRequest {
  return snapshotStoreTransferRequest(
    decode(bytes, STORE_TRANSFER_REQUEST_MAX_BYTES),
    expectedWorkspace,
  );
}
export function parseStoreTransferReply(
  bytes: Uint8Array,
  requestId: string,
  operation: StoreTransferOperation,
): StoreTransferReply {
  uuid(requestId);
  if (operation !== "download" && operation !== "upload") fail();
  const raw = decode(bytes, STORE_TRANSFER_REPLY_MAX_BYTES),
    first = record(
      raw,
      ["version", "requestId", "ok"],
      ["result", "retryable", "diagnostic"],
    );
  if (first.version !== 1 || first.requestId !== requestId) fail();
  if (first.ok === true) {
    const row = record(raw, ["version", "requestId", "ok", "result"]);
    const result =
      operation === "download"
        ? row.result === null
          ? null
          : fail()
        : text(row.result, 1_024, ETAG);
    return Object.freeze({ version: 1, requestId, ok: true, result });
  }
  const row = record(raw, [
    "version",
    "requestId",
    "ok",
    "retryable",
    "diagnostic",
  ]);
  if (
    row.ok !== false ||
    typeof row.retryable !== "boolean" ||
    !STORE_TRANSFER_DIAGNOSTICS.some((value) => value === row.diagnostic)
  )
    fail();
  return Object.freeze({
    version: 1,
    requestId,
    ok: false,
    retryable: row.retryable,
    diagnostic: row.diagnostic as StoreTransferDiagnostic,
  });
}
