import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  prepareSparkle,
  readDashboardUpdaterConfiguration,
  validateUpdaterConfiguration,
} from "./sparkle-artifacts.mjs";
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const shaPattern = /^[a-f0-9]{64}$/;
const safeTools = {
  timeout: 60_000,
  maxBuffer: 128 * 1024,
  env: {
    HOME: process.env.HOME ?? "",
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
  },
};
export function parseUpdateOptions(args) {
  const fields = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (
      ![
        "--release-result",
        "--download-base",
        "--dashboard-config",
        "--keychain-account",
      ].includes(key) ||
      fields.has(key) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw new Error("INVALID_UPDATE_OPTIONS");
    fields.set(key, args[index + 1]);
  }
  if (
    !fields.has("--release-result") ||
    fields.has("--download-base") === fields.has("--dashboard-config") ||
    !fields.has("--keychain-account")
  )
    throw new Error("INVALID_UPDATE_OPTIONS");
  const account = fields.get("--keychain-account");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(account))
    throw new Error("UPDATE_KEYCHAIN_ACCOUNT_INVALID");
  return {
    releaseResult: resolve(fields.get("--release-result")),
    ...(fields.has("--download-base")
      ? { downloadBase: fields.get("--download-base") }
      : { dashboardConfig: resolve(fields.get("--dashboard-config")) }),
    account,
  };
}

export function validateAcceptedUpdateRecord(release, receipt, directory) {
  if (
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(release.version ?? "") ||
    !/^[1-9]\d{0,17}$/.test(release.build ?? "") ||
    release.state !== "READY" ||
    release.notarized !== true ||
    release.stapled !== true ||
    release.public_ready !== true ||
    release.dmg_gatekeeper_accepted !== true ||
    release.contained_app_gatekeeper_accepted !== true ||
    release.release_root !== directory ||
    !shaPattern.test(release.sha256 ?? "") ||
    release.dmg !==
      join(
        directory,
        "accepted.noindex",
        `MusicMute-${release.version}-arm64.dmg`,
      ) ||
    receipt.state !== "READY" ||
    receipt.public_ready !== true ||
    receipt.stapled_sha256 !== release.sha256 ||
    receipt.submission_id !== release.submission_id ||
    release.version !== receipt.version ||
    release.build !== receipt.build
  )
    throw new Error("ACCEPTED_UPDATE_RELEASE_REQUIRED");
}
export function updateAppcast({
  version,
  build,
  archiveURL,
  signature,
  bytes,
}) {
  if (
    !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version) ||
    !/^[1-9]\d{0,17}$/.test(build) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    Buffer.from(signature, "base64").length !== 64 ||
    Buffer.from(signature, "base64").toString("base64") !== signature
  )
    throw new Error("UPDATE_ENTRY_INVALID");
  validateUpdaterConfiguration({
    feedURL: archiveURL,
    publicKey: Buffer.alloc(32).toString("base64"),
    version,
    build,
  });
  const escape = (value) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>\n<title>MusicMute updates</title>\n<item><title>MusicMute ${version}</title><sparkle:version>${build}</sparkle:version><sparkle:shortVersionString>${version}</sparkle:shortVersionString><sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion><sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements><enclosure url="${escape(archiveURL)}" length="${bytes}" type="application/octet-stream" sparkle:edSignature="${signature}" /></item>\n</channel></rss>\n`;
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function owned(path, directory = false) {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o022 ||
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
  )
    throw new Error("UPDATE_INPUT_UNSAFE");
  return info;
}
/** Local preparation only: no uploads, Apple auth, new keys or publishing. */
export async function prepareMacosUpdate(args) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("UNSUPPORTED_PLATFORM");
  const options = parseUpdateOptions(args);
  const directory = dirname(options.releaseResult);
  if (
    basename(options.releaseResult) !== "release-result.json" ||
    dirname(directory) !== join(root, "output/macos-release") ||
    !/^release-[a-f0-9-]{36}\.noindex$/.test(basename(directory)) ||
    (await realpath(directory)) !== directory
  )
    throw new Error("EXPLICIT_ACCEPTED_RELEASE_REQUIRED");
  await owned(directory, true);
  await owned(options.releaseResult);
  const release = JSON.parse(await readFile(options.releaseResult, "utf8"));
  const receiptPath = join(directory, "notarization-receipt.json");
  await owned(receiptPath);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  validateAcceptedUpdateRecord(release, receipt, directory);
  const acceptedDirectory = join(directory, "accepted.noindex");
  await owned(acceptedDirectory, true);
  if ((await realpath(acceptedDirectory)) !== acceptedDirectory)
    throw new Error("UPDATE_INPUT_UNSAFE");
  await owned(release.dmg);
  if ((await digest(release.dmg)) !== release.sha256)
    throw new Error("UPDATE_RELEASE_CHANGED");
  const packageRoot = join(
    root,
    "output/macos",
    `build-${receipt.package_build_id}.noindex`,
  );
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
      receipt.package_build_id ?? "",
    ) ||
    (await realpath(packageRoot)) !== packageRoot
  )
    throw new Error("UPDATE_PACKAGE_IDENTITY_INVALID");
  const plist = join(packageRoot, "MusicMute Local.app/Contents/Info.plist");
  const { stdout } = await exec(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", plist],
    safeTools,
  );
  const values = JSON.parse(stdout);
  const configuration = validateUpdaterConfiguration({
    feedURL: values.SUFeedURL,
    publicKey: values.SUPublicEDKey,
    version: values.CFBundleShortVersionString,
    build: values.CFBundleVersion,
  });
  if (
    !configuration.configured ||
    configuration.version !== release.version ||
    configuration.build !== release.build
  )
    throw new Error("UPDATE_PACKAGE_CONFIG_MISMATCH");
  const dashboard = options.dashboardConfig
    ? await readDashboardUpdaterConfiguration(options.dashboardConfig)
    : null;
  if (
    dashboard &&
    (dashboard.feedURL !== configuration.feedURL ||
      dashboard.publicKey !== configuration.publicKey)
  )
    throw new Error("UPDATE_PACKAGE_CONFIG_MISMATCH");
  const base = new URL(dashboard?.downloadBase ?? options.downloadBase);
  validateUpdaterConfiguration({ ...configuration, feedURL: base.toString() });
  if (!base.pathname.endsWith("/"))
    throw new Error("UPDATE_DOWNLOAD_BASE_INVALID");
  await exec(
    "/usr/bin/codesign",
    [
      "--verify",
      "--deep",
      "--strict",
      join(packageRoot, "MusicMute Local.app"),
    ],
    safeTools,
  );
  await exec("/usr/bin/xcrun", ["stapler", "validate", release.dmg], safeTools);
  const tools = await prepareSparkle();
  const key = (
    await exec(
      join(tools, "bin/generate_keys"),
      ["--account", options.account, "-p"],
      safeTools,
    )
  ).stdout.trim();
  if (key !== configuration.publicKey)
    throw new Error("UPDATE_SIGNING_KEY_MISMATCH");
  const output = join(
    root,
    "output/macos-updates",
    `update-${randomUUID()}.noindex`,
  );
  await mkdir(output, { recursive: true, mode: 0o700 });
  const name = `MusicMute-${release.version}-${release.build}-arm64-${release.sha256}.dmg`;
  const archive = join(output, name);
  await copyFile(release.dmg, archive, 1);
  const signature = (
    await exec(
      join(tools, "bin/sign_update"),
      ["--account", options.account, "-p", archive],
      safeTools,
    )
  ).stdout.trim();
  await exec(
    join(tools, "bin/sign_update"),
    ["--account", options.account, "--verify", archive, signature],
    safeTools,
  );
  const feed = join(output, "appcast.xml");
  await writeFile(
    feed,
    updateAppcast({
      ...configuration,
      archiveURL: new URL(name, base).toString(),
      signature,
      bytes: (await lstat(archive)).size,
    }),
    { flag: "wx", mode: 0o644 },
  );
  await exec(
    join(tools, "bin/sign_update"),
    ["--account", options.account, "-p", feed],
    safeTools,
  );
  await exec(
    join(tools, "bin/sign_update"),
    ["--account", options.account, "--verify", feed],
    safeTools,
  );
  if ((await digest(archive)) !== release.sha256)
    throw new Error("UPDATE_RELEASE_CHANGED");
  const result = {
    schema_version: 1,
    output,
    archive,
    appcast: feed,
    version: release.version,
    build: release.build,
    sha256: release.sha256,
    signed: true,
    published: false,
  };
  await writeFile(
    join(output, "update-result.json"),
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return result;
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    console.log(
      JSON.stringify(await prepareMacosUpdate(process.argv.slice(2)), null, 2),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        error: /^[A-Z][A-Z0-9_]{1,100}$/.test(error?.message ?? "")
          ? error.message
          : "UPDATE_PREPARATION_FAILED",
        published: false,
      }),
    );
    process.exitCode = 1;
  }
}
