import { execFile } from "node:child_process";
import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, win32 } from "node:path";
import {
  runEnrollmentCommand,
  runInstallationPreparationCommand,
} from "../../enrollment/cli.js";
import { readInstallationArtifactsReceipt } from "../../enrollment/installation-receipt.js";
import { parseQualificationEvidence } from "../../enrollment/report-builder.js";
import { createInstallationReleaseArchive } from "../../enrollment/release-archive.js";
import { buildWindowsRelease } from "./release-builder.js";
import { verifyWindowsRelease } from "./release-manifest.js";
import {
  createWindowsReleaseLayout,
  createWindowsServiceLayout,
  DEFAULT_WINDOWS_INSTALL_ROOT,
  renderWinSWConfig,
} from "./service-definition.js";

export const WINDOWS_USAGE = `Usage:
  musicmute-worker windows package --worker-root <path> --output <path> --version <version> --node-root <path> --python-root <path> --media-root <path> --service-root <path> [--archive <path.zip>]
  musicmute-worker windows bootstrap --backend-url <api-base-url> --enrollment-file <path> --output <protected-path> --label <name> [--group-id <id>] [--allow-insecure-loopback <true|false>] [--root <path>]
  musicmute-worker windows verify --release <path>
  musicmute-worker windows service-config --root <path> --version <version> --output <path> [--qualification-fixture <path> --qualification-fixture-sha256 <hex> --qualification-report <path>]
  musicmute-worker windows qualification-check --report <path> --fixture-sha256 <hex>`;

type InstallationReceipt = Awaited<
  ReturnType<typeof readInstallationArtifactsReceipt>
>;

export interface WindowsCommandRuntime {
  platform: NodeJS.Platform;
  architecture: string;
  prepareInstallation(arguments_: string[]): Promise<void>;
  readInstallationReceipt(outputRoot: string): Promise<InstallationReceipt>;
  enroll(arguments_: string[]): Promise<void>;
  privateFileExists(path: string): Promise<boolean>;
  runServiceManager(scriptPath: string, arguments_: string[]): Promise<void>;
}

const DEFAULT_WINDOWS_RUNTIME: WindowsCommandRuntime = {
  platform: process.platform,
  architecture: process.arch,
  prepareInstallation: runInstallationPreparationCommand,
  readInstallationReceipt: readInstallationArtifactsReceipt,
  enroll: runEnrollmentCommand,
  privateFileExists,
  runServiceManager: executeWindowsServiceManager,
};

export async function runWindowsCommand(
  arguments_: string[],
  runtime: WindowsCommandRuntime = DEFAULT_WINDOWS_RUNTIME,
): Promise<void> {
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
      "service-root",
      ...(flags.has("archive") ? ["archive"] : []),
    ]);
    exactFlags(flags, packageFlags);
    const outputRoot = absoluteFlag(flags, "output");
    const manifest = await buildWindowsRelease({
      workerRoot: absoluteFlag(flags, "worker-root"),
      outputRoot,
      releaseVersion: requiredFlag(flags, "version"),
      nodeRoot: absoluteFlag(flags, "node-root"),
      pythonRoot: absoluteFlag(flags, "python-root"),
      mediaRoot: absoluteFlag(flags, "media-root"),
      serviceRoot: absoluteFlag(flags, "service-root"),
    });
    const archive = flags.has("archive")
      ? await createInstallationReleaseArchive({
          releaseRoot: outputRoot,
          outputPath: absoluteFlag(flags, "archive"),
          platform: "windows-amd64",
        })
      : undefined;
    report(action, manifest.releaseVersion, manifest.entries.length, archive);
    return;
  }
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
      ]),
    );
    if (runtime.platform !== "win32" || runtime.architecture !== "x64")
      throw new TypeError(
        "Windows bootstrap requires Windows x64 administrator privileges",
      );
    const backendUrl = requiredFlag(flags, "backend-url");
    const enrollmentFile = windowsAbsoluteFlag(flags, "enrollment-file");
    const outputRoot = windowsAbsoluteFlag(flags, "output");
    const label = requiredFlag(flags, "label");
    const allowInsecureLoopback =
      flags.get("allow-insecure-loopback") ?? "false";
    const layout = createWindowsServiceLayout(
      flags.has("root")
        ? windowsAbsoluteFlag(flags, "root")
        : DEFAULT_WINDOWS_INSTALL_ROOT,
    );
    await runtime.prepareInstallation([
      "--backend-url",
      backendUrl,
      "--enrollment-file",
      enrollmentFile,
      "--platform",
      "windows-amd64",
      "--output",
      outputRoot,
      "--allow-insecure-loopback",
      allowInsecureLoopback,
    ]);
    const receipt = await runtime.readInstallationReceipt(outputRoot);
    if (receipt.platform !== "windows-amd64")
      throw new TypeError("Windows bootstrap artifact platform is invalid");
    const qualificationPath = win32.join(outputRoot, "qualification.json");
    const managerPath = win32.join(
      receipt.release.releaseRoot,
      "installer",
      "manage-windows-service.ps1",
    );
    if (!(await runtime.privateFileExists(qualificationPath))) {
      await runtime.runServiceManager(managerPath, [
        "-Action",
        "Stage",
        "-Release",
        receipt.release.releaseRoot,
        "-ModelSource",
        receipt.model.path,
        "-FixtureSource",
        receipt.fixture.path,
        "-FixtureSha256",
        receipt.fixture.sha256,
        "-QualificationOutput",
        qualificationPath,
        "-InstallRoot",
        layout.installRoot,
      ]);
    }
    await runtime.enroll([
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
    await runtime.runServiceManager(managerPath, [
      "-Action",
      "Install",
      "-Release",
      receipt.release.releaseRoot,
      "-Config",
      win32.join(outputRoot, "runtime.json"),
      "-Credential",
      win32.join(outputRoot, "machine.credential"),
      "-ModelSource",
      receipt.model.path,
      "-FixtureSource",
      receipt.fixture.path,
      "-FixtureSha256",
      receipt.fixture.sha256,
      "-InstallRoot",
      layout.installRoot,
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
  if (action === "verify") {
    exactFlags(flags, new Set(["release"]));
    const manifest = await verifyWindowsRelease(absoluteFlag(flags, "release"));
    report(action, manifest.releaseVersion, manifest.entries.length);
    return;
  }
  if (action === "service-config") {
    const qualificationFlags = [
      "qualification-fixture",
      "qualification-fixture-sha256",
      "qualification-report",
    ] as const;
    const qualificationFlagCount = qualificationFlags.filter((name) =>
      flags.has(name),
    ).length;
    if (
      qualificationFlagCount !== 0 &&
      qualificationFlagCount !== qualificationFlags.length
    )
      throw new TypeError(
        "Windows qualification flags must be provided together",
      );
    exactFlags(
      flags,
      new Set([
        "root",
        "version",
        "output",
        ...(qualificationFlagCount === 0 ? [] : qualificationFlags),
      ]),
    );
    const version = requiredFlag(flags, "version");
    const layout = createWindowsServiceLayout(absoluteFlag(flags, "root"));
    const release = createWindowsReleaseLayout(layout, version);
    const manifest = await verifyWindowsRelease(release.releaseRoot);
    if (manifest.releaseVersion !== version)
      throw new TypeError("Windows release version does not match its path");
    const handle = await open(absoluteFlag(flags, "output"), "wx", 0o600);
    try {
      await handle.writeFile(
        renderWinSWConfig(
          layout,
          release,
          qualificationFlagCount === 0
            ? undefined
            : {
                fixturePath: absoluteFlag(flags, "qualification-fixture"),
                fixtureSha256: requiredFlag(
                  flags,
                  "qualification-fixture-sha256",
                ),
                reportPath: absoluteFlag(flags, "qualification-report"),
              },
        ),
        "utf8",
      );
    } finally {
      await handle.close();
    }
    report(action, manifest.releaseVersion, manifest.entries.length);
    return;
  }
  if (action === "qualification-check") {
    exactFlags(flags, new Set(["report", "fixture-sha256"]));
    const reportPath = absoluteFlag(flags, "report");
    const fixtureSha256 = requiredFlag(flags, "fixture-sha256");
    if (!/^[a-f0-9]{64}$/u.test(fixtureSha256))
      throw new TypeError("Windows qualification fixture digest is invalid");
    const info = await lstat(reportPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size < 2 ||
      info.size > 64 * 1024
    )
      throw new TypeError("Windows qualification report is unsafe");
    const evidence = parseQualificationEvidence(
      JSON.parse(await readFile(reportPath, "utf8")) as unknown,
    );
    if (
      evidence.platform !== "windows-amd64" ||
      evidence.provider !== "directml" ||
      evidence.gpuId !== "gpu0" ||
      evidence.fixtureDigest !== fixtureSha256
    )
      throw new TypeError(
        "Windows qualification report does not match installation",
      );
    console.log(
      JSON.stringify({
        status: "ok",
        action,
        recipeCount: evidence.recipeIds.length,
      }),
    );
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
  if ([...flags.keys()].some((key) => !allowed.has(key)))
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

function windowsAbsoluteFlag(flags: Map<string, string>, name: string): string {
  const value = requiredFlag(flags, name);
  if (!win32.isAbsolute(value))
    throw new TypeError(`--${name} must be an absolute Windows path`);
  return value;
}

async function privateFileExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.size > 1;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return false;
    throw error;
  }
}

async function executeWindowsServiceManager(
  scriptPath: string,
  arguments_: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "RemoteSigned",
        "-File",
        scriptPath,
        ...arguments_,
      ],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error) => {
        if (error) {
          reject(new TypeError("Windows service manager failed"));
          return;
        }
        resolve();
      },
    );
  });
}

function report(
  action: string,
  releaseVersion: string,
  entryCount: number,
  archive?: unknown,
) {
  console.log(
    JSON.stringify({
      status: "ok",
      action,
      releaseVersion,
      entryCount,
      ...(archive === undefined ? {} : { archive }),
    }),
  );
}
