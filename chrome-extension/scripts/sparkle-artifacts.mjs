import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const SPARKLE = Object.freeze({
  version: "2.10.0",
  url: "https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz",
  sha256: "c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c",
});
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
export const sparkleRoot = join(
  root,
  "output/sparkle",
  `${SPARKLE.version}.noindex`,
);
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
/** The published GitHub asset hash is pinned in source; never trust an extracted cache. */
export async function prepareSparkle({ destination = sparkleRoot } = {}) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const archive = join(destination, `Sparkle-${SPARKLE.version}.tar.xz`);
  try {
    const info = await lstat(archive);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024)
      throw new Error("SPARKLE_ARCHIVE_INVALID");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(SPARKLE.url, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body)
      throw new Error("SPARKLE_DOWNLOAD_FAILED");
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 64 * 1024 * 1024) throw new Error("SPARKLE_ARCHIVE_INVALID");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks, length);
    if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024)
      throw new Error("SPARKLE_ARCHIVE_INVALID");
    if (createHash("sha256").update(bytes).digest("hex") !== SPARKLE.sha256)
      throw new Error("SPARKLE_ARCHIVE_HASH_MISMATCH");
    await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
  }
  if ((await digest(archive)) !== SPARKLE.sha256)
    throw new Error("SPARKLE_ARCHIVE_HASH_MISMATCH");
  // A fresh extraction prevents modified cached native binaries from being packaged.
  const temporary = join(destination, `staged-${randomUUID()}.noindex`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await exec(
      "/usr/bin/tar",
      [
        "-xJf",
        archive,
        "-C",
        temporary,
        "./Sparkle.framework",
        "./bin",
        "./LICENSE",
      ],
      {
        timeout: 60_000,
        maxBuffer: 128 * 1024,
      },
    );
    const { stdout } = await exec("/usr/bin/plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      "-o",
      "-",
      join(temporary, "Sparkle.framework/Versions/B/Resources/Info.plist"),
    ]);
    if (stdout.trim() !== SPARKLE.version)
      throw new Error("SPARKLE_VERSION_MISMATCH");
    for (const name of ["Sparkle.framework", "bin", "LICENSE"]) {
      await rm(join(destination, name), { recursive: true, force: true });
      await rename(join(temporary, name), join(destination, name));
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return destination;
}

export function validateUpdaterConfiguration({
  feedURL,
  publicKey,
  version,
  build,
}) {
  if (
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version ?? "") ||
    !/^[1-9]\d{0,17}$/.test(build ?? "")
  )
    throw new Error("MACOS_VERSION_INVALID");
  if (!feedURL && !publicKey) return { configured: false, version, build };
  if (!feedURL || !publicKey) throw new Error("UPDATER_CONFIG_INCOMPLETE");
  if (typeof feedURL !== "string" || feedURL.length > 2048)
    throw new Error("UPDATER_FEED_INVALID");
  let url;
  try {
    url = new URL(feedURL);
  } catch {
    throw new Error("UPDATER_FEED_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.port ||
    /^(?:localhost$|127\.|\[?::1\]?$)/i.test(url.hostname)
  )
    throw new Error("UPDATER_FEED_INVALID");
  const decoded = Buffer.from(publicKey, "base64");
  if (decoded.length !== 32 || decoded.toString("base64") !== publicKey)
    throw new Error("UPDATER_PUBLIC_KEY_INVALID");
  return {
    configured: true,
    feedURL: url.toString(),
    publicKey,
    version,
    build,
  };
}

/** Only public publisher settings are downloaded from the administrator dashboard. */
export function parseDashboardUpdaterConfiguration(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "download_base_url,feed_url,public_ed_key,schema_version" ||
    value.schema_version !== 1
  )
    throw new Error("UPDATER_DASHBOARD_CONFIG_INVALID");
  const configuration = validateUpdaterConfiguration({
    feedURL: value.feed_url,
    publicKey: value.public_ed_key,
    version: "0.1.0",
    build: "1",
  });
  if (!configuration.configured) throw new Error("UPDATER_CONFIG_INCOMPLETE");
  const expectedFeed = new URL("/macos-updates/appcast.xml", value.feed_url);
  const expectedBase = new URL("/macos-updates/artifacts/", value.feed_url);
  if (
    configuration.feedURL !== expectedFeed.toString() ||
    value.download_base_url !== expectedBase.toString()
  )
    throw new Error("UPDATER_DASHBOARD_CONFIG_INVALID");
  return {
    feedURL: configuration.feedURL,
    publicKey: configuration.publicKey,
    downloadBase: expectedBase.toString(),
  };
}

export async function readDashboardUpdaterConfiguration(path) {
  let bytes;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384)
      throw new Error("UPDATER_DASHBOARD_CONFIG_INVALID");
    bytes = await readFile(path);
  } catch {
    throw new Error("UPDATER_DASHBOARD_CONFIG_UNREADABLE");
  }
  if (bytes.length > 16_384)
    throw new Error("UPDATER_DASHBOARD_CONFIG_INVALID");
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("UPDATER_DASHBOARD_CONFIG_INVALID");
  }
  return parseDashboardUpdaterConfiguration(value);
}

export async function packagingUpdaterConfiguration({ configFile, ...values }) {
  if (!configFile) return validateUpdaterConfiguration(values);
  if (values.feedURL || values.publicKey)
    throw new Error("UPDATER_CONFIG_CONFLICT");
  const dashboard = await readDashboardUpdaterConfiguration(configFile);
  return validateUpdaterConfiguration({ ...values, ...dashboard });
}

export async function stageSparkle(resources, frameworks) {
  const source = await prepareSparkle();
  await mkdir(frameworks, { recursive: true });
  await cp(
    join(source, "Sparkle.framework"),
    join(frameworks, "Sparkle.framework"),
    { recursive: true, verbatimSymlinks: true },
  );
  await mkdir(join(resources, "Notices"), { recursive: true });
  await cp(
    join(source, "LICENSE"),
    join(resources, "Notices/Sparkle-LICENSE.txt"),
  );
  return source;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    if (
      process.argv.length !== 2 ||
      process.platform !== "darwin" ||
      process.arch !== "arm64"
    )
      throw new Error("INVALID_UPDATER_SETUP_OPTIONS");
    await prepareSparkle();
    console.log(
      JSON.stringify({
        framework: "Sparkle",
        version: SPARKLE.version,
        sha256: SPARKLE.sha256,
        ready: true,
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        error: /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.message ?? "")
          ? error.message
          : "UPDATER_SETUP_FAILED",
        ready: false,
      }),
    );
    process.exitCode = 1;
  }
}
