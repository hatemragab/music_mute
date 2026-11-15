const { createHash } = require("node:crypto");
const { readFile, writeFile, lstat } = require("node:fs/promises");
const path = require("node:path");
const { extractFile, getRawHeader } = require("@electron/asar");
const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");
const { verifySignedPe } = require("./authenticode.cjs");
const {
  signedPayloadInventory,
  ownedRemovalScript,
  verifyPackagedLicensedAssets,
} = require("./inventory.cjs");
module.exports = async function afterSign(context) {
  if (
    context.electronPlatformName !== "win32" ||
    context.arch !== 1 ||
    process.platform !== "win32"
  )
    throw new Error("WINDOWS_PACKAGE_MACHINE_REQUIRED");
  const root = context.appOutDir,
    asar = path.join(root, "resources", "app.asar"),
    executable = path.join(root, "MusicMute Local.exe");
  const stage = process.env.MUSICMUTE_PACKAGE_STAGE;
  if (!stage || !path.isAbsolute(stage))
    throw new Error("PACKAGE_STAGE_REQUIRED");
  const assets = require("../dist/packaging/validate-assets.cjs");
  const indexBytes = extractFile(asar, "packaged-resources.json"),
    index = assets.parsePackagedResourceIndex(
      assets.parsePackageJson(indexBytes),
    );
  const wire = await getCurrentFuseWire(executable);
  if (wire.version !== "1") throw new Error("PACKAGE_FUSE_INVALID");
  for (const [option, value] of [
    [FuseV1Options.RunAsNode, 48],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, 48],
    [FuseV1Options.EnableNodeCliInspectArguments, 48],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, 49],
    [FuseV1Options.OnlyLoadAppFromAsar, 49],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, 48],
  ])
    if (wire[option] !== value) throw new Error("PACKAGE_FUSE_INVALID");
  const headerHash = createHash("sha256")
    .update(getRawHeader(asar).headerString)
    .digest("hex");
  await verifySignedPe(
    executable,
    index.publisherSha256,
    "payload",
    headerHash,
  );
  for (const entry of index.entries) {
    const target = path.join(
      root,
      ...(entry.placement === "resources" ? ["resources"] : []),
      ...entry.path.split("/"),
    );
    const stat = await lstat(target),
      bytes = await readFile(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      bytes.length !== entry.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    )
      throw new Error("PACKAGE_STAGE_INVALID");
    if (entry.path.endsWith(".exe"))
      await verifySignedPe(target, index.publisherSha256);
  }
  const bytes = await readFile(executable);
  await writeFile(
    path.join(root, "resources", "native", "account-authority-manifest.json"),
    JSON.stringify({
      version: 1,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      publisherSha256: index.publisherSha256,
    }) + "\n",
    { flag: "wx" },
  );
  const inventory = await signedPayloadInventory(root);
  const licensedAssets = await verifyPackagedLicensedAssets(
    asar,
    path.join(stage, "app"),
  );
  if (
    !inventory.some((entry) => entry.path === "resources/app.asar") ||
    !inventory.some((entry) => entry.path === "MusicMute Local.exe")
  )
    throw new Error("PACKAGE_INVENTORY_INVALID");
  await writeFile(
    path.join(stage, "installer", "payload-inventory.json"),
    JSON.stringify({
      version: 1,
      appVersion: index.appVersion,
      payloadSha256: index.payloadSha256,
      asarHeaderSha256: headerHash,
      publisherSha256: index.publisherSha256,
      entries: inventory,
      licensedAssets,
    }) + "\n",
    { flag: "wx" },
  );
  await writeFile(
    path.join(stage, "installer", "remove-owned-files.nsh"),
    ownedRemovalScript(inventory.map((entry) => entry.path)),
    { flag: "wx" },
  );
};
