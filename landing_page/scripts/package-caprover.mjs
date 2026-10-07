import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const landingRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const staging = mkdtempSync(join(tmpdir(), "musicmute-landing-caprover-"));
const files = [
  "landing_page/Dockerfile",
  "landing_page/package.json",
  "landing_page/package-lock.json",
  "landing_page/index.html",
  "landing_page/ar/index.html",
  "landing_page/tsconfig.json",
  "landing_page/vite.config.ts",
  "landing_page/server.mjs",
];

function collect(directory) {
  for (const entry of readdirSync(join(repositoryRoot, directory), {
    withFileTypes: true,
  })) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink())
      throw new Error(`Refusing symlink: ${relative}`);
    if (entry.isDirectory()) collect(relative);
    else if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
      files.push(relative);
  }
}

collect("landing_page/public");
collect("landing_page/src");

for (const file of files) {
  if (!lstatSync(join(repositoryRoot, file)).isFile())
    throw new Error(`Expected a regular build input: ${file}`);
  const destination = join(staging, file);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(repositoryRoot, file), destination);
}

copyFileSync(
  join(landingRoot, "captain-definition"),
  join(staging, "captain-definition"),
);
copyFileSync(
  join(landingRoot, ".dockerignore"),
  join(staging, ".dockerignore"),
);

const output = join(staging, "landing-page.tar");
execFileSync(
  "tar",
  [
    "-cf",
    output,
    "-C",
    staging,
    ".dockerignore",
    "captain-definition",
    "landing_page",
  ],
  { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } },
);
console.log(output);
