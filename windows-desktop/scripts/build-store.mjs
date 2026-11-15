import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
async function main() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("WINDOWS_STORE_BUILD_REQUIRED");
  const arguments_ = process.argv.slice(2);
  const verification = arguments_[0] === "--verify";
  const [inputsPath, newStage] = verification
    ? arguments_.slice(1)
    : arguments_;
  if (
    arguments_.length !== (verification ? 3 : 2) ||
    !inputsPath ||
    !newStage ||
    resolve(inputsPath) !== inputsPath ||
    resolve(newStage) !== newStage
  )
    throw new Error("STORE_BUILD_ARGUMENT_INVALID");
  // Builder dependencies resolve from this exclusive source-local scratch, not
  // ambient NODE_PATH or a sibling's stale dist. No consumer execution occurs.
  const temporary = await mkdtemp(join(root, ".store-builder-"));
  try {
    const entry = join(temporary, "store-build.mjs");
    await build({
      entryPoints: [join(root, "packaging/store/build.ts")],
      outfile: entry,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      target: "node24",
      sourcemap: false,
      logLevel: "silent",
    });
    for (const name of ["CMakeLists.txt", "pack.cmake"])
      await copyFile(
        join(root, "packaging/store", name),
        join(temporary, name),
      );
    const {
      readStoreBuildInputsFile,
      prepareStorePackages,
      verifyPreparedStorePackages,
    } = await import(pathToFileURL(entry).href);
    const receipt = await (
      verification ? verifyPreparedStorePackages : prepareStorePackages
    )(await readStoreBuildInputsFile(inputsPath), root, newStage);
    process.stdout.write(
      JSON.stringify({
        status: verification
          ? "unsigned-upload-archives-readback-verified"
          : "audited-upload-inputs-staged",
        packed: verification ? true : receipt.packed,
        installable: false,
        releaseReady: false,
        paidSigning: false,
        next: verification
          ? "namespace-and-store-certification-pending"
          : "approved-qa-cmake-pack",
      }) + "\n",
    );
  } finally {
    await rm(temporary, { recursive: true });
  }
}
main().catch((error) => {
  const message = error instanceof Error ? error.message : "STORE_BUILD_FAILED";
  const code = /^[A-Z_]+$/u.test(message) ? message : "STORE_BUILD_FAILED";
  process.stderr.write(
    JSON.stringify({
      status: "failed",
      code,
      ...(code === "STORE_INPUTS_MISSING"
        ? { role: error.role, missing: error.missing }
        : {}),
    }) + "\n",
  );
  process.exitCode = 2;
});
