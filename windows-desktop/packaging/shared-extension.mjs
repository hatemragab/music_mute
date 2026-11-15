import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildSharedExtension } from "../../chrome-extension/scripts/build-extension.mjs";

export const SHARED_EXTENSION_ID = "acmgefmmndomcpdlgnafkjbgobinllep";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** Fresh exclusive build and a closed immutable payload, never sibling dist. */
export async function stageSharedExtension(destination, readBounded) {
  const info = await lstat(destination);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await readdir(destination)).length
  )
    throw new Error("PACKAGE_EXTENSION_STAGE_INVALID");
  const temporary = await mkdtemp(
    join(dirname(destination), ".extension-build-"),
  );
  try {
    const built = await buildSharedExtension({
      output: join(temporary, "extension"),
      exclusive: true,
      sourcemap: false,
    });
    const id = Array.from(
      sha(Buffer.from(built.manifest.key, "base64")).slice(0, 32),
      (hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)),
    ).join("");
    if (id !== SHARED_EXTENSION_ID)
      throw new Error("PACKAGE_EXTENSION_ID_INVALID");
    // The actual current graph has only owned project source. New external code
    // needs an explicit bundled notice return; silently dropping its license is forbidden.
    if (
      Object.keys(built.metafile.inputs).some((name) =>
        name.replaceAll("\\", "/").includes("node_modules/"),
      )
    )
      throw new Error("PACKAGE_EXTENSION_NOTICE_REQUIRED");
    const entries = [];
    let total = 0;
    for (const name of built.files) {
      const bytes = await readBounded(
        join(temporary, "extension", name),
        8 * 1024 ** 2,
      );
      total += bytes.length;
      if (total > 32 * 1024 ** 2)
        throw new Error("PACKAGE_EXTENSION_STAGE_INVALID");
      if (name.endsWith(".png")) {
        const size = Number(name.match(/icon-(\d+)\.png$/u)?.[1]);
        if (
          bytes.length < 24 ||
          bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
          bytes.readUInt32BE(16) !== size ||
          bytes.readUInt32BE(20) !== size
        )
          throw new Error("PACKAGE_EXTENSION_ASSET_INVALID");
      }
      if (
        name.endsWith(".js") &&
        /sourceMappingURL=|MM_FIXTURE|\/Users\//u.test(bytes.toString("utf8"))
      )
        throw new Error("PACKAGE_EXTENSION_PRIVATE_BUILD_CONTENT");
      await mkdir(resolve(destination, name, ".."), { recursive: true });
      await writeFile(join(destination, name), bytes, { flag: "wx" });
      entries.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
    }
    const notice = Buffer.from(
      "MusicMute shared Chrome extension. Built from current repository source.\nThe audited browser graph bundles no external runtime packages.\nProject redistribution approval and Chrome Web Store delivery are separate release decisions.\n",
    );
    await writeFile(join(destination, "notices.txt"), notice, { flag: "wx" });
    entries.push({
      path: "notices.txt",
      bytes: notice.length,
      sha256: sha(notice),
    });
    const inventory = {
      version: 1,
      extensionId: id,
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    };
    await writeFile(
      join(destination, "inventory.json"),
      JSON.stringify(inventory) + "\n",
      { flag: "wx" },
    );
    return inventory;
  } finally {
    // This exclusive Node-only build folder was created here and never launched.
    await rm(temporary, { recursive: true, force: true });
  }
}
