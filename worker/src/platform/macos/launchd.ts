import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export const MAC_SERVICE_LABEL = "com.musicmute.worker";
export const DEFAULT_MAC_INSTALL_ROOT =
  "/Library/Application Support/MusicMuteWorker";
export const DEFAULT_MAC_LAUNCH_DAEMONS_ROOT = "/Library/LaunchDaemons";

const ACCOUNT_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/u;

export interface MacServiceLayout {
  installRoot: string;
  releasesRoot: string;
  currentLink: string;
  stateRoot: string;
  workRoot: string;
  modelCacheRoot: string;
  runtimeCacheRoot: string;
  temporaryRoot: string;
  configPath: string;
  credentialPath: string;
  logRoot: string;
  stdoutPath: string;
  stderrPath: string;
  plistPath: string;
  nodePath: string;
  cliPath: string;
  engineRoot: string;
  pythonPath: string;
  ffmpegPath: string;
  ffprobePath: string;
}

export interface LaunchDaemonOptions {
  layout: MacServiceLayout;
  serviceUser: string;
  serviceGroup: string;
  qualification?: MacLaunchQualification;
}

export interface MacLaunchQualification {
  releaseRoot: string;
  fixturePath: string;
  fixtureSha256: string;
  reportPath: string;
}

export function createMacServiceLayout(
  installRoot = DEFAULT_MAC_INSTALL_ROOT,
  launchDaemonsRoot = DEFAULT_MAC_LAUNCH_DAEMONS_ROOT,
): MacServiceLayout {
  const root = safeAbsoluteRoot(installRoot, "Mac install root");
  const daemons = safeAbsoluteRoot(launchDaemonsRoot, "LaunchDaemons root");
  const currentLink = join(root, "current");
  const stateRoot = join(root, "state");
  const logRoot = join(root, "logs");
  return {
    installRoot: root,
    releasesRoot: join(root, "releases"),
    currentLink,
    stateRoot,
    workRoot: join(stateRoot, "attempts"),
    modelCacheRoot: join(stateRoot, "models"),
    runtimeCacheRoot: join(stateRoot, "cache"),
    temporaryRoot: join(stateRoot, "tmp"),
    configPath: join(stateRoot, "runtime.json"),
    credentialPath: join(stateRoot, "machine.credential"),
    logRoot,
    stdoutPath: join(logRoot, "worker.log"),
    stderrPath: join(logRoot, "worker.error.log"),
    plistPath: join(daemons, `${MAC_SERVICE_LABEL}.plist`),
    nodePath: join(currentLink, "runtime", "node", "bin", "node"),
    cliPath: join(currentLink, "app", "dist", "src", "cli", "main.js"),
    engineRoot: join(currentLink, "app", "engine"),
    pythonPath: join(currentLink, "runtime", "python", "bin", "python3"),
    ffmpegPath: join(currentLink, "runtime", "bin", "ffmpeg"),
    ffprobePath: join(currentLink, "runtime", "bin", "ffprobe"),
  };
}

export function renderLaunchDaemonPlist({
  layout,
  serviceUser,
  serviceGroup,
  qualification,
}: LaunchDaemonOptions): string {
  assertAccountName(serviceUser, "service user");
  assertAccountName(serviceGroup, "service group");
  if (
    qualification !== undefined &&
    !/^[a-f0-9]{64}$/u.test(qualification.fixtureSha256)
  )
    throw new TypeError("Qualification fixture digest is invalid");
  if (qualification !== undefined) {
    assertPathInside(
      layout.releasesRoot,
      qualification.releaseRoot,
      "Qualification release root",
    );
    assertPathInside(
      layout.stateRoot,
      qualification.fixturePath,
      "Qualification fixture path",
    );
    assertPathInside(
      layout.stateRoot,
      qualification.reportPath,
      "Qualification report path",
    );
  }
  const programArguments =
    qualification === undefined
      ? [layout.nodePath, layout.cliPath, "run", "--config", layout.configPath]
      : [
          layout.pythonPath,
          "-m",
          "musicmute_engine.qualification",
          "--provider",
          "coreml",
          "--fixture",
          qualification.fixturePath,
          "--fixture-sha256",
          qualification.fixtureSha256,
          "--work-root",
          layout.workRoot,
          "--release-root",
          qualification.releaseRoot,
          "--model-cache",
          layout.modelCacheRoot,
          "--ffmpeg",
          layout.ffmpegPath,
          "--ffprobe",
          layout.ffprobePath,
          "--report",
          qualification.reportPath,
        ];
  const workingDirectory =
    qualification === undefined
      ? join(layout.currentLink, "app")
      : layout.engineRoot;
  const values = [
    ...programArguments.filter((value) => value.startsWith(sep)),
    workingDirectory,
    layout.stateRoot,
    layout.runtimeCacheRoot,
    layout.temporaryRoot,
    layout.stdoutPath,
    layout.stderrPath,
  ];
  if (values.some((value) => !isAbsolute(value)))
    throw new TypeError("LaunchDaemon paths must be absolute");
  const keepAlive =
    qualification === undefined
      ? `<dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>`
      : "<false/>";
  const path =
    qualification === undefined
      ? "/usr/bin:/bin:/usr/sbin:/sbin"
      : `${dirname(layout.ffmpegPath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((value) => `    <string>${xml(value)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(workingDirectory)}</string>
  <key>UserName</key>
  <string>${xml(serviceUser)}</string>
  <key>GroupName</key>
  <string>${xml(serviceGroup)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(layout.stateRoot)}</string>
    <key>MPLCONFIGDIR</key>
    <string>${xml(join(layout.runtimeCacheRoot, "matplotlib"))}</string>
    <key>NUMBA_CACHE_DIR</key>
    <string>${xml(join(layout.runtimeCacheRoot, "numba"))}</string>
    <key>PATH</key>
    <string>${xml(path)}</string>
    <key>TMPDIR</key>
    <string>${xml(layout.temporaryRoot)}</string>
    <key>XDG_CACHE_HOME</key>
    <string>${xml(layout.runtimeCacheRoot)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  ${keepAlive}
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardOutPath</key>
  <string>${xml(layout.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(layout.stderrPath)}</string>
</dict>
</plist>
`;
}

function safeAbsoluteRoot(value: string, label: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute`);
  const normalized = resolve(value);
  if (normalized === resolve(sep)) throw new TypeError(`${label} is unsafe`);
  return normalized;
}

function assertAccountName(value: string, label: string): void {
  if (!ACCOUNT_NAME.test(value)) throw new TypeError(`${label} is invalid`);
}

function assertPathInside(root: string, value: string, label: string): void {
  if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute`);
  const normalizedRoot = resolve(root);
  const normalized = resolve(value);
  if (!normalized.startsWith(`${normalizedRoot}${sep}`))
    throw new TypeError(`${label} is unsafe`);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
