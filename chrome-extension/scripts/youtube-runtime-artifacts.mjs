import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export const YOUTUBE_RUNTIME_PINS = Object.freeze({
  deno: {
    version: "2.9.7",
    url: "https://github.com/denoland/deno/releases/download/v2.9.7/deno-aarch64-apple-darwin.zip",
    bytes: 38469316,
    sha256: "5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c",
  },
  provider: {
    version: "2.0.1",
    url: "https://codeload.github.com/Brainicism/bgutil-ytdlp-pot-provider/tar.gz/refs/tags/2.0.1",
    sha256: "bae71b7971fa22376af57edca8d3487724ac9a8ada56d1cccf07a547b4b9b62c",
  },
  canvas: {
    version: "3.2.3",
    url: "https://github.com/Automattic/node-canvas/releases/download/v3.2.3/canvas-v3.2.3-napi-v7-darwin-arm64.tar.gz",
    bytes: 6878351,
    sha256: "38c296c9d81c05598db849fb8103543d6649fec7246c35197d9be8199c75116f",
  },
  deno_source: {
    url: "https://codeload.github.com/denoland/deno/tar.gz/refs/tags/v2.9.7",
    sha256: "28c9677ccee96f9ba0910067d3249fcee90a795063af8a14372769c17a6e1bb2",
  },
  canvas_source: {
    url: "https://codeload.github.com/Automattic/node-canvas/tar.gz/refs/tags/v3.2.3",
    sha256: "22c456e461731d2acdb2f8261ce889127d3430688cd9ff654c4ef4667bd85580",
  },
});
export async function fileDigest(path) {
  const digest = createHash("sha256");
  for await (const data of createReadStream(path)) digest.update(data);
  return digest.digest("hex");
}
export async function youtubeRuntimeInventory(root) {
  const entries = [];
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name),
        key = relative(root, path).split(sep).join("/");
      if (key === "identity.json") continue;
      const info = await lstat(path);
      if (info.mode & 0o022) throw new Error("PO_TOKEN_PROVIDER_INVALID");
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        if (!resolve(directory, target).startsWith(`${resolve(root)}${sep}`))
          throw new Error("PO_TOKEN_PROVIDER_INVALID");
        entries.push({ path: key, link: target });
      } else if (info.isDirectory()) await visit(path);
      else if (info.isFile() && info.nlink === 1)
        entries.push({
          path: key,
          bytes: info.size,
          sha256: await fileDigest(path),
        });
      else throw new Error("PO_TOKEN_PROVIDER_INVALID");
    }
  }
  await visit(root);
  if (entries.length > 30000) throw new Error("PO_TOKEN_PROVIDER_INVALID");
  return entries;
}
// Signing modifies native bytes. Refresh ONLY while constructing the owned app,
// before its outer resource signature seals this generated immutable manifest.
export async function refreshYoutubeRuntimeIdentity(root) {
  const identity = {
    schema_version: 1,
    deno_version: "2.9.7",
    provider_version: "2.0.1",
    platform: "darwin",
    arch: "arm64",
    sources: YOUTUBE_RUNTIME_PINS,
    files: await youtubeRuntimeInventory(root),
  };
  await writeFile(
    join(root, "identity.json"),
    JSON.stringify(identity) + "\n",
    { mode: 0o600 },
  );
  return identity;
}
