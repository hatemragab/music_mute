import { lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");
const info = await lstat(output).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (info && (!info.isDirectory() || info.isSymbolicLink()))
  throw new Error("Refusing to clean an unsafe build directory");
await rm(output, { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.build.json",
  ],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
