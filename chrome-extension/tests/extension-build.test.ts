import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
const { buildSharedExtension, extensionFiles } = (await import(
  new URL("../scripts/build-extension.mjs", import.meta.url).href
)) as {
  extensionFiles: string[];
  buildSharedExtension(options: {
    output: string;
    exclusive?: boolean;
    sourcemap?: boolean;
  }): Promise<{
    files: string[];
    manifest: { key: string };
    metafile: { inputs: Record<string, unknown> };
  }>;
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("builds the complete same shared extension from current source without Mac/native/worker or stale dist inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "musicmute-shared-extension-"));
  roots.push(root);
  const first = join(root, "first"),
    second = join(root, "second");
  const a = await buildSharedExtension({
    output: first,
    exclusive: true,
    sourcemap: false,
  });
  const b = await buildSharedExtension({
    output: second,
    exclusive: true,
    sourcemap: false,
  });
  expect(a.files).toEqual(extensionFiles);
  expect(a.files).toHaveLength(19);
  for (const name of a.files)
    expect(await readFile(join(first, name))).toEqual(
      await readFile(join(second, name)),
    );
  expect(a.manifest.key).toBe(b.manifest.key);
  expect(
    Object.keys(a.metafile.inputs).every((name) =>
      /^src\/(extension|shared)\//.test(name),
    ),
  ).toBe(true);
  expect(Object.keys(a.metafile.inputs).join()).not.toMatch(
    /dist\/|companion\/|worker\/|macos\/|\.env|profile/,
  );
  expect(await readdir(first)).not.toContain("background.js.map");
  expect(await readFile(join(first, "manifest.json"))).toEqual(
    await readFile(
      new URL("../src/extension/static/manifest.json", import.meta.url),
    ),
  );
  await writeFile(join(first, "stale-private.json"), "must not be inherited");
  await expect(
    buildSharedExtension({ output: first, exclusive: true, sourcemap: false }),
  ).rejects.toMatchObject({ code: "EEXIST" });
});
it("retains default development source maps and rejects relative output rather than altering installed app data", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "musicmute-shared-extension-maps-"),
  );
  roots.push(root);
  await buildSharedExtension({
    output: join(root, "extension"),
    exclusive: true,
  });
  expect(await readdir(join(root, "extension"))).toContain("background.js.map");
  await expect(
    buildSharedExtension({ output: "relative-extension" }),
  ).rejects.toThrow("EXTENSION_OUTPUT_INVALID");
});
