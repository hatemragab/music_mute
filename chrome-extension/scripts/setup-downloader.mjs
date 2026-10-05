import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Explicit installation only: no launch-time updates, pip, Homebrew or fleet writes.
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("UNSUPPORTED_PLATFORM");
const root =
  process.env.MUSICMUTE_LOCAL_ROOT ??
  join(homedir(), "Library/Application Support/MusicMuteLocalMvp");
if (!isAbsolute(root)) throw new Error("INVALID_LOCAL_ROOT");
const tools = join(root, "tools");
for (const directory of [root, tools]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await stat(directory)).mode & 0o077)
    throw new Error("LOCAL_DIRECTORY_NOT_PRIVATE");
}
const lockPath = join(tools, ".setup-downloader.lock");
const lock = await open(lockPath, "wx", 0o600).catch(() => {
  throw new Error("DOWNLOADER_SETUP_BUSY");
});
const suffix = randomUUID();
const temporaryBinary = join(tools, `.yt-dlp-${suffix}.download`);
const temporaryIdentity = join(tools, `.yt-dlp-${suffix}.json`);
const destination = join(tools, "yt-dlp");
const identityPath = join(tools, "yt-dlp.identity.json");
const ALLOWED_HOSTS = new Set([
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
const MAX_BINARY_BYTES = 128 * 1024 * 1024;

async function download(url, limit, destinationPath) {
  const abort = new AbortController();
  const lifetime = setTimeout(() => abort.abort(), 300_000);
  let inactivity = setTimeout(() => abort.abort(), 30_000);
  let handle;
  try {
    let response;
    for (let redirects = 0; redirects < 6; redirects++) {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" ||
        !ALLOWED_HOSTS.has(parsed.hostname) ||
        parsed.username ||
        parsed.password
      )
        throw new Error("DOWNLOAD_HOST_INVALID");
      response = await fetch(url, {
        redirect: "manual",
        signal: abort.signal,
        headers: {
          "User-Agent": "MusicMuteLocalMvp-setup/0.1",
          Accept:
            parsed.hostname === "api.github.com"
              ? "application/vnd.github+json"
              : "application/octet-stream",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("DOWNLOAD_REDIRECT_INVALID");
        url = new URL(location, url).href;
        continue;
      }
      break;
    }
    if (!response?.ok || !response.body) throw new Error("DOWNLOAD_FAILED");
    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > limit) throw new Error("DOWNLOAD_LIMIT_EXCEEDED");
    if (destinationPath) handle = await open(destinationPath, "wx", 0o600);
    const chunks = [];
    const hash = createHash("sha256");
    let bytes = 0;
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      clearTimeout(inactivity);
      inactivity = setTimeout(() => abort.abort(), 30_000);
      bytes += value.length;
      if (bytes > limit) {
        abort.abort();
        throw new Error("DOWNLOAD_LIMIT_EXCEEDED");
      }
      hash.update(value);
      if (handle) await handle.write(value);
      else chunks.push(Buffer.from(value));
    }
    if (handle) await handle.sync();
    return {
      bytes,
      sha256: hash.digest("hex"),
      text: handle ? undefined : Buffer.concat(chunks).toString("utf8"),
    };
  } finally {
    clearTimeout(lifetime);
    clearTimeout(inactivity);
    await handle?.close();
  }
}

async function fileIdentity(path) {
  const information = await lstat(path);
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size > MAX_BINARY_BYTES
  )
    throw new Error("DOWNLOADER_IDENTITY_INVALID");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { bytes: information.size, sha256: hash.digest("hex") };
}

try {
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) +
      "\n",
  );
  let prior;
  try {
    prior = JSON.parse(await readFile(identityPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("DOWNLOADER_IDENTITY_INVALID");
  }
  let exists = false;
  try {
    await lstat(destination);
    exists = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (exists) {
    if (
      !prior ||
      prior.source !== "yt-dlp/yt-dlp" ||
      prior.asset !== "yt-dlp_macos" ||
      !/^[a-f0-9]{64}$/.test(prior.sha256)
    )
      throw new Error("FOREIGN_DOWNLOADER_EXISTS");
    const actual = await fileIdentity(destination);
    if (actual.bytes !== prior.bytes || actual.sha256 !== prior.sha256)
      throw new Error("DOWNLOADER_IDENTITY_INVALID");
  }
  console.log("Resolving the official yt-dlp stable release.");
  const release = JSON.parse(
    (
      await download(
        "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
        1024 * 1024,
      )
    ).text,
  );
  const version = release.tag_name;
  if (
    !/^20\d{2}\.\d{2}\.\d{2}$/.test(version) ||
    release.draft ||
    release.prerelease ||
    !Array.isArray(release.assets)
  )
    throw new Error("RELEASE_METADATA_INVALID");
  const asset = release.assets.find((item) => item.name === "yt-dlp_macos");
  const sums = release.assets.find((item) => item.name === "SHA2-256SUMS");
  const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/`;
  if (
    !asset ||
    !sums ||
    asset.browser_download_url !== base + "yt-dlp_macos" ||
    sums.browser_download_url !== base + "SHA2-256SUMS" ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > MAX_BINARY_BYTES
  )
    throw new Error("RELEASE_ASSET_INVALID");
  const checksums = (await download(sums.browser_download_url, 1024 * 1024))
    .text;
  const expected = /^([a-fA-F0-9]{64})\s+\*?yt-dlp_macos\s*$/m
    .exec(checksums)?.[1]
    ?.toLowerCase();
  if (!expected || (asset.digest && asset.digest !== `sha256:${expected}`))
    throw new Error("RELEASE_CHECKSUM_INVALID");
  if (exists && prior.version === version && prior.sha256 === expected) {
    console.log(
      JSON.stringify({
        ready: true,
        cached: true,
        version,
        sha256: expected,
        bytes: prior.bytes,
      }),
    );
  } else {
    console.log(`Downloading yt-dlp ${version} (${asset.size} bytes).`);
    const actual = await download(
      asset.browser_download_url,
      MAX_BINARY_BYTES,
      temporaryBinary,
    );
    if (actual.bytes !== asset.size || actual.sha256 !== expected)
      throw new Error("DOWNLOADER_CHECKSUM_MISMATCH");
    await chmod(temporaryBinary, 0o700);
    const { stdout } = await promisify(execFile)(
      temporaryBinary,
      ["--ignore-config", "--no-plugin-dirs", "--version"],
      {
        timeout: 30_000,
        maxBuffer: 32 * 1024,
        env: {
          HOME: homedir(),
          PATH: "/usr/bin:/bin",
          TMPDIR: tools,
          LANG: "en_US.UTF-8",
        },
      },
    );
    if (stdout.trim() !== version)
      throw new Error("DOWNLOADER_VERSION_MISMATCH");
    const identity = {
      schema_version: 1,
      source: "yt-dlp/yt-dlp",
      asset: "yt-dlp_macos",
      version,
      sha256: expected,
      bytes: actual.bytes,
      installed_at: new Date().toISOString(),
    };
    await writeFile(
      temporaryIdentity,
      JSON.stringify(identity, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    await rename(temporaryBinary, destination);
    await rename(temporaryIdentity, identityPath);
    console.log(
      JSON.stringify({
        ready: true,
        cached: false,
        version,
        sha256: expected,
        bytes: actual.bytes,
      }),
    );
  }
} finally {
  for (const file of [temporaryBinary, temporaryIdentity])
    await unlink(file).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  await lock.close();
  await unlink(lockPath);
}
