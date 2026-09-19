import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  createMacServiceLayout,
  DEFAULT_MAC_INSTALL_ROOT,
  DEFAULT_MAC_LAUNCH_DAEMONS_ROOT,
} from "./launchd.js";
import { buildMacRelease } from "./release-builder.js";
import {
  activateMacService,
  deactivateMacService,
  getMacCurrentRelease,
  inspectMacServiceInstallation,
  installMacModelArtifact,
  installMacServiceFiles,
  rollbackMacServiceFiles,
  uninstallMacServiceFiles,
} from "./service-manager.js";

const ACCOUNT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/u;

export const MACOS_USAGE = `Usage:
  musicmute-worker macos package --worker-root <path> --output <path> --version <version> --node-root <path> --python-root <path> --media-root <path>
  musicmute-worker macos install --release <path> --config <path> --credential <path> --model-source <path> --service-user <name> --service-group <name> [--root <path>] [--launch-daemons-root <path>]
  musicmute-worker macos repair --release <path> --config <path> --credential <path> --model-source <path> --service-user <name> --service-group <name> [--root <path>] [--launch-daemons-root <path>]
  musicmute-worker macos doctor --service-user <name> --service-group <name> [--root <path>] [--launch-daemons-root <path>]
  musicmute-worker macos uninstall [--root <path>] [--launch-daemons-root <path>]`;

export async function runMacosCommand(arguments_: string[]): Promise<void> {
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
      ]),
    );
    const manifest = await buildMacRelease({
      workerRoot: absoluteFlag(flags, "worker-root"),
      outputRoot: absoluteFlag(flags, "output"),
      releaseVersion: requiredFlag(flags, "version"),
      nodeRoot: absoluteFlag(flags, "node-root"),
      pythonRoot: absoluteFlag(flags, "python-root"),
      mediaRoot: absoluteFlag(flags, "media-root"),
    });
    console.log(
      JSON.stringify({
        status: "ok",
        action,
        releaseVersion: manifest.releaseVersion,
        entryCount: manifest.entries.length,
      }),
    );
    return;
  }
  const layout = createMacServiceLayout(
    optionalAbsoluteFlag(flags, "root") ?? DEFAULT_MAC_INSTALL_ROOT,
    optionalAbsoluteFlag(flags, "launch-daemons-root") ??
      DEFAULT_MAC_LAUNCH_DAEMONS_ROOT,
  );
  if (action === "install" || action === "repair") {
    exactFlags(
      flags,
      new Set([
        "release",
        "config",
        "credential",
        "model-source",
        "service-user",
        "service-group",
        "root",
        "launch-daemons-root",
      ]),
    );
    const serviceUser = accountFlag(flags, "service-user");
    const serviceGroup = accountFlag(flags, "service-group");
    const owner = await serviceOwner(serviceUser, serviceGroup);
    const previousRelease = await getMacCurrentRelease(layout);
    await deactivateMacService();
    let installation:
      Awaited<ReturnType<typeof installMacServiceFiles>> | undefined;
    try {
      installation = await installMacServiceFiles({
        releaseRoot: absoluteFlag(flags, "release"),
        configSource: absoluteFlag(flags, "config"),
        credentialSource: absoluteFlag(flags, "credential"),
        layout,
        serviceUser,
        serviceGroup,
        owner,
      });
      await installMacModelArtifact(
        layout,
        absoluteFlag(flags, "model-source"),
        owner,
      );
      await activateMacService(layout);
      const inspection = await inspectMacServiceInstallation(
        layout,
        serviceUser,
        serviceGroup,
        owner,
        true,
        true,
      );
      if (!inspection.serviceLoaded)
        throw new Error("LaunchDaemon did not remain loaded");
      console.log(
        JSON.stringify({
          status: "ok",
          action,
          releaseVersion: installation.releaseVersion,
          previousRelease: installation.previousRelease,
          serviceLoaded: true,
          runtimeValidated: inspection.runtime?.status === "ok",
        }),
      );
    } catch (error) {
      if (installation !== undefined)
        await rollbackMacServiceFiles(layout, installation.previousRelease);
      if (previousRelease !== null) await activateMacService(layout);
      throw error;
    }
    return;
  }
  if (action === "doctor") {
    exactFlags(
      flags,
      new Set(["service-user", "service-group", "root", "launch-daemons-root"]),
    );
    const serviceUser = accountFlag(flags, "service-user");
    const serviceGroup = accountFlag(flags, "service-group");
    const owner = await serviceOwner(serviceUser, serviceGroup);
    const inspection = await inspectMacServiceInstallation(
      layout,
      serviceUser,
      serviceGroup,
      owner,
      true,
      true,
    );
    console.log(JSON.stringify({ status: "ok", action, ...inspection }));
    return;
  }
  if (action === "uninstall") {
    exactFlags(flags, new Set(["root", "launch-daemons-root"]));
    await deactivateMacService();
    await uninstallMacServiceFiles(layout);
    console.log(
      JSON.stringify({
        status: "ok",
        action,
        preservedStateRoot: layout.stateRoot,
        preservedReleasesRoot: layout.releasesRoot,
      }),
    );
    return;
  }
  throw new TypeError("Unknown macOS service command");
}

export function macosCommandErrorSummary(error: unknown): string {
  if (!(error instanceof Error)) return "operation failed";
  const message = error.message.replaceAll(/[\r\n\t]/gu, " ").slice(0, 240);
  if (
    [
      "Mac ",
      "macOS ",
      "LaunchDaemon ",
      "Installed ",
      "Copied ",
      "Previous ",
      "Unknown ",
    ].some((prefix) => message.startsWith(prefix))
  )
    return message;
  return "operation failed";
}

function parseFlags(arguments_: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !flag.startsWith("--") ||
      value.startsWith("--") ||
      flag.length < 3
    )
      throw new TypeError("macOS command arguments are invalid");
    const name = flag.slice(2);
    if (result.has(name))
      throw new TypeError(`macOS command flag is duplicated: --${name}`);
    result.set(name, value);
  }
  return result;
}

function exactFlags(
  flags: ReadonlyMap<string, string>,
  allowed: ReadonlySet<string>,
): void {
  for (const name of flags.keys()) {
    if (!allowed.has(name))
      throw new TypeError(`macOS command flag is unknown: --${name}`);
  }
}

function requiredFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = flags.get(name);
  if (value === undefined || value.length < 1 || value.trim() !== value)
    throw new TypeError(`macOS command flag is required: --${name}`);
  return value;
}

function absoluteFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = requiredFlag(flags, name);
  if (!isAbsolute(value))
    throw new TypeError(`macOS command path must be absolute: --${name}`);
  return value;
}

function optionalAbsoluteFlag(
  flags: ReadonlyMap<string, string>,
  name: string,
): string | undefined {
  if (!flags.has(name)) return undefined;
  return absoluteFlag(flags, name);
}

function accountFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = requiredFlag(flags, name);
  if (!ACCOUNT_NAME.test(value))
    throw new TypeError(`macOS service account is invalid: --${name}`);
  return value;
}

async function accountId(flag: "-u" | "-g", name: string): Promise<number> {
  const value = await accountValue(flag, name);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 0)
    throw new TypeError("macOS service account ID is invalid");
  return id;
}

async function serviceOwner(
  serviceUser: string,
  serviceGroup: string,
): Promise<{ uid: number; gid: number }> {
  const primaryGroup = await accountValue("-gn", serviceUser);
  if (primaryGroup !== serviceGroup)
    throw new TypeError(
      "macOS service group must be the account primary group",
    );
  return {
    uid: await accountId("-u", serviceUser),
    gid: await accountId("-g", serviceUser),
  };
}

async function accountValue(
  flag: "-u" | "-g" | "-gn",
  name: string,
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn("/usr/bin/id", [flag, name], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 32) stdout += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || code !== 0)
        return reject(new TypeError("macOS service account does not exist"));
      resolvePromise(stdout.trim());
    });
  });
}
