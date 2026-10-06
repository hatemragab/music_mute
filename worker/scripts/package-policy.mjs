import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

async function filesBelow(root, directory) {
  const entries = await readdir(join(root, directory), {
    recursive: true,
    withFileTypes: true,
  });
  if (entries.some((entry) => entry.isSymbolicLink()))
    throw new Error(`Package source contains links: ${directory}`);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(root, join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
    );
}

export async function expectedPackageFiles(root) {
  const expected = new Set([
    "package.json",
    "dist/package.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "RELEASING.md",
  ]);
  for (const directory of ["src", "protocol"]) {
    for (const source of await filesBelow(root, directory)) {
      if (!source.endsWith(".ts") || source.endsWith(".d.ts")) continue;
      for (const suffix of [".js", ".js.map", ".d.ts"])
        expected.add(`dist/${source.slice(0, -3)}${suffix}`);
    }
  }
  for (const source of await filesBelow(root, "engine/musicmute_engine"))
    if (/^engine\/musicmute_engine\/[a-z_]+\.py$/u.test(source))
      expected.add(source);
  return expected;
}

export function assertPackageInventory(packed, expected) {
  if (!Array.isArray(packed.files))
    throw new Error("npm returned no package inventory");
  const actual = new Set(packed.files.map((file) => file.path));
  const missing = [...expected].filter((path) => !actual.has(path));
  const extra = [...actual].filter((path) => !expected.has(path));
  if (missing.length || extra.length || actual.size !== packed.files.length)
    throw new Error(
      `Unsafe package inventory: missing ${missing.join(", ") || "none"}; unexpected ${extra.join(", ") || "none"}`,
    );
  if (!actual.has("dist/src/cli/main.js"))
    throw new Error("Package executable is missing");
}

export async function inspectPackage(root, packed) {
  const expected = await expectedPackageFiles(root);
  assertPackageInventory(packed, expected);
  for (const path of expected) {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink() || info.size > 5 * 1024 * 1024)
      throw new Error(`Unsafe package file: ${path}`);
    const text = await readFile(join(root, path), "utf8");
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bnpm_[A-Za-z0-9]{36,}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b/u.test(
        text,
      )
    )
      throw new Error(`Credential-like content in package file: ${path}`);
  }
  const manifest = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const compiledManifest = JSON.parse(
    await readFile(join(root, "dist/package.json"), "utf8"),
  );
  if (
    compiledManifest.name !== manifest.name ||
    compiledManifest.version !== manifest.version
  )
    throw new Error(
      "Compiled package identity differs from the public package",
    );
  if (
    manifest.name !== "@music-mute/worker" ||
    manifest.bin?.mw !== "./dist/src/cli/main.js" ||
    manifest.license !== "Apache-2.0" ||
    manifest.publishConfig?.access !== "public" ||
    manifest.publishConfig?.registry !== "https://registry.npmjs.org/" ||
    packed.name !== manifest.name ||
    packed.version !== manifest.version
  )
    throw new Error("Package identity or publication settings are invalid");
  return manifest;
}
