import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The component commands select only the existing guarded native case set. */
export function nativeCheckArguments(argv) {
  if (
    argv.length !== 5 ||
    !["build", "test"].includes(argv[0]) ||
    argv[4] !== "--acknowledge-windows-phase" ||
    argv
      .slice(1, 4)
      .some(
        (path) =>
          typeof path !== "string" ||
          !isAbsolute(path) ||
          path.length > 4096 ||
          /[\p{Cc}\p{Cf}]/u.test(path),
      )
  )
    throw new Error("ACCEPTANCE_ARGUMENT_INVALID");
  return [
    "run-native",
    ...argv.slice(1, 4),
    argv[0] === "build"
      ? "native-build"
      : "native-build,native-security-fixtures",
    "--acknowledge-windows-phase",
  ];
}

export async function nativeCheckMain(argv) {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("ACCEPTANCE_WINDOWS_PHASE_REQUIRED");
  const invocation = nativeCheckArguments(argv),
    root = resolve(import.meta.dirname, ".."),
    runner = resolve(root, "dist/acceptance/runner.cjs"),
    stat = await lstat(runner);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > 16 * 1024 ** 2
  )
    throw new Error("ACCEPTANCE_FILE_INVALID");
  const { acceptanceMain } = createRequire(import.meta.url)(runner);
  await acceptanceMain(invocation, root);
}

if (
  process.argv[1] &&
  (process.platform === "win32"
    ? resolve(process.argv[1]).toLowerCase() ===
      fileURLToPath(import.meta.url).toLowerCase()
    : resolve(process.argv[1]) === fileURLToPath(import.meta.url))
)
  await nativeCheckMain(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error && /^ACCEPTANCE_[A-Z_]+$/u.test(error.message) ? error.message : "ACCEPTANCE_FAILED"}\n` +
        "Native checks require connected Windows x64, a source build, target.json, approved tools.json v2 and an output folder. No native pass was produced by this error.\n",
    );
    process.exitCode = 2;
  });
