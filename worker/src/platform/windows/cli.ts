import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { buildWindowsRelease } from "./release-builder.js";
import { verifyWindowsRelease } from "./release-manifest.js";
import {
  createWindowsReleaseLayout,
  createWindowsServiceLayout,
  renderWinSWConfig,
} from "./service-definition.js";

export const WINDOWS_USAGE = `Usage:
  musicmute-worker windows package --worker-root <path> --output <path> --version <version> --node-root <path> --python-root <path> --media-root <path> --service-root <path>
  musicmute-worker windows verify --release <path>
  musicmute-worker windows service-config --root <path> --version <version> --output <path>`;

export async function runWindowsCommand(arguments_: string[]): Promise<void> {
  const action = arguments_[0];
  const flags = parseFlags(arguments_.slice(1));
  if (action === "package") {
    exactFlags(
      flags,
      new Set([
        "worker-root",
        "output",
        "version",
        "node-root",
        "python-root",
        "media-root",
        "service-root",
      ]),
    );
    const manifest = await buildWindowsRelease({
      workerRoot: absoluteFlag(flags, "worker-root"),
      outputRoot: absoluteFlag(flags, "output"),
      releaseVersion: requiredFlag(flags, "version"),
      nodeRoot: absoluteFlag(flags, "node-root"),
      pythonRoot: absoluteFlag(flags, "python-root"),
      mediaRoot: absoluteFlag(flags, "media-root"),
      serviceRoot: absoluteFlag(flags, "service-root"),
    });
    report(action, manifest.releaseVersion, manifest.entries.length);
    return;
  }
  if (action === "verify") {
    exactFlags(flags, new Set(["release"]));
    const manifest = await verifyWindowsRelease(absoluteFlag(flags, "release"));
    report(action, manifest.releaseVersion, manifest.entries.length);
    return;
  }
  if (action === "service-config") {
    exactFlags(flags, new Set(["root", "version", "output"]));
    const version = requiredFlag(flags, "version");
    const layout = createWindowsServiceLayout(absoluteFlag(flags, "root"));
    const release = createWindowsReleaseLayout(layout, version);
    const manifest = await verifyWindowsRelease(release.releaseRoot);
    if (manifest.releaseVersion !== version)
      throw new TypeError("Windows release version does not match its path");
    const handle = await open(absoluteFlag(flags, "output"), "wx", 0o600);
    try {
      await handle.writeFile(renderWinSWConfig(layout, release), "utf8");
    } finally {
      await handle.close();
    }
    report(action, manifest.releaseVersion, manifest.entries.length);
    return;
  }
  throw new TypeError("Windows action is unsupported");
}

export function windowsCommandErrorSummary(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  return error.message.slice(0, 200).replace(/[\r\n]+/gu, " ");
}

function parseFlags(arguments_: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith("--") ||
      value.startsWith("--")
    )
      throw new TypeError("Windows command flags are invalid");
    const name = flag.slice(2);
    if (flags.has(name))
      throw new TypeError("Windows command flag is duplicated");
    flags.set(name, value);
  }
  return flags;
}

function exactFlags(flags: Map<string, string>, allowed: Set<string>): void {
  if (
    flags.size !== allowed.size ||
    [...flags.keys()].some((key) => !allowed.has(key))
  )
    throw new TypeError("Windows command flags are invalid");
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new TypeError(`Windows command requires --${name}`);
  return value;
}

function absoluteFlag(flags: Map<string, string>, name: string): string {
  const value = requiredFlag(flags, name);
  if (!isAbsolute(value)) throw new TypeError(`--${name} must be absolute`);
  return value;
}

function report(action: string, releaseVersion: string, entryCount: number) {
  console.log(
    JSON.stringify({ status: "ok", action, releaseVersion, entryCount }),
  );
}
