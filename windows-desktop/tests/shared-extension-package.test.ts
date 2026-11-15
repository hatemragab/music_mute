import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { packageFile } from "../packaging/validate-assets.js";
import {
  verifiedExtensionFolder,
  BUNDLED_EXTENSION_FILES,
  BUNDLED_EXTENSION_ID,
} from "../src/main/setup-assistance/extension.js";
const { stageSharedExtension } = (await import(
  new URL("../packaging/shared-extension.mjs", import.meta.url).href
)) as {
  stageSharedExtension(
    destination: string,
    read: (path: string, maximum: number) => Promise<Buffer>,
  ): Promise<{
    version: 1;
    extensionId: string;
    entries: { path: string; bytes: number; sha256: string }[];
  }>;
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-extension-stage-"));
  roots.push(root);
  const extension = join(root, "extension");
  await mkdir(extension);
  return { root, extension };
}
it("stages the real full source-built extension with unchanged identity, closed asset hashes/notices and no source maps or private state", async () => {
  const f = await fixture(),
    inventory = await stageSharedExtension(f.extension, packageFile);
  expect(inventory.extensionId).toBe(BUNDLED_EXTENSION_ID);
  expect(inventory.entries.map((e) => e.path).sort()).toEqual(
    BUNDLED_EXTENSION_FILES,
  );
  for (const entry of inventory.entries) {
    const bytes = await readFile(join(f.extension, entry.path));
    expect(bytes.length).toBe(entry.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
  }
  expect(await readFile(join(f.extension, "notices.txt"), "utf8")).toContain(
    "no external runtime packages",
  );
  expect(
    await verifiedExtensionFolder(f.root, new AbortController().signal),
  ).toBe(f.extension);
  expect(await readdir(f.root)).toEqual(["extension"]);
  await expect(stageSharedExtension(f.extension, packageFile)).rejects.toThrow(
    "PACKAGE_EXTENSION_STAGE_INVALID",
  );
});
it.each(["altered", "missing", "extra", "link"] as const)(
  "refuses %s shared payload before reveal/copy can trust the folder",
  async (fault) => {
    const f = await fixture();
    await stageSharedExtension(f.extension, packageFile);
    if (fault === "altered")
      await writeFile(
        join(f.extension, "background.js"),
        "foreign changed script",
      );
    if (fault === "missing") await rm(join(f.extension, "popup.html"));
    if (fault === "extra")
      await writeFile(
        join(f.extension, "private-config.json"),
        "not authorized",
      );
    if (fault === "link") {
      await rm(join(f.extension, "privacy.html"));
      await symlink(
        join(f.extension, "popup.html"),
        join(f.extension, "privacy.html"),
      );
    }
    await expect(
      verifiedExtensionFolder(f.root, new AbortController().signal),
    ).rejects.toThrow();
  },
);
it("refuses manifest-only old payload and refuses receiver inventory tampering even when source names seem complete", async () => {
  const f = await fixture();
  await writeFile(
    join(f.extension, "manifest.json"),
    await readFile(
      new URL(
        "../../chrome-extension/src/extension/static/manifest.json",
        import.meta.url,
      ),
    ),
  );
  await expect(
    verifiedExtensionFolder(f.root, new AbortController().signal),
  ).rejects.toThrow();
  await rm(join(f.extension, "manifest.json"));
  const inventory = await stageSharedExtension(f.extension, packageFile);
  inventory.entries[0]!.path = "../private.json";
  await writeFile(
    join(f.extension, "inventory.json"),
    JSON.stringify(inventory),
  );
  await expect(
    verifiedExtensionFolder(f.root, new AbortController().signal),
  ).rejects.toThrow("SETUP_ASSISTANCE_UNAVAILABLE");
});
