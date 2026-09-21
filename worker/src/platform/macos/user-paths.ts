import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

export const MAC_USER_SERVICE_LABEL = "com.musicmute.worker";

export interface MacUserLayout {
  homeRoot: string;
  installRoot: string;
  configRoot: string;
  credentialRoot: string;
  stateRoot: string;
  transactionRoot: string;
  releasesRoot: string;
  currentLink: string;
  modelRoot: string;
  workRoot: string;
  cacheRoot: string;
  temporaryRoot: string;
  logRoot: string;
  configPath: string;
  credentialPath: string;
  installationStatePath: string;
  lifecyclePath: string;
  updateStatePath: string;
  updateTrustPath: string;
  unpairReceiptPath: string;
  commandLockPath: string;
  runtimeStatusPath: string;
  stdoutPath: string;
  stderrPath: string;
  launchAgentsRoot: string;
  plistPath: string;
  nodePath: string;
  cliPath: string;
  engineRoot: string;
  pythonPath: string;
  ffmpegPath: string;
  ffprobePath: string;
}

export function createMacUserLayout(homeRoot: string): MacUserLayout {
  const home = safeAbsoluteRoot(homeRoot, "macOS home root");
  const installRoot = join(
    home,
    "Library",
    "Application Support",
    "MusicMuteWorker",
  );
  const configRoot = join(installRoot, "config");
  const credentialRoot = join(installRoot, "credentials");
  const stateRoot = join(installRoot, "state");
  const currentLink = join(installRoot, "runtime", "current");
  const logRoot = join(installRoot, "logs");
  const launchAgentsRoot = join(home, "Library", "LaunchAgents");
  return {
    homeRoot: home,
    installRoot,
    configRoot,
    credentialRoot,
    stateRoot,
    transactionRoot: join(stateRoot, "transactions"),
    releasesRoot: join(installRoot, "runtime", "releases"),
    currentLink,
    modelRoot: join(installRoot, "models"),
    workRoot: join(installRoot, "jobs", "attempts"),
    cacheRoot: join(installRoot, "cache"),
    temporaryRoot: join(installRoot, "tmp"),
    logRoot,
    configPath: join(configRoot, "runtime.json"),
    credentialPath: join(credentialRoot, "machine.credential"),
    installationStatePath: join(stateRoot, "installation.json"),
    lifecyclePath: join(stateRoot, "lifecycle.json"),
    updateStatePath: join(stateRoot, "update.json"),
    updateTrustPath: join(configRoot, "update-trust.json"),
    unpairReceiptPath: join(stateRoot, "unpaired.json"),
    commandLockPath: join(stateRoot, "command.lock"),
    runtimeStatusPath: join(stateRoot, "runtime-status.json"),
    stdoutPath: join(logRoot, "worker.stdout.log"),
    stderrPath: join(logRoot, "worker.stderr.log"),
    launchAgentsRoot,
    plistPath: join(launchAgentsRoot, `${MAC_USER_SERVICE_LABEL}.plist`),
    nodePath: join(currentLink, "runtime", "node", "bin", "node"),
    cliPath: join(currentLink, "app", "dist", "src", "cli", "main.js"),
    engineRoot: join(currentLink, "app", "engine"),
    pythonPath: join(currentLink, "runtime", "python", "bin", "python3"),
    ffmpegPath: join(currentLink, "runtime", "bin", "ffmpeg"),
    ffprobePath: join(currentLink, "runtime", "bin", "ffprobe"),
  };
}

export async function createMacUserDirectories(
  layout: MacUserLayout,
): Promise<void> {
  await assertSafeExistingAncestors(layout.homeRoot, layout.installRoot);
  await assertSafeExistingAncestors(layout.homeRoot, layout.launchAgentsRoot);
  const roots = [
    layout.installRoot,
    layout.configRoot,
    layout.credentialRoot,
    layout.stateRoot,
    layout.transactionRoot,
    layout.releasesRoot,
    layout.modelRoot,
    layout.workRoot,
    layout.cacheRoot,
    layout.temporaryRoot,
    layout.logRoot,
  ];
  for (const root of roots) await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(layout.launchAgentsRoot, { recursive: true, mode: 0o700 });
  for (const root of roots) {
    const info = await lstat(root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0
    )
      throw new TypeError(`Unsafe macOS user directory: ${root}`);
  }
  const launchAgents = await lstat(layout.launchAgentsRoot);
  if (
    !launchAgents.isDirectory() ||
    launchAgents.isSymbolicLink() ||
    (launchAgents.mode & 0o022) !== 0
  )
    throw new TypeError(
      `Unsafe macOS user directory: ${layout.launchAgentsRoot}`,
    );
}

export async function assertSafeExistingAncestors(
  trustedRoot: string,
  target: string,
): Promise<void> {
  const root = safeAbsoluteRoot(trustedRoot, "trusted root");
  const destination = assertPathInside(root, target, "target path");
  const relative = destination.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const part of relative) {
    current = join(current, part);
    const info = await lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (info === null) return;
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new TypeError(`Unsafe macOS path ancestor: ${current}`);
    if ((info.mode & 0o022) !== 0)
      throw new TypeError(`Writable macOS path ancestor: ${current}`);
  }
}

function safeAbsoluteRoot(value: string, label: string): string {
  if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute`);
  const result = resolve(value);
  if (result === "/" || result !== normalize(value))
    throw new TypeError(`${label} is unsafe`);
  return result;
}

function assertPathInside(root: string, value: string, label: string): string {
  const result = resolve(value);
  if (result !== root && !result.startsWith(`${root}${sep}`))
    throw new TypeError(`${label} is outside the trusted root`);
  return result;
}
