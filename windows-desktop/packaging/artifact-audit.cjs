const { readFile, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { verifySignedPe } = require("./authenticode.cjs");
module.exports = async function auditArtifact(event) {
  if (!event.file || !event.file.endsWith(".exe")) return;
  const stage = process.env.MUSICMUTE_PACKAGE_STAGE;
  if (!stage || !path.isAbsolute(stage))
    throw new Error("PACKAGE_STAGE_REQUIRED");
  const assets = require("../dist/packaging/validate-assets.cjs");
  const index = assets.parsePackagedResourceIndex(
    assets.parsePackageJson(
      await readFile(path.join(stage, "app", "packaged-resources.json")),
    ),
  );
  await verifySignedPe(event.file, index.publisherSha256, "installer");
  // sign-hook audits v26's temporary signed uninstaller before it is deleted.
  const uninstaller = assets.parsePackageJson(
    await readFile(path.join(stage, "installer", "uninstaller-audit.json")),
  );
  if (
    uninstaller.version !== 1 ||
    uninstaller.publisherSha256 !== index.publisherSha256 ||
    !/^[a-f0-9]{64}$/.test(uninstaller.sha256) ||
    !Number.isSafeInteger(uninstaller.bytes) ||
    uninstaller.bytes < 1
  )
    throw new Error("PACKAGE_SIGNATURE_INVALID");
  const payload = assets.parsePackageJson(
    await readFile(path.join(stage, "installer", "payload-inventory.json")),
    1024 * 1024,
  );
  if (
    payload.version !== 1 ||
    payload.payloadSha256 !== index.payloadSha256 ||
    payload.publisherSha256 !== index.publisherSha256 ||
    !Array.isArray(payload.entries)
  )
    throw new Error("PACKAGE_INVENTORY_INVALID");
  const bytes = await readFile(event.file);
  await writeFile(
    `${event.file}.sha256`,
    `${createHash("sha256").update(bytes).digest("hex")}  ${path.basename(event.file)}\n`,
    { flag: "wx" },
  );
  await writeFile(
    `${event.file}.evidence.json`,
    JSON.stringify(
      {
        version: 1,
        appId: index.appId,
        appVersion: index.appVersion,
        payloadSha256: index.payloadSha256,
        installer: {
          filename: path.basename(event.file),
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        publisherSha256: index.publisherSha256,
        uninstaller,
        payload,
        boundary:
          "Windows package/signature audit; installation, Chrome, GPU and publication unverified",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
};
