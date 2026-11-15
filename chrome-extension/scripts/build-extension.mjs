import { build } from "esbuild";
import { mkdir, lstat, open, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, relative } from "node:path";
import { staticFiles, validateManifest } from "./package-chrome.mjs";

const root = resolve(import.meta.dirname, "..");
export const extensionScripts = [
  "background",
  "content",
  "offscreen",
  "popup",
  "privacy",
];
export const extensionFiles = [
  ...staticFiles,
  ...extensionScripts.map((name) => `${name}.js`),
].sort();

async function sourceFile(path, maximum = 8 * 1024 ** 2) {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size < 1n ||
    before.size > BigInt(maximum)
  )
    throw new Error("EXTENSION_SOURCE_INVALID");
  const file = await open(path, "r");
  try {
    const opened = await file.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs ||
      opened.ctimeNs !== before.ctimeNs
    )
      throw new Error("EXTENSION_SOURCE_CHANGED");
    const bytes = Buffer.alloc(Number(opened.size));
    for (let at = 0; at < bytes.length;) {
      const { bytesRead } = await file.read(
        bytes,
        at,
        Math.min(65536, bytes.length - at),
        at,
      );
      if (!bytesRead) throw new Error("EXTENSION_SOURCE_CHANGED");
      at += bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead)
      throw new Error("EXTENSION_SOURCE_CHANGED");
    for (const after of [
      await file.stat({ bigint: true }),
      await lstat(path, { bigint: true }),
    ])
      if (
        after.isSymbolicLink() ||
        after.nlink !== 1n ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs
      )
        throw new Error("EXTENSION_SOURCE_CHANGED");
    return bytes;
  } finally {
    await file.close();
  }
}

/** Shared Mac/Windows extension build only. No Swift, companion, worker, install,
 * profile, private config or sibling dist input is opened. */
export async function buildSharedExtension({
  output,
  exclusive = false,
  sourcemap = true,
  localDebug = false,
}) {
  if (!isAbsolute(output)) throw new Error("EXTENSION_OUTPUT_INVALID");
  const manifestBytes = await sourceFile(
    join(root, "src/extension/static/manifest.json"),
    32768,
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const pkg = JSON.parse(
    (await sourceFile(join(root, "package.json"), 65536)).toString("utf8"),
  );
  validateManifest(manifest, pkg.version);
  await mkdir(output, exclusive ? undefined : { recursive: true });
  const result = await build({
    entryPoints: extensionScripts.map((name) => `src/extension/${name}.ts`),
    outdir: output,
    platform: "browser",
    target: "chrome116",
    format: "iife",
    bundle: true,
    define: {
      __MUSICMUTE_LOCAL_DEBUG__: JSON.stringify(
        localDebug && process.env.MUSICMUTE_LOG_ENABLED === "1",
      ),
      __MUSICMUTE_LOCAL_PAYLOADS__: JSON.stringify(
        localDebug && process.env.MUSICMUTE_LOG_PAYLOADS === "1",
      ),
      __MUSICMUTE_LOCAL_CONSOLE__: JSON.stringify(
        localDebug && process.env.MUSICMUTE_LOG_CONSOLE === "1",
      ),
    },
    sourcemap,
    metafile: true,
    absWorkingDir: root,
    plugins: [
      {
        name: "public-extension-source-only",
        setup(builder) {
          builder.onLoad({ filter: /.*/ }, (args) => {
            const name = relative(root, args.path).replaceAll("\\", "/");
            if (
              !/^(?:src\/(?:extension|shared)\/|node_modules\/)/u.test(name) ||
              /(?:^|\/)(?:tests?|__tests__|\.env(?:\.[^/]+)?)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/iu.test(
                name,
              )
            )
              throw new Error("EXTENSION_PRIVATE_BUILD_INPUT");
          });
        },
      },
    ],
  });
  for (const name of Object.keys(result.metafile.inputs))
    if (
      !/^(?:src\/(?:extension|shared)\/|node_modules\/)/u.test(
        name.replaceAll("\\", "/"),
      ) ||
      /(?:^|\/)(?:tests?|__tests__|\.env(?:\.[^/]+)?)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/iu.test(
        name,
      )
    )
      throw new Error("EXTENSION_PRIVATE_BUILD_INPUT");
  for (const emitted of Object.values(result.metafile.outputs))
    if (emitted.imports.some((entry) => entry.external))
      throw new Error("EXTENSION_EXTERNAL_BUILD_INPUT");
  for (const name of staticFiles) {
    const bytes =
      name === "manifest.json"
        ? manifestBytes
        : await sourceFile(join(root, "src/extension/static", name));
    await mkdir(resolve(output, name, ".."), { recursive: true });
    await writeFile(join(output, name), bytes);
  }
  return {
    metafile: result.metafile,
    files: [...extensionFiles],
    sourceRoot: root,
    manifest,
  };
}
