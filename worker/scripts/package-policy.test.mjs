import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPackageInventory } from "./package-policy.mjs";

const expected = new Set(["package.json", "dist/src/cli/main.js"]);
test("rejects an unbuilt package", () => {
  assert.throws(
    () =>
      assertPackageInventory({ files: [{ path: "package.json" }] }, expected),
    /missing/u,
  );
});
for (const path of [
  ".env",
  "credentials/machine.credential",
  "dist/src/platform/macos/service-manager.js",
  "models/model.onnx",
  "../escape",
]) {
  test(`rejects unexpected package entry ${path}`, () => {
    assert.throws(
      () =>
        assertPackageInventory(
          { files: [...expected, path].map((path) => ({ path })) },
          expected,
        ),
      /unexpected/u,
    );
  });
}
test("accepts only the complete expected inventory", () => {
  assertPackageInventory(
    { files: [...expected].map((path) => ({ path })) },
    expected,
  );
});
