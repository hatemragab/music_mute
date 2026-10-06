import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { PO_TOKEN_PROVIDER_WHEEL } from "./youtube-runtime.js";

export const DOWNLOADER_VERSION = "2026.08.19";
export const DOWNLOADER_BOOTSTRAP = "downloader_bootstrap.py";
export const DOWNLOADER_BOOTSTRAP_SHA256 =
  "ccf96466d04fcf623292471e73ca372ac7b90d5a0ccc7a0875b6258ca921d488";
export const DOWNLOADER_WHEELS = [
  PO_TOKEN_PROVIDER_WHEEL,
  {
    file: "yt_dlp-2026.8.19-py3-none-any.whl",
    version: DOWNLOADER_VERSION,
    bytes: 3_185_533,
    sha256: "1d57897e94c6665a0a6f9bc54b34e584284e32c034ffab3a7df25d8f7b24eedf",
  },
  {
    file: "yt_dlp_ejs-0.8.0-py3-none-any.whl",
    version: "0.8.0",
    bytes: 53_443,
    sha256: "79300e5fca7f937a1eeede11f0456862c1b41107ce1d726871e0207424f4bdb4",
  },
] as const;

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Validate immutable archives before importing downloader or EJS code. */
export async function verifyDownloaderBundle(
  directory: string,
  packaged: boolean,
  appBootstrap?: string,
): Promise<void> {
  const invalid = (): never => {
    throw new Error("YT_DLP_IDENTITY_INVALID");
  };
  if (!isAbsolute(directory)) invalid();
  const modeMask = packaged ? 0o022 : 0o077;
  const root = await lstat(directory);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    root.mode & modeMask ||
    (!packaged && root.uid !== process.getuid?.())
  )
    invalid();
  const entries = [
    DOWNLOADER_BOOTSTRAP,
    "identity.json",
    ...DOWNLOADER_WHEELS.map((wheel) => wheel.file),
  ];
  const actual = await readdir(directory);
  if (
    actual.length !== entries.length ||
    actual.some((file) => !entries.includes(file))
  )
    invalid();
  for (const file of entries) {
    const information = await lstat(join(directory, file));
    if (
      !information.isFile() ||
      information.isSymbolicLink() ||
      information.nlink !== 1 ||
      (!packaged && information.uid !== process.getuid?.()) ||
      information.mode & modeMask ||
      information.size > (file.endsWith(".whl") ? 4 * 1024 * 1024 : 32 * 1024)
    )
      invalid();
  }
  const identity = JSON.parse(
    await readFile(join(directory, "identity.json"), "utf8"),
  ) as Record<string, unknown>;
  if (
    identity.schema_version !== 1 ||
    identity.source !== "yt-dlp/yt-dlp" ||
    identity.asset !== "python-wheels" ||
    identity.version !== DOWNLOADER_VERSION ||
    !identity.bootstrap ||
    typeof identity.bootstrap !== "object" ||
    !Array.isArray(identity.wheels) ||
    identity.wheels.length !== DOWNLOADER_WHEELS.length
  )
    invalid();
  const bootstrap = identity.bootstrap as Record<string, unknown>;
  const bootstrapPath = appBootstrap ?? join(directory, DOWNLOADER_BOOTSTRAP);
  const bootstrapInfo = await lstat(bootstrapPath);
  if (
    !isAbsolute(bootstrapPath) ||
    !bootstrapInfo.isFile() ||
    bootstrapInfo.isSymbolicLink() ||
    bootstrapInfo.nlink !== 1 ||
    bootstrapInfo.mode & modeMask ||
    bootstrapInfo.size > 32 * 1024 ||
    (!appBootstrap &&
      (bootstrap.file !== DOWNLOADER_BOOTSTRAP ||
        bootstrap.sha256 !== DOWNLOADER_BOOTSTRAP_SHA256 ||
        bootstrap.bytes !== bootstrapInfo.size)) ||
    (await digest(bootstrapPath)) !== DOWNLOADER_BOOTSTRAP_SHA256
  )
    invalid();
  const wheels = identity.wheels as unknown[];
  for (const [index, expected] of DOWNLOADER_WHEELS.entries()) {
    const recorded = wheels[index] as Record<string, unknown> | null;
    const path = join(directory, expected.file);
    if (
      !recorded ||
      recorded.file !== expected.file ||
      recorded.version !== expected.version ||
      recorded.bytes !== expected.bytes ||
      recorded.sha256 !== expected.sha256 ||
      (await lstat(path)).size !== expected.bytes ||
      (await digest(path)) !== expected.sha256
    )
      invalid();
  }
}

export function downloaderToolArguments(
  config: {
    runner_path: string;
    yt_dlp_path: string;
    downloader_bundle_root?: string;
    downloader_bootstrap_path?: string;
    youtube_runtime_root?: string;
  },
  arguments_: string[],
): string[] {
  return [
    config.runner_path,
    "--tool",
    config.yt_dlp_path,
    "--",
    ...(config.downloader_bundle_root
      ? [
          "-I",
          "-B",
          "-S",
          config.downloader_bootstrap_path ??
            join(config.downloader_bundle_root, DOWNLOADER_BOOTSTRAP),
          ...(config.downloader_bootstrap_path
            ? ["--musicmute-downloader-root", config.downloader_bundle_root]
            : []),
          ...(config.youtube_runtime_root
            ? ["--musicmute-youtube-runtime", config.youtube_runtime_root]
            : []),
        ]
      : []),
    ...arguments_,
  ];
}
