import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, rename, unlink } from "node:fs/promises";
import { win32 } from "node:path";
import { publicThumbnailUrl } from "../../../../chrome-extension/src/shared/thumbnail-url.js";
import type { HostContext } from "../host-context.js";
import { readPrivateBytes, newPrivateFile } from "../prepare/private-files.js";
import {
  storageBirth,
  type StorageWriteLease,
} from "../storage/write-journal.js";
import type { StoragePartialWriteAdmission } from "../storage/partial-write-policy.js";
const LIMIT = 1024 * 1024,
  MAX_FILES = 128;
export function thumbnailMime(bytes: Buffer): "image/jpeg" | "image/webp" {
  if (bytes.length < 16 || bytes.length > LIMIT)
    throw new Error("THUMBNAIL_INVALID");
  if (
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  ) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) throw new Error("THUMBNAIL_INVALID");
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length)
        throw new Error("THUMBNAIL_INVALID");
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (size < 8) throw new Error("THUMBNAIL_INVALID");
        dimensions(
          bytes.readUInt16BE(offset + 5),
          bytes.readUInt16BE(offset + 3),
        );
        return "image/jpeg";
      }
      offset += size;
    }
  }
  if (
    bytes.length >= 20 &&
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP" &&
    bytes.readUInt32LE(4) === bytes.length - 8
  ) {
    const kind = bytes.subarray(12, 16).toString(),
      size = bytes.readUInt32LE(16);
    if (size > bytes.length - 20) throw new Error("THUMBNAIL_INVALID");
    if (kind === "VP8X" && bytes.length >= 30) {
      dimensions(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
      return "image/webp";
    }
    if (
      kind === "VP8 " &&
      bytes.length >= 30 &&
      bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    ) {
      dimensions(
        bytes.readUInt16LE(26) & 0x3fff,
        bytes.readUInt16LE(28) & 0x3fff,
      );
      return "image/webp";
    }
    if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      return "image/webp";
    }
  }
  throw new Error("THUMBNAIL_INVALID");
}
function dimensions(width: number, height: number) {
  if (
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    width * height > 16_000_000
  )
    throw new Error("THUMBNAIL_INVALID");
}
/** Public YouTube pixels only. Private grants, SVG, redirects and oversized images never enter this cache. */
export class LibraryThumbnailCache {
  private admission: StoragePartialWriteAdmission | undefined;
  setWriteAdmission(admission: StoragePartialWriteAdmission): void {
    this.admission = admission;
  }
  constructor(
    private readonly host: HostContext,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async resolve(
    value: unknown,
    userSignal: AbortSignal,
  ): Promise<string | null> {
    const url = publicThumbnailUrl(value);
    if (!url) return null;
    const name = createHash("sha256").update(url).digest("hex"),
      relative = `library\\thumbnails\\${name}.image`;
    try {
      await lstat(win32.join(this.host.personalRoot, relative));
      const bytes = await readPrivateBytes(this.host, relative, LIMIT);
      return `data:${thumbnailMime(bytes)};base64,${bytes.toString("base64")}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    if (!this.admission) return null;
    const signal = AbortSignal.any([userSignal, AbortSignal.timeout(10000)]);
    let response: Response | undefined;
    let write: StorageWriteLease | undefined;
    try {
      response = await this.fetcher(url, {
        signal,
        redirect: "error",
        credentials: "omit",
        headers: { Accept: "image/jpeg,image/webp" },
      });
      if (!response.ok || !response.body)
        throw new Error("THUMBNAIL_UNAVAILABLE");
      const declared = response.headers.get("content-length");
      if (
        declared !== null &&
        (!/^\d+$/u.test(declared) || Number(declared) > LIMIT)
      )
        throw new Error("THUMBNAIL_INVALID");
      const reader = response.body.getReader(),
        parts: Uint8Array[] = [];
      let count = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const item = await reader.read();
          if (item.done) break;
          count += item.value.length;
          if (count > LIMIT) throw new Error("THUMBNAIL_INVALID");
          parts.push(item.value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const bytes = Buffer.concat(parts),
        mime = thumbnailMime(bytes);
      await this.admission.recoverPartialWrites(relative, signal);
      const temporary = `${relative}.${randomUUID()}.tmp`;
      write = await this.admission.beginPartialWrite(temporary, bytes.length);
      const file = await newPrivateFile(this.host, temporary);
      let birth;
      try {
        const { device, fileId, bornAt } = await file.info();
        birth = { device, fileId, bornAt };
        await write.captureCreated(birth);
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const lease = await this.host.native.acquireMutex("cache");
      if (!lease) throw new Error("LIBRARY_BUSY");
      try {
        signal.throwIfAborted();
        await this.host.directory("library\\thumbnails");
        await this.host.native.validatePath("personal", temporary, "file");
        if (
          JSON.stringify(
            storageBirth(
              await lstat(win32.join(this.host.personalRoot, temporary), {
                bigint: true,
              }),
            ),
          ) !== JSON.stringify(birth)
        )
          throw new Error("STORAGE_WRITE_CHANGED");
        try {
          await lstat(win32.join(this.host.personalRoot, relative));
          const existing = await readPrivateBytes(this.host, relative, LIMIT);
          return `data:${thumbnailMime(existing)};base64,${existing.toString("base64")}`;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const names = (
          await readdir(
            win32.join(this.host.personalRoot, "library\\thumbnails"),
          )
        ).filter((name) => /^[a-f0-9]{64}\.image$/u.test(name));
        if (names.length >= MAX_FILES) {
          const ages = await Promise.all(
            names.map(async (name) => ({
              name,
              at: (
                await lstat(
                  win32.join(
                    this.host.personalRoot,
                    "library\\thumbnails",
                    name,
                  ),
                )
              ).mtimeMs,
            })),
          );
          ages.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
          for (const old of ages.slice(0, names.length - MAX_FILES + 1)) {
            const path = `library\\thumbnails\\${old.name}`;
            await this.host.native.validatePath("personal", path, "file");
            await unlink(win32.join(this.host.personalRoot, path));
          }
        }
        await this.host.native.validatePath("personal", relative, "absent");
        await rename(
          win32.join(this.host.personalRoot, temporary),
          win32.join(this.host.personalRoot, relative),
        );
        await this.host.native.validatePath("personal", relative, "file");
      } finally {
        await this.host.native.releaseMutex(lease);
      }
      return `data:${mime};base64,${bytes.toString("base64")}`;
    } catch {
      return null;
    } finally {
      void response?.body?.cancel().catch(() => {});
      if (write) {
        await write.settle();
        await this.admission!.recoverPartialWrites(
          relative,
          new AbortController().signal,
        );
      }
    }
  }
}
