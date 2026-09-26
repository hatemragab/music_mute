import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [
  "captain-definition",
  ".dockerignore",
  "Dockerfile",
  "package.json",
  "package-lock.json",
  "index.html",
  "tsconfig.json",
  "vite.config.ts",
  "server.mjs",
];

function collect(directory) {
  for (const entry of readdirSync(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = `${directory}/${entry.name}`;
    if (path === "src/tests") continue;
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
    if (entry.isDirectory()) collect(path);
    else if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) files.push(path);
  }
}

collect("src");
collect("public");
for (const file of files) {
  if (!lstatSync(join(root, file)).isFile()) {
    throw new Error(`Expected a regular build input: ${file}`);
  }
}

const output = join(
  mkdtempSync(join(tmpdir(), "musicmute-web-caprover-")),
  "web.tar",
);
execFileSync("tar", ["-cf", output, "-C", root, ...files.sort()], {
  stdio: "inherit",
  env: { ...process.env, COPYFILE_DISABLE: "1" },
});
console.log(output);
