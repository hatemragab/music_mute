// Runs the real installer only in disposable HOME directories with signed APFS clones.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const installer = join(root, "scripts/install-macos.mjs");
const output = join(root, "output/installer-recovery-proof", randomUUID());
const started = Date.now();
const children = new Set();
const environment = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  scope: "ACTUAL_INSTALLER_DISPOSABLE_SIGNED_CLONE_FAILURE_ROLLBACK_AND_RETRY",
  browser_installation: false,
  browser_playback: false,
  real_user_registration_changed: false,
  gui_opened: false,
  inference_run: false,
  network_used: false,
  copy_strategy: "MACOS_CP_CLONE_PRESERVE_NO_FULL_COPY_FALLBACK",
  isolation:
    "PRIVATE_HOME_OS_SANDBOX_DENIES_OUTBOUND_NETWORK_AND_NONFIXTURE_WRITES_EXCEPT_DEV_NULL",
  checks: [],
  attempts: [],
  gaps: [
    "Injected filesystem/validation failures exercise recovery, not physical disk failure or public distribution.",
    "Source identity is checked immediately before rename; destination no-clobber is atomic, but arbitrary hostile replacement of the source is not an atomic identity guarantee.",
    "Chrome extension installation and real replacement playback remain manual acceptance work.",
  ],
};
let timedOut = false;

function check(name, condition) {
  assert.ok(condition, "QUALIFICATION_CHECK_FAILED");
  report.checks.push(name);
}
function contained(parent, path) {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  assert.ok(
    info.isDirectory() && !info.isSymbolicLink() && !(info.mode & 0o077),
    "UNSAFE_FIXTURE_DIRECTORY",
  );
}
async function privateWrite(path, bytes) {
  await privateDirectory(dirname(path));
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
}
async function boundedRead(path, maximum = 1024 * 1024) {
  const info = await lstat(path);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size <= maximum,
    "UNSAFE_FIXTURE_FILE",
  );
  return readFile(path);
}
function signalGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* Only this qualification's owned groups are signalled. */
  }
}
function capture(
  executable,
  args,
  env = environment,
  timeout = 180_000,
  emergency = false,
) {
  assert.ok(!timedOut || emergency, "QUALIFICATION_OVERALL_TIMEOUT");
  return new Promise((done, reject) => {
    const child = spawn(executable, args, {
      cwd: output,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let failure;
    let killTimer;
    const stop = (code) => {
      failure ??= code;
      signalGroup(child, "SIGTERM");
      killTimer ??= setTimeout(() => signalGroup(child, "SIGKILL"), 1_000);
    };
    const timer = setTimeout(
      () => stop("QUALIFICATION_CHILD_TIMEOUT"),
      timeout,
    );
    for (const [stream, field] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ])
      stream.on("data", (bytes) => {
        if (field === "stdout") stdout = Buffer.concat([stdout, bytes]);
        else stderr = Buffer.concat([stderr, bytes]);
        if (stdout.length + stderr.length > 256 * 1024)
          stop("QUALIFICATION_OUTPUT_LIMIT");
      });
    child.once("error", () => stop("QUALIFICATION_CHILD_START_FAILED"));
    child.once("close", (code, signal) => {
      children.delete(child);
      clearTimeout(timer);
      if (!failure) clearTimeout(killTimer);
      if (failure) reject(new Error(failure));
      else done({ code, signal, stdout, stderr });
    });
  });
}
async function signature(app) {
  const result = await capture("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    app,
  ]);
  assert.ok(result.code === 0 && !result.signal, "APP_SIGNATURE_INVALID");
}
async function identity(app) {
  const info = await lstat(app);
  assert.ok(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid(),
    "UNSAFE_APP_FIXTURE",
  );
  return `${info.dev}:${info.ino}`;
}
async function sealedIdentity(app) {
  await signature(app);
  return digest(
    Buffer.concat(
      await Promise.all(
        [
          "Contents/Info.plist",
          "Contents/_CodeSignature/CodeResources",
          "Contents/Resources/bundle-audit.json",
          "Contents/Resources/companion/host.js",
          "Contents/Resources/companion/app-control.js",
        ].map((path) => boundedRead(join(app, path), 8 * 1024 * 1024)),
      ),
    ),
  );
}
async function remainingProcesses(emergency = false) {
  const result = await capture(
    "/usr/bin/pgrep",
    ["-f", output],
    environment,
    5_000,
    emergency,
  );
  assert.ok(
    [0, 1].includes(result.code) && !result.signal,
    "OWNED_PROCESS_CHECK_FAILED",
  );
  const pids = result.stdout
    .toString("utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(Number);
  assert.ok(
    pids.every(
      (pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid,
    ),
    "OWNED_PROCESS_CHECK_INVALID",
  );
  return pids;
}
async function qualify() {
  assert.ok(
    process.platform === "darwin" && process.arch === "arm64",
    "UNSUPPORTED_PLATFORM",
  );
  assert.ok(process.argv.length === 2, "INVALID_QUALIFICATION_ARGUMENTS");
  await privateDirectory(output);
  const latestPath = join(root, "output/macos/latest.json");
  const packageRecord = await boundedRead(latestPath, 64 * 1024);
  const app = await realpath(JSON.parse(packageRecord.toString("utf8")).app);
  assert.ok(contained(join(root, "output/macos"), app), "UNSAFE_PACKAGE_PATH");
  const baseline = await sealedIdentity(app);
  report.package_sealed_identity_sha256 = baseline;
  report.installer_sha256 = digest(await boundedRead(installer));
  report.script_sha256 = digest(await boundedRead(import.meta.filename));
  const installerSource = (await boundedRead(installer)).toString("utf8");
  const renameCode = installerSource.match(
    /const exclusiveRename = `([^`]+)`;/,
  )?.[1];
  assert.ok(
    renameCode?.includes("renamex_np"),
    "INSTALLER_RENAME_HELPER_INVALID",
  );
  const resources = join(app, "Contents/Resources");
  const python = join(resources, "runtime/runtime/python/bin/python3");
  const node = join(resources, "runtime/runtime/node/bin/node");
  // Signed bundle symlinks must stay inside the app before any bundled code executes.
  let entries = 0;
  let symlinks = 0;
  async function scan(path) {
    for (const name of await readdir(path)) {
      assert.ok(++entries <= 30_000, "APP_ENTRY_LIMIT");
      const child = join(path, name);
      const info = await lstat(child);
      if (info.isSymbolicLink()) {
        symlinks++;
        assert.ok(
          contained(app, await realpath(child)),
          "APP_EXTERNAL_SYMLINK",
        );
      } else if (info.isDirectory()) await scan(child);
      else assert.ok(info.isFile(), "APP_SPECIAL_FILE");
    }
  }
  await scan(app);
  report.package_entries = entries;
  report.package_internal_symlinks = symlinks;
  const pinnedLatest = join(output, "package.json");
  await privateWrite(pinnedLatest, packageRecord);
  const profile = join(output, "sandbox.sb");
  const escaped = output.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  await privateWrite(
    profile,
    `(version 1)\n(allow default)\n(deny network-outbound)\n(deny file-write* (require-all (require-not (subpath "${escaped}")) (require-not (literal "/dev/null"))))\n`,
  );
  const guard = join(output, "installer-guard.mjs");
  await privateWrite(
    guard,
    `import childProcess from 'node:child_process';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
const source = ${JSON.stringify(app)};
const python = ${JSON.stringify(python)};
const renameCode = ${JSON.stringify(renameCode)};
const latestPath = ${JSON.stringify(latestPath)};
const pinnedLatest = ${JSON.stringify(pinnedLatest)};
const home = process.env.QUALIFICATION_HOME;
const applications = join(home,'Applications');
const destination = join(applications,'MusicMute Local.app');
const mode = process.env.QUALIFICATION_FAILURE;
let promoted = false;
let injected = false;
if (homedir() !== home || !home.startsWith(${JSON.stringify(output)}+'/')) throw new Error('QUALIFICATION_HOME_INVALID');
const contained = (parent,path) => { const child = relative(parent,path); return child === '' || (!child.startsWith('..') && !isAbsolute(child)); };
const record = (event) => fs.appendFileSync(process.env.QUALIFICATION_MARKER,JSON.stringify(event)+'\\n',{mode:0o600});
const readFile = promises.readFile;
promises.readFile = (path,...args) => readFile(path === latestPath ? pinnedLatest : path,...args);
const original = childProcess.execFile;
function wrapped(executable,args,options,callback) {
 if (typeof callback !== 'function' || !Array.isArray(args) || options?.shell) throw new Error('QUALIFICATION_COMMAND_INVALID');
 const rename = executable === python && args.length === 9 && JSON.stringify(args.slice(0,5)) === JSON.stringify(['-I','-B','-S','-c',renameCode]) && contained(applications,args[5]) && contained(applications,args[6]) && args.slice(7).every((value) => /^\\d+$/.test(value)) && options.env?.HOME === home;
 const copy = executable === '/bin/cp' && args.length === 5 && JSON.stringify(args.slice(0,3)) === JSON.stringify(['-c','-p','-R']) && args[3] === source && contained(applications,args[4]);
 const plist = executable === '/usr/bin/plutil' && JSON.stringify(args.slice(0,5)) === JSON.stringify(['-extract','CFBundleIdentifier','raw','-o','-']) && args.length === 6 && [source,applications].some((base) => contained(base,args[5]));
 const signature = executable === '/usr/bin/codesign' && args.length === 4 && JSON.stringify(args.slice(0,3)) === JSON.stringify(['--verify','--deep','--strict']) && [source,applications].some((base) => contained(base,args[3]));
 if (!rename && !copy && !plist && !signature) { record({kind:'denied',code:'COMMAND'}); throw new Error('QUALIFICATION_FORBIDDEN_COMMAND'); }
 const promotion = rename && args[5].startsWith(join(applications,'.musicmute-install-')) && args[6] === destination;
 const finalValidation = signature && args[3] === destination && promoted;
 const fail = (code) => { injected = true; record({kind:'injected',code}); queueMicrotask(() => callback(Object.assign(new Error(code),{code}), '', '')); };
 if (!injected && promotion && mode === 'promotion') return fail('QUALIFICATION_PROMOTION_FAILURE');
 if (!injected && promotion && mode === 'concurrent_promotion') {
  injected = true;
  fs.mkdirSync(destination,{mode:0o700});
  record({kind:'injected',code:'CONCURRENT_EMPTY_DESTINATION'});
 }
 if (!injected && finalValidation && ['validation','concurrent_validation'].includes(mode)) {
  if (mode === 'concurrent_validation') {
   fs.renameSync(destination,join(applications,'.qualification-displaced.app'));
   fs.mkdirSync(destination,{mode:0o700});
   fs.writeFileSync(join(destination,'foreign-sentinel'),'foreign concurrent bytes',{flag:'wx',mode:0o600});
  }
  return fail('QUALIFICATION_FINAL_VALIDATION_FAILURE');
 }
 return original(executable,args,options,(error,stdout,stderr) => {
  if (!error && promotion) promoted = true;
  record({kind:'command',operation:rename ? 'exclusive-rename' : copy ? 'clone' : signature ? 'signature' : 'plist',success:!error});
  callback(error,stdout,stderr);
 });
}
wrapped[promisify.custom] = (executable,args,options) => new Promise((done,reject) => wrapped(executable,args,options ?? {},(error,stdout,stderr) => error ? reject(error) : done({stdout,stderr})));
childProcess.execFile = wrapped;
for (const method of ['spawn','spawnSync','exec','execSync','execFileSync','fork']) childProcess[method] = () => { record({kind:'denied',code:'OTHER_COMMAND'}); throw new Error('QUALIFICATION_FORBIDDEN_COMMAND'); };
syncBuiltinESMExports();
`,
  );
  async function fixture(name) {
    const home = join(output, name);
    const applications = join(home, "Applications");
    await privateDirectory(applications);
    const destination = join(applications, "MusicMute Local.app");
    const clone = await capture("/bin/cp", [
      "-c",
      "-p",
      "-R",
      app,
      destination,
    ]);
    assert.ok(clone.code === 0 && !clone.signal, "APP_CLONE_FAILED");
    check(
      `${name}: initial signed clone matches package`,
      (await sealedIdentity(destination)) === baseline,
    );
    const registration = join(
      home,
      "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.musicmute.local.json",
    );
    const launcher = join(
      home,
      "Library/Application Support/MusicMuteLocal/bin/native-host",
    );
    const sentinel = join(home, "unrelated-user-file");
    await privateWrite(
      registration,
      '{"qualification_sentinel":"registration remains unchanged"}\n',
    );
    await privateWrite(
      launcher,
      "#!/bin/sh\n# qualification launcher sentinel\nexit 0\n",
    );
    await privateWrite(sentinel, "unrelated private fixture bytes\n");
    const preserved = new Map(
      await Promise.all(
        [registration, launcher, sentinel].map(async (path) => [
          path,
          digest(await boundedRead(path)),
        ]),
      ),
    );
    return {
      home,
      applications,
      destination,
      oldIdentity: await identity(destination),
      preserved,
    };
  }
  async function attempt(state, mode) {
    const marker = join(output, `guard-${randomUUID()}.jsonl`);
    const at = Date.now();
    const result = await capture(
      "/usr/bin/sandbox-exec",
      ["-f", profile, node, "--import", guard, installer],
      {
        ...environment,
        HOME: state.home,
        TMPDIR: output,
        QUALIFICATION_HOME: state.home,
        QUALIFICATION_FAILURE: mode,
        QUALIFICATION_MARKER: marker,
      },
    );
    const events = (await boundedRead(marker, 64 * 1024))
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    check(
      `${mode}: finite command whitelist has no denied operations`,
      !events.some((event) => event.kind === "denied"),
    );
    report.attempts.push({
      mode,
      milliseconds: Date.now() - at,
      exit_code: result.code,
      stdout_bytes: result.stdout.length,
      stderr_bytes: result.stderr.length,
      injected: events
        .filter((event) => event.kind === "injected")
        .map((event) => event.code),
    });
    for (const [path, hash] of state.preserved)
      check(
        `${mode}: private ${path.endsWith("json") ? "registration" : path.endsWith("native-host") ? "launcher" : "unrelated file"} bytes remain unchanged`,
        digest(await boundedRead(path)) === hash,
      );
    assert.ok(!result.signal, "INSTALLER_UNEXPECTED_SIGNAL");
    return result;
  }
  async function preservedAppPaths(state, prefix) {
    const directories = [
      state.applications,
      join(state.applications, ".musicmute-backups.noindex"),
    ];
    const apps = [];
    for (const directory of directories) {
      const info = await lstat(directory);
      assert.ok(
        info.isDirectory() &&
          !info.isSymbolicLink() &&
          info.uid === process.getuid() &&
          !(info.mode & 0o022),
        "UNSAFE_PRESERVED_APP_DIRECTORY",
      );
      for (const name of await readdir(directory))
        if (name.startsWith(prefix)) apps.push(join(directory, name));
    }
    return apps;
  }
  async function preservedApps(state, prefix) {
    const apps = await preservedAppPaths(state, prefix);
    assert.ok(apps.length > 0, "PRESERVED_APP_MISSING");
    for (const preserved of apps)
      assert.ok(
        (await sealedIdentity(preserved)) === baseline,
        "PRESERVED_APP_CHANGED",
      );
    return apps;
  }
  const retry = await fixture("rollback-and-retry");
  for (const mode of ["promotion", "validation"]) {
    const result = await attempt(retry, mode);
    check(
      `${mode}: injected failure is surfaced`,
      result.code !== 0 &&
        result.stderr.includes(
          Buffer.from(
            mode === "promotion"
              ? "QUALIFICATION_PROMOTION_FAILURE"
              : "QUALIFICATION_FINAL_VALIDATION_FAILURE",
          ),
        ),
    );
    check(
      `${mode}: original directory identity and sealed bytes are restored`,
      (await identity(retry.destination)) === retry.oldIdentity &&
        (await sealedIdentity(retry.destination)) === baseline,
    );
    await preservedApps(
      retry,
      mode === "promotion" ? ".musicmute-install-" : ".musicmute-failed-",
    );
    check(`${mode}: failed candidate remains signed and preserved`, true);
    check(
      `${mode}: successful rollback leaves no previous-app orphan`,
      (await preservedAppPaths(retry, "MusicMute Local.previous-")).length ===
        0,
    );
  }
  for (const mode of ["concurrent_promotion", "concurrent_validation"]) {
    const state = await fixture(mode);
    const result = await attempt(state, mode);
    check(
      `${mode}: occupied destination blocks rollback safely`,
      result.code !== 0 &&
        result.stderr.includes(Buffer.from("INSTALL_ROLLBACK_BLOCKED")),
    );
    const old = await preservedApps(state, "MusicMute Local.previous-");
    check(
      `${mode}: original app identity remains preserved`,
      old.length === 1 && (await identity(old[0])) === state.oldIdentity,
    );
    const foreignEntries = await readdir(state.destination);
    check(
      `${mode}: concurrent foreign destination is unchanged`,
      mode === "concurrent_promotion"
        ? foreignEntries.length === 0
        : foreignEntries.length === 1 &&
            foreignEntries[0] === "foreign-sentinel" &&
            (
              await boundedRead(join(state.destination, "foreign-sentinel"))
            ).toString("utf8") === "foreign concurrent bytes",
    );
    await preservedApps(
      state,
      mode === "concurrent_promotion"
        ? ".musicmute-install-"
        : ".qualification-displaced",
    );
    check(
      `${mode}: unpromoted or displaced candidate remains signed and preserved`,
      true,
    );
  }
  const success = await attempt(retry, "none");
  assert.ok(success.code === 0, "CLEAN_RETRY_FAILED");
  const installed = JSON.parse(success.stdout.toString("utf8"));
  check(
    "Clean retry preserves existing installer success contract",
    installed.installed_app === retry.destination &&
      contained(retry.applications, installed.previous_app_preserved) &&
      installed.notarized === false &&
      installed.setup_required === true &&
      installed.registration_changed === false,
  );
  check(
    "Clean retry promotes candidate and preserves original signed app",
    (await identity(retry.destination)) !== retry.oldIdentity &&
      (await sealedIdentity(retry.destination)) === baseline &&
      (await identity(installed.previous_app_preserved)) ===
        retry.oldIdentity &&
      (await sealedIdentity(installed.previous_app_preserved)) === baseline,
  );
  check(
    "Read-only source package sealed identity/signature remains unchanged",
    (await sealedIdentity(app)) === baseline,
  );
  check(
    "Pinned latest record avoids changing packaging state",
    digest(await boundedRead(pinnedLatest, 64 * 1024)) ===
      digest(packageRecord),
  );
  check(
    "All directly owned installer child groups completed",
    children.size === 0,
  );
  check(
    "No process remains for this unique qualification directory",
    (await remainingProcesses()).length === 0,
  );
}

const overall = setTimeout(() => {
  timedOut = true;
  for (const child of children) signalGroup(child, "SIGTERM");
  setTimeout(() => {
    for (const child of children) signalGroup(child, "SIGKILL");
  }, 1_000);
}, 300_000);
try {
  await qualify();
  report.status = "PASSED";
} catch (error) {
  report.status = "FAILED";
  report.error_code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message
    : "QUALIFICATION_FAILED";
  for (const child of children) signalGroup(child, "SIGTERM");
  for (const signal of ["SIGTERM", "SIGKILL"])
    for (const pid of await remainingProcesses(true)) {
      try {
        process.kill(pid, signal);
      } catch {
        /* Owned process already exited. */
      }
    }
  report.owned_children_remaining = (await remainingProcesses(true)).length;
  process.exitCode = 1;
} finally {
  clearTimeout(overall);
  report.milliseconds = Date.now() - started;
  await privateDirectory(output);
  const path = join(output, "result.json");
  await privateWrite(path, JSON.stringify(report, null, 2) + "\n");
  assert.ok(
    ((await lstat(path)).mode & 0o777) === 0o600,
    "REPORT_PERMISSIONS_INVALID",
  );
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      report: path,
    }),
  );
}
