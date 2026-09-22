import { execFile as nodeExecFile } from "node:child_process";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { MAC_USER_SERVICE_LABEL, type MacUserLayout } from "./user-paths.js";

const execFilePromise = promisify(nodeExecFile);

export interface LaunchAgentExecutionResult {
  stdout: string;
  stderr: string;
}

export type LaunchAgentExecutor = (
  file: string,
  arguments_: readonly string[],
) => Promise<LaunchAgentExecutionResult>;

export interface LaunchAgentStatus {
  loaded: boolean;
  running: boolean;
  pid?: number;
  detail?: string;
}

export interface MacUserLaunchQualification {
  fixturePath: string;
  fixtureSha256: string;
  reportPath: string;
  releaseRoot: string;
}

export function renderLaunchAgentPlist(
  layout: MacUserLayout,
  qualification?: MacUserLaunchQualification,
): string {
  if (
    qualification !== undefined &&
    !/^[a-f0-9]{64}$/u.test(qualification.fixtureSha256)
  )
    throw new TypeError("Qualification fixture digest is invalid");
  if (qualification !== undefined) {
    assertInside(
      layout.stateRoot,
      qualification.fixturePath,
      "qualification fixture",
    );
    assertInside(
      layout.stateRoot,
      qualification.reportPath,
      "qualification report",
    );
    assertInside(
      layout.releasesRoot,
      qualification.releaseRoot,
      "qualification release",
    );
  }
  const qualificationPythonPath =
    qualification === undefined
      ? layout.pythonPath
      : join(qualification.releaseRoot, "runtime", "python", "bin", "python3");
  const qualificationFfmpegPath =
    qualification === undefined
      ? layout.ffmpegPath
      : join(qualification.releaseRoot, "runtime", "bin", "ffmpeg");
  const qualificationFfprobePath =
    qualification === undefined
      ? layout.ffprobePath
      : join(qualification.releaseRoot, "runtime", "bin", "ffprobe");
  const qualificationNodeBinPath =
    qualification === undefined
      ? dirname(layout.nodePath)
      : join(qualification.releaseRoot, "runtime", "node", "bin");
  const arguments_ =
    qualification === undefined
      ? [layout.nodePath, layout.cliPath, "run", "--config", layout.configPath]
      : [
          qualificationPythonPath,
          "-m",
          "musicmute_engine.qualification",
          "--provider",
          "mps",
          "--fixture",
          qualification.fixturePath,
          "--fixture-sha256",
          qualification.fixtureSha256,
          "--work-root",
          layout.workRoot,
          "--release-root",
          qualification.releaseRoot,
          "--model-cache",
          layout.modelRoot,
          "--ffmpeg",
          qualificationFfmpegPath,
          "--ffprobe",
          qualificationFfprobePath,
          "--report",
          qualification.reportPath,
        ];
  const workingDirectory =
    qualification === undefined
      ? layout.installRoot
      : join(qualification.releaseRoot, "app", "engine");
  const runtimePath = `${dirname(qualificationFfmpegPath)}:${qualificationNodeBinPath}:/usr/bin:/bin:/usr/sbin:/sbin`;
  const keepAlive =
    qualification === undefined
      ? `  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(MAC_USER_SERVICE_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${arguments_.map((argument) => `    <string>${xml(argument)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(layout.homeRoot)}</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
    <key>PATH</key>
    <string>${xml(runtimePath)}</string>
    <key>MUSICMUTE_PROVIDER</key>
    <string>mps</string>
    <key>MPLCONFIGDIR</key>
    <string>${xml(join(layout.cacheRoot, "matplotlib"))}</string>
    <key>NUMBA_CACHE_DIR</key>
    <string>${xml(join(layout.cacheRoot, "numba"))}</string>
    <key>PYTHONDONTWRITEBYTECODE</key>
    <string>1</string>
    <key>PYTHONNOUSERSITE</key>
    <string>1</string>
    <key>PYTHONPYCACHEPREFIX</key>
    <string>${xml(join(layout.cacheRoot, "python"))}</string>
    <key>PYTHONUNBUFFERED</key>
    <string>1</string>
    <key>XDG_CACHE_HOME</key>
    <string>${xml(layout.cacheRoot)}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${xml(layout.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(layout.stderrPath)}</string>
  <key>RunAtLoad</key>
  <true/>
${keepAlive}  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
</dict>
</plist>
`;
}

export async function writeLaunchAgentPlist(
  layout: MacUserLayout,
  qualification?: MacUserLaunchQualification,
): Promise<void> {
  await mkdir(dirname(layout.plistPath), { recursive: true, mode: 0o700 });
  const temporary = `${layout.plistPath}.${process.pid}.tmp`;
  await writeFile(temporary, renderLaunchAgentPlist(layout, qualification), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, layout.plistPath);
  await chmod(layout.plistPath, 0o600);
}

export class MacLaunchAgentController {
  public constructor(
    private readonly uid: number,
    private readonly execute: LaunchAgentExecutor = executeLaunchctl,
  ) {
    if (!Number.isSafeInteger(uid) || uid <= 0)
      throw new TypeError("macOS user id is invalid");
  }

  public async bootstrap(plistPath: string): Promise<void> {
    await this.execute("/bin/launchctl", ["bootstrap", this.domain, plistPath]);
  }

  public async bootout(): Promise<void> {
    await this.execute("/bin/launchctl", ["bootout", this.service]);
  }

  public async kickstart(): Promise<void> {
    await this.execute("/bin/launchctl", ["kickstart", "-k", this.service]);
  }

  public async status(): Promise<LaunchAgentStatus> {
    try {
      const result = await this.execute("/bin/launchctl", [
        "print",
        this.service,
      ]);
      const state = /^\s*state = (.+)$/mu.exec(result.stdout)?.[1]?.trim();
      const pidValue = /^\s*pid = (\d+)$/mu.exec(result.stdout)?.[1];
      const pid = pidValue === undefined ? undefined : Number(pidValue);
      return {
        loaded: true,
        running: state === "running",
        ...(pid === undefined ? {} : { pid }),
        ...(state === undefined ? {} : { detail: state }),
      };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // launchctl exits with EX_NOTFOUND (113) when the label is absent.
      if (code === "ESRCH" || code === "ENOENT" || code === 113)
        return { loaded: false, running: false };
      throw error;
    }
  }

  private get domain(): string {
    return `gui/${this.uid}`;
  }

  private get service(): string {
    return `${this.domain}/${MAC_USER_SERVICE_LABEL}`;
  }
}

async function executeLaunchctl(
  file: string,
  arguments_: readonly string[],
): Promise<LaunchAgentExecutionResult> {
  return execFilePromise(file, [...arguments_], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertInside(root: string, path: string, label: string): void {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (!resolvedPath.startsWith(`${resolvedRoot}${sep}`))
    throw new TypeError(`${label} path is unsafe`);
}
