import { Readable } from "node:stream";
import {
  assertConsumerNonce,
  assertConsumerRelativePath,
  ConsumerNativeError,
  decodeConsumerBase64,
  object,
} from "./consumer-native-policy.js";
import {
  cacheIdentityToWire,
  type ConsumerCacheFileIdentity,
  type ConsumerFileBirth,
} from "./consumer-native-cache.js";
import type { ConsumerNativeTransport } from "./consumer-native-transport.js";

export const PRIVATE_FILE_MAX_BYTES = 4 * 1024 ** 3;
export const PRIVATE_FILE_CHUNK_BYTES = 24 * 1024;
export type PrivateFileMode = "read" | "create-new" | "resume";
export interface PrivateFileChunks {
  start?: number;
  /** Exclusive upper bound, matching the archive reader's ranges. */
  end?: number;
  signal?: AbortSignal;
}
export interface PrivateReadable {
  info(): Promise<ConsumerCacheFileIdentity>;
  read(
    target: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  chunks(options?: PrivateFileChunks): AsyncIterable<Buffer>;
  close(): Promise<void>;
}
export interface PrivateWritable extends PrivateReadable {
  write(
    source: Uint8Array,
    offset: number,
    length: number,
    position?: number,
  ): Promise<{ bytesWritten: number }>;
  writeFile(source: Uint8Array | string): Promise<void>;
  truncate(length: number): Promise<void>;
  sync(): Promise<void>;
}
/** Publication observations only; this is not model/GPU or Ready authority. */
export interface StoreModelPublication {
  version: 1;
  state: "published" | "reused";
  identity: ConsumerCacheFileIdentity;
  sha256: string;
  bytes: number;
  backupRelativePath: string | null;
}
export interface StoreModelWritable extends PrivateWritable {
  publish(): Promise<StoreModelPublication>;
}
const STORE_MODEL_BYTES = 66759214;
const STORE_MODEL_SHA256 =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
export function parseStoreModelPublication(
  value: unknown,
): StoreModelPublication {
  const row = closedKeys(value, [
    "version",
    "state",
    "identity",
    "sha256",
    "bytes",
    "backup_relative_path",
  ]);
  const found = identity(row.identity);
  if (
    row.version !== 1 ||
    (row.state !== "published" && row.state !== "reused") ||
    row.sha256 !== STORE_MODEL_SHA256 ||
    row.bytes !== STORE_MODEL_BYTES ||
    found.bytes !== STORE_MODEL_BYTES ||
    (row.backup_relative_path !== null &&
      (typeof row.backup_relative_path !== "string" ||
        !/^models\\Kim_Vocal_2\.onnx\.previous-[a-f0-9]{64}$/u.test(
          row.backup_relative_path,
        )))
  )
    malformed();
  return {
    version: 1,
    state: row.state,
    identity: found,
    sha256: STORE_MODEL_SHA256,
    bytes: STORE_MODEL_BYTES,
    backupRelativePath: row.backup_relative_path as string | null,
  };
}
function bad(): never {
  throw new ConsumerNativeError("BAD_REQUEST");
}
function malformed(): never {
  throw new ConsumerNativeError("PROTOCOL_MISMATCH");
}
function closedKeys(
  value: unknown,
  names: readonly string[],
): Record<string, unknown> {
  const row = object(value);
  if (Object.keys(row).sort().join() !== [...names].sort().join()) malformed();
  return row;
}
function bound(value: number, maximum = PRIVATE_FILE_MAX_BYTES): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) bad();
}
function identity(value: unknown): ConsumerCacheFileIdentity {
  const row = closedKeys(value, [
    "device",
    "file_id",
    "born_at",
    "bytes",
    "written_at",
    "changed_at",
  ]);
  const result = {
    device: row.device,
    fileId: row.file_id,
    bornAt: row.born_at,
    bytes: row.bytes,
    writtenAt: row.written_at,
    changedAt: row.changed_at,
  };
  try {
    cacheIdentityToWire(result as ConsumerCacheFileIdentity, "file");
  } catch {
    malformed();
  }
  if (
    BigInt(result.device as string) > 0xffffffffn ||
    BigInt(result.fileId as string) > 0xffffffffffffffffn ||
    (result.bytes as number) > PRIVATE_FILE_MAX_BYTES
  )
    malformed();
  return {
    device: result.device as string,
    fileId: result.fileId as string,
    bornAt: result.bornAt as string,
    bytes: result.bytes as number,
    writtenAt: result.writtenAt as string,
    changedAt: result.changedAt as string,
  };
}
function sameBirth(a: ConsumerFileBirth, b: ConsumerFileBirth): boolean {
  return (
    a.device === b.device && a.fileId === b.fileId && a.bornAt === b.bornAt
  );
}
function sliceRange(bytes: Uint8Array, offset: number, length: number): void {
  if (!(bytes instanceof Uint8Array)) bad();
  bound(offset, bytes.byteLength);
  bound(length, bytes.byteLength - offset);
}
/** A retained native object, never a Node descriptor or pathname fallback. */
class NativePrivateFile implements StoreModelWritable {
  readonly #token: string;
  readonly #transport: ConsumerNativeTransport;
  private cursor = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private poisoned = false;
  private closeResult: Promise<void> | undefined;
  private readonly unsubscribe: (() => void) | undefined;
  constructor(
    transport: ConsumerNativeTransport,
    token: string,
    private mode: PrivateFileMode,
    private readonly maximum: number,
    private readonly birth: ConsumerFileBirth,
    private readonly storeModel = false,
  ) {
    this.#transport = transport;
    this.#token = token;
    this.unsubscribe = transport.onClosed?.(() => {
      this.poisoned = true;
    });
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed || this.poisoned)
      return Promise.reject(new ConsumerNativeError("HELPER_UNAVAILABLE"));
    const result = this.tail.then(async () => {
      if (this.poisoned) throw new ConsumerNativeError("HELPER_UNAVAILABLE");
      try {
        return await action();
      } catch (error) {
        this.poisoned = true;
        throw error;
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  private writable(): void {
    if (this.mode === "read") bad();
  }
  private checkIdentity(value: unknown): ConsumerCacheFileIdentity {
    const found = identity(value);
    if (!sameBirth(found, this.birth) || found.bytes > this.maximum)
      malformed();
    return found;
  }
  info(): Promise<ConsumerCacheFileIdentity> {
    return this.enqueue(async () => {
      const row = closedKeys(
        await this.#transport.request("private_file_info", {
          token: this.#token,
        }),
        ["identity"],
      );
      return this.checkIdentity(row.identity);
    });
  }
  read(
    target: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    sliceRange(target, offset, length);
    bound(position, this.maximum);
    return this.enqueue(async () => {
      let total = 0;
      while (total < length) {
        const count = Math.min(PRIVATE_FILE_CHUNK_BYTES, length - total);
        const row = closedKeys(
          await this.#transport.request("private_file_read", {
            token: this.#token,
            position: position + total,
            length: count,
          }),
          ["bytes_base64", "bytes_read"],
        );
        const bytes = decodeConsumerBase64(row.bytes_base64, count);
        if (
          !Number.isSafeInteger(row.bytes_read) ||
          row.bytes_read !== bytes.byteLength ||
          bytes.byteLength > this.maximum - position - total
        )
          malformed();
        target.set(bytes, offset + total);
        total += bytes.byteLength;
        if (bytes.byteLength < count) break;
      }
      return { bytesRead: total };
    });
  }
  private async writeAt(
    source: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<number> {
    let total = 0;
    while (total < length) {
      const count = Math.min(PRIVATE_FILE_CHUNK_BYTES, length - total);
      const encoded = Buffer.from(
        source.buffer,
        source.byteOffset + offset + total,
        count,
      ).toString("base64");
      const row = closedKeys(
        await this.#transport.request("private_file_write", {
          token: this.#token,
          position: position + total,
          bytes_base64: encoded,
        }),
        ["bytes_written"],
      );
      if (
        !Number.isSafeInteger(row.bytes_written) ||
        (row.bytes_written as number) < 1 ||
        (row.bytes_written as number) > count
      )
        malformed();
      total += row.bytes_written as number;
    }
    return total;
  }
  write(
    source: Uint8Array,
    offset: number,
    length: number,
    position?: number,
  ): Promise<{ bytesWritten: number }> {
    this.writable();
    sliceRange(source, offset, length);
    if (position !== undefined) {
      bound(position, this.maximum);
      bound(length, this.maximum - position);
    }
    return this.enqueue(async () => {
      const start = position ?? this.cursor;
      bound(length, this.maximum - start);
      const bytesWritten = await this.writeAt(source, offset, length, start);
      if (position === undefined) this.cursor += bytesWritten;
      return { bytesWritten };
    });
  }
  writeFile(source: Uint8Array | string): Promise<void> {
    this.writable();
    const bytes =
      typeof source === "string" ? Buffer.from(source, "utf8") : source;
    if (!(bytes instanceof Uint8Array)) bad();
    return this.enqueue(async () => {
      bound(bytes.byteLength, this.maximum - this.cursor);
      this.cursor += await this.writeAt(
        bytes,
        0,
        bytes.byteLength,
        this.cursor,
      );
    });
  }
  truncate(length: number): Promise<void> {
    this.writable();
    bound(length, this.maximum);
    return this.enqueue(async () => {
      const row = closedKeys(
        await this.#transport.request("private_file_truncate", {
          token: this.#token,
          length,
        }),
        ["identity"],
      );
      if (this.checkIdentity(row.identity).bytes !== length) malformed();
    });
  }
  sync(): Promise<void> {
    this.writable();
    return this.enqueue(async () => {
      const row = closedKeys(
        await this.#transport.request("private_file_sync", {
          token: this.#token,
        }),
        ["synced", "identity"],
      );
      if (row.synced !== true) malformed();
      this.checkIdentity(row.identity);
    });
  }
  publish(): Promise<StoreModelPublication> {
    if (arguments.length !== 0 || !this.storeModel) bad();
    this.mode = "read";
    return this.enqueue(async () => {
      const published = parseStoreModelPublication(
        await this.#transport.request("store_model_publish", {
          token: this.#token,
        }),
      );
      if (
        published.state === "published" &&
        !sameBirth(published.identity, this.birth)
      )
        malformed();
      return published;
    });
  }
  async *chunks(options: PrivateFileChunks = {}): AsyncIterable<Buffer> {
    const start = options.start ?? 0;
    bound(start, this.maximum);
    const end = options.end ?? (await this.info()).bytes;
    bound(end, this.maximum);
    if (end < start) bad();
    let position = start;
    while (position < end) {
      options.signal?.throwIfAborted();
      const bytes = Buffer.allocUnsafe(
        Math.min(PRIVATE_FILE_CHUNK_BYTES, end - position),
      );
      const { bytesRead } = await this.read(
        bytes,
        0,
        bytes.byteLength,
        position,
      );
      options.signal?.throwIfAborted();
      if (!bytesRead) throw new ConsumerNativeError("HELPER_INTEGRITY_INVALID");
      position += bytesRead;
      yield bytes.subarray(0, bytesRead);
    }
  }
  close(): Promise<void> {
    if (this.closeResult) return this.closeResult;
    // Consume locally before dispatch; an uncertain close is never replayed.
    this.closed = true;
    const result = this.tail.then(async () => {
      this.unsubscribe?.();
      const row = closedKeys(
        await this.#transport.request("private_file_close", {
          token: this.#token,
        }),
        ["closed"],
      );
      if (row.closed !== true) malformed();
    });
    this.closeResult = result;
    this.tail = result.catch(() => {});
    return result;
  }
}
export async function openConsumerPrivateFile(
  transport: ConsumerNativeTransport,
  relativePath: string,
  mode: PrivateFileMode,
  maximumBytes: number,
  expectedBirth?: ConsumerFileBirth,
): Promise<PrivateWritable | null> {
  return openPrivateFileCapability(
    transport,
    "private_file_open",
    relativePath,
    mode,
    maximumBytes,
    expectedBirth,
  );
}
/** A Store-only data operation. Native independently requires its living GUI
 * or Prepare role; this adapter cannot turn an injected transport into it. */
export async function openConsumerStoreFixtureFile(
  transport: ConsumerNativeTransport,
  relativePath: string,
  maximumBytes: number,
  expectedBirth?: ConsumerFileBirth,
): Promise<PrivateWritable> {
  if (
    !/^prepare\\approved\\[a-f0-9]{64}\.wav$/u.test(relativePath) ||
    maximumBytes < 44 ||
    maximumBytes > 64 * 1024 ** 2
  )
    bad();
  const file = await openPrivateFileCapability(
    transport,
    "store_fixture_file_open",
    relativePath,
    expectedBirth ? "resume" : "create-new",
    maximumBytes,
    expectedBirth,
  );
  if (!file) malformed();
  return file;
}
export async function openConsumerStoreModelFile(
  transport: ConsumerNativeTransport,
  expectedBirth?: ConsumerFileBirth,
): Promise<StoreModelWritable> {
  const file = await openPrivateFileCapability(
    transport,
    "store_model_file_open",
    "models\\Kim_Vocal_2.onnx.part",
    expectedBirth ? "resume" : "create-new",
    STORE_MODEL_BYTES,
    expectedBirth,
  );
  if (!file) malformed();
  return file as StoreModelWritable;
}
export async function recoverConsumerStoreModelPublication(
  transport: ConsumerNativeTransport,
): Promise<StoreModelPublication | null> {
  const result = await transport.request("store_model_recover", {});
  return result === null ? null : parseStoreModelPublication(result);
}
async function openPrivateFileCapability(
  transport: ConsumerNativeTransport,
  operation:
    "private_file_open" | "store_fixture_file_open" | "store_model_file_open",
  relativePath: string,
  mode: PrivateFileMode,
  maximumBytes: number,
  expectedBirth?: ConsumerFileBirth,
): Promise<PrivateWritable | null> {
  assertConsumerRelativePath(relativePath);
  bound(maximumBytes);
  if (maximumBytes === 0 || relativePath.split("\\").length > 32) bad();
  if (!["read", "create-new", "resume"].includes(mode)) bad();
  if (mode === "resume") {
    if (
      !expectedBirth ||
      !(
        operation === "store_fixture_file_open" ||
        [
          "prepare\\downloads\\runtime.part",
          "models\\Kim_Vocal_2.onnx.part",
        ].includes(relativePath)
      )
    )
      bad();
  } else if (expectedBirth !== undefined) bad();
  const expected = expectedBirth
    ? cacheIdentityToWire(expectedBirth, "directory")
    : null;
  const expectedIdentity = expected
    ? {
        device: expected.device as string,
        fileId: expected.file_id as string,
        bornAt: expected.born_at as string,
      }
    : undefined;
  try {
    const result = object(
      await transport.request(
        operation,
        operation === "store_model_file_open"
          ? {
              mode,
              expected_birth: expected,
            }
          : {
              root: "personal",
              relative_path: relativePath,
              mode,
              maximum_bytes: maximumBytes,
              expected_birth: expected,
            },
      ),
    );
    if (result.state === "missing") {
      closedKeys(result, ["state"]);
      if (mode !== "read") malformed();
      return null;
    }
    closedKeys(result, ["state", "token", "identity"]);
    if (result.state !== "opened" || typeof result.token !== "string")
      malformed();
    try {
      assertConsumerNonce(result.token);
    } catch {
      malformed();
    }
    const found = identity(result.identity);
    if (
      found.bytes > maximumBytes ||
      (mode === "create-new" && found.bytes !== 0) ||
      (expectedIdentity && !sameBirth(found, expectedIdentity))
    )
      malformed();
    return new NativePrivateFile(
      transport,
      result.token,
      mode,
      maximumBytes,
      found,
      operation === "store_model_file_open",
    );
  } catch (error) {
    // The helper may own an open with no usable client token. Await its exit,
    // rather than trusting a malformed token or replaying an uncertain open.
    await transport.close();
    throw error;
  }
}
/** Standard stream adapter for consumers that need backpressure, never an fd. */
export function privateFileStream(
  file: PrivateReadable,
  options: PrivateFileChunks = {},
): Readable {
  return Readable.from(file.chunks(options), { objectMode: false });
}
