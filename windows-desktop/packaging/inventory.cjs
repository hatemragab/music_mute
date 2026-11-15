const { lstat, readFile, readdir, open } = require("node:fs/promises");
const { constants } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");

function safeOwnedPath(value) {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part &&
          part !== "." &&
          part !== ".." &&
          !/[ .]$/.test(part) &&
          !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
      )
  );
}
function ownedRemovalScript(files) {
  if (
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > 1024 ||
    files.some((name) => !safeOwnedPath(name)) ||
    new Set(files.map((name) => name.toLowerCase())).size !== files.length
  )
    throw new Error("PACKAGE_INVENTORY_INVALID");
  const directories = new Set();
  for (const file of files)
    for (
      let parent = path.posix.dirname(file);
      parent !== ".";
      parent = path.posix.dirname(parent)
    )
      directories.add(parent);
  // No recursion, wildcard, /REBOOTOK or data-root deletion. Failed owned-file
  // removal aborts; empty-directory failures merely preserve unknown files.
  const lines = ["SetOutPath $TEMP"];
  for (const file of [...files].sort())
    lines.push(
      `\${If} \${FileExists} "$INSTDIR\\${file.replaceAll("/", "\\")}"`,
      "ClearErrors",
      `Delete "$INSTDIR\\${file.replaceAll("/", "\\")}"`,
      "${If} ${Errors}",
      `  Abort "MusicMute could not remove an owned application file. Close it and retry."`,
      "${EndIf}",
      "${EndIf}",
    );
  for (const directory of [...directories].sort(
    (a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a),
  ))
    lines.push(`RMDir "$INSTDIR\\${directory.replaceAll("/", "\\")}"`);
  lines.push('Delete "$INSTDIR\\${UNINSTALL_FILENAME}"', "RMDir $INSTDIR");
  return `${lines.join("\n")}\n`;
}
async function boundedInventoryFile(full, maximum = 512 * 1024 ** 2) {
  const before = await lstat(full, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size < 1n ||
    before.size > BigInt(maximum)
  )
    throw new Error("PACKAGE_INVENTORY_INVALID");
  const file = await open(
    full,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let bytes;
  try {
    const opened = await file.stat({ bigint: true });
    const named = await lstat(full, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.size < 1n ||
      opened.size > BigInt(maximum) ||
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      named.size !== opened.size ||
      opened.size !== before.size
    )
      throw new Error("PACKAGE_INVENTORY_INVALID");
    bytes = Buffer.alloc(Number(opened.size));
    let at = 0;
    while (at < bytes.length) {
      const { bytesRead } = await file.read(
        bytes,
        at,
        Math.min(65536, bytes.length - at),
        at,
      );
      if (!bytesRead) throw new Error("PACKAGE_INVENTORY_INVALID");
      at += bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, at)).bytesRead)
      throw new Error("PACKAGE_INVENTORY_INVALID");
    const after = await file.stat({ bigint: true }),
      current = await lstat(full, { bigint: true });
    for (const snapshot of [after, current])
      if (
        !snapshot.isFile() ||
        snapshot.isSymbolicLink() ||
        snapshot.nlink !== 1n ||
        snapshot.dev !== opened.dev ||
        snapshot.ino !== opened.ino ||
        snapshot.size !== opened.size ||
        snapshot.mtimeNs !== opened.mtimeNs ||
        snapshot.ctimeNs !== opened.ctimeNs
      )
        throw new Error("PACKAGE_INVENTORY_INVALID");
  } finally {
    await file.close();
  }
  return bytes;
}
async function signedPayloadInventory(root) {
  const entries = [];
  let directories = 0;
  const visit = async (folder, prefix, depth) => {
    if (depth > 16 || ++directories > 256)
      throw new Error("PACKAGE_INVENTORY_INVALID");
    const directory = await lstat(folder);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("PACKAGE_INVENTORY_INVALID");
    for (const name of (await readdir(folder)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (!safeOwnedPath(relative))
        throw new Error("PACKAGE_INVENTORY_INVALID");
      const full = path.join(folder, name),
        stat = await lstat(full);
      if (stat.isDirectory() && !stat.isSymbolicLink())
        await visit(full, relative, depth + 1);
      else {
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size < 1 ||
          stat.size > 512 * 1024 ** 2
        )
          throw new Error("PACKAGE_INVENTORY_INVALID");
        const bytes = await boundedInventoryFile(full);
        entries.push({
          path: relative,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
      if (entries.length > 1024) throw new Error("PACKAGE_INVENTORY_INVALID");
    }
  };
  await visit(root, "", 0);
  return entries;
}
const LICENSED_BUILD_ASSETS = [
  [
    "../chrome-extension/macos/Resources/Fonts/NotoSansArabic.ttf",
    "renderer/fonts/NotoSansArabic.ttf",
  ],
  [
    "../chrome-extension/macos/Resources/licenses/noto_sans_arabic_ofl.txt",
    "licenses/noto_sans_arabic_ofl.txt",
  ],
  ["node_modules/electron/LICENSE", "licenses/electron_mit.txt"],
  ["packaging/notices/google-branding.txt", "licenses/google_branding.txt"],
];
async function verifyLicensedBuildAssets(component, distribution) {
  const electron = JSON.parse(
    (
      await boundedInventoryFile(
        path.join(component, "node_modules/electron/package.json"),
        65536,
      )
    ).toString("utf8"),
  );
  if (electron.version !== "44.7.0")
    throw new Error("PACKAGE_BUILDER_VERSION_MISMATCH");
  const result = [];
  for (const [source, relative] of LICENSED_BUILD_ASSETS) {
    const original = await boundedInventoryFile(
      path.resolve(component, source),
      4 * 1024 ** 2,
    );
    const current = await boundedInventoryFile(
      path.join(distribution, relative),
      4 * 1024 ** 2,
    );
    if (!original.equals(current)) throw new Error("PACKAGE_NOTICE_MISSING");
    result.push(relative);
  }
  return result;
}
async function verifyPackagedLicensedAssets(asar, stagedApp) {
  const { extractFile, statFile } = require("@electron/asar");
  const result = [];
  for (const [, relative] of LICENSED_BUILD_ASSETS) {
    const key = `dist/${relative}`,
      archivePath = path.join("dist", ...relative.split("/")),
      expected = await boundedInventoryFile(
        path.join(stagedApp, key),
        4 * 1024 ** 2,
      );
    let actual;
    try {
      const descriptor = statFile(asar, archivePath, false);
      if (
        descriptor.size !== expected.length ||
        descriptor.unpacked ||
        descriptor.link
      )
        throw new Error("invalid");
      actual = extractFile(asar, archivePath);
    } catch {
      throw new Error("PACKAGE_NOTICE_MISSING");
    }
    if (!actual.equals(expected)) throw new Error("PACKAGE_NOTICE_MISSING");
    result.push({
      path: key,
      bytes: actual.length,
      sha256: createHash("sha256").update(actual).digest("hex"),
    });
  }
  return result;
}
const buildOnlyPackages = [
  "sprintf-js",
  "roarr",
  "global-agent",
  "@electron/get",
  "app-builder-lib",
  "dmg-builder",
  "electron-builder",
  "electron-builder-squirrel-windows",
];
function assertRuntimeDependency(reference) {
  if (typeof reference !== "string") throw new Error("PACKAGE_BUILD_INVALID");
  const normalized = reference.replaceAll("\\", "/").toLowerCase();
  const paths = [
    normalized,
    ...normalized.split(/(?:^|\/)node_modules\//).slice(1),
  ];
  if (
    paths.some((name) =>
      buildOnlyPackages.some(
        (dependency) =>
          name === dependency || name.startsWith(`${dependency}/`),
      ),
    )
  )
    throw new Error("PACKAGE_BUILD_ONLY_DEPENDENCY");
}
function assertRuntimeImports(details) {
  if (details?.imports === undefined) return;
  if (!Array.isArray(details.imports)) throw new Error("PACKAGE_BUILD_INVALID");
  for (const imported of details.imports)
    assertRuntimeDependency(imported?.path);
}
function executedBuildGraphs(metafiles) {
  const entries = [
    ["dist/main/main.cjs", "src/main/main.ts"],
    ["dist/preload/index.cjs", "src/preload/index.ts"],
    ["dist/renderer/app.js", "src/renderer/index.tsx"],
    ["dist/agent/browser-host.cjs", "src/agent/browser-host-cli.ts"],
    ["dist/agent/session-agent.cjs", "src/agent/session-agent.ts"],
    ["dist/agent/login-worker.cjs", "src/agent/login-worker.ts"],
    ["dist/agent/personal.cjs", "src/agent/personal.ts"],
    ["dist/agent/fleet.cjs", "src/agent/fleet.ts"],
    ["dist/agent/prepare.cjs", "src/agent/prepare.ts"],
  ];
  if (!Array.isArray(metafiles) || metafiles.length > 32)
    throw new Error("PACKAGE_BUILD_INVALID");
  const selected = entries.map(([name, entry]) => {
    const matches = metafiles.filter(
      (file) =>
        file &&
        file.inputs &&
        typeof file.inputs === "object" &&
        !Array.isArray(file.inputs) &&
        file.outputs &&
        Object.hasOwn(file.outputs, name),
    );
    if (matches.length !== 1) throw new Error("PACKAGE_BUILD_INVALID");
    if (!Object.hasOwn(matches[0].inputs, entry))
      throw new Error("PACKAGE_EXECUTED_ENTRY_UNBOUND");
    return matches[0];
  });
  const mainInputs = Object.keys(selected[0].inputs);
  for (const graph of selected) {
    for (const [name, details] of Object.entries(graph.inputs)) {
      assertRuntimeDependency(name);
      assertRuntimeImports(details);
      if (
        /(?:^|\/)(?:tests?|__tests__|\.env(?:\.[^/]+)?)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$|(?:^|\/)(?:id_rsa|credentials\.json)$/i.test(
          name.replaceAll("\\", "/"),
        )
      )
        throw new Error("PACKAGE_PRIVATE_OR_FIXTURE_INPUT");
    }
    for (const details of Object.values(graph.outputs))
      assertRuntimeImports(details);
  }
  for (const required of [
    "src/main/main.ts",
    "src/main/browser/package-trust.ts",
    "src/main/browser/installer-maintenance.ts",
    "src/main/browser/account-authority.ts",
  ])
    if (!mainInputs.includes(required))
      throw new Error("PACKAGE_EXECUTED_ENTRY_UNBOUND");
  return selected;
}
async function bundledNotices(componentRoot, metafiles) {
  const packages = new Map();
  for (const metafile of executedBuildGraphs(metafiles))
    for (const name of Object.keys(metafile.inputs)) {
      if (!name.replaceAll("\\", "/").includes("node_modules/")) continue;
      let directory = path.dirname(path.resolve(componentRoot, name));
      let found = false;
      for (let i = 0; i < 32; i += 1) {
        try {
          const manifest = JSON.parse(
            await readFile(path.join(directory, "package.json"), "utf8"),
          );
          if (
            typeof manifest.name !== "string" ||
            typeof manifest.version !== "string" ||
            !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(manifest.name)
          )
            throw new Error("PACKAGE_NOTICE_MISSING");
          packages.set(`${manifest.name}@${manifest.version}`, directory);
          found = true;
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
      if (!found) throw new Error("PACKAGE_NOTICE_MISSING");
    }
  const chunks = [
    "Third-party code bundled in MusicMute Local. Runtime/native notices are supplied separately.",
  ];
  for (const [name, directory] of [...packages].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const names = (await readdir(directory))
      .filter((name) =>
        /^(?:licen[sc]e|copying|notice)(?:\.[a-z]+)?$/i.test(name),
      )
      .sort();
    if (!names.length) throw new Error("PACKAGE_NOTICE_MISSING");
    chunks.push(`\n${name}\n`);
    for (const file of names) {
      const full = path.join(directory, file),
        stat = await lstat(full);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 1024 * 1024
      )
        throw new Error("PACKAGE_NOTICE_MISSING");
      chunks.push(
        `${file}\n${new TextDecoder("utf-8", { fatal: true }).decode(await boundedInventoryFile(full, 1024 * 1024))}`,
      );
    }
  }
  const text = `${chunks.join("\n")}\n`;
  if (Buffer.byteLength(text) > 4 * 1024 ** 2)
    throw new Error("PACKAGE_NOTICE_MISSING");
  return text;
}
module.exports = {
  safeOwnedPath,
  ownedRemovalScript,
  signedPayloadInventory,
  executedBuildGraphs,
  bundledNotices,
  verifyLicensedBuildAssets,
  verifyPackagedLicensedAssets,
};
