import { build } from "esbuild";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
test("renderer is self-contained and cannot import Node, Electron or trusted services", async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/renderer/index.tsx"],
    bundle: true,
    platform: "browser",
    outdir: "dist/fixture-renderer",
    write: false,
    metafile: true,
    loader: { ".ttf": "file" },
    assetNames: "fonts/[name]",
  });
  for (const path of Object.keys(result.metafile.inputs)) {
    assert.ok(!/src\/(main|companion)\//.test(path), path);
    assert.ok(!/worker\/|chrome-extension\/src\/companion\//.test(path), path);
  }
  for (const output of Object.values(result.metafile.outputs))
    for (const imported of output.imports) {
      assert.notEqual(imported.external, true);
      assert.ok(imported.path.endsWith("/fonts/NotoSansArabic.ttf"));
      assert.ok(result.metafile.outputs[imported.path]);
    }
});
test("preload exposes only the typed bridge and keeps Electron external", async () => {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/preload/index.ts"],
    bundle: true,
    platform: "node",
    external: ["electron"],
    write: false,
    metafile: true,
  });
  assert.ok(
    Object.keys(result.metafile.inputs).every(
      (path) => !/src\/main\/|worker\//.test(path),
    ),
  );
  assert.ok(
    Object.values(result.metafile.outputs).every((output) =>
      output.imports.every((i) => i.path === "electron"),
    ),
  );
});
