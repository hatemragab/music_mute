import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createAcceptanceFixture } from "../../worker/scripts/service-acceptance-fixture.mjs";
import { verifyWorkerService } from "./worker-service-artifact.mjs";

const OUTPUT = Buffer.from("synthetic processed vocals; no real inference");
const SHA256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const SAFE_TIMEOUT_MS = 45_000;
const execute = promisify(execFile);

function exists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") {
      // Automation may observe a launchd-owned fixture but lack kill(0)
      // authority. Require positive same-user process metadata, never infer
      // absence from EPERM. Crash requests use only the exact launchd label.
      try {
        const owner = execFileSync(
          "/bin/ps",
          ["-p", String(pid), "-o", "uid=", "-o", "lstart="],
          {
            timeout: 1000,
            maxBuffer: 4096,
            encoding: "utf8",
            env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
          },
        );
        const record =
          /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/u.exec(
            owner,
          );
        if (record && Number(record[1]) === process.getuid()) return true;
      } catch {
        /* Unreadable metadata remains an unconfirmed process. */
      }
      try {
        process.kill(pid, 0);
      } catch (again) {
        if (again.code === "ESRCH") return false;
      }
    }
    const code = ["EPERM", "EINVAL", "ERR_INVALID_ARG_TYPE"].includes(
      error.code,
    )
      ? error.code
      : "UNKNOWN";
    throw new Error(`FIXTURE_PROCESS_EXIT_UNCONFIRMED_${code}`);
  }
}
async function until(predicate, message, timeout = SAFE_TIMEOUT_MS) {
  const deadline = performance.now() + timeout;
  for (;;) {
    if (await predicate()) return;
    if (performance.now() >= deadline) throw new Error(message);
    await delay(25);
  }
}
async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
function safeEnvironment(home) {
  return {
    HOME: home,
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    MUSICMUTE_SENTRY_ENABLED: "false",
  };
}
async function copiedEntry(app, relative, original) {
  const source = await readFile(join(original, "app", relative));
  assert.equal(SHA256(await readFile(join(app, relative))), SHA256(source));
}

async function confirmFixtureExit(ownedPids, ownedGroups) {
  try {
    await until(
      () => [...ownedPids].every((pid) => !exists(pid)),
      "FIXTURE_PROCESS_GROUP_CLEANUP_FAILED",
      10_000,
    );
  } catch (error) {
    // A broken guardian must FAIL acceptance. Emergency cleanup of known
    // private groups happens only after that failure, and never masks it.
    for (const group of ownedGroups) {
      try {
        process.kill(-group, "SIGKILL");
      } catch (failure) {
        if (failure.code !== "ESRCH") throw failure;
      }
    }
    await until(
      () => [...ownedPids].every((pid) => !exists(pid)),
      "FIXTURE_EMERGENCY_CLEANUP_FAILED",
      10_000,
    );
    throw error;
  }
}

/** The only launchd mutations target a fresh qualification UUID, never the
 * installed worker label. The plist stays inside the disposable fixture root.
 */
async function qualificationAgent({
  app,
  home,
  nodePath,
  pythonPath,
  configPath,
  stdoutPath,
  stderrPath,
  root,
}) {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid <= 0)
    throw new Error("QUALIFICATION_USER_DOMAIN_REQUIRED");
  const label = `com.musicmute.qualification.${randomUUID()}`;
  const target = `gui/${uid}/${label}`;
  const plistPath = join(root, `${label}.plist`);
  const { renderLaunchAgentPlist } = await import(
    pathToFileURL(join(app, "dist/src/platform/macos/launch-agent.js"))
  );
  const { createMacUserLayout } = await import(
    pathToFileURL(join(app, "dist/src/platform/macos/user-paths.js"))
  );
  let plist = renderLaunchAgentPlist({
    ...createMacUserLayout(home),
    nodePath,
    cliPath: join(app, "dist/src/cli/main.js"),
    configPath,
    installRoot: app,
    ffmpegPath: pythonPath,
    stdoutPath,
    stderrPath,
  });
  const originalLabel = "<string>com.musicmute.worker</string>";
  assert.equal(plist.split(originalLabel).length, 2);
  plist = plist.replace(originalLabel, `<string>${label}</string>`);
  const environmentEnd = "  </dict>\n  <key>WorkingDirectory</key>";
  assert.equal(plist.split(environmentEnd).length, 2);
  plist = plist.replace(
    environmentEnd,
    "    <key>MUSICMUTE_SENTRY_ENABLED</key>\n    <string>false</string>\n" +
      environmentEnd,
  );
  assert(!plist.includes("com.musicmute.worker"));
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/u);
  assert.match(
    plist,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u,
  );
  await writeFile(plistPath, plist, { flag: "wx", mode: 0o600 });
  const run = async (args) =>
    execute("/bin/launchctl", args, {
      timeout: 5000,
      maxBuffer: 128 * 1024,
      env: safeEnvironment(home),
    });
  const pid = async () => {
    try {
      const { stdout } = await run(["print", target]);
      const match = /^\s*pid = (\d+)\s*$/mu.exec(stdout);
      return match ? Number(match[1]) : undefined;
    } catch (error) {
      if ([3, 113].includes(error.code)) return undefined;
      throw new Error("QUALIFICATION_AGENT_STATUS_FAILED");
    }
  };
  // Refuse even an improbable UUID collision rather than taking over a job.
  try {
    await run(["print", target]);
    throw new Error("QUALIFICATION_LABEL_ALREADY_EXISTS");
  } catch (error) {
    if (![3, 113].includes(error.code)) throw error;
  }
  let registered = false;
  return {
    label,
    pid,
    async crash() {
      try {
        await run(["kill", "SIGKILL", target]);
      } catch {
        throw new Error("QUALIFICATION_AGENT_CRASH_FAILED");
      }
    },
    async start() {
      registered = true; // A timed-out bootstrap may still have registered it.
      try {
        await run(["bootstrap", `gui/${uid}`, plistPath]);
      } catch {
        throw new Error("QUALIFICATION_AGENT_BOOTSTRAP_FAILED");
      }
    },
    async close() {
      if (!registered) return;
      try {
        await run(["bootout", target]);
      } catch (error) {
        if (![3, 113].includes(error.code))
          throw new Error("QUALIFICATION_AGENT_BOOTOUT_FAILED");
      }
      await until(
        async () => {
          try {
            await run(["print", target]);
            return false;
          } catch (error) {
            if ([3, 113].includes(error.code)) return true;
            throw new Error("QUALIFICATION_AGENT_REMOVAL_UNCONFIRMED");
          }
        },
        "QUALIFICATION_AGENT_STILL_REGISTERED",
        10_000,
      );
      registered = false;
    },
  };
}

/** Actual frozen Node runtime/controller/guardian/transfer processes; synthetic
 * loopback backend, Python engine, decoder and bytes. Default mode never calls
 * launchctl; explicit launch-agent mode owns one temporary qualification label.
 * No enrollment, model loading, installed state, public network or real R2.
 */
export async function qualifyWorkerBackgroundService({
  serviceRoot,
  nodePath = process.execPath,
  pythonPath = "/usr/bin/python3",
  scenario = "controller-eof",
  serviceMode = "direct",
  fault = null,
  onFixtureProcesses = () => {},
}) {
  if (!["controller-eof", "controller-kill"].includes(scenario))
    throw new Error("INVALID_ACCEPTANCE_SCENARIO");
  if (![null, "unexpected-output"].includes(fault))
    throw new Error("INVALID_ACCEPTANCE_FAULT");
  if (!["direct", "launch-agent"].includes(serviceMode))
    throw new Error("INVALID_ACCEPTANCE_SERVICE_MODE");
  if (typeof onFixtureProcesses !== "function")
    throw new Error("INVALID_ACCEPTANCE_OBSERVER");
  for (const path of [serviceRoot, nodePath, pythonPath]) {
    if (typeof path !== "string" || !isAbsolute(path))
      throw new Error("ABSOLUTE_ACCEPTANCE_PATH_REQUIRED");
  }
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("MACOS_ARM64_ACCEPTANCE_REQUIRED");
  serviceRoot = await realpath(serviceRoot);
  nodePath = await realpath(nodePath);
  pythonPath = await realpath(pythonPath);
  const manifest = await verifyWorkerService(serviceRoot);
  const root = await realpath(await mkdtemp("/tmp/mm-background-"));
  await chmod(root, 0o700);
  const home = join(root, "home"),
    app = join(root, "external-service", "app"),
    gui = join(root, "Disposable GUI.app"),
    engine = join(root, "fake-engine"),
    state = join(
      home,
      "Library",
      "Application Support",
      "MusicMuteWorker",
      "state",
    ),
    models = join(root, "fake-model-cache");
  // The explicit config is intentionally outside the installation layout: the
  // real run entry cannot invoke launchctl or inspect an installed binding.
  const configPath = join(root, "config", "runtime.json"),
    credentialPath = join(root, "config", "synthetic-credential"),
    statusPath = join(state, "runtime-status.json");
  const serviceStdout = join(root, "service-output"),
    serviceStderr = join(root, "service-error"),
    prefix = join(root, "acceptance");
  let controller,
    service,
    servicePid,
    agent,
    childPids = [],
    fixture;
  let stdoutFile, stderrFile;
  let acceptanceError;
  const ownedPids = new Set(),
    ownedGroups = new Set();
  const captureChildren = (pids) => {
    if (!pids) return;
    const children = [pids.guardian_pid, pids.engine_pid, pids.decoder_pid];
    assert(children.every((pid) => Number.isSafeInteger(pid) && pid > 1));
    for (const pid of children) ownedPids.add(pid);
    ownedGroups.add(children[0]);
    childPids = children;
  };
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const wait = (predicate, message, timeout) =>
    until(
      async () => {
        if (stopping.signal.aborted)
          throw new Error("FIXTURE_ACCEPTANCE_INTERRUPTED");
        return await predicate();
      },
      message,
      timeout,
    );
  try {
    for (const path of [
      home,
      dirname(app),
      gui,
      engine,
      state,
      models,
      dirname(configPath),
    ])
      await mkdir(path, { recursive: true, mode: 0o700 });
    await cp(join(serviceRoot, "app"), app, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    await writeFile(
      join(dirname(app), "service-manifest.json"),
      await readFile(join(serviceRoot, "service-manifest.json")),
      { mode: 0o600, flag: "wx" },
    );
    assert.equal(
      (await verifyWorkerService(dirname(app))).payload_sha256,
      manifest.payload_sha256,
    );
    for (const entry of [
      "dist/src/cli/main.js",
      "dist/src/cli/app-control.js",
      "dist/src/runtime/worker-runtime.js",
      "dist/src/agent/process-guardian.js",
      "dist/src/runtime/transfer-process.js",
    ])
      await copiedEntry(app, entry, serviceRoot);
    const credential = randomBytes(32).toString("base64url"),
      machineId = randomUUID(),
      workerId = randomUUID();
    await writeFile(credentialPath, credential + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    const recipe = {
      recipeId: "kim-vocals-v2",
      recipeRevision: 4,
      protocolVersion: 1,
      recipeDigest: "a".repeat(64),
      modelFilename: "Kim_Vocal_2.onnx",
      modelDigest: "b".repeat(64),
      modelBytes: 66_759_214,
      inputProfileId: "direct-input-v1",
      stepIds: ["separate-kim-vocal-2-direct-mp3-v1", "validate-audio-v1"],
      trimEnabled: false,
      denoiseEnabled: false,
      denoisePresetId: null,
      trimProfileId: null,
      outputFormat: "mp3",
      outputBitrateKbps: 160,
    };
    fixture = createAcceptanceFixture({
      config: { machineId },
      credential,
      input: Buffer.from("synthetic owned input"),
      outputPath: prefix,
      recipes: [
        recipe,
        {
          ...recipe,
          recipeId: "kim-vocals-v2-trim",
          trimEnabled: true,
          trimProfileId: "fixture-trim",
        },
      ],
      claimsEnabled: () => true,
    });
    fixture.server.listen(0, "127.0.0.1");
    await once(fixture.server, "listening");
    const origin = `http://127.0.0.1:${fixture.server.address().port}`;
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        backendBaseUrl: origin,
        machineId,
        credentialFile: credentialPath,
        localRuntimeStatusPath: statusPath,
        workRoot: join(root, "attempts"),
        modelCacheRoot: models,
        engineRoot: engine,
        pythonPath,
        ffmpegPath: pythonPath,
        ffprobePath: pythonPath,
        allowInsecureLoopback: true,
        slots: [
          {
            workerId,
            gpuId: "gpu0",
            slotIndex: 0,
            recipeIds: [recipe.recipeId],
            provider: "mps",
          },
        ],
      }),
      { mode: 0o600, flag: "wx" },
    );
    await mkdir(join(engine, "musicmute_engine"), { mode: 0o700 });
    await writeFile(join(engine, "musicmute_engine", "__init__.py"), "", {
      mode: 0o600,
    });
    await writeFile(
      join(engine, "musicmute_engine", "child.py"),
      fakeEngine.replace(
        "__SYNTHETIC_OUTPUT__",
        fault === "unexpected-output"
          ? "deliberately unexpected synthetic output"
          : OUTPUT.toString("utf8"),
      ),
      { mode: 0o600 },
    );
    const launcher = join(gui, "controller.mjs");
    await writeFile(launcher, controllerSource, { mode: 0o600 });
    stdoutFile = await open(serviceStdout, "wx", 0o600);
    stderrFile = await open(serviceStderr, "wx", 0o600);
    if (serviceMode === "launch-agent") {
      agent = await qualificationAgent({
        app,
        home,
        nodePath,
        pythonPath,
        configPath,
        stdoutPath: serviceStdout,
        stderrPath: serviceStderr,
        root,
      });
      await agent.start();
      await wait(async () => {
        servicePid = await agent.pid();
        const runtime = await json(statusPath);
        return (
          Number.isSafeInteger(servicePid) &&
          servicePid > 1 &&
          runtime?.processId === servicePid
        );
      }, "QUALIFICATION_AGENT_DID_NOT_RUN_AT_LOAD");
    } else {
      service = spawn(
        nodePath,
        [join(app, "dist/src/cli/main.js"), "run", "--config", configPath],
        {
          detached: true,
          cwd: app,
          env: safeEnvironment(home),
          stdio: ["ignore", stdoutFile.fd, stderrFile.fd],
        },
      );
      await once(service, "spawn");
      servicePid = service.pid;
    }
    assert(Number.isSafeInteger(servicePid) && servicePid > 1);
    ownedPids.add(servicePid);
    controller = spawn(
      nodePath,
      [launcher, app, String(servicePid), home, statusPath],
      {
        cwd: gui,
        env: safeEnvironment(home),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let controllerOutput = "",
      controllerErrors = "";
    let controllerFailed = false;
    controller.on("error", () => {
      controllerFailed = true;
    });
    controller.stdin.on("error", () => {
      controllerFailed = true;
    });
    controller.stdout.setEncoding("utf8");
    controller.stderr.setEncoding("utf8");
    controller.stdout.on("data", (bytes) => {
      controllerOutput += bytes;
      if (controllerOutput.length > 1024 * 1024) controller.kill("SIGKILL");
    });
    controller.stderr.on("data", (bytes) => {
      controllerErrors += bytes;
      if (controllerErrors.length > 65536) controller.kill("SIGKILL");
    });
    controller.stdin.write(
      JSON.stringify({
        protocol_version: 1,
        request_id: randomUUID(),
        type: "SUBSCRIBE",
        command: "status",
        parameters: {},
      }) + "\n",
    );
    await wait(async () => {
      const pids = await json(join(models, "owned-processes.json"));
      captureChildren(pids);
      if (!exists(servicePid))
        throw new Error("COPIED_SERVICE_EXITED_BEFORE_ACCEPTANCE");
      if (
        controllerFailed ||
        controller.exitCode !== null ||
        controller.signalCode !== null
      )
        throw new Error("CONTROLLER_EXITED_BEFORE_ACCEPTANCE");
      if (fixture.snapshot().jobs[0].status === "failed")
        throw new Error("BACKGROUND_ATTEMPT_FAILED");
      return (
        Number.isSafeInteger(servicePid) &&
        childPids.length === 3 &&
        fixture.snapshot().jobs[0].status === "running" &&
        fixture.snapshot().jobs[0].separationObservedAtMs !== null &&
        controllerOutput.includes('"type":"SNAPSHOT"')
      );
    }, "BACKGROUND_SERVICE_DID_NOT_ACCEPT_FIXTURE");
    assert.equal(controllerErrors, "");
    const accepted = fixture.snapshot().jobs[0],
      originalServicePid = servicePid;
    assert.equal(accepted.completion, null);
    assert(
      childPids.every(
        (pid) => Number.isSafeInteger(pid) && pid > 1 && exists(pid),
      ),
    );
    assert(exists(servicePid));
    onFixtureProcesses(
      Object.freeze({
        service: servicePid,
        controller: controller.pid,
        children: Object.freeze([...childPids]),
      }),
    );
    const exited = once(controller, "exit");
    if (scenario === "controller-eof") controller.stdin.end();
    else controller.kill("SIGKILL");
    const controllerExitTimer = new AbortController();
    try {
      await Promise.race([
        exited,
        delay(5000, null, { signal: controllerExitTimer.signal }).then(() => {
          throw new Error("CONTROLLER_DID_NOT_EXIT");
        }),
      ]);
    } finally {
      controllerExitTimer.abort();
    }
    assert(exists(originalServicePid));
    assert.equal(fixture.snapshot().jobs[0].status, "running");
    assert.equal(fixture.snapshot().jobs[0].completion, null);
    await rm(gui, { recursive: true });
    await writeFile(join(models, "finish-accepted-attempt"), "finish\n", {
      mode: 0o600,
      flag: "wx",
    });
    await wait(() => {
      if (fixture.snapshot().jobs[0].status === "failed")
        throw new Error("BACKGROUND_ATTEMPT_FAILED");
      if (!exists(originalServicePid))
        throw new Error("COPIED_SERVICE_EXITED_BEFORE_COMPLETION");
      return fixture.snapshot().jobs[0].status === "ready";
    }, "BACKGROUND_ATTEMPT_DID_NOT_FINISH");
    const completed = fixture.snapshot(),
      job = completed.jobs[0];
    assert.equal(job.attemptId, accepted.attemptId);
    assert.equal(job.workerId, workerId);
    assert.equal(job.failureCode, null);
    assert.equal(agent ? await agent.pid() : service.pid, originalServicePid);
    assert(exists(originalServicePid));
    if (!OUTPUT.equals(await readFile(`${prefix}.0.mp3`)))
      throw new Error("BACKGROUND_OUTPUT_MISMATCH");
    const processEvents = (
      await readFile(join(models, "process-events.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(processEvents.length, 1);
    assert.equal(processEvents[0].attempt_id, accepted.attemptId);
    assert.equal(
      completed.requests["POST /worker/attempts/:id/completions"],
      1,
    );
    assert.equal(completed.requests["PUT /acceptance/:id/output"], 1);
    assert.equal(completed.requests["GET /acceptance/:id/input"], 1);
    assert.equal(completed.jobs[1].status, "waiting");
    assert(
      !(await readFile(`${prefix}.evidence.json`, "utf8")).includes(credential),
    );
    if (service) {
      const serviceExit = once(service, "exit");
      assert.equal(service.kill("SIGKILL"), true);
      await serviceExit;
    } else await agent.crash();
    await wait(
      () =>
        !exists(originalServicePid) && childPids.every((pid) => !exists(pid)),
      "COPIED_SERVICE_PROCESS_GROUP_SURVIVED",
      10_000,
    );
    let launchAgent;
    if (agent) {
      await wait(async () => {
        const nextPid = await agent.pid();
        const nextChildren = await json(join(models, "owned-processes.json"));
        const nextRuntime = await json(statusPath);
        if (
          !nextPid ||
          nextPid === originalServicePid ||
          nextRuntime?.processId !== nextPid ||
          !nextChildren ||
          nextChildren.guardian_pid === childPids[0] ||
          !exists(nextPid)
        )
          return false;
        servicePid = nextPid;
        ownedPids.add(nextPid);
        captureChildren(nextChildren);
        return childPids.every(
          (pid) => Number.isSafeInteger(pid) && pid > 1 && exists(pid),
        );
      }, "QUALIFICATION_AGENT_KEEPALIVE_FAILED");
      assert.equal(
        fixture.snapshot().requests["POST /worker/attempts/:id/completions"],
        1,
      );
      assert.equal(
        (await readFile(join(models, "process-events.jsonl"), "utf8"))
          .trim()
          .split("\n").length,
        1,
      );
      await agent.close();
      await wait(
        () => !exists(servicePid) && childPids.every((pid) => !exists(pid)),
        "QUALIFICATION_AGENT_BOOTOUT_LEFT_PROCESSES",
        10_000,
      );
      launchAgent = {
        label: agent.label,
        run_at_load_observed: true,
        keep_alive_restarted_after_supervisor_death: true,
        exact_label_bootout_confirmed: true,
        installed_in_launch_agents_directory: false,
        login_or_reboot_tested: false,
      };
    }
    return {
      schema_version: 1,
      scope:
        "copied-production-node-service-and-controller-with-loopback-backend-and-stdlib-fake-python-engine",
      scenario,
      service_mode: serviceMode,
      service_payload_sha256: manifest.payload_sha256,
      same_service_pid: true,
      same_accepted_attempt: true,
      controller_exited_before_completion: true,
      gui_folder_removed_before_completion: true,
      process_invocations: processEvents.length,
      input_downloads: 1,
      conditional_output_uploads: 1,
      completions: 1,
      process_group_confirmed_gone_after_supervisor_death: true,
      real_inference: false,
      installed_launch_agent: false,
      controller_adapter:
        "production-session-and-file-subscription-with-isolated-status-command",
      telemetry_disabled: true,
      complete_copied_inventory_verified: true,
      service_entries: manifest.entries.length,
      ...(launchAgent ? { temporary_launch_agent: launchAgent } : {}),
    };
  } catch (error) {
    // Only fixed acceptance codes escape. Synthetic credentials and tool output
    // remain in the disposable private root and are never copied into evidence.
    acceptanceError =
      error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
        ? error
        : new Error("BACKGROUND_SERVICE_ACCEPTANCE_FAILED");
    if (agent) acceptanceError.qualification_label = agent.label;
    throw acceptanceError;
  } finally {
    try {
      if (
        controller &&
        controller.exitCode === null &&
        controller.signalCode === null
      ) {
        const exit = once(controller, "exit");
        controller.kill("SIGKILL");
        await exit;
      }
      if (service && service.exitCode === null && service.signalCode === null) {
        const exit = once(service, "exit");
        service.kill("SIGKILL");
        await exit;
      }
      if (agent) {
        const currentPid = await agent.pid();
        if (currentPid) ownedPids.add(currentPid);
        captureChildren(await json(join(models, "owned-processes.json")));
        await agent.close();
      }
      await confirmFixtureExit(ownedPids, ownedGroups);
      if (acceptanceError) acceptanceError.fixture_cleanup_confirmed = true;
    } finally {
      if (fixture)
        await new Promise((done) => {
          fixture.server.close(done);
          fixture.server.closeAllConnections();
        });
      await stdoutFile?.close();
      await stderrFile?.close();
      await rm(root, { recursive: true, force: true });
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
  }
}

const controllerSource = `
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
const [app, servicePid, home, statusFile] = process.argv.slice(2);
const deadline = performance.now() + 30_000;
for (;;) {
  try { await readFile(statusFile); break; }
  catch (error) { if (error.code !== 'ENOENT' || performance.now() >= deadline) throw new Error('FIXTURE_STATUS_UNAVAILABLE'); }
  await delay(25);
}
const { runAppControlSession } = await import(pathToFileURL(join(app, 'dist/src/cli/app-control.js')));
const { createMacUserLayout } = await import(pathToFileURL(join(app, 'dist/src/platform/macos/user-paths.js')));
const layout = createMacUserLayout(home);
await runAppControlSession(process.stdin, process.stdout, {
  context: { layout, host: { home, platform: 'darwin', arch: 'arm64' } },
  runCommand: async (command, _args, context) => {
    if (command !== 'status') throw new Error('FIXTURE_READ_ONLY_CONTROLLER');
    const runtime = JSON.parse(await readFile(statusFile, 'utf8'));
    context.stdout(JSON.stringify({ service: { loaded: true, running: true, pid: Number(servicePid) }, runtime }));
    return 0;
  },
});
`;

const fakeEngine = `
import base64, datetime, hashlib, json, os, pathlib, struct, subprocess, sys, time, uuid
args = sys.argv
incarnation = args[args.index('--incarnation') + 1]
models = pathlib.Path(args[args.index('--model-cache-root') + 1])
decoder = subprocess.Popen([sys.executable, '-I', '-B', '-c', 'import time; time.sleep(600)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
processes = models / 'owned-processes.json'
temporary = models / 'owned-processes.tmp'
temporary.write_text(json.dumps({'engine_pid': os.getpid(), 'guardian_pid': os.getppid(), 'decoder_pid': decoder.pid}))
os.chmod(temporary, 0o600)
temporary.rename(processes)
def send(kind, request_id, payload):
    body = json.dumps({'protocolVersion': 1, 'type': kind, 'requestId': request_id, 'incarnation': incarnation, 'sentAt': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'), 'payload': payload}).encode()
    sys.stdout.buffer.write(struct.pack('>I', len(body)) + body)
    sys.stdout.buffer.flush()
def read_exact(size):
    result = b''
    while len(result) < size:
        chunk = sys.stdin.buffer.read(size - len(result))
        if not chunk: raise EOFError()
        result += chunk
    return result
send('ready', str(uuid.uuid4()), {'processCapacity': 1})
while True:
    try:
        length = struct.unpack('>I', read_exact(4))[0]
        message = json.loads(read_exact(length))
    except EOFError: break
    request = message['requestId']
    if message['command'] == 'shutdown':
        send('result', request, {'stopped': True})
        break
    if message['command'] == 'ping':
        send('result', request, {'status': 'ok'})
        continue
    payload = message['payload']
    with (models / 'process-events.jsonl').open('a') as records:
        records.write(json.dumps({'attempt_id': payload['attemptId'], 'request_id': request}) + '\\n')
    os.chmod(models / 'process-events.jsonl', 0o600)
    send('accepted', request, {'accepted': True})
    send('progress', request, {'stage': 'separation'})
    while not (models / 'finish-accepted-attempt').exists(): time.sleep(0.025)
    output = pathlib.Path(payload['attemptDirectory']) / 'output/vocals.mp3'
    output.parent.mkdir(mode=0o700, exist_ok=True)
    data = b'__SYNTHETIC_OUTPUT__'
    output.write_bytes(data)
    os.chmod(output, 0o600)
    recipe = payload['recipe']
    result = {'attemptId': payload['attemptId'], 'outputPath': str(output), 'bytes': len(data), 'sha256': base64.b64encode(hashlib.sha256(data).digest()).decode(), 'contentType': 'audio/mpeg', 'measuredInputDurationSeconds': 1, 'measuredOutputDurationSeconds': 1, 'stageTimings': {'separation': 0.025, 'encode': 0.005}}
    for key in ['recipeId', 'recipeRevision', 'recipeDigest', 'modelDigest', 'trimEnabled', 'denoiseEnabled', 'outputFormat', 'outputBitrateKbps']: result[key] = recipe[key]
    send('result', request, result)
`;

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const arguments_ = process.argv.slice(2);
  const serviceMode =
    arguments_[0] === "--launch-agent"
      ? (arguments_.shift(), "launch-agent")
      : "direct";
  const [serviceRoot, nodePath, pythonPath, evidencePath, ...extra] =
    arguments_;
  if (
    !serviceRoot ||
    extra.length ||
    (evidencePath && !isAbsolute(evidencePath))
  )
    throw new Error(
      "usage: qualify-worker-service [--launch-agent] <service-root> [node] [python] [absolute-evidence-json]",
    );
  const reports = [];
  for (const scenario of serviceMode === "direct"
    ? ["controller-eof", "controller-kill"]
    : ["controller-kill"])
    reports.push(
      await qualifyWorkerBackgroundService({
        serviceRoot: resolve(serviceRoot),
        ...(nodePath ? { nodePath: resolve(nodePath) } : {}),
        ...(pythonPath ? { pythonPath: resolve(pythonPath) } : {}),
        scenario,
        serviceMode,
      }),
    );
  const evidence = { schema_version: 1, reports };
  if (evidencePath)
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  console.log(JSON.stringify(evidence));
}
