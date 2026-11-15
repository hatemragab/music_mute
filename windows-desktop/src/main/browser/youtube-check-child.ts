import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";
import {
  WINDOWS_CONSUMER_PINS,
  WINDOWS_CONSUMER_DOWNLOADER_WHEELS,
} from "../../../../worker/src/platform/windows/consumer-pins.js";
import { isCurrentUserSid } from "../../../../worker/src/platform/windows/consumer-native.js";
import { tokenProviderCheckArguments } from "../../../../chrome-extension/src/companion/youtube-runtime.js";
import {
  installationCheckFailure,
  isInstallationCheckCode,
} from "./check-errors.js";
import type { HostContext } from "../host-context.js";
import {
  hashPrivateFile,
  writePrivateAtomic,
} from "../prepare/private-files.js";
const execute = promisify(execFile),
  UUID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu,
  SHA = /^[a-f0-9]{64}$/u;
export interface BrowserYoutubeCheckConfiguration {
  version: 1;
  operation: "browser_check_youtube";
  requestId: string;
  executionId: string;
  release: string;
  sid: string;
  manifestSha256: string;
  helperSha256: string;
}
export interface BrowserYoutubeCheckResult {
  version: 1;
  operation: "browser_check_youtube";
  requestId: string;
  executionId: string;
  release: string;
  manifestSha256: string;
  sid: string;
  passed: boolean;
  errorCode: string | null;
  inferencePerformed: false;
  networkRequests: 0;
}
export function isBrowserYoutubeCheckOperation(v: unknown) {
  return (
    !!v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    (v as { operation?: unknown }).operation === "browser_check_youtube"
  );
}
export function parseBrowserYoutubeCheckConfiguration(
  v: unknown,
): BrowserYoutubeCheckConfiguration {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("INSTALLATION_CHECK_FAILED");
  const r = v as BrowserYoutubeCheckConfiguration;
  if (
    Object.keys(r).sort().join() !==
      "executionId,helperSha256,manifestSha256,operation,release,requestId,sid,version" ||
    r.version !== 1 ||
    r.operation !== "browser_check_youtube" ||
    !UUID.test(r.requestId) ||
    !UUID.test(r.executionId) ||
    !isCurrentUserSid(r.sid) ||
    [r.release, r.manifestSha256, r.helperSha256].some(
      (x) => typeof x !== "string" || !SHA.test(x),
    )
  )
    throw new Error("INSTALLATION_CHECK_FAILED");
  return structuredClone(r);
}
export function parseBrowserYoutubeCheckResult(
  v: unknown,
  c: BrowserYoutubeCheckConfiguration,
): BrowserYoutubeCheckResult {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("INSTALLATION_CHECK_FAILED");
  const r = v as BrowserYoutubeCheckResult;
  if (
    Object.keys(r).sort().join() !==
      "errorCode,executionId,inferencePerformed,manifestSha256,networkRequests,operation,passed,release,requestId,sid,version" ||
    r.version !== 1 ||
    r.operation !== c.operation ||
    r.requestId !== c.requestId ||
    r.executionId !== c.executionId ||
    r.release !== c.release ||
    r.manifestSha256 !== c.manifestSha256 ||
    r.sid !== c.sid ||
    typeof r.passed !== "boolean" ||
    r.inferencePerformed !== false ||
    r.networkRequests !== 0 ||
    (r.passed ? r.errorCode !== null : !isInstallationCheckCode(r.errorCode))
  )
    throw new Error("INSTALLATION_CHECK_FAILED");
  return structuredClone(r);
}
export type YoutubeCheckExecute = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    windowsHide: true;
    maxBuffer: number;
    timeout: number;
    signal: AbortSignal;
  },
) => Promise<{ stdout: string }>;
/** Fixed offline probe only, inside the previously authenticated signed Prepare
 * Job. No URL/source acquisition, model session or remote-component fallback. */
export async function runBrowserYoutubeCheckChild(
  host: HostContext,
  c: BrowserYoutubeCheckConfiguration,
  releaseRoot: string,
  run: YoutubeCheckExecute = execute,
) {
  const relative = `cloud\\work\\${c.requestId}`,
    work = win32.join(host.personalRoot, relative);
  await host.native.validatePath("personal", relative, "directory");
  const prefix = `runtime\\releases\\${c.release}`,
    bundle = win32.join(releaseRoot, "tools", "downloader"),
    youtube = win32.join(releaseRoot, "tools", "youtube"),
    bootstrap = win32.join(bundle, "downloader_bootstrap.py"),
    python = win32.join(releaseRoot, "runtime", "python", "python.exe"),
    deno = win32.join(youtube, "bin", "deno.exe");
  const env: NodeJS.ProcessEnv = {
    PATH: win32.join(releaseRoot, "runtime", "bin"),
    TEMP: work,
    TMP: work,
    DENO_DIR: win32.join(work, "deno-cache"),
    HOME: work,
    USERPROFILE: work,
    XDG_CACHE_HOME: work,
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR"])
    if (process.env[key]) env[key] = process.env[key];
  const signal = AbortSignal.timeout(180000),
    tool = (file: string, args: string[], max = 32768) =>
      run(file, args, {
        cwd: work,
        env,
        windowsHide: true,
        maxBuffer: max,
        timeout: 30000,
        signal,
      });
  let code: string | null = null;
  try {
    // Complete signed release hashing already ran at the fixed entry. Recheck
    // immutable approved bootstrap/wheels before importing or executing them.
    if (
      (await hashPrivateFile(
        host,
        `${prefix}\\tools\\downloader\\downloader_bootstrap.py`,
        1024 * 1024,
        signal,
      )) !== WINDOWS_CONSUMER_PINS.downloaderBootstrapSha256
    )
      throw new Error("YT_DLP_IDENTITY_INVALID");
    for (const wheel of WINDOWS_CONSUMER_DOWNLOADER_WHEELS)
      if (
        (await hashPrivateFile(
          host,
          `${prefix}\\tools\\downloader\\${wheel.file}`,
          wheel.bytes,
          signal,
        )) !== wheel.sha256
      )
        throw new Error("YT_DLP_IDENTITY_INVALID");
    for (const [file, sha256] of [
      ["generate_once.ts", WINDOWS_CONSUMER_PINS.providerScriptSha256],
      ["session_manager.ts", WINDOWS_CONSUMER_PINS.providerSessionSha256],
    ])
      if (
        (await hashPrivateFile(
          host,
          `${prefix}\\tools\\youtube\\provider\\src\\${file}`,
          1024 * 1024,
          signal,
        )) !== sha256
      )
        throw new Error("PO_TOKEN_PROVIDER_UNAVAILABLE");
    const args = (tail: string[]) => [
      "-I",
      "-B",
      "-S",
      bootstrap,
      "--musicmute-downloader-root",
      bundle,
      "--musicmute-youtube-runtime",
      youtube,
      ...tail,
    ];
    if (
      (
        await tool(
          python,
          args(["--ignore-config", "--no-plugin-dirs", "--version"]),
        )
      ).stdout.trim() !== WINDOWS_CONSUMER_PINS.downloader
    )
      throw new Error("YT_DLP_VERSION_INVALID");
    const help = (
      await tool(
        python,
        args(["--ignore-config", "--no-plugin-dirs", "--help"]),
        131072,
      )
    ).stdout;
    for (const flag of [
      "--no-plugin-dirs",
      "--no-cache-dir",
      "--no-remote-components",
      "--no-js-runtimes",
      "--js-runtimes",
      "--dump-single-json",
    ])
      if (!help.includes(flag)) throw new Error("CLI_OPTION_UNSUPPORTED");
    if (
      (await tool(python, args(["--musicmute-check-ejs"]))).stdout.trim() !==
      "ready"
    )
      throw new Error("YT_DLP_EJS_MISSING");
    if (
      (await tool(deno, ["--version"])).stdout.split("\n")[0]?.trim() !==
      `deno ${WINDOWS_CONSUMER_PINS.deno}`
    )
      throw new Error("DENO_VERSION_INVALID");
    // This existing script check is cached/frozen with explicit --deny-net.
    if (
      (
        await tool(deno, tokenProviderCheckArguments(youtube, work))
      ).stdout.trim() !== "ready"
    )
      throw new Error("PO_TOKEN_PROVIDER_UNAVAILABLE");
  } catch (error) {
    code = installationCheckFailure(error, "YOUTUBE_TOOLS_UNAVAILABLE");
  }
  const result = parseBrowserYoutubeCheckResult(
    {
      version: 1,
      operation: c.operation,
      requestId: c.requestId,
      executionId: c.executionId,
      release: c.release,
      manifestSha256: c.manifestSha256,
      sid: c.sid,
      passed: code === null,
      errorCode: code,
      inferencePerformed: false,
      networkRequests: 0,
    },
    c,
  );
  await writePrivateAtomic(
    host,
    `${relative}\\youtube-check-result.json`,
    Buffer.from(JSON.stringify(result)),
  );
}
