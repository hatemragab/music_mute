import { open, type FileHandle } from "node:fs/promises";
import type {
  PrivateReadable,
  PrivateWritable,
} from "../../worker/src/platform/windows/consumer-private-file.js";
import type {
  ConsumerCacheFileIdentity,
  ConsumerFileBirth,
} from "../../worker/src/platform/windows/consumer-native-cache.js";
import { assertConsumerRelativePath } from "../../worker/src/platform/windows/consumer-native-policy.js";

const MAXIMUM_BYTES = 4 * 1024 ** 3,
  CHUNK_BYTES = 24 * 1024;

function boundedInteger(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error("BAD_REQUEST");
}

/** Test-only port for temporary fixture descriptors; never used by production code. */
export function nodePrivateFileFixture(
  file: FileHandle,
  maximumBytes = MAXIMUM_BYTES,
  mode: "read" | "create-new" | "resume" = "create-new",
): PrivateWritable {
  let cursor = 0,
    closed = false;
  const current = () => {
    if (closed) throw new Error("PRIVATE_FILE_CLOSED");
  };
  const writable = () => {
    current();
    if (mode === "read") throw new Error("BAD_REQUEST");
  };
  const range = (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ) => {
    current();
    boundedInteger(offset, buffer.byteLength);
    boundedInteger(length, buffer.byteLength - offset);
    boundedInteger(position, maximumBytes);
    boundedInteger(position + length, maximumBytes);
  };
  const info = async (): Promise<ConsumerCacheFileIdentity> => {
    current();
    const stat = await file.stat({ bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      stat.ino === 0n ||
      stat.size < 0n ||
      stat.size > BigInt(maximumBytes)
    )
      throw new Error("PATH_UNSAFE");
    return {
      device: String(stat.dev),
      fileId: String(stat.ino),
      bornAt: String(stat.birthtimeNs),
      bytes: Number(stat.size),
      writtenAt: String(stat.mtimeNs),
      changedAt: String(stat.ctimeNs),
    };
  };
  const read: PrivateReadable["read"] = async (
    buffer,
    offset,
    length,
    position,
  ) => {
    current();
    boundedInteger(offset, buffer.byteLength);
    boundedInteger(length, buffer.byteLength - offset);
    boundedInteger(position, maximumBytes);
    const result = await file.read(
      buffer,
      offset,
      Math.min(length, CHUNK_BYTES, maximumBytes - position),
      position,
    );
    return { bytesRead: result.bytesRead };
  };
  const write: PrivateWritable["write"] = async (
    buffer,
    offset,
    length,
    position,
  ) => {
    writable();
    const target = position ?? cursor;
    range(buffer, offset, length, target);
    const result = await file.write(
      buffer,
      offset,
      Math.min(length, CHUNK_BYTES),
      target,
    );
    if (position === undefined) cursor += result.bytesWritten;
    return { bytesWritten: result.bytesWritten };
  };
  return {
    info,
    read,
    write,
    async *chunks(options = {}) {
      const end = options.end ?? (await info()).bytes;
      let position = options.start ?? 0;
      boundedInteger(position, maximumBytes);
      boundedInteger(end, maximumBytes);
      if (end < position) throw new Error("BAD_REQUEST");
      while (position < end) {
        options.signal?.throwIfAborted();
        const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, end - position)),
          result = await read(buffer, 0, buffer.length, position);
        if (result.bytesRead === 0) throw new Error("PRIVATE_FILE_READ_FAILED");
        position += result.bytesRead;
        yield buffer.subarray(0, result.bytesRead);
      }
    },
    async writeFile(value) {
      writable();
      const bytes = typeof value === "string" ? Buffer.from(value) : value;
      let offset = 0;
      while (offset < bytes.length) {
        const result = await write(bytes, offset, bytes.length - offset);
        if (result.bytesWritten === 0)
          throw new Error("PRIVATE_FILE_WRITE_FAILED");
        offset += result.bytesWritten;
      }
    },
    async truncate(length) {
      writable();
      boundedInteger(length, maximumBytes);
      await file.truncate(length);
    },
    async sync() {
      writable();
      await file.sync();
    },
    async close() {
      if (closed) return;
      await file.close();
      closed = true;
    },
  };
}

/** Node-backed stand-in for the private native port on isolated test roots only. */
export function privateFileNativeFixture(path: (relative: string) => string) {
  function openPrivateFile(
    relative: string,
    mode: "read",
    maximumBytes: number,
  ): Promise<PrivateReadable | null>;
  function openPrivateFile(
    relative: string,
    mode: "create-new" | "resume",
    maximumBytes: number,
    expectedBirth?: ConsumerFileBirth,
  ): Promise<PrivateWritable>;
  async function openPrivateFile(
    relative: string,
    mode: "read" | "create-new" | "resume",
    maximumBytes: number,
    expectedBirth?: ConsumerFileBirth,
  ): Promise<PrivateWritable | null> {
    assertConsumerRelativePath(relative);
    boundedInteger(maximumBytes, MAXIMUM_BYTES);
    if (maximumBytes === 0 || relative.split("\\").length > 32)
      throw new Error("BAD_REQUEST");
    if (
      !["read", "create-new", "resume"].includes(mode) ||
      (mode === "resume" ? !expectedBirth : expectedBirth !== undefined)
    )
      throw new Error("BAD_REQUEST");
    if (
      mode === "resume" &&
      ![
        "prepare\\downloads\\runtime.part",
        "models\\Kim_Vocal_2.onnx.part",
      ].includes(relative)
    )
      throw new Error("BAD_REQUEST");
    let file: FileHandle;
    try {
      file = await open(
        path(relative),
        mode === "create-new" ? "wx+" : mode === "resume" ? "r+" : "r",
        0o600,
      );
    } catch (error) {
      if (mode === "read" && (error as NodeJS.ErrnoException).code === "ENOENT")
        return null;
      throw error;
    }
    const port = nodePrivateFileFixture(file, maximumBytes, mode);
    try {
      const identity = await port.info();
      if (
        expectedBirth &&
        ["device", "fileId", "bornAt"].some(
          (key) =>
            identity[key as keyof ConsumerFileBirth] !==
            expectedBirth[key as keyof ConsumerFileBirth],
        )
      )
        throw new Error("PRIVATE_FILE_CONFLICT");
      return port;
    } catch (error) {
      await port.close();
      throw error;
    }
  }
  return { openPrivateFile };
}
