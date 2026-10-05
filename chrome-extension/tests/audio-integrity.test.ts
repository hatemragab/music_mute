import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyPrivateAudio } from "../src/companion/audio-integrity.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mm-integrity-"));
  roots.push(root);
  const path = join(root, "vocals.mp3"),
    data = Buffer.from("verified synthetic vocals");
  await writeFile(path, data, { mode: 0o600 });
  const file = await open(path, "r");
  const reads = vi.spyOn(Object.getPrototypeOf(file), "createReadStream");
  await file.close();
  const digest = createHash("sha256").update(data).digest("hex");
  return {
    root,
    path,
    data,
    digest,
    reads,
    verify: () => verifyPrivateAudio(path, data.length, digest),
  };
}

describe("process-private audio validation receipts", () => {
  it("hashes once across repeated cache layers and still checks the account fence", async () => {
    const e = await fixture();
    expect(await e.verify()).toBe(true);
    expect(await e.verify()).toBe(true);
    expect(await e.verify()).toBe(true);
    expect(e.reads).toHaveBeenCalledTimes(1);
    await expect(
      verifyPrivateAudio(e.path, e.data.length, e.digest, async () => {
        throw new Error("ACCOUNT_CHANGED");
      }),
    ).rejects.toThrow("ACCOUNT_CHANGED");
  });
  it("rehashes after expiration instead of extending trust on every read", async () => {
    const e = await fixture();
    expect(await e.verify()).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
    expect(await e.verify()).toBe(true);
    expect(e.reads).toHaveBeenCalledTimes(2);
  });
  it("rejects changed bytes even when the writer restores size and mtime", async () => {
    const e = await fixture(),
      before = await stat(e.path);
    expect(await e.verify()).toBe(true);
    await writeFile(e.path, Buffer.alloc(e.data.length));
    await utimes(e.path, before.atime, before.mtime);
    expect(await e.verify()).toBe(false);
    expect(e.reads).toHaveBeenCalledTimes(2);
  });
  it("does not reuse evidence across expected checksums or replaced files", async () => {
    const e = await fixture();
    expect(await e.verify()).toBe(true);
    expect(
      await verifyPrivateAudio(e.path, e.data.length, "f".repeat(64)),
    ).toBe(false);
    const replacement = join(e.root, "replacement.mp3");
    await writeFile(replacement, Buffer.alloc(e.data.length), { mode: 0o600 });
    await rename(replacement, e.path);
    expect(await e.verify()).toBe(false);
  });
  it.each(["permissions", "hardlink", "symlink"])(
    "rejects a %s change after verification",
    async (change) => {
      const e = await fixture();
      expect(await e.verify()).toBe(true);
      if (change === "permissions") await chmod(e.path, 0o644);
      else if (change === "hardlink")
        await link(e.path, join(e.root, "alias.mp3"));
      else {
        await rename(e.path, join(e.root, "actual.mp3"));
        await symlink(join(e.root, "actual.mp3"), e.path);
      }
      await expect(e.verify()).rejects.toBeDefined();
    },
  );
});
