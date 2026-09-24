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

const root = fileURLToPath(new URL("../../", import.meta.url));
const staging = mkdtempSync(join(tmpdir(), "musicmute-dashboard-caprover-"));
const files = [
  "dashboard/Dockerfile",
  "dashboard/server-sentry.mjs",
  "dashboard/package.json",
  "dashboard/package-lock.json",
  "dashboard/index.html",
  "dashboard/vite.config.ts",
  "dashboard/vite-environment.ts",
  "dashboard/server.mjs",
  ...readdirSync(join(root, "dashboard"))
    .filter((name) => /^tsconfig.*\.json$/.test(name))
    .map((name) => `dashboard/${name}`),
];

function collect(directory) {
  for (const entry of readdirSync(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
    if (path === "dashboard/src/test") continue;
    if (entry.isDirectory()) collect(path);
    else if (
      !/\.(?:test|spec)\.[jt]sx?$/.test(entry.name) &&
      path !== "dashboard/src/auth/e2e-auth-adapter.ts"
    )
      files.push(path);
  }
}

collect("dashboard/public");
collect("dashboard/src");

for (const file of files) {
  if (!lstatSync(join(root, file)).isFile())
    throw new Error(`Expected a regular build input: ${file}`);
  const destination = join(staging, file);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(root, file), destination);
}
copyFileSync(
  join(root, "dashboard/captain-definition"),
  join(staging, "captain-definition"),
);
copyFileSync(
  join(root, "dashboard/.dockerignore"),
  join(staging, ".dockerignore"),
);

const output = join(staging, "dashboard.tar");
execFileSync(
  "tar",
  [
    "-cf",
    output,
    "-C",
    staging,
    ".dockerignore",
    "captain-definition",
    "dashboard",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  },
);
console.log(output);
