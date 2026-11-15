import { mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
async function main() {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("WINDOWS_STORE_BUILD_REQUIRED");
  const arguments_ = process.argv.slice(2);
  const [inputsPath, newStage] = arguments_;
  if (
    arguments_.length !== 2 ||
    !inputsPath ||
    !newStage ||
    resolve(inputsPath) !== inputsPath ||
    resolve(newStage) !== newStage
  )
    throw new Error("STORE_GUI_ARGUMENT_INVALID");
  // Root runs this fixed source-built CLI inside the approved owned Windows QA
  // Job. Packages resolve from this source-local scratch, never NODE_PATH or a
  // sibling's dist. The Electron framework is an explicit primary-pinned ZIP.
  const temporary = await mkdtemp(join(root, ".store-builder-"));
  try {
    const entry = join(temporary, "store-gui-build.mjs");
    await build({
      entryPoints: [join(root, "packaging/store/gui.ts")],
      outfile: entry,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      target: "node24",
      sourcemap: false,
      logLevel: "silent",
    });
    const { readStoreGuiBuildInputsFile, buildStoreGuiDirectory } =
      await import(pathToFileURL(entry).href);
    const receipt = await buildStoreGuiDirectory(
      await readStoreGuiBuildInputsFile(inputsPath),
      root,
      newStage,
    );
    process.stdout.write(
      JSON.stringify({
        status: "unsigned-store-gui-directory-audited",
        electronDirectoryBuilt: receipt.electronDirectoryBuilt,
        frameworkClosureReadback: receipt.frameworkClosureReadback,
        appBuildNumber: receipt.appBuildNumber,
        installable: false,
        releaseReady: false,
        functionalStoreFlowsVerified: false,
        paidSigning: false,
        published: false,
      }) + "\n",
    );
  } finally {
    await rm(temporary, { recursive: true });
  }
}
main().catch((error) => {
  const message =
    error instanceof Error ? error.message : "STORE_GUI_BUILD_FAILED";
  process.stderr.write(
    JSON.stringify({
      status: "failed",
      code: /^[A-Z_]+$/u.test(message) ? message : "STORE_GUI_BUILD_FAILED",
    }) + "\n",
  );
  process.exitCode = 2;
});
