// Read-only local bundle qualification. Never opens the GUI, Chrome or Keychain.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  stageExternalRuntimeForQualification,
  verifyExternalRuntimeForQualification,
} from "./external-runtime-qualification.mjs";

const root = resolve(import.meta.dirname, "..");
const output = join(
  root,
  "output/packaged-tools-proof",
  `${randomUUID()}.noindex`,
);
const modelHash =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
const modelBytes = 66_759_214;
const children = new Set();
const sourceHome = homedir();
const qualificationCodes = new Set([
  "UNSUPPORTED_PLATFORM",
  "INVALID_QUALIFICATION_ARGUMENTS",
  "QUALIFICATION_MODEL_SAFE",
  "QUALIFICATION_APP_UNSAFE",
  "QUALIFICATION_MODEL_HASH_VALID",
  "QUALIFICATION_COPIED_MODEL_HASH_VALID",
  "QUALIFICATION_DIRECTORY_UNSAFE",
  "BUNDLE_SYMLINK_UNSAFE",
  "BUNDLE_DIRECTORY_PERMISSIONS_INVALID",
  "BUNDLE_FILE_PERMISSIONS_INVALID",
  "BUNDLE_HARDLINK_UNSAFE",
  "BUNDLE_ENTRY_UNSAFE",
  "QUALIFICATION_SIGNAL_FAILED",
  "QUALIFICATION_CANCELLED",
  "QUALIFICATION_CHILD_TIMEOUT",
  "QUALIFICATION_CHILD_START_FAILED",
  "QUALIFICATION_STDIN_FAILED",
  "QUALIFICATION_OUTPUT_LIMIT",
  "QUALIFICATION_STDERR_LIMIT",
  "NATIVE_HELLO_INVALID",
  "NATIVE_HELLO_MISSING",
  "APP_REPLY_INVALID",
  "PACKAGED_TOOLS_NOT_READY",
  "PACKAGED_COMPONENT_NOT_READY",
  "BUNDLE_SIGNATURE_VALID_BEFORE",
  "BUNDLE_SIGNING_RECORD_INVALID",
  "PACKAGED_VERIFIERS_DIFFERING_UID_ACCEPTED",
  "QUALIFICATION_REGISTRATION_UNSAFE",
  "ISOLATED_CHROME_REGISTRATION_VALID",
  "REINSTALL_REPAIRS_MISSING_LAUNCHER",
  "GUI_CLOSED_NATIVE_HELLO_READY_AND_CLEAN_EXIT",
  "BUNDLE_SIGNATURE_INTACT_AFTER_QUALIFICATION",
  "PACKAGED_BOOTSTRAP_DIFFERING_UID_REJECTED",
  "QUALIFICATION_PACKAGE_ROOT_INVALID",
  "QUALIFICATION_PACKAGE_RESULT_INVALID",
  "QUALIFICATION_RUNTIME_ARCHIVE_INVALID",
  "QUALIFICATION_RUNTIME_DIRECTORY_UNSAFE",
  "QUALIFICATION_RUNTIME_INVENTORY_INVALID",
  "QUALIFICATION_RUNTIME_MANIFEST_INVALID",
  "QUALIFICATION_RUNTIME_MANIFEST_MISMATCH",
  "QUALIFICATION_RUNTIME_PATH_INVALID",
  "QUALIFICATION_RUNTIME_ACTIVE_INVALID",
  "QUALIFICATION_RUNTIME_PERMISSIONS_INVALID",
  "QUALIFICATION_RUNTIME_SIGNATURE_COUNT_INVALID",
  "QUALIFICATION_THIN_APP_INVALID",
  "RUNTIME_ARCHIVE_LISTING_INVALID",
  "RUNTIME_SIGNATURE_INVALID",
]);
const appCodes = new Set([
  "APP_COMMAND_FAILED",
  "APP_RESOURCES_MISSING",
  "APP_RUNTIME_BOOTSTRAP_INVALID",
  "APP_RUNTIME_BOOTSTRAP_MISSING",
  "APP_RUNTIME_DESCRIPTOR_INVALID",
  "APP_RUNTIME_INCOMPATIBLE",
  "APP_RUNTIME_MISSING",
  "APP_RUNTIME_NOT_PREPARED",
  "CANCELLED",
  "CLI_OPTION_UNSUPPORTED",
  "DENO_MISSING",
  "DENO_VERSION_INVALID",
  "DEV_RUNTIME_INCOMPLETE",
  "DISK_SPACE_LOW",
  "ENGINE_DOCTOR_INVALID",
  "ENGINE_MISSING",
  "ENGINE_NOT_READY",
  "FOREIGN_NATIVE_LAUNCHER_EXISTS",
  "FOREIGN_NATIVE_REGISTRATION_EXISTS",
  "LOCAL_COMPANION_BUSY",
  "LOCAL_COMPANION_LOCK_UNSAFE",
  "LOCAL_COMPANION_START_FAILED",
  "LOCAL_DIRECTORY_NOT_PRIVATE",
  "MEMORY_LOW",
  "MODEL_CACHE_INVALID",
  "MODEL_CHECKSUM_INVALID",
  "MODEL_DOWNLOAD_FAILED",
  "MODEL_DOWNLOAD_TIMEOUT",
  "MODEL_NOT_READY",
  "NATIVE_REGISTRATION_MISSING",
  "PO_TOKEN_PROVIDER_INVALID",
  "PO_TOKEN_PROVIDER_MISSING",
  "PO_TOKEN_PROVIDER_UNAVAILABLE",
  "SETUP_BUSY",
  "SETUP_REQUIRED",
  "TOOL_FAILED",
  "TOOL_TIMEOUT",
  "UPDATE_INSTALLING",
  "UPDATE_LOCK_UNSAFE",
  "YT_DLP_EJS_MISSING",
  "YT_DLP_IDENTITY_INVALID",
  "YT_DLP_MISSING",
  "YT_DLP_VERSION_INVALID",
  "YOUTUBE_TOOLS_CHECK_FAILED",
]);
const report = {
  schema_version: 1,
  scope: "LOCAL_PACKAGED_OFFLINE_SETUP_AND_GUI_CLOSED_NATIVE_HELLO",
  passed: false,
  gui_opened: false,
  browser_opened: false,
  real_browser_profile_used: false,
  existing_user_state_read_allowed: false,
  account_used: false,
  keychain_helper_execution_allowed: false,
  cloud_work_submitted: false,
  model_downloaded: false,
  inference_run: false,
  setup_network_allowed: false,
  native_outbound_network_allowed: false,
  differing_uid_verification: "SIMULATED_UID_ONLY",
  notarization_proven: false,
  clean_os_user_proven: false,
  checks: [],
  commands: [],
};
let phase = "OPTIONS";
let interrupted = false;

function check(code, condition) {
  ensure(condition, code);
  report.checks.push(code);
}

function ensure(condition, code) {
  if (!condition) throw new Error(code);
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  ensure(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      (info.mode & 0o777) === 0o700,
    "QUALIFICATION_DIRECTORY_UNSAFE",
  );
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function contained(parent, path) {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function auditBundle(app) {
  const counts = { directories: 0, files: 0, executables: 0, symlinks: 0 };
  async function visit(path) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      ensure(
        !isAbsolute(target) && contained(app, resolve(dirname(path), target)),
        "BUNDLE_SYMLINK_UNSAFE",
      );
      ensure(contained(app, await realpath(path)), "BUNDLE_SYMLINK_UNSAFE");
      counts.symlinks++;
    } else if (info.isDirectory()) {
      ensure(
        (info.mode & 0o777) === 0o755,
        "BUNDLE_DIRECTORY_PERMISSIONS_INVALID",
      );
      counts.directories++;
      for (const name of await readdir(path)) await visit(join(path, name));
    } else if (info.isFile()) {
      const executable = Boolean(info.mode & 0o111);
      ensure(
        (info.mode & 0o777) === (executable ? 0o755 : 0o644),
        "BUNDLE_FILE_PERMISSIONS_INVALID",
      );
      ensure(info.nlink === 1, "BUNDLE_HARDLINK_UNSAFE");
      counts.files++;
      if (executable) counts.executables++;
    } else throw new Error("BUNDLE_ENTRY_UNSAFE");
  }
  await visit(app);
  return counts;
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw new Error("QUALIFICATION_SIGNAL_FAILED");
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interrupted = true;
    for (const child of children) signalGroup(child, "SIGTERM");
  });
}

function run(
  code,
  executable,
  args,
  { env, timeout = 120_000, native = false, requestId } = {},
) {
  ensure(!interrupted, "QUALIFICATION_CANCELLED");
  const summary = { code, stdout_bytes: 0, stderr_bytes: 0 };
  report.commands.push(summary);
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, {
      cwd: output,
      env,
      detached: true,
      stdio: [native ? "pipe" : "ignore", "pipe", "pipe"],
    });
    children.add(child);
    const started = Date.now();
    let stdout = Buffer.alloc(0);
    let failure;
    let escalation;
    let hello;
    let closed = false;
    const stop = (reason) => {
      failure ??= reason;
      signalGroup(child, "SIGTERM");
      escalation ??= setTimeout(() => signalGroup(child, "SIGKILL"), 1_000);
    };
    const deadline = setTimeout(
      () => stop("QUALIFICATION_CHILD_TIMEOUT"),
      timeout,
    );
    child.on("error", () => stop("QUALIFICATION_CHILD_START_FAILED"));
    child.stdin?.on("error", () => {
      if (!closed && !hello) stop("QUALIFICATION_STDIN_FAILED");
    });
    child.stdout.on("data", (chunk) => {
      summary.stdout_bytes += chunk.length;
      if (summary.stdout_bytes > 1024 * 1024) {
        stop("QUALIFICATION_OUTPUT_LIMIT");
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
      if (!native || hello || stdout.length < 4) return;
      try {
        const length = stdout.readUInt32LE(0);
        ensure(length >= 2 && length <= 64 * 1024, "NATIVE_FRAME_INVALID");
        if (stdout.length < length + 4) return;
        const message = JSON.parse(
          stdout.subarray(4, length + 4).toString("utf8"),
        );
        if (
          message.type === "ERROR" &&
          appCodes.has(message.payload?.error_code)
        )
          throw new Error(message.payload.error_code);
        ensure(
          message.protocol_version === 1 &&
            message.request_id === requestId &&
            message.type === "HELLO" &&
            message.payload?.ready === true &&
            message.payload.platform === "darwin" &&
            message.payload.arch === "arm64" &&
            typeof message.payload.version === "string" &&
            /^\d+\.\d+\.\d+$/.test(message.payload.version) &&
            message.payload.max_duration_seconds === 1200 &&
            Array.isArray(message.payload.capabilities) &&
            message.payload.capabilities.includes("error_context_v1") &&
            message.payload.capabilities.includes("cloud_handoff_v1"),
          "NATIVE_HELLO_INVALID",
        );
        hello = {
          ready: true,
          version: message.payload.version,
          capabilities: ["error_context_v1", "cloud_handoff_v1"],
        };
        child.stdin.end();
      } catch (error) {
        stop(
          appCodes.has(error.message) ? error.message : "NATIVE_HELLO_INVALID",
        );
      }
    });
    child.stderr.on("data", (chunk) => {
      summary.stderr_bytes += chunk.length;
      if (summary.stderr_bytes > 256 * 1024) stop("QUALIFICATION_STDERR_LIMIT");
    });
    child.on("close", (exitCode, signal) => {
      closed = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      children.delete(child);
      Object.assign(summary, {
        exit_code: exitCode,
        signal,
        wall_ms: Date.now() - started,
      });
      if (interrupted) failure ??= "QUALIFICATION_CANCELLED";
      if (native && !hello) failure ??= "NATIVE_HELLO_MISSING";
      if (failure) reject(new Error(failure));
      else resolveCommand({ stdout, exitCode, signal, hello });
    });
    if (native) {
      const message = Buffer.from(
        JSON.stringify({
          protocol_version: 1,
          request_id: requestId,
          type: "HELLO",
          payload: { capabilities: ["error_context_v1"] },
        }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32LE(message.length);
      child.stdin.write(Buffer.concat([header, message]));
    }
  });
}

function validateStatus(result) {
  if (result.exitCode === 75) throw new Error("UPDATE_INSTALLING");
  if (result.exitCode === 76) throw new Error("UPDATE_LOCK_UNSAFE");
  const lines = result.stdout.toString("utf8").trim().split("\n");
  ensure(lines.length > 0 && lines.length <= 128, "APP_REPLY_INVALID");
  let status;
  for (const line of lines) {
    ensure(Buffer.byteLength(line) <= 64 * 1024, "APP_REPLY_INVALID");
    const message = JSON.parse(line);
    ensure(message.protocol_version === 1, "APP_REPLY_INVALID");
    if (message.type === "error")
      throw new Error(
        appCodes.has(message.error_code)
          ? message.error_code
          : "APP_COMMAND_FAILED",
      );
    ensure(
      message.type === "progress" || message.type === "result",
      "APP_REPLY_INVALID",
    );
    if (message.type === "result") {
      ensure(!status, "APP_REPLY_INVALID");
      status = message.status;
    }
  }
  ensure(result.exitCode === 0 && !result.signal, "APP_COMMAND_FAILED");
  if (Array.isArray(status?.components)) {
    for (const component of status.components) {
      if (component.state !== "ready" && appCodes.has(component.error_code))
        throw new Error(component.error_code);
    }
  }
  ensure(
    status &&
      status.ready === true &&
      status.platform === "darwin" &&
      status.arch === "arm64" &&
      status.runtime_ready === true &&
      status.model_ready === true &&
      status.extension_registered === true &&
      status.local_processing_ready === true &&
      status.downloader_ready === true &&
      status.javascript_ready === true &&
      status.token_provider_ready === true &&
      status.youtube_ready === true &&
      status.model_bytes === modelBytes &&
      status.diagnostic_mode === "LOCAL_ONLY" &&
      status.max_duration_seconds === 1200,
    "PACKAGED_TOOLS_NOT_READY",
  );
  const names = [
    "engine",
    "model",
    "downloader",
    "javascript",
    "token_provider",
    "chrome",
  ];
  ensure(
    Array.isArray(status.components) &&
      status.components.length === names.length &&
      names.every(
        (name) =>
          status.components.filter(
            (component) =>
              component.component === name &&
              component.state === "ready" &&
              !component.error_code,
          ).length === 1,
      ),
    "PACKAGED_COMPONENT_NOT_READY",
  );
  return {
    local_processing_ready: true,
    downloader_ready: true,
    javascript_ready: true,
    token_provider_ready: true,
    youtube_tools_ready: true,
    extension_registered: true,
    components: names,
  };
}

try {
  ensure(
    process.platform === "darwin" && process.arch === "arm64",
    "UNSUPPORTED_PLATFORM",
  );
  const args = process.argv.slice(2);
  ensure(
    args.length === 4 &&
      args[0] === "--app" &&
      args[2] === "--model" &&
      isAbsolute(args[1]) &&
      isAbsolute(args[3]),
    "INVALID_QUALIFICATION_ARGUMENTS",
  );
  const modelInfo = await lstat(args[3]);
  check(
    "QUALIFICATION_MODEL_SAFE",
    modelInfo.isFile() &&
      !modelInfo.isSymbolicLink() &&
      modelInfo.uid === process.getuid() &&
      modelInfo.nlink === 1 &&
      modelInfo.size === modelBytes &&
      !(modelInfo.mode & 0o077),
  );
  const appInfo = await lstat(args[1]);
  ensure(
    appInfo.isDirectory() && !appInfo.isSymbolicLink(),
    "QUALIFICATION_APP_UNSAFE",
  );
  const app = await realpath(args[1]);
  const model = await realpath(args[3]);
  phase = "MODEL_VERIFICATION";
  check(
    "QUALIFICATION_MODEL_HASH_VALID",
    (await hashFile(model)) === modelHash,
  );
  await privateDirectory(output);
  const home = join(output, "home");
  const state = join(home, "Library/Application Support/MusicMuteLocal");
  const temporary = join(output, "tmp");
  const modelRoot = join(state, "models", modelHash);
  for (const path of [home, state, temporary, modelRoot])
    await privateDirectory(path);
  const copiedModel = join(modelRoot, "Kim_Vocal_2.onnx");
  await copyFile(
    model,
    copiedModel,
    constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
  );
  await chmod(copiedModel, 0o600);
  check(
    "QUALIFICATION_COPIED_MODEL_HASH_VALID",
    (await hashFile(copiedModel)) === modelHash,
  );
  phase = "EXTERNAL_RUNTIME_STAGING";
  const {
    resources,
    runtimeRoot,
    releaseRoot,
    activePath,
    runtime,
    packageResult,
  } = await stageExternalRuntimeForQualification({ app, stateRoot: state });
  report.runtime = {
    id: runtime.id,
    archive_sha256: runtime.archive_sha256,
    files: runtime.files.length,
    installed_bytes: runtime.installed_bytes,
    state: "DISPOSABLE_EXTERNAL_RUNTIME_VERIFIED",
  };
  report.checks.push("THIN_APP_EXTERNAL_RUNTIME_VERIFIED_AND_STAGED");
  const node = join(runtimeRoot, "runtime/node/bin/node");
  const python = join(runtimeRoot, "runtime/python/bin/python3");
  const env = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    TMPDIR: `${temporary}/`,
    MUSICMUTE_LOCAL_ROOT: state,
    MUSICMUTE_LOCAL_APP_RESOURCES: resources,
  };
  const quoted = (value) => JSON.stringify(value);
  const protectedWrites = `(deny file-write* (require-all (require-not (subpath ${quoted(output)})) (require-not (literal "/dev/null"))))`;
  const protectedRuntime = `(deny file-write* (subpath ${quoted(dirname(activePath))}))`;
  const denyKeychainHelper = `(deny process-exec (literal ${quoted(join(app, "Contents/MacOS/MusicMuteGuestCredentials"))})) (deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.secd"))`;
  const deniedUserState = [
    "Library/Application Support/MusicMuteLocal",
    "Library/Application Support/MusicMuteLocalMvp",
    "Library/Application Support/MusicMuteWorker",
    "Library/Application Support/Google/Chrome",
    "Library/Keychains",
  ]
    .map(
      (path) => `(deny file-read* (subpath ${quoted(join(sourceHome, path))}))`,
    )
    .join(" ");
  const setupPolicy = `(version 1) (allow default) (deny network*) ${protectedWrites} ${protectedRuntime} ${denyKeychainHelper} ${deniedUserState}`;
  const nativePolicy = `(version 1) (allow default) (deny network-outbound) ${protectedWrites} ${protectedRuntime} ${denyKeychainHelper} ${deniedUserState}`;
  phase = "BUNDLE_SIGNATURE";
  const signature = await run(
    "BUNDLE_SIGNATURE_BEFORE",
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", app],
    { env },
  );
  check(
    "BUNDLE_SIGNATURE_VALID_BEFORE",
    signature.exitCode === 0 && !signature.signal,
  );
  const audit = JSON.parse(
    await readFile(join(resources, "bundle-audit.json"), "utf8"),
  );
  ensure(
    audit.signing === "AD_HOC_LOCAL" ||
      audit.signing === "DEVELOPER_ID_LOCAL_NO_NOTARIZATION" ||
      audit.signing === "DEVELOPER_ID_DISTRIBUTION",
    "BUNDLE_SIGNING_RECORD_INVALID",
  );
  report.signing = audit.signing;
  report.release_mode = audit.release_mode === true;
  phase = "BUNDLE_PERMISSIONS";
  report.bundle_entries = await auditBundle(app);
  report.checks.push(
    "BUNDLE_IMMUTABLE_PERMISSIONS_AND_CONTAINED_SYMLINKS_VALID",
  );
  phase = "PACKAGED_VERIFIERS";
  const downloaderModule = pathToFileURL(
    join(resources, "companion/downloader-bundle.js"),
  ).href;
  const youtubeModule = pathToFileURL(
    join(resources, "companion/youtube-runtime.js"),
  ).href;
  const verifierCode = `import { verifyDownloaderBundle } from ${quoted(downloaderModule)};
import { verifyYoutubeRuntime } from ${quoted(youtubeModule)};
const uid = process.getuid(); process.getuid = () => uid + 1;
await verifyDownloaderBundle(${quoted(join(runtimeRoot, "tools/downloader"))}, true, ${quoted(join(resources, "engine/downloader_bootstrap.py"))});
await verifyYoutubeRuntime(${quoted(join(runtimeRoot, "tools/youtube"))}, true);
console.log("ready");`;
  const verified = await run(
    "PACKAGED_VERIFIERS_DIFFERING_UID",
    "/usr/bin/sandbox-exec",
    ["-p", setupPolicy, node, "--input-type=module", "-e", verifierCode],
    { env },
  );
  check(
    "PACKAGED_VERIFIERS_DIFFERING_UID_ACCEPTED",
    verified.exitCode === 0 &&
      !verified.signal &&
      verified.stdout.toString("utf8").trim() === "ready",
  );
  phase = "PACKAGED_BOOTSTRAP_PROTECTED_UID";
  const bootstrapCode = `import importlib.util, os, sys
path = ${quoted(join(resources, "engine/downloader_bootstrap.py"))}
spec = importlib.util.spec_from_file_location("musicmute_bootstrap", path)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)
uid = os.getuid()
os.getuid = lambda: uid + 1
try:
    archives = bootstrap.verified_archives(bundle_root=${quoted(join(runtimeRoot, "tools/downloader"))})
    sys.path[:0] = [str(path) for path in archives]
    bootstrap.install_token_provider(${quoted(join(runtimeRoot, "tools/youtube"))}, bundle_root=${quoted(join(runtimeRoot, "tools/downloader"))})
except bootstrap.BootstrapError as error:
    if str(error) != "DOWNLOADER_IDENTITY_INVALID":
        raise
    print("rejected")
else:
    raise RuntimeError("external runtime accepted for a different uid")
finally:
    os.getuid = lambda: uid
`;
  const protectedBootstrap = await run(
    "PACKAGED_BOOTSTRAP_DIFFERING_UID",
    "/usr/bin/sandbox-exec",
    ["-p", setupPolicy, python, "-I", "-B", "-S", "-c", bootstrapCode],
    { env },
  );
  check(
    "PACKAGED_BOOTSTRAP_DIFFERING_UID_REJECTED",
    protectedBootstrap.exitCode === 0 &&
      !protectedBootstrap.signal &&
      protectedBootstrap.stdout.toString("utf8").trim() === "rejected",
  );
  const controlArgs = [
    "-I",
    "-B",
    "-S",
    join(resources, "scripts/update-lock.py"),
    "--run",
    node,
    join(resources, "companion/app-control.js"),
  ];
  phase = "OFFLINE_SETUP";
  const setup = await run(
    "OFFLINE_SETUP",
    "/usr/bin/sandbox-exec",
    ["-p", setupPolicy, python, ...controlArgs, "setup"],
    { env, timeout: 240_000 },
  );
  report.setup = validateStatus(setup);
  report.checks.push("ACTUAL_PACKAGED_OFFLINE_SETUP_READY");
  phase = "OFFLINE_STATUS";
  const status = await run(
    "OFFLINE_STATUS",
    "/usr/bin/sandbox-exec",
    ["-p", setupPolicy, python, ...controlArgs, "status"],
    { env, timeout: 120_000 },
  );
  report.status = validateStatus(status);
  report.checks.push("ACTUAL_PACKAGED_OFFLINE_STATUS_READY");
  phase = "ISOLATED_CHROME_REGISTRATION";
  const launcher = join(state, "native-launcher.sh");
  const registration = join(
    home,
    "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.musicmute.local.json",
  );
  const manifestInfo = await lstat(registration);
  const launcherInfo = await lstat(launcher);
  ensure(
    manifestInfo.isFile() &&
      !manifestInfo.isSymbolicLink() &&
      manifestInfo.size <= 16 * 1024 &&
      manifestInfo.uid === process.getuid() &&
      (manifestInfo.mode & 0o777) === 0o600 &&
      launcherInfo.isFile() &&
      !launcherInfo.isSymbolicLink() &&
      launcherInfo.uid === process.getuid() &&
      (launcherInfo.mode & 0o777) === 0o700,
    "QUALIFICATION_REGISTRATION_UNSAFE",
  );
  const manifest = JSON.parse(await readFile(registration, "utf8"));
  check(
    "ISOLATED_CHROME_REGISTRATION_VALID",
    manifest.name === "com.musicmute.local" &&
      manifest.type === "stdio" &&
      manifest.path === launcher &&
      Array.isArray(manifest.allowed_origins) &&
      manifest.allowed_origins.length === 1 &&
      /^chrome-extension:\/\/[a-p]{32}\/$/.test(manifest.allowed_origins[0]),
  );
  phase = "OFFLINE_REINSTALL_REPAIR";
  const retainedManifest = await readFile(registration);
  const originalLauncher = await readFile(launcher);
  // Only remove this qualification's disposable launcher, retaining Chrome state.
  await unlink(launcher);
  const reinstall = await run(
    "OFFLINE_REINSTALL_REPAIR",
    "/usr/bin/sandbox-exec",
    ["-p", setupPolicy, python, ...controlArgs, "setup"],
    { env, timeout: 240_000 },
  );
  report.reinstall_setup = validateStatus(reinstall);
  const repairedLauncher = await lstat(launcher);
  check(
    "REINSTALL_REPAIRS_MISSING_LAUNCHER",
    (await readFile(registration)).equals(retainedManifest) &&
      (await readFile(launcher)).equals(originalLauncher) &&
      repairedLauncher.isFile() &&
      !repairedLauncher.isSymbolicLink() &&
      repairedLauncher.uid === process.getuid() &&
      (repairedLauncher.mode & 0o777) === 0o700,
  );
  phase = "GUI_CLOSED_NATIVE_HELLO";
  report.native_home_verification = "DISPOSABLE_CFFIXED_USER_HOME";
  const hello = await run(
    "GUI_CLOSED_NATIVE_HELLO",
    "/usr/bin/sandbox-exec",
    [
      "-p",
      nativePolicy,
      join(app, "Contents/MacOS/MusicMuteLocal"),
      "--native-host",
      manifest.allowed_origins[0],
    ],
    {
      env: { ...env, CFFIXED_USER_HOME: home },
      native: true,
      requestId: randomUUID(),
      // Normal native startup trusts the runtime staged and checked above.
      timeout: 180_000,
    },
  );
  check(
    "GUI_CLOSED_NATIVE_HELLO_READY_AND_CLEAN_EXIT",
    hello.exitCode === 0 && !hello.signal && Boolean(hello.hello),
  );
  report.native_hello = hello.hello;
  report.native_loopback_listener_only = true;
  phase = "FINAL_EXTERNAL_RUNTIME_AUDIT";
  await verifyExternalRuntimeForQualification({
    releaseRoot,
    activePath,
    runtime,
    packageResult,
  });
  report.checks.push("EXTERNAL_RUNTIME_IMMUTABLE_AFTER_QUALIFICATION");
  phase = "FINAL_SIGNATURE";
  const after = await run(
    "BUNDLE_SIGNATURE_AFTER",
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", app],
    { env },
  );
  check(
    "BUNDLE_SIGNATURE_INTACT_AFTER_QUALIFICATION",
    after.exitCode === 0 && !after.signal,
  );
  report.passed = true;
} catch (error) {
  report.failed_phase = phase;
  const message = error instanceof Error ? error.message : "";
  report.error_code =
    appCodes.has(message) || qualificationCodes.has(message)
      ? message
      : "PACKAGED_TOOLS_QUALIFICATION_FAILED";
  process.exitCode = 1;
}
await privateDirectory(output);
const reportPath = join(output, "result.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(
  `${JSON.stringify({ ...report, report_path: reportPath }, null, 2)}\n`,
);
