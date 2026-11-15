import {
  mkdtemp,
  writeFile,
  realpath,
  link,
  symlink,
  mkdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readStoreProtectedBytes } from "../src/main/session/store-protected-read.js";

const roots: string[] = [];
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "musicmute-store-read-")),
  );
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe("Store read-only receiving file policy", () => {
  it("reads stable package-style hardlinked bytes without granting native authority", async () => {
    const root = await fixture(),
      source = join(root, "inventory.json"),
      second = join(root, "linked-inventory.json");
    await writeFile(source, "protected-census");
    await link(source, second);
    expect(await readStoreProtectedBytes(source, 1024)).toEqual(
      Buffer.from("protected-census"),
    );
    expect(await readStoreProtectedBytes(second, 1024)).toEqual(
      Buffer.from("protected-census"),
    );
  });
  it("rejects symbolic file and ancestor aliases", async () => {
    const root = await fixture(),
      folder = join(root, "real"),
      alias = join(root, "alias");
    await mkdir(folder);
    await writeFile(join(folder, "inventory.json"), "census");
    await symlink(folder, alias, "dir");
    await expect(
      readStoreProtectedBytes(join(alias, "inventory.json"), 1024),
    ).rejects.toThrow("STORE_PROTECTED_READ_DENIED");
    const leaf = join(root, "alias.json");
    await symlink(join(folder, "inventory.json"), leaf);
    await expect(readStoreProtectedBytes(leaf, 1024)).rejects.toThrow(
      "STORE_PROTECTED_READ_DENIED",
    );
  });
  it("rejects empty, oversized, directory, relative and invalid-limit inputs", async () => {
    const root = await fixture(),
      empty = join(root, "empty.json"),
      file = join(root, "inventory.json");
    await writeFile(empty, "");
    await writeFile(file, "census");
    for (const [path, maximum] of [
      [empty, 1024],
      [file, 1],
      [root, 1024],
      ["inventory.json", 1024],
      [file, 0],
      [file, 1.5],
      [file, 8 * 1024 ** 2 + 1],
    ] as const)
      await expect(readStoreProtectedBytes(path, maximum)).rejects.toThrow(
        "STORE_PROTECTED_READ_DENIED",
      );
  });
});
