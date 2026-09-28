import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { verifyMacRelease } from "../dist/src/platform/macos/release-manifest.js";
import { verifyMacUpdateMetadata } from "../dist/src/platform/macos/update-metadata.js";
import { BUILT_IN_MAC_UPDATE_TRUST } from "../dist/src/platform/macos/user-updater.js";
import { prepareInstallationRelease } from "../dist/src/enrollment/release-archive.js";

// Read-only pre-promotion gate. Never signs, uploads, enrolls or activates.
const [runtimeRoot, archive, evidencePath, signedPath, sequence] =
  process.argv.slice(2);
if (
  process.argv.length !== 7 ||
  !runtimeRoot ||
  !archive ||
  !evidencePath ||
  !signedPath ||
  !/^\d+$/u.test(sequence ?? "")
)
  throw new Error(
    "Usage: node scripts/check-release-candidate.mjs <runtime-directory> <runtime.tar.gz> <package-evidence.json> <signed-update.json> <minimum-sequence>",
  );
const minimumSequence = Number(sequence);
if (!Number.isSafeInteger(minimumSequence) || minimumSequence < 1)
  throw new Error("A positive minimum catalog sequence is required");
const manifest = await verifyMacRelease(resolve(runtimeRoot));
const signed = JSON.parse(await readFile(signedPath, "utf8"));
const metadata = verifyMacUpdateMetadata(signed, {
  publicKeys: BUILT_IN_MAC_UPDATE_TRUST,
  minimumSequence,
});
const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
const packageManifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const runtimePackage = JSON.parse(
  await readFile(join(runtimeRoot, "app/package.json"), "utf8"),
);
if (
  manifest.releaseVersion !== packageManifest.version ||
  runtimePackage.version !== manifest.releaseVersion ||
  evidence.version !== manifest.releaseVersion ||
  metadata.releaseVersion !== manifest.releaseVersion ||
  evidence.schemaVersion !== 1 ||
  evidence.packageSmoke !== "passed" ||
  !/^music-mute-worker-[0-9A-Za-z.+-]+\.tgz$/u.test(evidence.filename ?? "")
)
  throw new Error(
    "CLI, runtime, package evidence and signed catalog must identify the same release",
  );
async function digest(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Artifact must be a regular file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: info.size, sha256: hash.digest("hex") };
}
const runtimeDigest = await digest(archive);
if (
  runtimeDigest.sha256 !== metadata.release.sha256 ||
  runtimeDigest.bytes !== metadata.release.bytes ||
  basename(archive) !== metadata.release.filename
)
  throw new Error("Runtime archive does not match signed catalog metadata");
const packageDigest = await digest(
  join(dirname(resolve(evidencePath)), evidence.filename),
);
if (packageDigest.sha256 !== evidence.sha256)
  throw new Error("npm archive changed after its smoke test");
const temporary = await mkdtemp(join(tmpdir(), "musicmute-candidate-"));
try {
  const prepared = await prepareInstallationRelease({
    archivePath: resolve(archive),
    outputRoot: temporary,
    platform: "darwin-arm64",
    releaseVersion: manifest.releaseVersion,
  });
  const archivedManifest = await verifyMacRelease(prepared.path);
  if (JSON.stringify(archivedManifest) !== JSON.stringify(manifest))
    throw new Error("Runtime directory differs from the signed archive");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      status: "passed",
      version: manifest.releaseVersion,
      sequence: metadata.sequence,
      productionAcceptance: "requires-separate-evidence",
    },
    null,
    2,
  ),
);
