import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import type { Stats } from "node:fs";
import {
  chmod,
  chown,
  cp,
  lstat,
  lchown,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseQualificationEvidence } from "../../enrollment/report-builder.js";
import { loadRuntimeConfig } from "../../runtime/runtime-config.js";
import {
  MAC_SERVICE_LABEL,
  type MacServiceLayout,
  renderLaunchDaemonPlist,
} from "./launchd.js";
import {
  type MacReleaseManifest,
  verifyMacRelease,
} from "./release-manifest.js";

export interface MacServiceOwner {
  uid: number;
  gid: number;
}

export interface StageMacServiceOptions {
  releaseRoot: string;
  layout: MacServiceLayout;
  serviceUser: string;
  serviceGroup: string;
  owner?: MacServiceOwner;
}

export interface InstallMacServiceOptions extends StageMacServiceOptions {
  configSource: string;
  credentialSource: string;
}

export interface MacServiceInstallation {
  releaseVersion: string;
  releaseRoot: string;
  previousRelease: string | null;
  plistPath: string;
}

export interface MacServiceQualificationOptions {
  layout: MacServiceLayout;
  releaseRoot: string;
  fixtureSource: string;
  fixtureSha256: string;
  serviceUser: string;
  serviceGroup: string;
  owner?: MacServiceOwner;
  lifecycle?: {
    activate: () => Promise<void>;
    deactivate: () => Promise<void>;
  };
  waitForReport?: (
    reportPath: string,
    fixtureSha256: string,
    owner?: MacServiceOwner,
  ) => Promise<void>;
}

export interface MacServiceQualification {
  fixturePath: string;
  reportPath: string;
}

export interface MacServiceInspection {
  releaseVersion: string;
  releaseRoot: string;
  serviceLoaded: boolean | null;
  runtime: MacRuntimeDiagnostics | null;
}

export interface MacRuntimeDiagnostics {
  status: "ok";
  platform: "darwin";
  architecture: "arm64";
  python: string;
  onnxRuntime: string;
  audioSeparator: string;
  provider: "CoreMLExecutionProvider";
  modelSha256: string;
  modelBytes: number;
  ffmpeg: string;
  ffprobe: string;
  modelPath: string;
}

export async function installMacServiceFiles(
  options: InstallMacServiceOptions,
): Promise<MacServiceInstallation> {
  const installation = await stageMacServiceFiles(options);
  await installMacServiceIdentity(
    options.layout,
    options.configSource,
    options.credentialSource,
    options.owner,
  );
  return installation;
}

export async function installMacServiceIdentity(
  layout: MacServiceLayout,
  configSource: string,
  credentialSource: string,
  owner?: MacServiceOwner,
): Promise<void> {
  await assertSecureSource(configSource, "runtime config", 64 * 1024, false);
  await assertSecureSource(credentialSource, "machine credential", 128, true);
  await atomicCopy(
    credentialSource,
    layout.credentialPath,
    0o600,
    owner,
    "machine credential",
  );
  await atomicCopy(
    configSource,
    layout.configPath,
    0o600,
    owner,
    "runtime config",
  );
  const config = await loadRuntimeConfig(layout.configPath);
  assertServiceConfig(config, layout);
}

export async function stageMacServiceFiles(
  options: StageMacServiceOptions,
): Promise<MacServiceInstallation> {
  const manifest = await verifyMacRelease(options.releaseRoot);
  await ensureDirectory(options.layout.installRoot, 0o755);
  await ensureDirectory(options.layout.releasesRoot, 0o755);
  await ensureDirectory(options.layout.stateRoot, 0o700, options.owner);
  await ensureDirectory(options.layout.workRoot, 0o700, options.owner);
  await ensureDirectory(options.layout.modelCacheRoot, 0o700, options.owner);
  await ensureDirectory(options.layout.runtimeCacheRoot, 0o700, options.owner);
  await ensureDirectory(options.layout.temporaryRoot, 0o700, options.owner);
  await ensureDirectory(options.layout.logRoot, 0o700, options.owner);
  await ensureDirectory(dirname(options.layout.plistPath), 0o755);

  const installedRelease = join(
    options.layout.releasesRoot,
    manifest.releaseVersion,
  );
  await installImmutableRelease(
    options.releaseRoot,
    installedRelease,
    manifest,
  );
  await assertReleaseOwnership(installedRelease, options.owner);
  const plist = renderLaunchDaemonPlist(options);
  const previousRelease = await currentRelease(options.layout);
  const temporaryLink = join(
    options.layout.installRoot,
    `.current.${randomUUID()}`,
  );
  const temporaryPlist = `${options.layout.plistPath}.${randomUUID()}.tmp`;
  await symlink(
    relative(options.layout.installRoot, installedRelease),
    temporaryLink,
  );
  await atomicWrite(temporaryPlist, plist, 0o644);
  try {
    await rename(temporaryLink, options.layout.currentLink);
    await rename(temporaryPlist, options.layout.plistPath);
  } catch (error) {
    await rm(temporaryLink, { force: true });
    await rm(temporaryPlist, { force: true });
    if (previousRelease !== null)
      await replaceCurrentLink(options.layout, previousRelease);
    throw error;
  }
  return {
    releaseVersion: manifest.releaseVersion,
    releaseRoot: installedRelease,
    previousRelease,
    plistPath: options.layout.plistPath,
  };
}

export async function inspectMacServiceInstallation(
  layout: MacServiceLayout,
  serviceUser: string,
  serviceGroup: string,
  owner?: MacServiceOwner,
  checkLaunchd = false,
  checkRuntime = false,
): Promise<MacServiceInspection> {
  const target = await currentRelease(layout);
  if (target === null)
    throw new TypeError("Mac service current release is missing");
  const releaseRoot = resolve(layout.installRoot, target);
  if (!releaseRoot.startsWith(`${layout.releasesRoot}${sep}`))
    throw new TypeError("Mac service current release is unsafe");
  const manifest = await verifyMacRelease(releaseRoot);
  await assertReleaseOwnership(releaseRoot, owner);
  await assertMode(layout.stateRoot, 0o700, "directory", owner);
  await assertMode(layout.workRoot, 0o700, "directory", owner);
  await assertMode(layout.modelCacheRoot, 0o700, "directory", owner);
  await assertMode(layout.runtimeCacheRoot, 0o700, "directory", owner);
  await assertMode(layout.temporaryRoot, 0o700, "directory", owner);
  await assertMode(layout.logRoot, 0o700, "directory", owner);
  await assertMode(layout.configPath, 0o600, "file", owner);
  await assertMode(layout.credentialPath, 0o600, "file", owner);
  const config = await loadRuntimeConfig(layout.configPath);
  assertServiceConfig(config, layout);
  const expectedPlist = renderLaunchDaemonPlist({
    layout,
    serviceUser,
    serviceGroup,
  });
  if ((await readFile(layout.plistPath, "utf8")) !== expectedPlist)
    throw new TypeError("LaunchDaemon definition does not match installation");
  const serviceLoaded = checkLaunchd
    ? (await launchctl(["print", `system/${MAC_SERVICE_LABEL}`], true)).code ===
      0
    : null;
  const runtime = checkRuntime
    ? await runMacRuntimeDoctor(layout, owner)
    : null;
  return {
    releaseVersion: manifest.releaseVersion,
    releaseRoot,
    serviceLoaded,
    runtime,
  };
}

async function runMacRuntimeDoctor(
  layout: MacServiceLayout,
  owner?: MacServiceOwner,
): Promise<MacRuntimeDiagnostics> {
  const output = await runPrivatePython(
    layout,
    [
      "-m",
      "musicmute_engine.service_doctor",
      "--model-cache",
      layout.modelCacheRoot,
      "--ffmpeg",
      layout.ffmpegPath,
      "--ffprobe",
      layout.ffprobePath,
    ],
    owner,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch {
    throw new TypeError("Mac service runtime doctor returned invalid JSON");
  }
  return parseRuntimeDiagnostics(decoded, layout);
}

export async function installMacModelArtifact(
  layout: MacServiceLayout,
  source: string,
  owner?: MacServiceOwner,
): Promise<void> {
  const sourceInfo = await lstat(source);
  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink() ||
    sourceInfo.size !== 66_759_214
  )
    throw new TypeError("Mac model source is unsafe");
  const stagedSource = join(
    layout.stateRoot,
    `.model-source-${randomUUID()}.onnx`,
  );
  await atomicCopy(source, stagedSource, 0o600, owner, "staged model source");
  let output: string;
  try {
    output = await runPrivatePython(
      layout,
      [
        "-m",
        "musicmute_engine.model_tool",
        "--source",
        stagedSource,
        "--model-cache",
        layout.modelCacheRoot,
      ],
      owner,
    );
  } finally {
    await rm(stagedSource, { force: true });
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch {
    throw new TypeError("Mac model installer returned invalid JSON");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
    throw new TypeError("Mac model installer returned invalid output");
  const result = decoded as Record<string, unknown>;
  const expectedPath = join(
    layout.modelCacheRoot,
    "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
    "Kim_Vocal_2.onnx",
  );
  if (
    Object.keys(result).length !== 4 ||
    result.status !== "ok" ||
    result.modelSha256 !==
      "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b" ||
    result.modelBytes !== 66_759_214 ||
    result.modelPath !== expectedPath
  )
    throw new TypeError("Mac model installer returned invalid output");
}

export async function runMacServiceQualification(
  options: MacServiceQualificationOptions,
): Promise<MacServiceQualification> {
  if (!/^[a-f0-9]{64}$/u.test(options.fixtureSha256))
    throw new TypeError("Mac qualification fixture digest is invalid");
  if (extname(options.fixtureSource).toLowerCase() !== ".wav")
    throw new TypeError("Mac qualification fixture must be WAV");
  await assertSecureSource(
    options.fixtureSource,
    "qualification fixture",
    64 * 1024 * 1024,
    false,
  );

  const releaseRoot = resolve(options.releaseRoot);
  if (!releaseRoot.startsWith(`${resolve(options.layout.releasesRoot)}${sep}`))
    throw new TypeError("Mac qualification release is unsafe");
  await verifyMacRelease(releaseRoot);

  const fixturePath = join(
    options.layout.stateRoot,
    `qualification-fixture-${options.fixtureSha256}.wav`,
  );
  await atomicCopy(
    options.fixtureSource,
    fixturePath,
    0o600,
    options.owner,
    "qualification fixture",
  );
  const installedDigest = createHash("sha256")
    .update(await readFile(fixturePath))
    .digest("hex");
  if (installedDigest !== options.fixtureSha256) {
    await rm(fixturePath, { force: true });
    throw new TypeError("Mac qualification fixture digest does not match");
  }

  const reportPath = join(
    options.layout.stateRoot,
    `qualification-${randomUUID()}.json`,
  );
  const qualificationPlist = renderLaunchDaemonPlist({
    layout: options.layout,
    serviceUser: options.serviceUser,
    serviceGroup: options.serviceGroup,
    qualification: {
      releaseRoot,
      fixturePath,
      fixtureSha256: options.fixtureSha256,
      reportPath,
    },
  });
  const activePlist = renderLaunchDaemonPlist({
    layout: options.layout,
    serviceUser: options.serviceUser,
    serviceGroup: options.serviceGroup,
  });
  const lifecycle = options.lifecycle ?? {
    activate: () => activateMacService(options.layout),
    deactivate: () => deactivateMacService(),
  };
  const waitForReport = options.waitForReport ?? waitForMacQualificationReport;

  let qualificationError: unknown;
  try {
    await replaceManagedPlist(options.layout.plistPath, qualificationPlist);
    await lifecycle.activate();
    await waitForReport(reportPath, options.fixtureSha256, options.owner);
  } catch (error) {
    qualificationError = error;
  }

  let cleanupError: unknown;
  try {
    await lifecycle.deactivate();
  } catch (error) {
    cleanupError = error;
  }
  try {
    await replaceManagedPlist(options.layout.plistPath, activePlist);
  } catch (error) {
    cleanupError ??= error;
  }

  if (qualificationError !== undefined || cleanupError !== undefined) {
    await rm(reportPath, { force: true });
    throw qualificationError ?? cleanupError;
  }
  return { fixturePath, reportPath };
}

export async function waitForMacQualificationReport(
  reportPath: string,
  fixtureSha256: string,
  owner?: MacServiceOwner,
  wait: (milliseconds: number) => Promise<unknown> = delay,
  attempts = 9_600,
): Promise<void> {
  if (
    !isAbsolute(reportPath) ||
    !/^[a-f0-9]{64}$/u.test(fixtureSha256) ||
    !Number.isSafeInteger(attempts) ||
    attempts < 1
  )
    throw new TypeError("Mac qualification report wait is invalid");

  let invalidJsonAttempts = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const info = await optionalLstat(reportPath);
    if (info === null || info.size < 2) {
      if (attempt + 1 < attempts) await wait(250);
      continue;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 64 * 1024 ||
      (info.mode & 0o777) !== 0o600 ||
      (owner !== undefined &&
        (info.uid !== owner.uid || info.gid !== owner.gid))
    )
      throw new TypeError("Mac qualification report is unsafe");

    let value: unknown;
    try {
      value = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    } catch {
      invalidJsonAttempts += 1;
      if (invalidJsonAttempts >= 10)
        throw new TypeError("Mac qualification report is invalid JSON");
      if (attempt + 1 < attempts) await wait(250);
      continue;
    }
    const evidence = parseQualificationEvidence(value);
    if (
      evidence.platform !== "darwin-arm64" ||
      evidence.provider !== "coreml" ||
      evidence.gpuId !== "gpu0" ||
      evidence.fixtureDigest !== fixtureSha256
    )
      throw new TypeError(
        "Mac qualification report does not match installation",
      );
    return;
  }
  throw new Error("Mac qualification service timed out");
}

async function runPrivatePython(
  layout: MacServiceLayout,
  arguments_: string[],
  owner?: MacServiceOwner,
): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(layout.pythonPath, arguments_, {
      cwd: layout.engineRoot,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        HOME: layout.stateRoot,
        MPLCONFIGDIR: join(layout.runtimeCacheRoot, "matplotlib"),
        NUMBA_CACHE_DIR: join(layout.runtimeCacheRoot, "numba"),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONNOUSERSITE: "1",
        TMPDIR: layout.temporaryRoot,
        XDG_CACHE_HOME: layout.runtimeCacheRoot,
      },
      ...(owner === undefined ? {} : { uid: owner.uid, gid: owner.gid }),
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 64 * 1024) child.kill("SIGKILL");
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null || code !== 0 || stdout.length > 64 * 1024)
        return reject(new Error("Mac private Python command failed"));
      resolvePromise(stdout);
    });
  });
}

function parseRuntimeDiagnostics(
  value: unknown,
  layout: MacServiceLayout,
): MacRuntimeDiagnostics {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Mac service runtime diagnostics are invalid");
  const result = value as Record<string, unknown>;
  const keys = new Set([
    "status",
    "platform",
    "architecture",
    "python",
    "onnxRuntime",
    "audioSeparator",
    "provider",
    "modelSha256",
    "modelBytes",
    "ffmpeg",
    "ffprobe",
    "modelPath",
  ]);
  if (
    Object.keys(result).length !== keys.size ||
    Object.keys(result).some((key) => !keys.has(key)) ||
    result.status !== "ok" ||
    result.platform !== "darwin" ||
    result.architecture !== "arm64" ||
    result.provider !== "CoreMLExecutionProvider" ||
    typeof result.python !== "string" ||
    !result.python.startsWith("3.13.") ||
    result.onnxRuntime !== "1.30.0" ||
    result.audioSeparator !== "0.47.0" ||
    typeof result.modelSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(result.modelSha256) ||
    result.modelBytes !== 66_759_214 ||
    typeof result.ffmpeg !== "string" ||
    !result.ffmpeg.startsWith("ffmpeg version 8.0.3 ") ||
    typeof result.ffprobe !== "string" ||
    !result.ffprobe.startsWith("ffprobe version 8.0.3 ") ||
    typeof result.modelPath !== "string" ||
    !resolve(result.modelPath).startsWith(`${layout.modelCacheRoot}${sep}`)
  )
    throw new TypeError("Mac service runtime diagnostics are invalid");
  return result as unknown as MacRuntimeDiagnostics;
}

export async function activateMacService(
  layout: MacServiceLayout,
): Promise<void> {
  assertDarwinAdministrator();
  await launchctl(["bootout", `system/${MAC_SERVICE_LABEL}`], true);
  await waitForMacServiceDeactivation();
  const bootstrap = await launchctl(
    ["bootstrap", "system", layout.plistPath],
    false,
  );
  if (bootstrap.code !== 0) throw new Error("LaunchDaemon bootstrap failed");
  const kickstart = await launchctl(
    ["kickstart", "-k", `system/${MAC_SERVICE_LABEL}`],
    false,
  );
  if (kickstart.code !== 0) throw new Error("LaunchDaemon kickstart failed");
}

export async function deactivateMacService(): Promise<void> {
  assertDarwinAdministrator();
  await launchctl(["bootout", `system/${MAC_SERVICE_LABEL}`], true);
  await waitForMacServiceDeactivation();
}

export async function waitForMacServiceDeactivation(
  check: () => Promise<{ code: number }> = () =>
    launchctl(["print", `system/${MAC_SERVICE_LABEL}`], true),
  wait: (milliseconds: number) => Promise<unknown> = delay,
  attempts = 50,
): Promise<void> {
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new TypeError("Mac service deactivation attempts are invalid");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await check()).code !== 0) return;
    if (attempt + 1 < attempts) await wait(100);
  }
  throw new Error("LaunchDaemon deactivation failed");
}

export async function uninstallMacServiceFiles(
  layout: MacServiceLayout,
): Promise<void> {
  await rm(layout.plistPath, { force: true });
  const currentInfo = await optionalLstat(layout.currentLink);
  if (currentInfo !== null && !currentInfo.isSymbolicLink())
    throw new TypeError("Mac service current path is unsafe");
  await rm(layout.currentLink, { force: true });
}

export async function rollbackMacServiceFiles(
  layout: MacServiceLayout,
  previousRelease: string | null,
): Promise<void> {
  if (previousRelease === null) {
    await uninstallMacServiceFiles(layout);
    return;
  }
  const destination = resolve(layout.installRoot, previousRelease);
  if (!destination.startsWith(`${layout.releasesRoot}${sep}`))
    throw new TypeError("Previous Mac release is unsafe");
  await verifyMacRelease(destination);
  await replaceCurrentLink(layout, previousRelease);
}

export async function getMacCurrentRelease(
  layout: MacServiceLayout,
): Promise<string | null> {
  return await currentRelease(layout);
}

async function installImmutableRelease(
  source: string,
  destination: string,
  expected: MacReleaseManifest,
): Promise<void> {
  const existing = await optionalLstat(destination);
  if (existing !== null) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new TypeError("Installed Mac release path is unsafe");
    const installed = await verifyMacRelease(destination);
    if (JSON.stringify(installed) !== JSON.stringify(expected))
      throw new TypeError("Installed Mac release version is immutable");
    await normalizeReleaseOwnership(destination);
    return;
  }
  const temporary = `${destination}.${randomUUID()}.installing`;
  try {
    await cp(source, temporary, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    const copied = await verifyMacRelease(temporary);
    if (JSON.stringify(copied) !== JSON.stringify(expected))
      throw new TypeError("Copied Mac release failed verification");
    await normalizeReleaseOwnership(temporary);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function normalizeReleaseOwnership(releaseRoot: string): Promise<void> {
  if (process.geteuid?.() !== 0) return;
  const entries = [releaseRoot];
  for (let index = 0; index < entries.length; index += 1) {
    const path = entries[index];
    if (path === undefined) continue;
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      await lchown(path, 0, 0);
      continue;
    }
    await chown(path, 0, 0);
    if (info.isDirectory())
      for (const child of await readdir(path)) entries.push(join(path, child));
  }
}

async function currentRelease(
  layout: MacServiceLayout,
): Promise<string | null> {
  const info = await optionalLstat(layout.currentLink);
  if (info === null) return null;
  if (!info.isSymbolicLink())
    throw new TypeError("Mac service current path is unsafe");
  const target = await readlink(layout.currentLink);
  if (
    target.length < 1 ||
    target.startsWith("/") ||
    target.split(/[\\/]/u).some((part) => part === "..")
  )
    throw new TypeError("Mac service current link is unsafe");
  const destination = resolve(layout.installRoot, target);
  if (!destination.startsWith(`${layout.releasesRoot}${sep}`))
    throw new TypeError("Mac service current link is unsafe");
  return target;
}

async function replaceCurrentLink(
  layout: MacServiceLayout,
  target: string,
): Promise<void> {
  const temporary = join(layout.installRoot, `.current.${randomUUID()}`);
  await symlink(target, temporary);
  await rename(temporary, layout.currentLink);
}

async function ensureDirectory(
  path: string,
  mode: number,
  owner?: MacServiceOwner,
): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new TypeError(`Mac service directory is unsafe: ${basename(path)}`);
  await chmod(path, mode);
  if (owner) await chown(path, owner.uid, owner.gid);
}

async function atomicCopy(
  source: string,
  destination: string,
  mode: number,
  owner?: MacServiceOwner,
  label = "private file",
): Promise<void> {
  const contents = await readFile(source);
  const existingInfo = await optionalLstat(destination);
  if (existingInfo !== null) {
    if (!existingInfo.isFile() || existingInfo.isSymbolicLink())
      throw new TypeError(`Mac ${label} destination is unsafe`);
    const existing = await readFile(destination);
    if (
      existing.length !== contents.length ||
      !timingSafeEqual(existing, contents)
    )
      throw new TypeError(`Mac ${label} is immutable during repair`);
    await chmod(destination, mode);
    if (owner) await chown(destination, owner.uid, owner.gid);
    return;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, mode);
  if (owner) await chown(temporary, owner.uid, owner.gid);
  await rename(temporary, destination);
}

async function atomicWrite(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

async function replaceManagedPlist(
  path: string,
  contents: string,
): Promise<void> {
  const info = await optionalLstat(path);
  if (info === null || !info.isFile() || info.isSymbolicLink())
    throw new TypeError("LaunchDaemon definition is unsafe");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await atomicWrite(temporary, contents, 0o644);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function assertSecureSource(
  path: string,
  label: string,
  maximumBytes: number,
  privateFile: boolean,
): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 1 ||
    info.size > maximumBytes ||
    (privateFile && (info.mode & 0o077) !== 0)
  )
    throw new TypeError(`Mac ${label} source is unsafe`);
}

async function assertMode(
  path: string,
  mode: number,
  kind: "directory" | "file",
  owner?: MacServiceOwner,
): Promise<void> {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    (kind === "directory" ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o777) !== mode ||
    (owner !== undefined && (info.uid !== owner.uid || info.gid !== owner.gid))
  )
    throw new TypeError(
      `Mac service permissions are invalid: ${basename(path)}`,
    );
}

async function assertReleaseOwnership(
  releaseRoot: string,
  serviceOwner?: MacServiceOwner,
): Promise<void> {
  const entries = [releaseRoot];
  for (let index = 0; index < entries.length; index += 1) {
    const path = entries[index];
    if (path === undefined) continue;
    const info = await lstat(path);
    if (
      (process.geteuid?.() === 0 && (info.uid !== 0 || info.gid !== 0)) ||
      (serviceOwner !== undefined && info.uid === serviceOwner.uid)
    )
      throw new TypeError("Mac release ownership is unsafe");
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const child of await readdir(path)) entries.push(join(path, child));
    }
  }
}

function assertServiceConfig(
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>,
  layout: MacServiceLayout,
): void {
  const expected: Record<string, string> = {
    credentialFile: layout.credentialPath,
    workRoot: layout.workRoot,
    modelCacheRoot: layout.modelCacheRoot,
    engineRoot: layout.engineRoot,
    pythonPath: layout.pythonPath,
    ffmpegPath: layout.ffmpegPath,
    ffprobePath: layout.ffprobePath,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (config[key as keyof typeof config] !== value)
      throw new TypeError(`Mac service config path is invalid: ${key}`);
  }
  if (config.slots.some((slot) => slot.provider !== "coreml"))
    throw new TypeError("Mac service config must use CoreML");
}

function assertDarwinAdministrator(): void {
  if (process.platform !== "darwin" || process.geteuid?.() !== 0)
    throw new Error("Mac service activation requires a Darwin administrator");
}

async function launchctl(
  arguments_: string[],
  ignoreFailure: boolean,
): Promise<{ code: number }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/launchctl", arguments_, {
      stdio: ["ignore", "ignore", "ignore"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null)
        return reject(new Error("launchctl was interrupted"));
      const status = code ?? 1;
      if (!ignoreFailure && status !== 0)
        return resolvePromise({ code: status });
      resolvePromise({ code: status });
    });
  });
}

async function optionalLstat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
