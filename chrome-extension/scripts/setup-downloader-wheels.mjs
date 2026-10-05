import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

// Explicit build/development preparation only; no runtime package installer.
const PINS = [
  {
    project: "bgutil-ytdlp-pot-provider",
    pypi_version: "2.0.1",
    version: "2.0.1",
    file: "bgutil_ytdlp_pot_provider-2.0.1-py3-none-any.whl",
    bytes: 12777,
    sha256: "ff6c2e85443e0777e2483e4a5ef2084ca745a1dd3cc07cf355ddd3a77bd882e8",
    url: "https://files.pythonhosted.org/packages/d7/8c/e084842878d23b89c7a263a0c0a29a31b256b61289193979fc192db0aec1/bgutil_ytdlp_pot_provider-2.0.1-py3-none-any.whl",
  },
  {
    project: "yt-dlp",
    pypi_version: "2026.8.19",
    version: "2026.08.19",
    file: "yt_dlp-2026.8.19-py3-none-any.whl",
    bytes: 3_185_533,
    sha256: "1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf",
    url: "https://files.pythonhosted.org/packages/69/b2/8cd1613f56eed7ceb64fbd4df3f1c01246bfb098e6f398228bafda22b80b/yt_dlp-2026.8.19-py3-none-any.whl",
  },
  {
    project: "yt-dlp-ejs",
    pypi_version: "0.8.0",
    version: "0.8.0",
    file: "yt_dlp_ejs-0.8.0-py3-none-any.whl",
    bytes: 53_443,
    sha256: "79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4",
    url: "https://files.pythonhosted.org/packages/e3/bd/520769863744b669440a924271a6159ddd82ad5ae26b4ac4d4b69e9f8d44/yt_dlp_ejs-0.8.0-py3-none-any.whl",
  },
];
const target =
  process.env.MUSICMUTE_LOCAL_DOWNLOADER_TARGET ??
  join(
    homedir(),
    "Library/Application Support/MusicMuteLocalMvp/tools/downloader",
  );
const source = resolve(
  import.meta.dirname,
  "../engine/downloader_bootstrap.py",
);
const uid = process.getuid();
const allowedEntries = [
  "downloader_bootstrap.py",
  "identity.json",
  ...PINS.map((pin) => pin.file),
].sort();
const safeCode = (error) =>
  /^[A-Z][A-Z_]{1,63}$/.test(error?.message ?? "")
    ? error.message
    : "DOWNLOADER_SETUP_FAILED";
const fail = (code) => {
  throw new Error(code);
};

async function safeInformation(path, directory = false) {
  const information = await lstat(path);
  if (
    (directory ? !information.isDirectory() : !information.isFile()) ||
    information.isSymbolicLink() ||
    information.uid !== uid ||
    information.mode & 0o022 ||
    (!directory && information.nlink !== 1)
  )
    fail("DOWNLOADER_IDENTITY_INVALID");
  return information;
}

async function ensureParent(path) {
  // Traverse existing directories without following a symlink. System-owned
  // ancestors are allowed; the final parent must belong to this user.
  const parsed = parse(path);
  let current = parsed.root;
  const parts = path.slice(parsed.root.length).split("/").filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const information = await lstat(current);
    if (
      !information.isDirectory() ||
      information.isSymbolicLink() ||
      information.mode & 0o022 ||
      ![0, uid].includes(information.uid)
    )
      fail("DOWNLOADER_DIRECTORY_INVALID");
  }
  await safeInformation(path, true);
}

async function fileIdentity(path, limit) {
  const before = await safeInformation(path);
  if (before.size > limit) fail("DOWNLOADER_IDENTITY_INVALID");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1
    )
      fail("DOWNLOADER_IDENTITY_INVALID");
    const data = await handle.readFile();
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      fail("DOWNLOADER_IDENTITY_INVALID");
    return {
      data,
      bytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path, data) {
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function transfer(url, limit) {
  const abort = new AbortController();
  const lifetime = setTimeout(() => abort.abort(), 60_000);
  let inactivity = setTimeout(() => abort.abort(), 15_000);
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !["pypi.org", "files.pythonhosted.org"].includes(parsed.hostname) ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash
    )
      fail("DOWNLOADER_SOURCE_INVALID");
    const response = await fetch(url, {
      redirect: "error",
      signal: abort.signal,
      headers: { "User-Agent": "MusicMuteLocal-wheel-setup/0.1" },
    });
    if (
      !response.ok ||
      !response.body ||
      Number(response.headers.get("content-length")) > limit
    )
      fail("DOWNLOADER_DOWNLOAD_FAILED");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      clearTimeout(inactivity);
      inactivity = setTimeout(() => abort.abort(), 15_000);
      bytes += chunk.length;
      if (bytes > limit) fail("DOWNLOADER_DOWNLOAD_LIMIT");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(lifetime);
    clearTimeout(inactivity);
  }
}

async function validPrior(bootstrap) {
  await safeInformation(target, true);
  if (
    JSON.stringify((await readdir(target)).sort()) !==
    JSON.stringify(allowedEntries)
  )
    fail("FOREIGN_DOWNLOADER_EXISTS");
  const raw = await fileIdentity(join(target, "identity.json"), 16 * 1024);
  let identity;
  try {
    identity = JSON.parse(raw.data.toString("utf8"));
  } catch {
    fail("DOWNLOADER_IDENTITY_INVALID");
  }
  if (
    identity.schema_version !== 1 ||
    identity.source !== "yt-dlp/yt-dlp" ||
    identity.asset !== "python-wheels" ||
    identity.version !== "2026.08.19" ||
    identity.bootstrap?.file !== "downloader_bootstrap.py" ||
    identity.bootstrap.bytes !== bootstrap.bytes ||
    identity.bootstrap.sha256 !== bootstrap.sha256 ||
    !Array.isArray(identity.wheels) ||
    identity.wheels.length !== PINS.length
  )
    fail("DOWNLOADER_IDENTITY_INVALID");
  for (const pin of [
    {
      file: "downloader_bootstrap.py",
      bytes: bootstrap.bytes,
      sha256: bootstrap.sha256,
    },
    ...PINS,
  ]) {
    const actual = await fileIdentity(join(target, pin.file), pin.bytes);
    if (actual.bytes !== pin.bytes || actual.sha256 !== pin.sha256)
      fail("DOWNLOADER_IDENTITY_INVALID");
    if (
      pin.version &&
      !identity.wheels.some(
        (item) =>
          item.file === pin.file &&
          item.bytes === pin.bytes &&
          item.sha256 === pin.sha256 &&
          item.version === pin.version,
      )
    )
      fail("DOWNLOADER_IDENTITY_INVALID");
  }
  // Never echo arbitrary fields from an on-disk identity file.
  return {
    schema_version: 1,
    source: "yt-dlp/yt-dlp",
    asset: "python-wheels",
    version: "2026.08.19",
    bootstrap: {
      file: "downloader_bootstrap.py",
      bytes: bootstrap.bytes,
      sha256: bootstrap.sha256,
    },
    wheels: PINS.map(({ file, bytes, sha256, version }) => ({
      file,
      bytes,
      sha256,
      version,
    })),
  };
}

let lock;
let staging;
let reserved = false;
let lockPath;
try {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    fail("UNSUPPORTED_PLATFORM");
  if (
    !isAbsolute(target) ||
    resolve(target) !== target ||
    target === parse(target).root
  )
    fail("INVALID_DOWNLOADER_TARGET");
  await ensureParent(dirname(target));
  lockPath = join(dirname(target), ".setup-downloader-wheels.lock");
  try {
    lock = await open(
      lockPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    fail("DOWNLOADER_SETUP_BUSY");
  }
  await lock.writeFile(
    JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) +
      "\n",
  );
  await lock.sync();
  const bootstrap = await fileIdentity(source, 64 * 1024);
  let existing = false;
  try {
    await lstat(target);
    existing = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    const identity = await validPrior(bootstrap);
    console.log(JSON.stringify({ ready: true, cached: true, identity }));
  } else {
    staging = join(dirname(target), `.downloader-${randomUUID()}.staging`);
    await mkdir(staging, { mode: 0o700 });
    await writeExclusive(
      join(staging, "downloader_bootstrap.py"),
      bootstrap.data,
    );
    for (const pin of PINS) {
      const metadata = JSON.parse(
        (
          await transfer(
            `https://pypi.org/pypi/${pin.project}/${pin.pypi_version}/json`,
            1024 * 1024,
          )
        ).toString("utf8"),
      );
      const release = metadata.urls?.find((item) => item.filename === pin.file);
      if (
        metadata.info?.name !== pin.project ||
        metadata.info.version !== pin.pypi_version ||
        !release ||
        release.url !== pin.url ||
        release.size !== pin.bytes ||
        release.digests?.sha256 !== pin.sha256 ||
        release.packagetype !== "bdist_wheel" ||
        release.yanked
      )
        fail("DOWNLOADER_RELEASE_INVALID");
      const data = await transfer(pin.url, pin.bytes);
      if (
        data.length !== pin.bytes ||
        createHash("sha256").update(data).digest("hex") !== pin.sha256
      )
        fail("DOWNLOADER_IDENTITY_INVALID");
      await writeExclusive(join(staging, pin.file), data);
    }
    const identity = {
      schema_version: 1,
      source: "yt-dlp/yt-dlp",
      asset: "python-wheels",
      version: "2026.08.19",
      bootstrap: {
        file: "downloader_bootstrap.py",
        bytes: bootstrap.bytes,
        sha256: bootstrap.sha256,
      },
      wheels: PINS.map(({ file, bytes, sha256, version }) => ({
        file,
        bytes,
        sha256,
        version,
      })),
      installed_at: new Date().toISOString(),
    };
    await writeExclusive(
      join(staging, "identity.json"),
      Buffer.from(JSON.stringify(identity, null, 2) + "\n"),
    );
    // Reserve exclusively, then atomically replace only our empty directory.
    await mkdir(target, { mode: 0o700 });
    reserved = true;
    await rename(staging, target);
    staging = undefined;
    reserved = false;
    await validPrior(bootstrap);
    console.log(JSON.stringify({ ready: true, cached: false, identity }));
  }
} catch (error) {
  console.error(safeCode(error));
  process.exitCode = 1;
} finally {
  if (staging) {
    for (const file of allowedEntries)
      await unlink(join(staging, file)).catch(() => {});
    await rmdir(staging).catch(() => {});
  }
  if (reserved) await rmdir(target).catch(() => {});
  await lock?.close();
  if (lock) await unlink(lockPath).catch(() => {});
}
