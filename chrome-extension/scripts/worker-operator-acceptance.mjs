// Qualification only. The parent MPS driver owns approval, physical ownership,
// cancellation and positive process exit; this module never acquires a host lock.
import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { verifyWorkerService } from "./worker-service-artifact.mjs";

const execute = promisify(execFile);
const self = fileURLToPath(import.meta.url);
const LABEL =
  /^com\.musicmute\.qualification\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const FIELDS = [
  "serviceRoot",
  "resourcesRoot",
  "preparedSupportRoot",
  "fixturePath",
  "outputRoot",
];
export const OPERATOR_FIXTURE = Object.freeze({
  bytes: 2_116_878,
  sha256: "495012a80265f5ba53d1458c266bb346470c417987dad5048d988a42d182e884",
});
const MODEL =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";

function absolute(path) {
  assert(
    typeof path === "string" &&
      isAbsolute(path) &&
      resolve(path) === path &&
      path !== "/" &&
      !Array.from(path).some(
        (char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127,
      ),
    "OPERATOR_PATH_INVALID",
  );
  return path;
}
export function operatorOptions(value) {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    "OPERATOR_OPTIONS_INVALID",
  );
  assert(
    Object.keys(value).length === FIELDS.length &&
      FIELDS.every((key) => Object.hasOwn(value, key)),
    "OPERATOR_OPTIONS_INVALID",
  );
  return Object.fromEntries(FIELDS.map((key) => [key, absolute(value[key])]));
}
export function parseOperatorArguments(args) {
  const names = {
    "--service-root": "serviceRoot",
    "--resources-root": "resourcesRoot",
    "--prepared-support-root": "preparedSupportRoot",
    "--fixture": "fixturePath",
    "--output-root": "outputRoot",
  };
  const value = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = names[args[index]];
    assert(
      key && !Object.hasOwn(value, key) && args[index + 1],
      "OPERATOR_ARGUMENT_INVALID",
    );
    value[key] = args[index + 1];
  }
  return operatorOptions(value);
}
async function safeDirectory(path, privateMode = false) {
  const info = await lstat(path);
  assert(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      !(info.mode & (privateMode ? 0o077 : 0o022)) &&
      (await realpath(path)) === path,
    "OPERATOR_DIRECTORY_UNSAFE",
  );
}
export async function verifyOperatorFixture(path) {
  absolute(path);
  const before = await lstat(path);
  assert(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.uid === process.getuid() &&
      before.size === OPERATOR_FIXTURE.bytes,
    "OPERATOR_FIXTURE_UNSAFE",
  );
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  const after = await lstat(path);
  assert(
    before.dev === after.dev &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      digest.digest("hex") === OPERATOR_FIXTURE.sha256,
    "OPERATOR_FIXTURE_IDENTITY_CHANGED",
  );
  return OPERATOR_FIXTURE;
}
export async function planWorkerOperatorAcceptance(value) {
  const options = operatorOptions(value);
  for (const key of ["serviceRoot", "resourcesRoot", "preparedSupportRoot"])
    await safeDirectory(options[key]);
  await safeDirectory(dirname(options.outputRoot), true);
  assert(
    await lstat(options.outputRoot).then(
      () => false,
      (error) => {
        if (error.code === "ENOENT") return true;
        throw error;
      },
    ),
    "OPERATOR_OUTPUT_ALREADY_EXISTS",
  );
  await verifyOperatorFixture(options.fixturePath);
  const service = await verifyWorkerService(options.serviceRoot);
  const embedded = JSON.parse(
    await readFile(
      join(options.resourcesRoot, "worker/service/service-manifest.json"),
      "utf8",
    ),
  );
  assert(
    embedded.payload_sha256 === service.payload_sha256,
    "OPERATOR_SERVICE_IDENTITY_CHANGED",
  );
  const bootstrap = JSON.parse(
    await readFile(
      join(options.resourcesRoot, "runtime-bootstrap.json"),
      "utf8",
    ),
  );
  assert(
    bootstrap.schema_version === 1 &&
      bootstrap.runtime.platform === "darwin" &&
      bootstrap.runtime.arch === "arm64" &&
      /^[a-zA-Z0-9._+-]{1,64}$/u.test(bootstrap.runtime.id),
    "OPERATOR_BASE_INVALID",
  );
  return {
    schema_version: 1,
    scope: "ISOLATED_ORIGINAL_MACOS_OPERATOR_REAL_MPS",
    execution_started: false,
    options,
    payload_sha256: service.payload_sha256,
    runtime_id: bootstrap.runtime.id,
    fixture: OPERATOR_FIXTURE,
    commands: [
      "benchmark --workers 1 --json",
      "benchmark-file full and trim --warmup-runs 1 --runs 3 --group-size 2",
      "benchmark --workers 2 --json",
      "capacity --workers 2 then 1 then 2 (only after genuine PASS)",
    ],
  };
}

export function projectOperatorQualificationPlist(plist, label) {
  assert(
    LABEL.test(label) && label !== "com.musicmute.worker",
    "OPERATOR_LABEL_INVALID",
  );
  const original = "<string>com.musicmute.worker</string>";
  assert(
    plist.split(original).length === 2 &&
      plist.includes("<string>musicmute_engine.qualification</string>") &&
      !plist.includes("<key>KeepAlive</key>"),
    "OPERATOR_QUALIFICATION_PLIST_REQUIRED",
  );
  const projected = plist.replace(original, `<string>${label}</string>`);
  assert(
    !projected.includes("com.musicmute.worker"),
    "OPERATOR_CANONICAL_TARGET_FORBIDDEN",
  );
  return projected;
}
export function operatorLaunchctlArguments(action, uid, label, plistPath) {
  assert(
    Number.isSafeInteger(uid) && uid > 0 && LABEL.test(label),
    "OPERATOR_LABEL_INVALID",
  );
  if (action === "bootstrap")
    return [action, `gui/${uid}`, absolute(plistPath)];
  assert(
    ["print", "bootout"].includes(action),
    "OPERATOR_LAUNCHCTL_ACTION_FORBIDDEN",
  );
  return [action, `gui/${uid}/${label}`];
}
export function operatorProcessIdentity(stdout, pid) {
  const match =
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u.exec(
      stdout,
    );
  assert(
    match &&
      Number(match[1]) === process.getuid() &&
      Number(match[2]) === pid &&
      [pid, Number(match[1]), Number(match[3]), Number(match[4])].every(
        Number.isSafeInteger,
      ) &&
      pid > 1 &&
      Number(match[4]) > 1,
    "OPERATOR_PROCESS_IDENTITY_INVALID",
  );
  return {
    uid: Number(match[1]),
    pid,
    parent: Number(match[3]),
    group: Number(match[4]),
    start: match[5],
    command: match[6],
  };
}
async function processIdentity(pid) {
  const result = await execute(
    "/bin/ps",
    ["-ww", "-p", String(pid), "-o", "uid=,pid=,ppid=,pgid=,lstart=,comm="],
    {
      timeout: 5000,
      maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    },
  );
  return operatorProcessIdentity(result.stdout, pid);
}

/** No callbacks/default observer can grant execution; approval comes from the parent. */
export async function runWorkerOperatorAcceptance(
  value,
  context = {},
  { forkChild = fork } = {},
) {
  const plan = await planWorkerOperatorAcceptance(value);
  if (context.approved !== true) return plan;
  assert(
    context.signal instanceof AbortSignal &&
      [
        "authorize",
        "assertSafe",
        "registerRoot",
        "observeDescendants",
        "cleanupOwned",
      ].every((key) => typeof context[key] === "function"),
    "OPERATOR_APPROVED_CONTEXT_REQUIRED",
  );
  context.signal.throwIfAborted();
  assert(
    (await context.authorize(plan)) === true,
    "OPERATOR_APPROVAL_REQUIRED",
  );
  await context.assertSafe();
  context.signal.throwIfAborted();
  const node = join(
    value.preparedSupportRoot,
    "runtime",
    "releases",
    plan.runtime_id,
    "runtime/runtime/node/bin/node",
  );
  await mkdir(value.outputRoot, { mode: 0o700 });
  const runner = join(value.outputRoot, "operator-runner.mjs");
  await copyFile(self, runner);
  await copyFile(
    join(import.meta.dirname, "worker-service-artifact.mjs"),
    join(value.outputRoot, "worker-service-artifact.mjs"),
  );
  await writeFile(join(value.outputRoot, "plan.json"), JSON.stringify(plan), {
    flag: "wx",
    mode: 0o600,
  });
  context.signal.throwIfAborted();
  const child = forkChild(runner, ["--private-runner"], {
    execPath: node,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      MUSICMUTE_SENTRY_ENABLED: "false",
    },
  });
  const records = { roots: [], labels: [] };
  let failure, result, cleanupPromise;
  const cleanupOwned = () => (cleanupPromise ??= context.cleanupOwned(records));
  const ended = new Promise((resolveEnd) => {
    child.once("exit", (code, signal) => resolveEnd({ code, signal }));
    child.once("error", (error) => {
      failure = error;
      resolveEnd({ code: null });
    });
  });
  const abort = () => {
    failure ??= new Error("OPERATOR_CANCELLED");
    child.kill("SIGTERM");
    void cleanupOwned().catch(() => undefined);
  };
  let removeCancellation = () => {};
  const register = async (record) => {
    records.roots.push(record);
    await context.registerRoot(record);
    await context.observeDescendants(record);
  };
  try {
    removeCancellation = attachOperatorCancellation(context.signal, abort);
    const root = await processIdentity(child.pid);
    assert(root.group === root.pid, "OPERATOR_RUNNER_GROUP_REQUIRED");
    await register({ ...root, phase: "confirmed", role: "operator-runner" });
    child.on("message", async (message) => {
      try {
        if (failure) return;
        context.signal.throwIfAborted();
        assert(
          message &&
            ["label", "root", "stage", "result", "failure"].includes(
              message.type,
            ),
          "OPERATOR_IPC_INVALID",
        );
        assert(
          Buffer.byteLength(JSON.stringify(message)) <= 2 * 1024 * 1024,
          "OPERATOR_IPC_TOO_LARGE",
        );
        if (message.type === "label") {
          assert(LABEL.test(message.label), "OPERATOR_LABEL_INVALID");
          const contract = {
            phase: "pending-label",
            label: message.label,
            uid: message.uid,
            plistPath: message.plistPath,
            expectedExecutable: message.expectedExecutable,
            reportPath: message.reportPath,
            releaseRoot: message.releaseRoot,
          };
          assert(
            contract.uid === process.getuid(),
            "OPERATOR_LABEL_UID_INVALID",
          );
          for (const path of [
            contract.plistPath,
            contract.expectedExecutable,
            contract.reportPath,
            contract.releaseRoot,
          ])
            assert(
              absolute(path).startsWith(`${value.outputRoot}/`),
              "OPERATOR_LABEL_PATH_INVALID",
            );
          records.labels.push(contract);
          // Pending labels are contracts for exact label/PID resolution, never
          // entries in the observer's owned-root exclusion set.
          await context.registerRoot(contract);
        } else if (message.type === "root") {
          const actual = await processIdentity(message.pid);
          const contract = records.labels.find(
            (record) => record.label === message.label,
          );
          const printed = await execute(
            "/bin/launchctl",
            operatorLaunchctlArguments(
              "print",
              process.getuid(),
              message.label,
            ),
            { timeout: 5000, maxBuffer: 128 * 1024 },
          );
          assert(
            contract &&
              actual.command === contract.expectedExecutable &&
              actual.command === message.command &&
              Number(/^\s*pid = (\d+)/mu.exec(printed.stdout)?.[1]) ===
                actual.pid,
            "OPERATOR_LAUNCHD_ROOT_INVALID",
          );
          await register({
            ...actual,
            phase: "confirmed",
            role: "qualification",
            label: message.label,
          });
        } else if (message.type === "result") result = message.result;
        else if (message.type === "failure")
          throw new Error("OPERATOR_EXECUTION_FAILED");
        if (["label", "root", "stage"].includes(message.type)) {
          context.signal.throwIfAborted();
          await context.assertSafe();
          for (const record of records.roots)
            await context.observeDescendants(record);
          child.send({ type: "ack", id: message.id });
        }
      } catch (error) {
        failure ??= error;
        abort();
      }
    });
    child.send({ type: "approved-init", plan });
    const exit = await ended;
    if (failure) throw failure;
    assert(exit.code === 0 && !exit.signal && result, "OPERATOR_RUNNER_FAILED");
    return { ...plan, execution_started: true, result };
  } finally {
    removeCancellation();
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    const cleanup = await cleanupOwned();
    assert(cleanup?.confirmed === true, "OPERATOR_EXIT_UNCONFIRMED");
    await ended;
  }
}

export function attachOperatorCancellation(signal, stop) {
  assert(
    signal instanceof AbortSignal && typeof stop === "function",
    "OPERATOR_CANCELLATION_REQUIRED",
  );
  signal.throwIfAborted();
  signal.addEventListener("abort", stop, { once: true });
  return () => signal.removeEventListener("abort", stop);
}

/** The dispatcher is the copied original; no qualifier/process overrides. */
export async function dispatchOriginalOperatorSteps(
  run,
  context,
  home,
  signalCheck = () => {},
) {
  const results = [];
  const command = async (name, args) => {
    await signalCheck({ command: name, arguments: args });
    const frames = [];
    const code = await run(name, args, {
      ...context,
      stdout: (text) => frames.push(JSON.parse(text)),
    });
    assert(code === 0, "OPERATOR_COMMAND_FAILED");
    results.push({ command: name, arguments: args, result: frames.at(-1) });
  };
  await command("benchmark", ["--workers", "1", "--json"]);
  for (const recipe of ["kim-vocals-v2", "kim-vocals-v2-trim"])
    await command("benchmark-file", [
      "--input",
      context.fixturePath,
      "--recipe",
      recipe,
      "--warmup-runs",
      "1",
      "--runs",
      "3",
      "--group-size",
      "2",
      "--report",
      join(home, `${recipe}.json`),
      "--save-audio-dir",
      join(home, `${recipe}-audio`),
      "--json",
    ]);
  await command("benchmark", ["--workers", "2", "--json"]);
  for (const workers of ["2", "1", "2"])
    await command("capacity", ["--workers", workers, "--json"]);
  const capacities = results
    .filter((result) => result.command === "capacity")
    .map((result) => result.result);
  assert.deepEqual(
    capacities[0].workerIds,
    capacities[2].workerIds,
    "OPERATOR_SLOT_IDENTITY_CHANGED",
  );
  assert.equal(
    capacities[1].workerIds[0],
    capacities[0].workerIds[0],
    "OPERATOR_SLOT_IDENTITY_CHANGED",
  );
  return results;
}

export async function waitForOperatorExecutable(
  readIdentity,
  expected,
  attempts = 200,
  pause = delay,
) {
  absolute(expected);
  assert(
    Number.isSafeInteger(attempts) && attempts > 0 && attempts <= 200,
    "OPERATOR_IDENTITY_WAIT_INVALID",
  );
  for (let attempt = 0; attempt < attempts; attempt++) {
    const identity = await readIdentity().catch(() => null);
    if (identity?.uid === process.getuid() && identity.command === expected)
      return identity;
    await pause(25);
  }
  throw new Error("OPERATOR_QUALIFICATION_PID_UNCONFIRMED");
}

async function privateRunner(plan) {
  const options = operatorOptions(plan.options);
  await safeDirectory(options.outputRoot, true);
  await verifyOperatorFixture(options.fixturePath);
  assert(
    (await verifyWorkerService(options.serviceRoot)).payload_sha256 ===
      plan.payload_sha256,
    "OPERATOR_CODE_IDENTITY_CHANGED",
  );
  const pending = new Map();
  process.on("message", (message) => {
    if (message.type === "ack") {
      pending.get(message.id)?.();
      pending.delete(message.id);
    }
  });
  const acknowledge = (message) =>
    new Promise((resolveAck, rejectAck) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectAck(new Error("OPERATOR_ACK_TIMEOUT"));
      }, 15_000);
      pending.set(id, () => {
        clearTimeout(timeout);
        resolveAck();
      });
      process.send({ ...message, id });
    });
  const load = (relative) =>
    import(
      pathToFileURL(join(options.serviceRoot, "app/dist/src", relative)).href
    );
  const paths = await load("platform/macos/user-paths.js");
  const binding = await load("platform/macos/app-installation-binding.js");
  const { runMacUserCommand } = await load("platform/macos/user-cli.js");
  const { initializeLocalLifecycle, setLocalLifecycleIntent } = await load(
    "runtime/local-lifecycle.js",
  );
  const home = join(options.outputRoot, "home");
  await mkdir(home, { mode: 0o700 });
  const layout = paths.createMacUserLayout(home);
  await paths.createMacUserDirectories(layout);
  const support = join(home, "Library/Application Support/MusicMuteLocal");
  await mkdir(join(support, "runtime/releases"), {
    recursive: true,
    mode: 0o700,
  });
  await cp(
    join(options.preparedSupportRoot, "runtime/releases", plan.runtime_id),
    join(support, "runtime/releases", plan.runtime_id),
    {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    },
  );
  const bootstrap = JSON.parse(
    await readFile(
      join(options.resourcesRoot, "runtime-bootstrap.json"),
      "utf8",
    ),
  );
  await writeFile(
    join(support, "runtime/active.json"),
    JSON.stringify({
      schema_version: 1,
      runtime_id: plan.runtime_id,
      api_version: 1,
      archive_sha256: bootstrap.runtime.archive_sha256,
      release_path: `releases/${plan.runtime_id}`,
    }),
    { mode: 0o600 },
  );
  await mkdir(join(support, "models", MODEL), { recursive: true, mode: 0o700 });
  await copyFile(
    join(options.preparedSupportRoot, "models", MODEL, "Kim_Vocal_2.onnx"),
    join(support, "models", MODEL, "Kim_Vocal_2.onnx"),
    constants.COPYFILE_FICLONE,
  );
  await chmod(join(support, "models", MODEL, "Kim_Vocal_2.onnx"), 0o600);
  const staged = await binding.stageMacAppService(
    layout,
    options.resourcesRoot,
    support,
  );
  assert(
    (await binding.readAppBinding(staged.releaseRoot)).payloadSha256 ===
      plan.payload_sha256,
    "OPERATOR_STAGED_CODE_IDENTITY_CHANGED",
  );
  await symlink(`releases/${staged.releaseVersion}`, layout.currentLink);
  await binding.publishMacAppRuntimeReference(layout, staged.releaseRoot);
  const executionLayout = await binding.resolveMacAppExecutionLayout(layout);
  await copyFile(
    options.fixturePath,
    join(layout.stateRoot, "qualification.wav"),
  );
  await chmod(join(layout.stateRoot, "qualification.wav"), 0o600);
  await verifyOperatorFixture(join(layout.stateRoot, "qualification.wav"));
  const machineId = randomUUID(),
    workerId = randomUUID();
  await writeFile(
    layout.credentialPath,
    randomBytes(32).toString("base64url") + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    layout.configPath,
    JSON.stringify({
      schemaVersion: 1,
      machineId,
      backendBaseUrl: "http://127.0.0.1:1",
      allowInsecureLoopback: true,
      credentialFile: layout.credentialPath,
      workRoot: layout.workRoot,
      modelCacheRoot: executionLayout.modelRoot,
      engineRoot: executionLayout.engineRoot,
      pythonPath: executionLayout.pythonPath,
      ffmpegPath: executionLayout.ffmpegPath,
      ffprobePath: executionLayout.ffprobePath,
      localLifecyclePath: layout.lifecyclePath,
      localRuntimeStatusPath: layout.runtimeStatusPath,
      validatedMaxWorkersPerGpu: 1,
      capacityValidationFile: layout.capacityValidationPath,
      slots: [
        {
          workerId,
          gpuId: "gpu0",
          slotIndex: 0,
          provider: "mps",
          recipeIds: ["kim-vocals-v2", "kim-vocals-v2-trim"],
        },
      ],
    }),
    { mode: 0o600 },
  );
  await initializeLocalLifecycle(layout.lifecyclePath);
  await setLocalLifecycleIntent(layout.lifecyclePath, "draining");
  Object.assign(process.env, {
    HOME: home,
    TMPDIR: layout.temporaryRoot,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    MUSICMUTE_SENTRY_ENABLED: "false",
  });
  let label = `com.musicmute.qualification.${randomUUID()}`;
  const uid = process.getuid();
  const launch = (action) =>
    execute("/bin/launchctl", operatorLaunchctlArguments(action, uid, label), {
      timeout: 5000,
      maxBuffer: 128 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
  const status = async () => {
    try {
      const { stdout } = await launch("print");
      const pid = Number(/^\s*pid = (\d+)/mu.exec(stdout)?.[1]);
      return {
        loaded: true,
        running: Number.isSafeInteger(pid) && pid > 1,
        ...(pid > 1 ? { pid } : {}),
      };
    } catch (error) {
      if ([3, 113].includes(error.code))
        return { loaded: false, running: false };
      throw error;
    }
  };
  assert(!(await status()).loaded, "OPERATOR_LABEL_COLLISION");
  const qualificationRoots = [];
  const agent = {
    status,
    async bootstrap(path) {
      assert(path === layout.plistPath, "OPERATOR_PLIST_PATH_INVALID");
      assert(!(await status()).loaded, "OPERATOR_PREVIOUS_LABEL_STILL_LOADED");
      label = `com.musicmute.qualification.${randomUUID()}`;
      assert(!(await status()).loaded, "OPERATOR_LABEL_COLLISION");
      const plist = projectOperatorQualificationPlist(
        await readFile(path, "utf8"),
        label,
      );
      const projected = join(options.outputRoot, `${randomUUID()}.plist`);
      await writeFile(projected, plist, { mode: 0o600, flag: "wx" });
      const expectedExecutable = await realpath(executionLayout.pythonPath);
      await acknowledge({
        type: "label",
        label,
        uid,
        plistPath: projected,
        expectedExecutable,
        reportPath: join(layout.stateRoot, "qualification.json"),
        releaseRoot: staged.releaseRoot,
      });
      await execute(
        "/bin/launchctl",
        operatorLaunchctlArguments("bootstrap", uid, label, projected),
        { timeout: 5000, maxBuffer: 128 * 1024 },
      );
      const identity = await waitForOperatorExecutable(async () => {
        const current = await status();
        return current.pid ? await processIdentity(current.pid) : null;
      }, expectedExecutable);
      qualificationRoots.push(identity);
      await acknowledge({
        type: "root",
        label,
        pid: identity.pid,
        command: identity.command,
      });
    },
    async bootout() {
      try {
        await launch("bootout");
      } catch (error) {
        if (![3, 113].includes(error.code)) throw error;
      }
      for (let attempt = 0; attempt < 400; attempt++) {
        if (!(await status()).loaded) {
          let exited = true;
          for (const previous of qualificationRoots) {
            try {
              const current = await processIdentity(previous.pid);
              if (current.start === previous.start) exited = false;
            } catch (error) {
              if (error.code !== 1) exited = false;
            }
          }
          if (exited) {
            if (process.connected) await acknowledge({ type: "stage" });
            return;
          }
        }
        await delay(25);
      }
      throw new Error("OPERATOR_LABEL_EXIT_UNCONFIRMED");
    },
    async kickstart() {
      throw new Error("OPERATOR_FLEET_START_FORBIDDEN");
    },
  };
  try {
    await acknowledge({ type: "stage" });
    const result = await dispatchOriginalOperatorSteps(
      runMacUserCommand,
      {
        layout: executionLayout,
        host: { platform: "darwin", arch: "arm64", uid, home },
        launchAgent: agent,
        fixturePath: join(layout.stateRoot, "qualification.wav"),
      },
      home,
      async () => {
        if (!process.connected) throw new Error("OPERATOR_PARENT_CLOSED");
        await acknowledge({ type: "stage" });
      },
    );
    await writeFile(
      join(options.outputRoot, "operator-result.json"),
      JSON.stringify({
        schema_version: 1,
        status: "PASS",
        scope: "ISOLATED_ORIGINAL_OPERATORS_REAL_MPS",
        payload_sha256: plan.payload_sha256,
        fixture: OPERATOR_FIXTURE,
        result,
      }),
      { flag: "wx", mode: 0o600 },
    );
    process.send({ type: "result", result });
  } catch (error) {
    const config = JSON.parse(await readFile(layout.configPath, "utf8"));
    await writeFile(
      join(options.outputRoot, "operator-failure.json"),
      JSON.stringify({
        schema_version: 1,
        status: "FAIL",
        scope: "ISOLATED_ORIGINAL_OPERATORS_REAL_MPS",
        error_code: "OPERATOR_EXECUTION_FAILED",
        payload_sha256: plan.payload_sha256,
        fixture: OPERATOR_FIXTURE,
        configured_workers: config.slots.length,
        qualification_report: join(layout.stateRoot, "qualification.json"),
        capacity_measurements: join(
          layout.stateRoot,
          "capacity-measurements.json",
        ),
        capacity_receipt: layout.capacityValidationPath,
        forced_pass: false,
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw error;
  } finally {
    await agent.bootout();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === self) {
  if (
    process.argv.length === 3 &&
    process.argv[2] === "--private-runner" &&
    typeof process.send === "function"
  ) {
    process.once("message", async (message) => {
      try {
        assert(message.type === "approved-init");
        await privateRunner(message.plan);
        process.disconnect();
      } catch {
        process.send({ type: "failure" });
        process.disconnect();
        process.exitCode = 1;
      }
    });
  } else {
    try {
      console.log(
        JSON.stringify(
          await planWorkerOperatorAcceptance(
            parseOperatorArguments(process.argv.slice(2)),
          ),
          null,
          2,
        ),
      );
    } catch {
      console.error("OPERATOR_PLAN_INVALID");
      process.exitCode = 1;
    }
  }
}
