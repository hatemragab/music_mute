const { createHash } = require("node:crypto");
const PINNED_BUILDER_FUNCTIONS = Object.freeze({
  computeFinalScript:
    "96dc0a53f6dfe745b9bee5e615f0a692b683f3b14a15c829ed048c1aaed1accc",
  doSign: "261ebdc62f133f7440fd1ea12ecfa0b1e0ab0401dcd498b6c3a5ccab9b47e206",
});
function assertPinnedBuilderFunction(name, fn) {
  if (
    require("app-builder-lib/package.json").version !== "26.15.3" ||
    typeof fn !== "function" ||
    !Object.hasOwn(PINNED_BUILDER_FUNCTIONS, name) ||
    createHash("sha256")
      .update(fn.toString().replaceAll("\r\n", "\n"))
      .digest("hex") !== PINNED_BUILDER_FUNCTIONS[name]
  )
    throw new Error("PACKAGE_BUILDER_VERSION_MISMATCH");
}
module.exports = { assertPinnedBuilderFunction };
