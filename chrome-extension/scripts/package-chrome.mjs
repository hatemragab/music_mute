import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, mkdtemp, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
export const staticFiles = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "offscreen.html",
  "content.css",
  "musicmute-mark.svg",
  "privacy.html",
  "privacy.css",
  ...[16, 32, 48, 128].map((size) => `icons/icon-${size}.png`),
];
const scripts = ["background", "content", "offscreen", "popup"];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function validateManifest(manifest, version) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (
    manifest.manifest_version !== 3 ||
    manifest.version !== version ||
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version) ||
    !manifest.name ||
    !manifest.description ||
    manifest.description.length > 132 ||
    !same(manifest.permissions, ["nativeMessaging", "offscreen", "storage"]) ||
    !same(manifest.host_permissions, [
      "https://www.youtube.com/*",
      "https://youtube.com/*",
      "http://127.0.0.1/*",
    ]) ||
    manifest.content_scripts?.length !== 1 ||
    !same(manifest.content_scripts[0].matches, [
      "https://www.youtube.com/*",
      "https://youtube.com/*",
    ]) ||
    !same(manifest.content_scripts[0].js, ["content.js"]) ||
    !same(manifest.content_scripts[0].css, ["content.css"]) ||
    manifest.background?.service_worker !== "background.js" ||
    manifest.action?.default_popup !== "popup.html" ||
    manifest.externally_connectable ||
    manifest.web_accessible_resources ||
    manifest.optional_permissions ||
    manifest.optional_host_permissions ||
    manifest.update_url ||
    !manifest.key ||
    manifest.minimum_chrome_version !== "116" ||
    manifest.content_scripts[0].run_at !== "document_idle" ||
    manifest.content_scripts[0].all_frames ||
    manifest.content_security_policy?.extension_pages !==
      "script-src 'self'; object-src 'none'; connect-src 'self' http://127.0.0.1:*; media-src 'self' http://127.0.0.1:*"
  ) {
    throw new Error("STORE_MANIFEST_INVALID");
  }
  for (const size of [16, 32, 48, 128]) {
    if (
      manifest.icons?.[size] !== `icons/icon-${size}.png` ||
      manifest.action.default_icon?.[size] !== manifest.icons[size]
    )
      throw new Error("STORE_ICONS_INVALID");
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Small, deterministic ZIP32 archive, stored entries, fixed 1980 timestamp.
// Names originate only from the explicit allowlist, never a recursive walk.
export function zipFiles(files) {
  const local = [],
    central = [];
  let offset = 0;
  for (const { name, bytes } of [...files].sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  )) {
    if (
      !/^[a-z0-9/.-]+$/.test(name) ||
      name.startsWith("/") ||
      name.split("/").includes("..") ||
      bytes.length > 0xffffffff
    )
      throw new Error("STORE_ARCHIVE_ENTRY_INVALID");
    const filename = Buffer.from(name);
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(33, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function packageChrome() {
  const source = join(root, "src/extension/static");
  const manifest = JSON.parse(
    await readFile(join(source, "manifest.json"), "utf8"),
  );
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  validateManifest(manifest, pkg.version);
  const parent = join(root, "output/chrome-store");
  await mkdir(parent, { recursive: true });
  const output = await mkdtemp(join(parent, `v${pkg.version}-`));
  const unpacked = join(output, "extension");
  await mkdir(unpacked);
  await build({
    entryPoints: scripts.map((name) => `src/extension/${name}.ts`),
    outdir: unpacked,
    platform: "browser",
    target: "chrome116",
    format: "iife",
    bundle: true,
    sourcemap: false,
    absWorkingDir: root,
  });
  for (const name of staticFiles) {
    await mkdir(resolve(unpacked, name, ".."), { recursive: true });
    await cp(join(source, name), join(unpacked, name));
  }
  const files = [];
  for (const name of [
    ...staticFiles,
    ...scripts.map((name) => `${name}.js`),
  ].sort()) {
    const bytes = await readFile(join(unpacked, name));
    if (
      name.endsWith(".js") &&
      /sourceMappingURL=|MM_FIXTURE|\/Users\//.test(bytes.toString())
    )
      throw new Error("STORE_PRIVATE_BUILD_CONTENT");
    if (name.endsWith(".png")) {
      const size = Number(name.match(/icon-(\d+)/)[1]);
      if (
        bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        bytes.readUInt32BE(16) !== size ||
        bytes.readUInt32BE(20) !== size
      )
        throw new Error("STORE_ICON_DIMENSIONS_INVALID");
    }
    files.push({ name, bytes });
  }
  const archive = zipFiles(files);
  const filename = `musicmute-local-${pkg.version}.zip`;
  await writeFile(join(output, filename), archive, { flag: "wx" });
  const report = {
    version: pkg.version,
    archive: filename,
    sha256: hash(archive),
    extension_id: [
      ...createHash("sha256")
        .update(Buffer.from(manifest.key, "base64"))
        .digest()
        .subarray(0, 16),
    ]
      .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
      .join(""),
    public_ready: false,
    remaining_release_gates: [
      "Chrome publisher identity and store extension ID alignment",
      "Hosted privacy policy and companion download",
      "Signed notarized companion and fresh-user installation",
      "Live YouTube source and listening qualification",
      "Chrome Web Store review",
    ],
    files: files.map(({ name, bytes }) => ({
      path: name,
      bytes: bytes.length,
      sha256: hash(bytes),
    })),
  };
  await writeFile(
    join(output, "package-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  return { output, ...report };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  console.log(JSON.stringify(await packageChrome(), null, 2));
}
