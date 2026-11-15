const { readFile, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { verifySignedPe } = require("./authenticode.cjs");
const { assertPinnedBuilderFunction } = require("./builder-compat.cjs");

/** v26.15.3 deletes its temporary signed uninstaller before the artifact hook.
 * Delegate its configured real signer, then audit the exact file before embed. */
module.exports = async function signAndAudit(configuration, packager) {
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    configuration.hash !== "sha256" ||
    !configuration.cscInfo
  )
    throw new Error("PACKAGE_SIGNING_CONFIGURATION_REQUIRED");
  if (require("app-builder-lib/package.json").version !== "26.15.3")
    throw new Error("PACKAGE_BUILDER_VERSION_MISMATCH");
  const stage = process.env.MUSICMUTE_PACKAGE_STAGE;
  if (!stage || !path.isAbsolute(stage))
    throw new Error("PACKAGE_STAGE_REQUIRED");
  const assets = require("../dist/packaging/validate-assets.cjs");
  const index = assets.parsePackagedResourceIndex(
    assets.parsePackageJson(
      await readFile(path.join(stage, "app", "packaged-resources.json")),
    ),
  );
  const manager = await packager.signingManager.value;
  assertPinnedBuilderFunction("doSign", manager.doSign);
  await manager.doSign(configuration, packager);
  if (path.basename(configuration.path).endsWith("__uninstaller.exe")) {
    await verifySignedPe(
      configuration.path,
      index.publisherSha256,
      "installer",
    );
    const bytes = await readFile(configuration.path);
    await writeFile(
      path.join(stage, "installer", "uninstaller-audit.json"),
      JSON.stringify({
        version: 1,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        publisherSha256: index.publisherSha256,
      }) + "\n",
      { flag: "wx" },
    );
  }
};
