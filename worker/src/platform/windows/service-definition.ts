import { win32 } from "node:path";

export const WINDOWS_SERVICE_ID = "MusicMuteWorker";
export const WINDOWS_SERVICE_ACCOUNT = "NT AUTHORITY\\LocalService";
export const DEFAULT_WINDOWS_INSTALL_ROOT = "C:\\ProgramData\\MusicMuteWorker";

export interface WindowsServiceLayout {
  installRoot: string;
  releasesRoot: string;
  stateRoot: string;
  workRoot: string;
  modelCacheRoot: string;
  runtimeCacheRoot: string;
  temporaryRoot: string;
  configPath: string;
  credentialPath: string;
  logRoot: string;
  serviceRoot: string;
  serviceExecutablePath: string;
  serviceConfigPath: string;
}

export interface WindowsReleaseLayout {
  releaseRoot: string;
  nodePath: string;
  cliPath: string;
  appRoot: string;
  engineRoot: string;
  pythonPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  serviceExecutableSource: string;
}

export function createWindowsServiceLayout(
  installRoot = DEFAULT_WINDOWS_INSTALL_ROOT,
): WindowsServiceLayout {
  const root = safeWindowsRoot(installRoot);
  const stateRoot = win32.join(root, "state");
  const serviceRoot = win32.join(root, "service");
  return {
    installRoot: root,
    releasesRoot: win32.join(root, "releases"),
    stateRoot,
    workRoot: win32.join(stateRoot, "attempts"),
    modelCacheRoot: win32.join(stateRoot, "models"),
    runtimeCacheRoot: win32.join(stateRoot, "cache"),
    temporaryRoot: win32.join(stateRoot, "tmp"),
    configPath: win32.join(stateRoot, "runtime.json"),
    credentialPath: win32.join(stateRoot, "machine.credential"),
    logRoot: win32.join(stateRoot, "logs"),
    serviceRoot,
    serviceExecutablePath: win32.join(
      serviceRoot,
      "MusicMuteWorkerService.exe",
    ),
    serviceConfigPath: win32.join(serviceRoot, "MusicMuteWorkerService.xml"),
  };
}

export function createWindowsReleaseLayout(
  layout: WindowsServiceLayout,
  releaseVersion: string,
): WindowsReleaseLayout {
  if (!/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(releaseVersion))
    throw new TypeError("Windows release version is invalid");
  const releaseRoot = win32.join(layout.releasesRoot, releaseVersion);
  const appRoot = win32.join(releaseRoot, "app");
  return {
    releaseRoot,
    nodePath: win32.join(releaseRoot, "runtime", "node", "node.exe"),
    cliPath: win32.join(appRoot, "dist", "src", "cli", "main.js"),
    appRoot,
    engineRoot: win32.join(appRoot, "engine"),
    pythonPath: win32.join(releaseRoot, "runtime", "python", "python.exe"),
    ffmpegPath: win32.join(releaseRoot, "runtime", "bin", "ffmpeg.exe"),
    ffprobePath: win32.join(releaseRoot, "runtime", "bin", "ffprobe.exe"),
    serviceExecutableSource: win32.join(
      releaseRoot,
      "runtime",
      "service",
      "MusicMuteWorkerService.exe",
    ),
  };
}

export function renderWinSWConfig(
  layout: WindowsServiceLayout,
  release: WindowsReleaseLayout,
): string {
  assertReleaseInsideLayout(layout, release);
  const arguments_ = [
    quoteWindowsArgument(release.cliPath),
    "run",
    "--config",
    quoteWindowsArgument(layout.configPath),
  ].join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>${WINDOWS_SERVICE_ID}</id>
  <name>MusicMute Worker</name>
  <description>MusicMute private DirectML processing worker</description>
  <executable>${xml(release.nodePath)}</executable>
  <arguments>${xml(arguments_)}</arguments>
  <workingdirectory>${xml(release.appRoot)}</workingdirectory>
  <env name="HOME" value="${xml(layout.stateRoot)}"/>
  <env name="MPLCONFIGDIR" value="${xml(win32.join(layout.runtimeCacheRoot, "matplotlib"))}"/>
  <env name="NUMBA_CACHE_DIR" value="${xml(win32.join(layout.runtimeCacheRoot, "numba"))}"/>
  <env name="PATH" value="%SystemRoot%\\System32;%SystemRoot%"/>
  <env name="TEMP" value="${xml(layout.temporaryRoot)}"/>
  <env name="TMP" value="${xml(layout.temporaryRoot)}"/>
  <env name="XDG_CACHE_HOME" value="${xml(layout.runtimeCacheRoot)}"/>
  <serviceaccount>
    <domain>NT AUTHORITY</domain>
    <user>LocalService</user>
  </serviceaccount>
  <startmode>Automatic</startmode>
  <delayedAutoStart/>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="none"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>30 sec</stoptimeout>
  <logpath>${xml(layout.logRoot)}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
`;
}

function assertReleaseInsideLayout(
  layout: WindowsServiceLayout,
  release: WindowsReleaseLayout,
): void {
  const relative = win32.relative(layout.releasesRoot, release.releaseRoot);
  if (
    relative.length < 1 ||
    relative.startsWith("..") ||
    win32.isAbsolute(relative)
  )
    throw new TypeError("Windows release path is unsafe");
  for (const value of Object.values(release)) assertSafeWindowsValue(value);
  for (const value of Object.values(layout)) assertSafeWindowsValue(value);
}

function safeWindowsRoot(value: string): string {
  assertSafeWindowsValue(value);
  if (!win32.isAbsolute(value))
    throw new TypeError("Windows install root must be absolute");
  const normalized = win32.resolve(value);
  if (normalized === win32.parse(normalized).root)
    throw new TypeError("Windows install root is unsafe");
  return normalized;
}

function assertSafeWindowsValue(value: string): void {
  if (
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || '"<>|?*'.includes(character),
    )
  )
    throw new TypeError("Windows service path is unsafe");
}

function quoteWindowsArgument(value: string): string {
  assertSafeWindowsValue(value);
  return `"${value.replace(/(\\*)$/u, "$1$1")}"`;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
