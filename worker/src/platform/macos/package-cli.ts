import { isAbsolute, resolve } from "node:path";
import { createInstallationReleaseArchive } from "../../enrollment/release-archive.js";
import { buildMacRelease } from "./release-builder.js";

export const MAC_PACKAGE_USAGE = `Usage:
  mw package-macos --worker-root <path> --output <path> --version <version> --node-root <path> --python-root <path> --media-root <path> [--archive <path.tar.gz>]`;

const REQUIRED_FLAGS = [
  "worker-root",
  "output",
  "version",
  "node-root",
  "python-root",
  "media-root",
] as const;

export async function runMacPackageCommand(
  arguments_: string[],
): Promise<void> {
  const flags = parseFlags(arguments_);
  const allowed = new Set<string>([...REQUIRED_FLAGS, "archive"]);
  for (const name of flags.keys()) {
    if (!allowed.has(name))
      throw new TypeError(`Unknown macOS package flag: --${name}`);
  }
  for (const name of REQUIRED_FLAGS) requiredFlag(flags, name);

  const outputRoot = absoluteFlag(flags, "output");
  const manifest = await buildMacRelease({
    workerRoot: absoluteFlag(flags, "worker-root"),
    outputRoot,
    releaseVersion: requiredFlag(flags, "version"),
    nodeRoot: absoluteFlag(flags, "node-root"),
    pythonRoot: absoluteFlag(flags, "python-root"),
    mediaRoot: absoluteFlag(flags, "media-root"),
  });
  const archive = flags.has("archive")
    ? await createInstallationReleaseArchive({
        releaseRoot: outputRoot,
        outputPath: absoluteFlag(flags, "archive"),
        platform: "darwin-arm64",
      })
    : undefined;
  console.log(
    JSON.stringify({
      status: "ok",
      action: "package-macos",
      releaseVersion: manifest.releaseVersion,
      entryCount: manifest.entries.length,
      ...(archive === undefined ? {} : { archive }),
    }),
  );
}

function parseFlags(arguments_: string[]): Map<string, string> {
  if (arguments_.length % 2 !== 0)
    throw new TypeError("macOS package flags require values");
  const result = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const token = arguments_[index];
    const value = arguments_[index + 1];
    if (!token?.startsWith("--") || token.length < 3 || !value)
      throw new TypeError("macOS package arguments are invalid");
    const name = token.slice(2);
    if (result.has(name))
      throw new TypeError(`Duplicate macOS package flag: --${name}`);
    result.set(name, value);
  }
  return result;
}

function requiredFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = flags.get(name)?.trim();
  if (!value) throw new TypeError(`Missing macOS package flag: --${name}`);
  return value;
}

function absoluteFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = requiredFlag(flags, name);
  if (!isAbsolute(value))
    throw new TypeError(`macOS package path must be absolute: --${name}`);
  return resolve(value);
}
