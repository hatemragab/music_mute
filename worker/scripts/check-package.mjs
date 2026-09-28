import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { inspectPackage } from "./package-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const result = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  }),
);
if (result.length !== 1) throw new Error("Expected exactly one npm package");
await inspectPackage(root, result[0]);
console.log(
  `Package inventory verified: ${result[0].files.length} files, ${result[0].size} bytes`,
);
