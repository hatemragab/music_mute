import { constants } from "node:fs";
import { chmod, copyFile, lstat, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import {
  runEnrollmentCommand,
  runInstallationPreparationCommand,
} from "../../enrollment/cli.js";
import { readInstallationArtifactsReceipt } from "../../enrollment/installation-receipt.js";
import {
  createMacServiceLayout,
  DEFAULT_MAC_INSTALL_ROOT,
  DEFAULT_MAC_LAUNCH_DAEMONS_ROOT,
} from "./launchd.js";
import { buildMacRelease } from "./release-builder.js";
import { createInstallationReleaseArchive } from "../../enrollment/release-archive.js";
import {
  activateMacService,
  deactivateMacService,
  getMacCurrentRelease,
  inspectMacServiceInstallation,
  installMacModelArtifact,
  installMacServiceIdentity,
  installMacServiceFiles,
  rollbackMacServiceFiles,
  runMacServiceQualification,
  stageMacServiceFiles,
  uninstallMacServiceFiles,
} from "./service-manager.js";
import {
  ensureMacServiceAccount,
  readMacServiceOwner,
} from "./service-account.js";

const ACCOUNT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/u;

export const MACOS_USAGE = `Usage:
  musicmute-worker macos package --worker-root <path> --output <path> --version <version> --node-root <path> --python-root <path> --media-root <path> [--archive <path.tar.gz>]
  musicmute-worker macos bootstrap --backend-url <api-base-url> --enrollment-file <path> --output <protected-path> --label <name> [--group-id <id>] [--allow-insecure-loopback <true|false>] [--root <path>] [--launch-daemons-root <path>]
  musicmute-worker macos stage --release <path> --model-source <path> --fixture-source <path> --fixture-sha256 <hex> --service-user <name> --service-group <name> [--qualification-output <path>] [--root <path>] [--launch-daemons-root <path>]
  musicmute-worker macos activate --release <path> --config <path> --credential <path> --service-user <name> --service-group <name> [--root <path>] [--launch-daemons-root <path>]
  musicmute-worker macos install --release <path> --config <path> --credential <path> --model-source <path> --fixture-source <path> --fixture-sha256 <hex> --service-user <name> --service-group <name> [--root <path>] [--launch-daemons-root <path>]
  musicmute-worker macos repair --release <path> --config <path> --credential <path> --model-source <path> --fixture-source <path> --fixture-sha256 <hex> --service-user <name> --service-group <name> [--root <path>] [--launch-daemons-root <path>]
  musicmute-worker macos doctor --service-user <name> --service-group <name> [--root <path>] [--launch-daemons-root <path>]
  musicmute-worker macos uninstall [--root <path>] [--launch-daemons-root <path>]`;

export async function runMacosCommand(arguments_: string[]): Promise<void> {
  const action = arguments_[0];
  const flags = parseFlags(arguments_.slice(1));
  if (action === "package") {
    const packageFlags = new Set([
      "worker-root",
      "output",
      "version",
      "node-root",
      "python-root",
      "media-root",
      ...(flags.has("archive") ? ["archive"] : []),
    ]);
    exactFlags(flags, packageFlags);
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
        action,
        releaseVersion: manifest.releaseVersion,
        entryCount: manifest.entries.length,
        ...(archive === undefined ? {} : { archive }),
      }),
    );
    return;
  }
  const layout = createMacServiceLayout(
    optionalAbsoluteFlag(flags, "root") ?? DEFAULT_MAC_INSTALL_ROOT,
    optionalAbsoluteFlag(flags, "launch-daemons-root") ??
      DEFAULT_MAC_LAUNCH_DAEMONS_ROOT,
  );
  if (action === "bootstrap") {
    exactFlags(
      flags,
      new Set([
        "backend-url",
        "enrollment-file",
        "output",
        "label",
        "group-id",
        "allow-insecure-loopback",
        "root",
        "launch-daemons-root",
      ]),
    );
    if (
      process.platform !== "darwin" ||
      process.arch !== "arm64" ||
      process.getuid?.() !== 0
    )
      throw new TypeError(
        "macOS bootstrap requires Darwin ARM64 administrator privileges",
      );
    const backendUrl = requiredFlag(flags, "backend-url");
    const enrollmentFile = absoluteFlag(flags, "enrollment-file");
    const outputRoot = absoluteFlag(flags, "output");
    const label = requiredFlag(flags, "label");
    const allowInsecureLoopback =
      flags.get("allow-insecure-loopback") ?? "false";
    await runInstallationPreparationCommand([
      "--backend-url",
      backendUrl,
      "--enrollment-file",
      enrollmentFile,
      "--platform",
      "darwin-arm64",
      "--output",
      outputRoot,
      "--allow-insecure-loopback",
      allowInsecureLoopback,
    ]);
    const receipt = await readInstallationArtifactsReceipt(outputRoot);
    if (receipt.platform !== "darwin-arm64")
      throw new TypeError("Mac bootstrap artifact platform is invalid");
    const qualificationPath = join(outputRoot, "qualification.json");
    if (!(await privateFileExists(qualificationPath))) {
      await runMacosCommand([
        "stage",
        "--release",
        receipt.release.releaseRoot,
        "--model-source",
        receipt.model.path,
        "--fixture-source",
        receipt.fixture.path,
        "--fixture-sha256",
        receipt.fixture.sha256,
        "--qualification-output",
        qualificationPath,
        "--service-user",
        "_musicmute",
        "--service-group",
        "_musicmute",
        ...layoutFlags(flags),
      ]);
    }
    await runEnrollmentCommand([
      "--backend-url",
      backendUrl,
      "--enrollment-file",
      enrollmentFile,
      "--release",
      receipt.release.releaseRoot,
      "--qualification",
      qualificationPath,
      "--label",
      label,
      ...(flags.has("group-id")
        ? ["--group-id", requiredFlag(flags, "group-id")]
        : []),
      "--service-root",
      layout.installRoot,
      "--output",
      outputRoot,
      "--allow-insecure-loopback",
      allowInsecureLoopback,
    ]);
    await runMacosCommand([
      "activate",
      "--release",
      receipt.release.releaseRoot,
      "--config",
      join(outputRoot, "runtime.json"),
      "--credential",
      join(outputRoot, "machine.credential"),
      "--service-user",
      "_musicmute",
      "--service-group",
      "_musicmute",
      ...layoutFlags(flags),
    ]);
    console.log(
      JSON.stringify({
        status: "ok",
        action,
        releaseVersion: receipt.releaseVersion,
        installationId: receipt.installationId,
      }),
    );
    return;
  }
  if (action === "stage") {
    exactFlags(
      flags,
      new Set([
        "release",
        "model-source",
        "fixture-source",
        "fixture-sha256",
        "service-user",
        "service-group",
        "qualification-output",
        "root",
        "launch-daemons-root",
      ]),
    );
    const serviceUser = accountFlag(flags, "service-user");
    const serviceGroup = accountFlag(flags, "service-group");
    const owner = (await ensureMacServiceAccount(serviceUser, serviceGroup))
      .owner;
    const previousRelease = await getMacCurrentRelease(layout);
    await deactivateMacService();
    let installation:
      Awaited<ReturnType<typeof stageMacServiceFiles>> | undefined;
    try {
      installation = await stageMacServiceFiles({
        releaseRoot: absoluteFlag(flags, "release"),
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
      const qualification = await runMacServiceQualification({
        layout,
        releaseRoot: installation.releaseRoot,
        fixtureSource: absoluteFlag(flags, "fixture-source"),
        fixtureSha256: requiredFlag(flags, "fixture-sha256"),
        serviceUser,
        serviceGroup,
        owner,
      });
      const qualificationReport = flags.has("qualification-output")
        ? await exportMacQualificationReport(
            qualification.reportPath,
            absoluteFlag(flags, "qualification-output"),
          )
        : qualification.reportPath;
      if (installation.previousRelease !== null) {
        await rollbackMacServiceFiles(layout, installation.previousRelease);
        await activateMacService(layout);
      }
      console.log(
        JSON.stringify({
          status: "ok",
          action,
          releaseVersion: installation.releaseVersion,
          previousRelease: installation.previousRelease,
          candidateActivated: false,
          previousServiceRestored: installation.previousRelease !== null,
          qualificationValidated: true,
          qualificationReport,
        }),
      );
    } catch (error) {
      await deactivateMacService();
      if (installation !== undefined)
        await rollbackMacServiceFiles(layout, installation.previousRelease);
      if (previousRelease !== null) await activateMacService(layout);
      throw error;
    }
    return;
  }
  if (action === "activate") {
    exactFlags(
      flags,
      new Set([
        "config",
        "credential",
        "release",
        "service-user",
        "service-group",
        "root",
        "launch-daemons-root",
      ]),
    );
    const serviceUser = accountFlag(flags, "service-user");
    const serviceGroup = accountFlag(flags, "service-group");
    const owner = await readMacServiceOwner(serviceUser, serviceGroup);
    const previousRelease = await getMacCurrentRelease(layout);
    await deactivateMacService();
    let installation:
      Awaited<ReturnType<typeof stageMacServiceFiles>> | undefined;
    try {
      installation = await stageMacServiceFiles({
        releaseRoot: absoluteFlag(flags, "release"),
        layout,
        serviceUser,
        serviceGroup,
        owner,
      });
      await installMacServiceIdentity(
        layout,
        absoluteFlag(flags, "config"),
        absoluteFlag(flags, "credential"),
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
          releaseVersion: inspection.releaseVersion,
          serviceLoaded: true,
          runtimeValidated: inspection.runtime?.status === "ok",
        }),
      );
    } catch (error) {
      await deactivateMacService();
      if (installation !== undefined)
        await rollbackMacServiceFiles(layout, installation.previousRelease);
      if (previousRelease !== null) await activateMacService(layout);
      throw error;
    }
    return;
  }
  if (action === "install" || action === "repair") {
    exactFlags(
      flags,
      new Set([
        "release",
        "config",
        "credential",
        "model-source",
        "fixture-source",
        "fixture-sha256",
        "service-user",
        "service-group",
        "root",
        "launch-daemons-root",
      ]),
    );
    const serviceUser = accountFlag(flags, "service-user");
    const serviceGroup = accountFlag(flags, "service-group");
    const owner =
      action === "install"
        ? (await ensureMacServiceAccount(serviceUser, serviceGroup)).owner
        : await readMacServiceOwner(serviceUser, serviceGroup);
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
      const qualification = await runMacServiceQualification({
        layout,
        releaseRoot: installation.releaseRoot,
        fixtureSource: absoluteFlag(flags, "fixture-source"),
        fixtureSha256: requiredFlag(flags, "fixture-sha256"),
        serviceUser,
        serviceGroup,
        owner,
      });
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
          qualificationValidated: true,
          qualificationReport: qualification.reportPath,
        }),
      );
    } catch (error) {
      await deactivateMacService();
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
    const owner = await readMacServiceOwner(serviceUser, serviceGroup);
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

export async function exportMacQualificationReport(
  source: string,
  destination: string,
) {
  const sourceInfo = await lstat(source);
  const parentInfo = await lstat(dirname(destination));
  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink() ||
    sourceInfo.size < 2 ||
    sourceInfo.size > 64 * 1024 ||
    !parentInfo.isDirectory() ||
    parentInfo.isSymbolicLink() ||
    (parentInfo.mode & 0o077) !== 0
  )
    throw new TypeError("Mac qualification export is unsafe");
  let copied = false;
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    copied = true;
    await chmod(destination, 0o600);
    return destination;
  } catch (error) {
    if (copied) await rm(destination, { force: true });
    throw error;
  }
}

async function privateFileExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 2 ||
      info.size > 64 * 1024 ||
      (info.mode & 0o077) !== 0
    )
      throw new TypeError("Mac qualification export is unsafe");
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function layoutFlags(flags: ReadonlyMap<string, string>): string[] {
  return [
    ...(flags.has("root") ? ["--root", absoluteFlag(flags, "root")] : []),
    ...(flags.has("launch-daemons-root")
      ? ["--launch-daemons-root", absoluteFlag(flags, "launch-daemons-root")]
      : []),
  ];
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
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
