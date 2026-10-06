import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  acquireExistingHostUpdateLock,
  fullTimelineAudioEvidence,
  handoverComponentSource,
  ownedTestReservation,
  ownedGroupSignalDecision,
  operatorPendingContract,
  operatorRootIdentityMatches,
  parseOperatorLabelSnapshot,
  parseQualificationArguments,
  physicalOwnership,
  qualificationEnvironment,
  qualificationExitConfirmed,
  qualificationPythonLauncher,
  qualificationRunCancellation,
  qualifyCopiedWorkerMps,
  syntheticWav,
  warmFleetEvidence,
  projectBundledHost,
  resolveOperatorOwnerRoots,
  workerUpdateBlocksQualification,
} from "./qualify-worker-mps.mjs";

const execute = promisify(execFile);
async function privateFixture(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "mm-mps-unit-")));
  await chmod(path, 0o700);
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

const idle = {
  launchctlCode: 0,
  launchctlOutput: "PID\tStatus\tLabel\n-\t0\tcom.example.unrelated\n",
  psCode: 0,
  psOutput: "501 100 1 100 /usr/bin/node\n",
  uid: 501,
  ownPids: [100],
};

test("generated fixture is stereo PCM with exact full timeline and silent edges", () => {
  const wav = syntheticWav(12);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 44_100);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 12 * 44_100 * 4);
  assert.equal(wav.length, 44 + 12 * 44_100 * 4);
  assert(wav.subarray(44, 44 + 44_100 * 4).every((value) => value === 0));
  assert(wav.subarray(-44_100 * 4).every((value) => value === 0));
  assert(
    wav.subarray(44 + 44_100 * 4, -44_100 * 4).some((value) => value !== 0),
  );
  assert.throws(() => syntheticWav(3));
  assert.throws(() => syntheticWav(31));
});

test("bundled component projection preserves exact UTF8 prefix and excludes host bootstrap", () => {
  const prefix =
    '// src/companion/host.ts\nconst arabic="صوت";\nasync function runLocalEngine(){}\nasync function retireLocalEngine(){}\nasync function acquireWorkerAdmission(){}\n';
  const boundary =
    "\n// src/companion/host.ts\nvar startupStarted = performance.now();";
  const original = Buffer.from(
    prefix + boundary + '\nthrow new Error("BOOTSTRAP_MUST_NOT_RUN");',
  );
  const result = projectBundledHost(original);
  assert(
    result.projection
      .subarray(0, Buffer.byteLength(prefix))
      .equals(Buffer.from(prefix)),
  );
  assert(!result.projection.toString().includes("BOOTSTRAP_MUST_NOT_RUN"));
  assert.equal(result.evidence.prefix_bytes, Buffer.byteLength(prefix));
  assert.equal(result.evidence.host_bootstrap_executed, false);
  assert.throws(() => projectBundledHost(prefix));
  assert.throws(() => projectBundledHost(original.toString() + boundary));
  assert.throws(() =>
    projectBundledHost(
      original
        .toString()
        .replace("function retireLocalEngine", "function missingApi"),
    ),
  );
  assert.throws(() =>
    projectBundledHost(prefix + "async function runLocalEngine(){}" + boundary),
  );
});

test("unknown or malformed physical state fails closed", () => {
  for (const values of [
    { launchctlCode: 1 },
    { psCode: 1 },
    { launchctlOutput: "unrecognized output" },
    { psOutput: "" },
    { psOutput: "not a process row" },
  ])
    assert.equal(physicalOwnership({ ...idle, ...values }).safe, false);
});

test("loaded real worker blocks even when launchctl shows no running PID", () => {
  const result = physicalOwnership({
    ...idle,
    launchctlOutput: idle.launchctlOutput + "-\t0\tcom.musicmute.worker\n",
  });
  assert.equal(result.safe, false);
  assert.equal(result.reason, "INSTALLED_WORKER_LOADED");
});

test("possible foreign Python/prepared owners and reservations block inference", () => {
  for (const command of [
    "/usr/bin/python3",
    "/opt/python3.14",
    "/Users/test/Library/Application Support/MusicMuteLocal/runtime/node/bin/node",
  ]) {
    const result = physicalOwnership({
      ...idle,
      psOutput: idle.psOutput + `501 102 1 102 ${command}\n`,
    });
    assert.equal(result.safe, false);
    assert.equal(result.possible_owner_count, 1);
  }
  assert.equal(
    physicalOwnership({ ...idle, personalReservationPresent: true }).safe,
    false,
  );
  assert.equal(
    physicalOwnership({
      ...idle,
      psOutput: idle.psOutput + "502 102 1 102 /usr/bin/python3\n",
    }).safe,
    false,
  );
});

test("only positively owned same-user descendants are excluded from GPU checks", () => {
  const tree =
    idle.psOutput +
    "501 103 101 101 /usr/bin/python3\n501 101 100 101 /usr/bin/node\n";
  const owned = physicalOwnership({ ...idle, psOutput: tree });
  assert.equal(owned.safe, true);
  assert(owned.owned_pids.includes(103));
  assert.deepEqual(owned.owned_groups, [101]);
  assert(
    owned.owned_processes.some(
      (row) => row.pid === 101 && row.role === "guardian",
    ),
  );
  assert(
    owned.owned_processes.some(
      (row) => row.pid === 103 && row.role === "engine" && row.group === 101,
    ),
  );
  assert.equal(
    physicalOwnership({ ...idle, psOutput: tree.replace("103 101", "103 999") })
      .safe,
    false,
  );
  for (const psOutput of [
    tree.replace("501 103", "502 103"),
    "502 100 1 100 /usr/bin/python3\n",
    "502 100 1 100 /Users/another/Library/Application Support/MusicMuteWorker/runtime/node/bin/node\n",
  ]) {
    const foreign = physicalOwnership({ ...idle, psOutput });
    assert.equal(foreign.safe, false);
    assert.equal(foreign.possible_owner_count, 1);
    assert(!foreign.owned_pids.includes(psOutput.includes("103") ? 103 : 100));
  }
});

function warmCohort() {
  const jobs = Array.from({ length: 3 }, (_, index) => ({
    jobId: `job-${index}`,
    attemptId: `attempt-${index}`,
    workerId: "slot-0",
    slotIndex: 0,
    status: "ready",
    recipe: { trimEnabled: false },
    completion: { recipeId: "kim-vocals-v2" },
    upload: {
      etag: `"output-${index}"`,
      sha256: "verified fixture checksum",
      bytes: 123,
    },
  }));
  const events = [
    {
      kind: "model-ready",
      workerId: "slot-0",
      childIncarnation: "same-engine",
      loadReason: "initial-start",
    },
  ];
  for (const job of jobs)
    events.push(
      {
        kind: "attempt-started",
        workerId: job.workerId,
        jobId: job.jobId,
        attemptId: job.attemptId,
        provider: "mps",
        modelLoadState: "preloaded",
        childIncarnation: "same-engine",
      },
      {
        kind: "attempt-succeeded",
        workerId: job.workerId,
        jobId: job.jobId,
        attemptId: job.attemptId,
      },
    );
  return { jobs, events };
}

test("warm fleet proof requires three independent completions on one preloaded child", () => {
  const f = warmCohort();
  const proof = warmFleetEvidence(f.events, f.jobs);
  assert.equal(proof.jobs, 3);
  assert.equal(proof.initial_model_ready_events, 1);
  assert.equal(proof.child_incarnation, "same-engine");
  for (const mutate of [
    ({ events }) => events.push(events[0]),
    ({ events }) => (events[1].childIncarnation = "replacement-engine"),
    ({ events }) => events.pop(),
    ({ events }) => (events[2].attemptId = "wrong-completion"),
    ({ jobs }) => (jobs[1].upload.etag = jobs[0].upload.etag),
    ({ jobs }) => (jobs[1].attemptId = jobs[0].attemptId),
    ({ jobs }) => (jobs[2].status = "failed"),
    ({ jobs }) => (jobs[2].recipe.trimEnabled = true),
  ]) {
    const invalid = warmCohort();
    mutate(invalid);
    assert.throws(() => warmFleetEvidence(invalid.events, invalid.jobs));
  }
});

test("Python and library caches are private test-home paths, never prepared runtime", () => {
  const home = "/private/tmp/owned-test/home",
    runtime = "/private/prepared-runtime";
  const env = qualificationEnvironment(
    home,
    "/private/tmp/owned-test/tmp",
    runtime,
  );
  for (const key of [
    "MPLCONFIGDIR",
    "NUMBA_CACHE_DIR",
    "PYTHONPYCACHEPREFIX",
    "XDG_CACHE_HOME",
  ]) {
    assert(env[key].startsWith(`${home}/cache`));
    assert(!env[key].startsWith(runtime));
  }
  assert.equal(env.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(env.PYTHONNOUSERSITE, "1");
  assert.equal(env.HOME, home);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.throws(() =>
    qualificationEnvironment("relative", "/tmp/owned", runtime),
  );
});

test("closed CLI arguments never approve inference or host coordination by default", () => {
  const paths = [
    "--service-root",
    "/service",
    "--runtime-root",
    "/runtime",
    "--model",
    "/model",
  ];
  assert.deepEqual(parseQualificationArguments(paths), {
    serviceRoot: "/service",
    runtimeRoot: "/runtime",
    modelPath: "/model",
  });
  assert.equal(
    parseQualificationArguments([...paths, "--run-mps"]).runMps,
    true,
  );
  assert.equal(
    parseQualificationArguments([
      ...paths,
      "--app",
      "/candidate.app",
      "--run-mps",
      "--component-handover",
      "--approve-host-coordination",
    ]).hostHandoverApproved,
    true,
  );
  for (const suffix of [
    ["--component-handover"],
    ["--run-mps", "--component-handover", "--app", "/candidate.app"],
    ["--run-mps", "--component-handover", "--approve-host-coordination"],
    ["--approve-host-coordination"],
    ["--run-mps", "--run-mps"],
    ["--unknown"],
    ["--app", "relative"],
    ["--app", "/unsafe\npath"],
    ["--model", "/duplicate"],
  ])
    assert.throws(() => parseQualificationArguments([...paths, ...suffix]));
});

test("qualification launcher exec preserves actual PID, literal arguments and private caches", async (t) => {
  const root = await privateFixture(t);
  const env = qualificationEnvironment(
    join(root, "home's"),
    join(root, "tmp"),
    "/prepared",
  );
  const launcher = join(root, "prepared-python");
  await writeFile(
    launcher,
    qualificationPythonLauncher(process.execPath, env),
    { mode: 0o500, flag: "wx" },
  );
  const literal = "literal 'argument' $(never-execute) `never-execute`";
  const child = spawn(
    launcher,
    [
      "--input-type=module",
      "-e",
      "console.log(JSON.stringify({pid:process.pid,arg:process.argv[1],env:Object.fromEntries(['HOME','TMPDIR','MPLCONFIGDIR','NUMBA_CACHE_DIR','XDG_CACHE_HOME','PYTHONPYCACHEPREFIX','PYTHONDONTWRITEBYTECODE','PYTHONNOUSERSITE'].map(k=>[k,process.env[k]]))}))",
      literal,
    ],
    { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => (stdout += bytes));
  child.stderr.on("data", (bytes) => (stderr += bytes));
  const [code, signal] = await once(child, "close");
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  const result = JSON.parse(stdout);
  assert.equal(result.pid, child.pid);
  assert.equal(result.arg, literal);
  for (const name of Object.keys(result.env))
    assert.equal(result.env[name], env[name]);
  assert.throws(() => qualificationPythonLauncher("relative", env));
  assert.throws(() =>
    qualificationPythonLauncher(process.execPath, {
      ...env,
      NUMBA_CACHE_DIR: "/unsafe\npath",
    }),
  );
});

test("only an exact positively owned personal reservation bypasses the observer fence", () => {
  const saved = {
    request_id: "11111111-1111-4111-8111-111111111111",
    phase: "active",
    client_pid: 201,
    client_identity: "owned-client-start",
  };
  const context = {
    clientPid: 201,
    clientIdentity: "owned-client-start",
    ownedPids: [201, 202],
    engineIdentity: "owned-engine-start",
  };
  assert.equal(ownedTestReservation(saved, { ...saved }, context), true);
  const withEngine = {
    ...saved,
    engine_pid: 202,
    process_identity: context.engineIdentity,
  };
  assert.equal(
    ownedTestReservation(withEngine, { ...withEngine }, context),
    true,
  );
  for (const mutation of [
    { request_id: "22222222-2222-4222-8222-222222222222" },
    { request_id: "not-a-request" },
    { phase: "idle" },
    { client_pid: 999 },
    { client_identity: "reused-pid" },
    { engine_pid: 203 },
    { engine_pid: 201 },
    { engine_pid: 1 },
    { process_identity: "reused-engine-pid" },
  ])
    assert.equal(
      ownedTestReservation({ ...withEngine, ...mutation }, withEngine, context),
      false,
    );
  assert.equal(
    ownedTestReservation(withEngine, withEngine, { ...context, ownedPids: [] }),
    false,
  );
  assert.equal(
    ownedTestReservation(withEngine, withEngine, {
      ...context,
      ownedPids: undefined,
    }),
    false,
  );
  assert.equal(ownedTestReservation(saved, undefined, context), false);
  assert.equal(ownedTestReservation(undefined, saved, context), false);
  assert.equal(
    ownedTestReservation(saved, saved, {
      ...context,
      clientIdentity: undefined,
    }),
    false,
  );
});

test("generated genuine component entry parses and rejects missing approval before any imports", async (t) => {
  const root = await privateFixture(t),
    source = join(root, "entry.mjs"),
    plan = join(root, "plan.json");
  const text = handoverComponentSource();
  await writeFile(source, text, { flag: "wx", mode: 0o400 });
  await execute(process.execPath, ["--check", source]);
  for (const value of [
    {},
    { run_mps: true },
    { host_handover_approved: true },
  ]) {
    await writeFile(plan, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(
      execute(process.execPath, [source, plan]),
      (error) =>
        error.code === 1 &&
        error.stderr.includes("HOST_HANDOVER_APPROVAL_REQUIRED") &&
        !error.stderr.includes("ERR_MODULE_NOT_FOUND"),
    );
  }
  // Verify the generated journal writer emits actual JSON whitespace, rather
  // than literal backslash-n characters that would invalidate progress reads.
  const body = text.slice(
    text.indexOf("async function mark("),
    text.indexOf("let personalResult;"),
  );
  const writer = new Function(
    "trace",
    "performance",
    "writeFile",
    "rename",
    "plan",
    "expectedReservation",
    "begun",
    body + "; return mark;",
  );
  let captured;
  await writer(
    [],
    performance,
    async (_path, bytes) => {
      captured = bytes;
    },
    async () => {},
    { progress: join(root, "progress") },
    { request_id: "test" },
    0,
  )("test");
  assert.equal(JSON.parse(captured).phase, "test");
  assert(captured.endsWith("\n"));
});

test("full-timeline audio evidence rejects wrong codec, channels, duration and nonfinite decoded samples", () => {
  const probe = {
    format: { duration: "12.05" },
    streams: [
      {
        codec_type: "audio",
        codec_name: "mp3",
        sample_rate: "44100",
        channels: 2,
      },
    ],
  };
  const pcm = Buffer.alloc(12 * 44100 * 8);
  const result = fullTimelineAudioEvidence(probe, pcm);
  assert.equal(result.full_timeline, true);
  assert.equal(result.decoded_frames, 12 * 44100);
  for (const mutate of [
    (p) => (p.format.duration = "5"),
    (p) => (p.format.duration = "NaN"),
    (p) => (p.streams[0].codec_name = "aac"),
    (p) => (p.streams[0].sample_rate = "48000"),
    (p) => (p.streams[0].channels = 1),
    (p) => p.streams.push({ ...p.streams[0] }),
  ]) {
    const invalid = structuredClone(probe);
    mutate(invalid);
    assert.throws(() => fullTimelineAudioEvidence(invalid, pcm));
  }
  for (const invalid of [
    Buffer.alloc(0),
    Buffer.alloc(8),
    Buffer.alloc(pcm.length + 1),
  ])
    assert.throws(() => fullTimelineAudioEvidence(probe, invalid));
  const invalid = Buffer.from(pcm);
  invalid.writeFloatLE(NaN, 0);
  assert.throws(() => fullTimelineAudioEvidence(probe, invalid));
});

test(
  "exclusive existing update lease refuses busy and never creates or replaces a permanent lock",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await privateFixture(t),
      support = join(root, "support");
    await mkdir(support, { mode: 0o700 });
    await assert.rejects(
      acquireExistingHostUpdateLock(support),
      /HOST_APP_UPDATE_LOCK_UNAVAILABLE/,
    );
    await assert.rejects(lstat(join(support, "update.lock")), {
      code: "ENOENT",
    });
    const path = join(support, "update.lock");
    await writeFile(path, "untouched-permanent-lock", {
      flag: "wx",
      mode: 0o600,
    });
    const before = await lstat(path),
      first = await acquireExistingHostUpdateLock(support);
    try {
      await assert.rejects(
        acquireExistingHostUpdateLock(support),
        /HOST_APP_UPDATE_LOCK_BUSY/,
      );
    } finally {
      await first.close();
    }
    const next = await acquireExistingHostUpdateLock(support);
    await next.close();
    const after = await lstat(path);
    assert.equal(before.ino, after.ino);
    assert.equal(before.dev, after.dev);
    assert.equal(await readFile(path, "utf8"), "untouched-permanent-lock");
  },
);

test(
  "existing update lease rejects symlink, loose mode, hardlink and noncanonical support",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await privateFixture(t),
      support = join(root, "support"),
      alias = join(root, "alias");
    await mkdir(support, { mode: 0o700 });
    await symlink(support, alias);
    await assert.rejects(
      acquireExistingHostUpdateLock(alias),
      /HOST_APP_SUPPORT_UNSAFE/,
    );
    const path = join(support, "update.lock"),
      target = join(root, "target");
    await writeFile(target, "private", { flag: "wx", mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(
      acquireExistingHostUpdateLock(support),
      /HOST_APP_UPDATE_LOCK_UNSAFE/,
    );
    await rm(path);
    await writeFile(path, "private", { flag: "wx", mode: 0o644 });
    await assert.rejects(
      acquireExistingHostUpdateLock(support),
      /HOST_APP_UPDATE_LOCK_UNSAFE/,
    );
    await chmod(path, 0o600);
    await link(path, join(root, "second-link"));
    await assert.rejects(
      acquireExistingHostUpdateLock(support),
      /HOST_APP_UPDATE_LOCK_UNSAFE/,
    );
  },
);

test("JS qualification API refuses nonboolean flags before any staging or host actions", async () => {
  const paths = {
    serviceRoot: "/not-opened-service",
    runtimeRoot: "/not-opened-runtime",
    modelPath: "/not-opened-model",
  };
  for (const field of [
    "runMps",
    "componentHandover",
    "hostHandoverApproved",
    "operatorAcceptance",
  ])
    for (const value of ["false", 1, null, {}])
      await assert.rejects(
        qualifyCopiedWorkerMps({ ...paths, [field]: value }),
        /QUALIFICATION_FLAGS_MUST_BE_BOOLEAN/,
      );
});

test("component maintenance gate refuses staged, activating, recovery and unknown update state", () => {
  for (const status of ["none", "healthy", "rolled-back"])
    assert.equal(workerUpdateBlocksQualification({ status }), false);
  for (const value of [
    undefined,
    {},
    { status: "staged" },
    { status: "activating" },
    { status: "unknown" },
    { status: "healthy", recovery: {} },
    { status: "healthy", recovery: null },
  ])
    assert.equal(workerUpdateBlocksQualification(value), true);
  const source = handoverComponentSource();
  assert(source.includes("platform/macos/user-updater.js"));
  assert(
    source.includes("loadUpdateState(join(plan.host_state,'update.json'))"),
  );
  assert(
    source.indexOf(
      "assert.equal(await maintenancePending(),false,'HOST_MAINTENANCE_ACTIVE');\n run=runtime.run",
    ) > source.indexOf("try {\n"),
  );
  assert(
    source.includes(
      "host_update_state_metadata_read_attempted:hostUpdateStateRead",
    ),
  );
  assert(!source.includes("host_config_credentials_lifecycle_read:false"));
});

test("process-group signals require a fresh same-user leader start identity and original PGID", () => {
  const expected = {
    group: 9999,
    processGroup: 9999,
    uid: process.getuid?.(),
    startIdentity: "Mon Oct  6 12:00:00 2026",
  };
  assert.equal(
    ownedGroupSignalDecision(expected, { ...expected, groupAlive: true }),
    "SIGNAL_OWNED_GROUP",
  );
  assert.equal(
    ownedGroupSignalDecision(expected, { groupAlive: false }),
    "EXITED",
  );
  for (const changes of [
    { startIdentity: "recycled PID" },
    { uid: expected.uid + 1 },
    { group: 9998 },
    { processGroup: 9998 },
    { startIdentity: undefined },
    { groupAlive: undefined },
  ])
    assert.equal(
      ownedGroupSignalDecision(expected, {
        ...expected,
        groupAlive: true,
        ...changes,
      }),
      "OWNERSHIP_UNCONFIRMED",
    );
  assert.equal(
    ownedGroupSignalDecision(undefined, { ...expected, groupAlive: true }),
    "OWNERSHIP_UNCONFIRMED",
  );
  assert.equal(
    ownedGroupSignalDecision(expected, undefined),
    "OWNERSHIP_UNCONFIRMED",
  );
  assert.equal(
    ownedGroupSignalDecision(
      { ...expected, uid: expected.uid + 1 },
      { ...expected, uid: expected.uid + 1, groupAlive: true },
    ),
    "OWNERSHIP_UNCONFIRMED",
  );
});

test("approved-run signal handlers request cleanup without terminating and stay until explicitly released", () => {
  const emitter = new EventEmitter(),
    cancellation = qualificationRunCancellation(emitter);
  assert.equal(emitter.listenerCount("SIGINT"), 1);
  assert.equal(emitter.listenerCount("SIGTERM"), 1);
  assert.equal(cancellation.signal.aborted, false);
  emitter.emit("SIGINT");
  assert.equal(cancellation.signal.aborted, true);
  assert.throws(
    () => cancellation.signal.throwIfAborted(),
    /MPS_QUALIFICATION_CANCELLED/,
  );
  emitter.emit("SIGTERM");
  assert.equal(emitter.listenerCount("SIGTERM"), 1);
  cancellation.close();
  cancellation.close();
  assert.equal(emitter.listenerCount("SIGINT"), 0);
  assert.equal(emitter.listenerCount("SIGTERM"), 0);
});

test("lease release needs fresh ownership and positive child/PID/group exits, never stale samples alone", () => {
  const gone = {
    ownershipConfirmed: true,
    childrenExited: true,
    pidsExited: true,
    groupsExited: true,
  };
  assert.equal(qualificationExitConfirmed(gone), true);
  for (const field of Object.keys(gone))
    for (const value of [false, undefined, "true", 1, null])
      assert.equal(
        qualificationExitConfirmed({ ...gone, [field]: value }),
        false,
      );
  assert.equal(qualificationExitConfirmed(undefined), false);
  assert.equal(
    qualificationExitConfirmed({ ...gone, ownershipConfirmed: false }),
    false,
  );
});

function operatorContract() {
  const root = "/private/operator-test";
  return {
    phase: "pending-label",
    label: "com.musicmute.qualification.11111111-1111-4111-8111-111111111111",
    uid: process.getuid(),
    plistPath: root + "/qualification.plist",
    expectedExecutable: root + "/python/bin/python3.13",
    reportPath: root + "/home/state/qualification.json",
    releaseRoot: root + "/home/release",
  };
}

test("operator flag needs explicit run, host approval and app; ordinary preflight remains disabled", () => {
  const paths = [
    "--service-root",
    "/service",
    "--runtime-root",
    "/runtime",
    "--model",
    "/model",
  ];
  for (const suffix of [
    ["--operator-acceptance"],
    ["--operator-acceptance", "--run-mps", "--app", "/app.app"],
    [
      "--operator-acceptance",
      "--approve-host-coordination",
      "--app",
      "/app.app",
    ],
    ["--operator-acceptance", "--run-mps", "--approve-host-coordination"],
  ])
    assert.throws(
      () => parseQualificationArguments([...paths, ...suffix]),
      /HOST_HANDOVER_APPROVAL_REQUIRED/,
    );
  const valid = parseQualificationArguments([
    ...paths,
    "--operator-acceptance",
    "--run-mps",
    "--approve-host-coordination",
    "--app",
    "/app.app",
  ]);
  assert.equal(valid.operatorAcceptance, true);
  assert.equal(valid.componentHandover, undefined);
  assert.equal(
    parseQualificationArguments(paths).operatorAcceptance,
    undefined,
  );
});

test("pending operator label contracts are closed, exact UUID labels with only private canonical paths", () => {
  const c = operatorContract();
  assert.deepEqual(
    operatorPendingContract(c, "/private/operator-test", process.getuid()),
    c,
  );
  for (const changes of [
    { label: "com.musicmute.worker" },
    { label: "com.musicmute.qualification.anything" },
    { uid: c.uid + 1 },
    { plistPath: "/outside/other.plist" },
    { expectedExecutable: "/private/operator-test/../outside/python" },
    { reportPath: "/private/operator-test/report\n.json" },
    { phase: "confirmed" },
    { unexpected: true },
  ])
    assert.throws(() =>
      operatorPendingContract(
        { ...c, ...changes },
        "/private/operator-test",
        process.getuid(),
      ),
    );
});

test("exact label snapshots refuse canonical target, wrong plist, multiple PIDs and unknown query status", () => {
  const c = operatorContract(),
    text = `gui/${c.uid}/${c.label} = {\n path = ${c.plistPath}\n pid = 123\n}`;
  assert.deepEqual(parseOperatorLabelSnapshot(text, 0, c), {
    loaded: true,
    pid: 123,
  });
  for (const code of [3, 113])
    assert.deepEqual(parseOperatorLabelSnapshot("", code, c), {
      loaded: false,
    });
  for (const [s, code, contract] of [
    [text, 1, c],
    [text.replace(c.plistPath, "/foreign.plist"), 0, c],
    [text + "\npid = 456\n", 0, c],
    [text.replace(c.label, "com.musicmute.worker"), 0, c],
    [text, 0, { ...c, label: "com.musicmute.worker" }],
  ])
    assert.throws(() => parseOperatorLabelSnapshot(s, code, contract));
});

test("operator roots require independent UID/start/PGID/parent/executable identity", () => {
  const record = {
    uid: process.getuid(),
    pid: 123,
    parent: 1,
    group: 123,
    start: "Mon Oct  6 12:00:00 2026",
    command: "/private/operator-test/python/bin/python3.13",
  };
  assert.equal(
    operatorRootIdentityMatches(record, { ...record }, record.uid),
    true,
  );
  for (const changes of [
    { uid: record.uid + 1 },
    { start: "recycled PID" },
    { group: 999 },
    { parent: 999 },
    { command: "/foreign/python3.13" },
    { command: "python3.13" },
    { pid: 124 },
  ])
    assert.equal(
      operatorRootIdentityMatches(
        record,
        { ...record, ...changes },
        record.uid,
      ),
      false,
    );
  assert.equal(
    operatorRootIdentityMatches(record, undefined, record.uid),
    false,
  );
});

test("pending labels never exclude a PID without fresh exact-label and prepared-Python proof", async () => {
  const c = operatorContract(),
    registry = { labels: new Map([[c.label, c]]), roots: new Map() };
  let calls = 0;
  const actual = {
    uid: c.uid,
    pid: 123,
    parent: 1,
    group: 123,
    start: "Mon Oct  6 12:00:00 2026",
    command: c.expectedExecutable,
  };
  const io = {
    queryLabel: async () => ({ loaded: false }),
    queryProcess: async () => {
      calls++;
      return actual;
    },
  };
  assert.deepEqual(await resolveOperatorOwnerRoots(registry, io, c.uid), []);
  assert.equal(calls, 0);
  io.queryLabel = async () => ({ loaded: true, pid: 123 });
  const confirmed = await resolveOperatorOwnerRoots(registry, io, c.uid);
  assert.equal(confirmed[0].pid, 123);
  assert.equal(confirmed[0].label, c.label);
  for (const bad of [
    undefined,
    { ...actual, uid: c.uid + 1 },
    { ...actual, command: "/usr/libexec/xpcproxy" },
    { ...actual, command: "/foreign/python3.13" },
    { ...actual, pid: 456 },
    { ...actual, parent: 0 },
    { ...actual, start: "x" },
  ]) {
    io.queryProcess = async () => bad;
    await assert.rejects(
      resolveOperatorOwnerRoots(registry, io, c.uid),
      /OPERATOR_ROOT_UNCONFIRMED/,
    );
  }
  io.queryLabel = async () => ({ loaded: true });
  await assert.rejects(
    resolveOperatorOwnerRoots(registry, io, c.uid),
    /OPERATOR_ROOT_UNCONFIRMED/,
  );
});

test("registered runner exclusions disappear after exit and reject recycled identities", async () => {
  const root = {
    phase: "confirmed",
    role: "operator-runner",
    uid: process.getuid(),
    pid: 124,
    parent: 123,
    group: 124,
    start: "Mon Oct  6 12:00:00 2026",
    command: "/prepared/node/bin/node",
  };
  const registry = { labels: new Map(), roots: new Map([[root.pid, root]]) };
  const io = { queryProcess: async () => ({ ...root }) };
  assert.equal(
    (await resolveOperatorOwnerRoots(registry, io, root.uid))[0].pid,
    root.pid,
  );
  io.queryProcess = async () => undefined;
  assert.deepEqual(await resolveOperatorOwnerRoots(registry, io, root.uid), []);
  io.queryProcess = async () => ({ ...root, start: "recycled PID" });
  await assert.rejects(
    resolveOperatorOwnerRoots(registry, io, root.uid),
    /OPERATOR_ROOT_UNCONFIRMED/,
  );
});

test("label removal does not drop a positively registered live qualification incarnation", async () => {
  const c = operatorContract(),
    root = {
      phase: "confirmed",
      role: "qualification",
      label: c.label,
      uid: c.uid,
      pid: 125,
      parent: 1,
      group: 125,
      start: "Mon Oct  6 12:00:00 2026",
      command: c.expectedExecutable,
    };
  const registry = {
    labels: new Map([[c.label, c]]),
    roots: new Map([[root.pid, root]]),
  };
  const io = {
    queryLabel: async () => ({ loaded: false }),
    queryProcess: async () => ({ ...root }),
  };
  assert.equal(
    (await resolveOperatorOwnerRoots(registry, io, c.uid))[0].pid,
    root.pid,
  );
  io.queryProcess = async () => undefined;
  assert.deepEqual(await resolveOperatorOwnerRoots(registry, io, c.uid), []);
  io.queryProcess = async () => ({ ...root, start: "recycled identity" });
  await assert.rejects(
    resolveOperatorOwnerRoots(registry, io, c.uid),
    /OPERATOR_ROOT_UNCONFIRMED/,
  );
});
