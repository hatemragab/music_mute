import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink, statfs, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { HostContext } from "../host-context.js";
import { MODEL } from "../../../../chrome-extension/src/shared/local-model.js";
export interface UpdateModelBlob {
  bytes: number;
  sha256: string;
}
export function parseUpdateModelBlob(value: unknown): UpdateModelBlob {
  const row = value as UpdateModelBlob;
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join() !== "bytes,sha256" ||
    !Number.isSafeInteger(row.bytes) ||
    row.bytes < 1 ||
    row.bytes > 2 * 1024 ** 3 ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.sha256)
  )
    throw new Error("UPDATE_STATE_INVALID");
  return { ...row };
}
/** Hash-bound immutable copies, never hard links to a mutable active model. */
export class ConsumerModelArchive {
  constructor(
    private readonly host: Pick<
      HostContext,
      "personalRoot" | "native" | "directory"
    >,
  ) {}
  private path(relative: string) {
    return join(this.host.personalRoot, ...relative.split("\\"));
  }
  private relative(identity: string) {
    if (!/^[a-f0-9]{64}$/u.test(identity))
      throw new Error("UPDATE_STATE_INVALID");
    return `updates\\backups\\${identity}\\model.onnx`;
  }
  async reserveSpace(blob: UpdateModelBlob) {
    parseUpdateModelBlob(blob);
    await this.host.native.validatePath("personal", "", "directory");
    const disk = await statfs(this.host.personalRoot, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(blob.bytes) * 2n + 1024n ** 3n)
      throw new Error("UPDATE_LOW_DISK");
  }
  async verify(
    relative: string,
    blob: UpdateModelBlob,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    parseUpdateModelBlob(blob);
    await this.host.native.validatePath("personal", relative, "file");
    const file = await open(
      this.path(relative),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const before = await file.stat({ bigint: true }),
        named = await lstat(this.path(relative), { bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size !== BigInt(blob.bytes) ||
        named.isSymbolicLink() ||
        named.ino !== before.ino ||
        named.dev !== before.dev
      )
        throw new Error("UPDATE_HASH_INVALID");
      const digest = createHash("sha256");
      signal.throwIfAborted();
      for await (const bytes of file.createReadStream({
        autoClose: false,
        signal,
      }))
        digest.update(bytes);
      const after = await file.stat({ bigint: true }),
        current = await lstat(this.path(relative), { bigint: true });
      if (
        digest.digest("hex") !== blob.sha256 ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        current.isSymbolicLink()
      )
        throw new Error("UPDATE_HASH_INVALID");
    } finally {
      await file.close();
    }
  }
  private async copy(
    source: string,
    destination: string,
    blob: UpdateModelBlob,
    signal: AbortSignal,
    replace: boolean,
  ): Promise<void> {
    await this.verify(source, blob, signal);
    const parent = destination.slice(0, destination.lastIndexOf("\\"));
    await this.host.directory(parent);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await this.host.native.validatePath("personal", temporary, "absent");
    const input = await open(
      this.path(source),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let output: Awaited<ReturnType<typeof open>> | undefined,
      published = false;
    try {
      output = await open(this.path(temporary), "wx", 0o600);
      const before = await input.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size !== BigInt(blob.bytes)
      )
        throw new Error("UPDATE_HASH_INVALID");
      const digest = createHash("sha256");
      let count = 0;
      signal.throwIfAborted();
      for await (const bytes of input.createReadStream({
        autoClose: false,
        signal,
      })) {
        signal.throwIfAborted();
        count += bytes.length;
        if (count > blob.bytes) throw new Error("UPDATE_HASH_INVALID");
        digest.update(bytes);
        await output.writeFile(bytes);
      }
      const after = await input.stat({ bigint: true });
      if (
        count !== blob.bytes ||
        digest.digest("hex") !== blob.sha256 ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new Error("UPDATE_HASH_INVALID");
      await output.sync();
      await output.close();
      output = undefined;
      await this.host.native.validatePath("personal", temporary, "file");
      if (replace) {
        try {
          await lstat(this.path(destination));
          await this.host.native.validatePath("personal", destination, "file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await this.host.native.validatePath(
            "personal",
            destination,
            "absent",
          );
        }
      } else
        await this.host.native.validatePath("personal", destination, "absent");
      signal.throwIfAborted();
      await rename(this.path(temporary), this.path(destination));
      published = true;
      await this.verify(destination, blob, signal);
    } finally {
      await input.close();
      await output?.close();
      if (!published) {
        try {
          await this.host.native.validatePath("personal", temporary, "file");
          await unlink(this.path(temporary));
        } catch {
          /* Unknown/denied temporary data remains conservatively retained. */
        }
      }
    }
  }
  async capture(identity: string, blob: UpdateModelBlob, signal: AbortSignal) {
    const destination = this.relative(identity);
    try {
      await lstat(this.path(destination));
      await this.verify(destination, blob, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.copy(
      `models\\${MODEL.filename}`,
      destination,
      blob,
      signal,
      false,
    );
  }
  async restore(identity: string, blob: UpdateModelBlob, signal: AbortSignal) {
    await this.copy(
      this.relative(identity),
      `models\\${MODEL.filename}`,
      blob,
      signal,
      true,
    );
  }
  async activate(identity: string, blob: UpdateModelBlob, signal: AbortSignal) {
    if (!/^[a-f0-9]{64}$/u.test(identity))
      throw new Error("UPDATE_STATE_INVALID");
    await this.copy(
      `updates\\staging\\${identity}\\model.onnx`,
      `models\\${MODEL.filename}`,
      blob,
      signal,
      true,
    );
  }
  async remove(identity: string) {
    const relative = this.relative(identity);
    try {
      await lstat(this.path(relative));
      await this.host.native.validatePath("personal", relative, "file");
      await unlink(this.path(relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = relative.slice(0, relative.lastIndexOf("\\"));
    try {
      await lstat(this.path(parent));
      await this.host.native.validatePath("personal", parent, "directory");
      await rmdir(this.path(parent));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY")
        throw new Error("UPDATE_CLEANUP_PENDING");
      throw error;
    }
  }
}
