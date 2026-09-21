import { basename, relative, sep } from "node:path";

const DEVELOPMENT_DIRECTORIES = new Set([
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "cmake",
  "doc",
  "docs",
  "include",
  "includes",
  "test",
  "tests",
]);

const DEVELOPMENT_SUFFIXES = [
  ".a",
  ".la",
  ".lib",
  ".pdb",
  ".pyc",
  ".pyo",
] as const;

export function shouldCopyReleaseTreeEntry(
  sourceRoot: string,
  candidate: string,
): boolean {
  const path = relative(sourceRoot, candidate);
  if (path.length === 0) return true;
  const segments = path.split(sep);
  if (
    segments.some((segment) =>
      DEVELOPMENT_DIRECTORIES.has(segment.toLowerCase()),
    )
  )
    return false;
  const name = basename(path).toLowerCase();
  return (
    name !== ".ds_store" &&
    !DEVELOPMENT_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}
