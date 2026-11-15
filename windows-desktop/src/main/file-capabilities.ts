import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";

const MAX_SOURCE_BYTES = 256 * 1024 ** 2;
const LIFETIME_MS = 15 * 60_000;
export interface SelectedInput {
  capability: string;
  name: string;
  bytes: number;
}
interface Entry {
  path: string;
  owner: string;
  expiresAt: number;
  inode: bigint;
  device: bigint;
  bytes: bigint;
  modified: bigint;
}
export class FileCapabilities {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}
  async grant(selectedPath: string, owner: string): Promise<SelectedInput> {
    this.expire();
    if (this.entries.size >= 32 || !owner)
      throw new Error("INPUT_LIMIT_REACHED");
    const named = await lstat(selectedPath);
    if (!named.isFile() || named.isSymbolicLink())
      throw new Error("INPUT_UNSAFE");
    const path = await realpath(selectedPath);
    const file = await open(path, constants.O_RDONLY);
    try {
      const stat = await file.stat({ bigint: true });
      if (
        !stat.isFile() ||
        stat.size < 1n ||
        stat.size > BigInt(MAX_SOURCE_BYTES)
      )
        throw new Error("INPUT_SIZE_UNSUPPORTED");
      const capability = randomUUID();
      this.entries.set(capability, {
        path,
        owner,
        expiresAt: this.now() + LIFETIME_MS,
        inode: stat.ino,
        device: stat.dev,
        bytes: stat.size,
        modified: stat.mtimeNs,
      });
      return {
        capability,
        name: basename(path)
          .replace(/[\p{Cc}\p{Cf}]/gu, "")
          .slice(0, 255),
        bytes: Number(stat.size),
      };
    } finally {
      await file.close();
    }
  }
  async consume(
    capability: string,
    owner: string,
  ): Promise<{ file: FileHandle; name: string; bytes: number }> {
    this.expire();
    const entry = this.entries.get(capability);
    if (!entry || entry.owner !== owner)
      throw new Error("INPUT_CAPABILITY_EXPIRED");
    this.entries.delete(capability);
    const named = await lstat(entry.path);
    if (!named.isFile() || named.isSymbolicLink())
      throw new Error("INPUT_CHANGED");
    const file = await open(entry.path, constants.O_RDONLY);
    try {
      const stat = await file.stat({ bigint: true });
      if (
        !stat.isFile() ||
        stat.ino !== entry.inode ||
        stat.dev !== entry.device ||
        stat.size !== entry.bytes ||
        stat.mtimeNs !== entry.modified
      )
        throw new Error("INPUT_CHANGED");
      return { file, name: basename(entry.path), bytes: Number(stat.size) };
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  revokeOwner(owner: string): void {
    for (const [key, value] of this.entries)
      if (value.owner === owner) this.entries.delete(key);
  }
  revoke(capability: string, owner: string): void {
    if (this.entries.get(capability)?.owner === owner)
      this.entries.delete(capability);
  }
  private expire(): void {
    for (const [key, value] of this.entries)
      if (value.expiresAt <= this.now()) this.entries.delete(key);
  }
}
