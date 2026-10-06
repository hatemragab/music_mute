import { lstat, readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createMacUserLayout } from "../platform/macos/user-paths.js";
import { createWindowsServiceLayout } from "../platform/windows/service-definition.js";

const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u;

/** No backend, credentials, runtime loading, or service mutation. */
export async function workerVersions(
  options: {
    packagePath?: string;
    packageVersion?: string;
    home?: string;
    platform?: NodeJS.Platform;
    windowsActiveReleasePath?: string;
  } = {},
) {
  const packagePath =
    options.packagePath ??
    fileURLToPath(new URL("../../../package.json", import.meta.url));
  const manifest =
    options.packageVersion === undefined
      ? (JSON.parse(await readFile(packagePath, "utf8")) as Record<
          string,
          unknown
        >)
      : { version: options.packageVersion };
  if (typeof manifest.version !== "string" || !VERSION.test(manifest.version))
    throw new TypeError("CLI package version is invalid");
  let runtimeVersion: string | null = null;
  let runtimeState:
    "not-installed" | "installed" | "unavailable" | "unsupported" =
    "not-installed";
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    try {
      const path =
        options.windowsActiveReleasePath ??
        createWindowsServiceLayout().activeReleasePath;
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size < 2 ||
        info.size > 4096
      )
        throw new TypeError("Unsafe Windows release marker");
      const state = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      if (
        typeof state.releaseVersion !== "string" ||
        !VERSION.test(state.releaseVersion)
      )
        throw new TypeError("Invalid Windows release marker");
      runtimeVersion = state.releaseVersion;
      runtimeState = "installed";
    } catch (error) {
      runtimeState =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "not-installed"
          : "unavailable";
    }
  } else if (platform !== "darwin") runtimeState = "unsupported";
  else {
    const layout = createMacUserLayout(options.home ?? homedir());
    try {
      const target = await readlink(layout.currentLink);
      const match = /^releases\/([0-9A-Za-z][0-9A-Za-z._+-]{0,63})$/u.exec(
        target,
      );
      if (!match) throw new TypeError("Unsafe runtime pointer");
      const info = await lstat(layout.installationStatePath);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 64 * 1024 ||
        (info.mode & 0o077) !== 0
      )
        throw new TypeError("Unsafe installation state");
      const state = JSON.parse(
        await readFile(layout.installationStatePath, "utf8"),
      ) as Record<string, unknown>;
      if (state.releaseVersion !== match[1])
        throw new TypeError("Runtime identity disagrees");
      runtimeVersion = match[1]!;
      runtimeState = "installed";
    } catch (error) {
      runtimeState =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "not-installed"
          : "unavailable";
    }
  }
  return {
    schemaVersion: 1,
    cliVersion: manifest.version,
    runtimeVersion,
    runtimeState,
  };
}

export async function printWorkerVersion(
  arguments_: readonly string[],
): Promise<void> {
  if (
    arguments_.length > 1 ||
    (arguments_.length === 1 && arguments_[0] !== "--json")
  )
    throw new TypeError("Usage: mw --version [--json]");
  const result = await workerVersions();
  console.log(
    arguments_.includes("--json")
      ? JSON.stringify(result)
      : `MusicMute CLI: ${result.cliVersion}\nInstalled runtime: ${result.runtimeVersion ?? result.runtimeState}`,
  );
}
