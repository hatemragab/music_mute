import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCapabilities } from "../src/main/file-capabilities.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function input() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-file-cap-"));
  roots.push(root);
  const path = join(root, "sample.wav");
  await writeFile(path, "fixture-audio");
  return { root, path };
}
it("returns an opaque one-use capability and a trusted open handle", async () => {
  const { path } = await input();
  const registry = new FileCapabilities();
  const selected = await registry.grant(path, "local-generation");
  expect(selected).toMatchObject({ name: "sample.wav", bytes: 13 });
  expect(JSON.stringify(selected)).not.toContain(path);
  await expect(
    registry.consume(selected.capability, "foreign-generation"),
  ).rejects.toThrow("INPUT_CAPABILITY_EXPIRED");
  const consumed = await registry.consume(
    selected.capability,
    "local-generation",
  );
  expect(await consumed.file.readFile("utf8")).toBe("fixture-audio");
  await consumed.file.close();
  await expect(
    registry.consume(selected.capability, "local-generation"),
  ).rejects.toThrow("INPUT_CAPABILITY_EXPIRED");
});
it("rejects replacement, expiry and revoked-owner inputs", async () => {
  const { path } = await input();
  let now = 0;
  const registry = new FileCapabilities(() => now);
  const changed = await registry.grant(path, "a");
  await writeFile(path, "different");
  await expect(registry.consume(changed.capability, "a")).rejects.toThrow(
    "INPUT_CHANGED",
  );
  const expired = await registry.grant(path, "a");
  now += 15 * 60_000;
  await expect(registry.consume(expired.capability, "a")).rejects.toThrow(
    "INPUT_CAPABILITY_EXPIRED",
  );
  const revoked = await registry.grant(path, "a");
  registry.revokeOwner("a");
  await expect(registry.consume(revoked.capability, "a")).rejects.toThrow(
    "INPUT_CAPABILITY_EXPIRED",
  );
});
it("refuses directories and symlinks without deleting source files", async () => {
  const { root, path } = await input();
  const link = join(root, "alias.wav");
  await symlink(path, link);
  const registry = new FileCapabilities();
  await expect(registry.grant(root, "a")).rejects.toThrow("INPUT_UNSAFE");
  await expect(registry.grant(link, "a")).rejects.toThrow("INPUT_UNSAFE");
  expect((await registry.grant(path, "a")).name).toBe("sample.wav");
});
