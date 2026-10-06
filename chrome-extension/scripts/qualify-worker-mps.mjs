// Copied production worker + generated audio + loopback backend. Never changes installed services.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createAcceptanceFixture } from "../../worker/scripts/service-acceptance-fixture.mjs";
import {
  verifyCompressedWorkerService,
  verifyWorkerService,
} from "./worker-service-artifact.mjs";

const execute = promisify(execFile);
const MODEL_SHA256 =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
const MODEL_BYTES = 66_759_214;
const INPUT_SECONDS = 12;
const RATE = 44_100;
const TIMEOUT_MS = 15 * 60_000;
const LIMIT = 2 * 1024 * 1024;
const repository = resolve(import.meta.dirname, "..");
const OPERATOR_LABEL =
  /^com\.musicmute\.qualification\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function syntheticWav(seconds = INPUT_SECONDS) {
  assert(Number.isSafeInteger(seconds) && seconds >= 4 && seconds <= 30);
  const frames = RATE * seconds;
  const bytes = Buffer.alloc(44 + frames * 4);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(RATE, 24);
  bytes.writeUInt32LE(RATE * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 4, 40);
  for (let index = RATE; index < frames - RATE; index++) {
    for (let channel = 0; channel < 2; channel++) {
      const phase = (2 * Math.PI * (channel ? 660 : 440) * index) / RATE;
      bytes.writeInt16LE(
        Math.round(Math.sin(phase) * 6000),
        44 + index * 4 + channel * 2,
      );
    }
  }
  return bytes;
}

/** Parse command names only. Unknown state is never permission to start MPS. */
export function physicalOwnership({
  launchctlCode,
  launchctlOutput,
  psCode,
  psOutput,
  uid,
  ownPids = [],
  personalReservationPresent = false,
}) {
  const roots = new Set(ownPids);
  if (
    launchctlCode !== 0 ||
    psCode !== 0 ||
    !/^PID\s+Status\s+Label/mu.test(launchctlOutput) ||
    !psOutput.trim()
  )
    return { safe: false, reason: "GPU_OWNER_QUERY_UNAVAILABLE" };
  const workerLoaded = launchctlOutput
    .split("\n")
    .some((line) => /(?:^|\s)com\.musicmute\.worker\s*$/u.test(line));
  const records = [];
  for (const line of psOutput.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) return { safe: false, reason: "GPU_OWNER_QUERY_UNAVAILABLE" };
    records.push({
      uid: Number(match[1]),
      pid: Number(match[2]),
      parent: Number(match[3]),
      group: Number(match[4]),
      command: match[5].trim().toLowerCase(),
    });
  }
  const ignored = new Set(
    records
      .filter((row) => row.uid === uid && roots.has(row.pid))
      .map((row) => row.pid),
  );
  for (let added = true; added;) {
    added = false;
    for (const row of records) {
      if (row.uid === uid && ignored.has(row.parent) && !ignored.has(row.pid)) {
        ignored.add(row.pid);
        added = true;
      }
    }
  }
  let possibleOwnerCount = 0;
  for (const row of records) {
    if (row.uid === uid && ignored.has(row.pid)) continue;
    const command = row.command;
    if (
      /\/musicmutelocal\/|\/musicmuteworker\//u.test(command) ||
      /^python(?:\d+(?:\.\d+)*)?$/u.test(basename(command))
    )
      possibleOwnerCount++;
  }
  return {
    safe:
      !workerLoaded && possibleOwnerCount === 0 && !personalReservationPresent,
    reason: workerLoaded
      ? "INSTALLED_WORKER_LOADED"
      : personalReservationPresent
        ? "PERSONAL_RESERVATION_PRESENT"
        : possibleOwnerCount
          ? "GPU_OWNER_PROCESS_PRESENT"
          : "NO_OBSERVED_OWNER",
    worker_loaded: workerLoaded,
    possible_owner_count: possibleOwnerCount,
    personal_reservation_present: personalReservationPresent,
    owned_pids: [...ignored],
    owned_groups: records
      .filter(
        (row) =>
          row.uid === uid &&
          ignored.has(row.pid) &&
          !roots.has(row.pid) &&
          row.group === row.pid &&
          row.group > 1,
      )
      .map((row) => row.group),
    owned_processes: records
      .filter((row) => row.uid === uid && ignored.has(row.pid))
      .map(({ uid: ownerUid, pid, parent, group, command }) => ({
        uid: ownerUid,
        pid,
        parent,
        group,
        role: /^python(?:\d+(?:\.\d+)*)?$/u.test(basename(command))
          ? "engine"
          : group === pid && !roots.has(pid)
            ? "guardian"
            : "helper",
      })),
  };
}

export function qualificationEnvironment(home, temporary, runtimeRoot) {
  for (const path of [home, temporary, runtimeRoot])
    assert(isAbsolute(path), "ABSOLUTE_ENVIRONMENT_PATH_REQUIRED");
  const cache = join(home, "cache");
  return {
    HOME: home,
    TMPDIR: temporary,
    PATH: `${join(runtimeRoot, "bin")}:${join(runtimeRoot, "node/bin")}:/usr/bin:/bin`,
    LANG: "C",
    LC_ALL: "C",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONPYCACHEPREFIX: join(cache, "python"),
    MPLCONFIGDIR: join(cache, "matplotlib"),
    NUMBA_CACHE_DIR: join(cache, "numba"),
    XDG_CACHE_HOME: cache,
    MUSICMUTE_SENTRY_ENABLED: "false",
  };
}

export function warmFleetEvidence(events, jobs) {
  assert(
    Array.isArray(events) && Array.isArray(jobs) && jobs.length === 3,
    "WARM_COHORT_INVALID",
  );
  assert(
    jobs.every(
      (job) =>
        job.status === "ready" &&
        job.slotIndex === 0 &&
        job.recipe.trimEnabled === false &&
        job.completion?.recipeId === "kim-vocals-v2",
    ),
    "WARM_JOB_INVALID",
  );
  assert.equal(
    new Set(jobs.map((job) => job.attemptId)).size,
    3,
    "WARM_ATTEMPTS_NOT_INDEPENDENT",
  );
  assert.equal(
    new Set(jobs.map((job) => job.jobId)).size,
    3,
    "WARM_JOBS_NOT_INDEPENDENT",
  );
  assert.equal(
    new Set(jobs.map((job) => job.upload?.etag)).size,
    3,
    "WARM_OUTPUTS_NOT_INDEPENDENT",
  );
  assert(
    jobs.every(
      (job) =>
        typeof job.upload?.etag === "string" &&
        typeof job.upload?.sha256 === "string" &&
        job.upload.bytes > 0,
    ),
    "WARM_OUTPUT_INVALID",
  );
  assert.equal(
    new Set(jobs.map((job) => job.workerId)).size,
    1,
    "WARM_SLOT_CHANGED",
  );
  const ready = events.filter((event) => event.kind === "model-ready");
  const started = events.filter((event) => event.kind === "attempt-started");
  const succeeded = events.filter(
    (event) => event.kind === "attempt-succeeded",
  );
  assert.equal(ready.length, 1, "MODEL_RELOADED_DURING_WARM_COHORT");
  assert.equal(
    ready[0].loadReason,
    "initial-start",
    "WARM_MODEL_READY_REASON_INVALID",
  );
  assert.equal(started.length, 3, "WARM_STARTED_COUNT_INVALID");
  assert.equal(succeeded.length, 3, "WARM_COMPLETION_COUNT_INVALID");
  assert(
    started.every(
      (event) =>
        event.provider === "mps" &&
        event.modelLoadState === "preloaded" &&
        event.childIncarnation === ready[0].childIncarnation &&
        event.workerId === ready[0].workerId,
    ),
    "WARM_CHILD_IDENTITY_CHANGED",
  );
  for (const job of jobs) {
    assert(
      started.some(
        (event) =>
          event.jobId === job.jobId && event.attemptId === job.attemptId,
      ),
      "WARM_START_IDENTITY_INVALID",
    );
    assert(
      succeeded.some(
        (event) =>
          event.jobId === job.jobId && event.attemptId === job.attemptId,
      ),
      "WARM_COMPLETION_IDENTITY_INVALID",
    );
  }
  assert.equal(
    new Set(started.map((event) => event.childIncarnation)).size,
    1,
    "WARM_CHILD_IDENTITY_CHANGED",
  );
  return {
    jobs: 3,
    slots: 1,
    initial_model_ready_events: 1,
    child_incarnation: ready[0].childIncarnation,
    worker_id: ready[0].workerId,
    independent_outputs_and_completions: true,
  };
}

export function projectBundledHost(original) {
  const bytes = Buffer.isBuffer(original) ? original : Buffer.from(original);
  const boundary = Buffer.from(
    "\n// src/companion/host.ts\nvar startupStarted = performance.now();",
  );
  const offset = bytes.indexOf(boundary);
  assert(
    offset > 0 && bytes.indexOf(boundary, offset + 1) === -1,
    "HOST_COMPONENT_BOUNDARY_INVALID",
  );
  const prefix = bytes.subarray(0, offset);
  const names = [
    "runLocalEngine",
    "retireLocalEngine",
    "acquireWorkerAdmission",
  ];
  for (const name of names)
    assert.equal(
      [
        ...prefix
          .toString("utf8")
          .matchAll(new RegExp(`(?:async )?function ${name}\\(`, "gu")),
      ].length,
      1,
      "HOST_COMPONENT_API_UNAVAILABLE",
    );
  const projection = Buffer.concat([
    prefix,
    Buffer.from(`\nexport { ${names.join(", ")} };\n`),
  ]);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  return {
    projection,
    evidence: {
      scope: "EXACT_BUNDLED_BYTE_PREFIX_COMPONENT_ENTRY_PROJECTION",
      original_sha256: digest(bytes),
      prefix_sha256: digest(prefix),
      projection_sha256: digest(projection),
      prefix_bytes: prefix.length,
      original_bytes: bytes.length,
      appended_exports: names,
      host_bootstrap_executed: false,
    },
  };
}

export function qualificationPythonLauncher(python, env) {
  const names = [
    "HOME",
    "TMPDIR",
    "MPLCONFIGDIR",
    "NUMBA_CACHE_DIR",
    "XDG_CACHE_HOME",
    "PYTHONPYCACHEPREFIX",
  ];
  const quote = (value) => {
    assert(
      typeof value === "string" &&
        isAbsolute(value) &&
        !Array.from(value).some(
          (char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127,
        ),
      "LAUNCHER_PATH_UNSAFE",
    );
    return `'${value.replaceAll("'", "'\\''")}'`;
  };
  const lines = names.map((name) => `export ${name}=${quote(env[name])}`);
  return `#!/bin/sh\n${lines.join("\n")}\nexport PYTHONDONTWRITEBYTECODE=1\nexport PYTHONNOUSERSITE=1\nexec ${quote(python)} "$@"\n`;
}

export function parseQualificationArguments(args) {
  const fields = {
    "--service-root": "serviceRoot",
    "--runtime-root": "runtimeRoot",
    "--model": "modelPath",
    "--app": "appPath",
  };
  const flags = {
    "--run-mps": "runMps",
    "--component-handover": "componentHandover",
    "--approve-host-coordination": "hostHandoverApproved",
    "--operator-acceptance": "operatorAcceptance",
  };
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index],
      name = fields[key] ?? flags[key];
    assert(
      name && values[name] === undefined,
      "INVALID_QUALIFICATION_ARGUMENTS",
    );
    if (flags[key]) values[name] = true;
    else {
      const value = args[++index];
      assert(
        typeof value === "string" &&
          isAbsolute(value) &&
          !value.startsWith("--") &&
          value.length <= 4096 &&
          !Array.from(value).some(
            (char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127,
          ),
        "ABSOLUTE_PATH_REQUIRED",
      );
      values[name] = value;
    }
  }
  assert(
    values.serviceRoot && values.runtimeRoot && values.modelPath,
    "QUALIFICATION_PATHS_REQUIRED",
  );
  assert(
    !(values.componentHandover || values.operatorAcceptance) ||
      (values.runMps && values.hostHandoverApproved && values.appPath),
    "HOST_HANDOVER_APPROVAL_REQUIRED",
  );
  assert(
    !values.hostHandoverApproved ||
      values.componentHandover ||
      values.operatorAcceptance,
    "INVALID_QUALIFICATION_ARGUMENTS",
  );
  return values;
}

export function workerUpdateBlocksQualification(update) {
  return (
    !update ||
    !["none", "healthy", "rolled-back"].includes(update.status) ||
    update.recovery !== undefined
  );
}

export function qualificationRunCancellation(emitter = process) {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(new Error("MPS_QUALIFICATION_CANCELLED"));
  emitter.on("SIGINT", cancel);
  emitter.on("SIGTERM", cancel);
  return {
    signal: controller.signal,
    cancel,
    close() {
      emitter.removeListener("SIGINT", cancel);
      emitter.removeListener("SIGTERM", cancel);
    },
  };
}

export function operatorRootIdentityMatches(expected, actual, uid) {
  return (
    !!expected &&
    !!actual &&
    Number.isSafeInteger(actual.pid) &&
    actual.pid > 1 &&
    Number.isSafeInteger(actual.group) &&
    actual.group > 1 &&
    Number.isSafeInteger(actual.uid) &&
    actual.uid > 0 &&
    Number.isSafeInteger(actual.parent) &&
    actual.parent > 0 &&
    actual.uid === uid &&
    expected.uid === uid &&
    ["pid", "parent", "group", "start", "command"].every(
      (key) => expected[key] === actual[key],
    ) &&
    typeof actual.start === "string" &&
    actual.start.length >= 10 &&
    typeof actual.command === "string" &&
    isAbsolute(actual.command)
  );
}

export function operatorPendingContract(record, outputRoot, uid) {
  const keys = [
    "phase",
    "label",
    "uid",
    "plistPath",
    "expectedExecutable",
    "reportPath",
    "releaseRoot",
  ];
  assert(
    record &&
      Object.keys(record).length === keys.length &&
      keys.every((key) => Object.hasOwn(record, key)) &&
      record.phase === "pending-label" &&
      record.uid === uid &&
      Number.isSafeInteger(uid) &&
      uid > 0 &&
      OPERATOR_LABEL.test(record.label),
    "OPERATOR_PENDING_CONTRACT_INVALID",
  );
  assert(
    isAbsolute(outputRoot) &&
      resolve(outputRoot) === outputRoot &&
      outputRoot !== "/",
    "OPERATOR_OUTPUT_ROOT_INVALID",
  );
  for (const key of keys.slice(3))
    assert(
      typeof record[key] === "string" &&
        isAbsolute(record[key]) &&
        resolve(record[key]) === record[key] &&
        record[key].startsWith(outputRoot + "/") &&
        !Array.from(record[key]).some(
          (char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127,
        ),
      "OPERATOR_PENDING_PATH_INVALID",
    );
  return { ...record };
}

export function parseOperatorLabelSnapshot(stdout, code, contract) {
  assert(
    contract?.uid === process.getuid() && OPERATOR_LABEL.test(contract.label),
    "OPERATOR_LABEL_INVALID",
  );
  if ([3, 113].includes(code)) return { loaded: false };
  assert(
    code === 0 &&
      stdout
        .trimStart()
        .startsWith(`gui/${contract.uid}/${contract.label} = {`),
    "OPERATOR_LABEL_QUERY_UNCONFIRMED",
  );
  const paths = [...stdout.matchAll(/^\s*path = (.+)\s*$/gmu)].map((match) =>
    match[1].trim(),
  );
  assert(
    paths.length === 1 && paths[0] === contract.plistPath,
    "OPERATOR_LABEL_PATH_CHANGED",
  );
  const pids = [...stdout.matchAll(/^\s*pid = (\d+)\s*$/gmu)].map((match) =>
    Number(match[1]),
  );
  assert(
    pids.length <= 1 &&
      (pids.length === 0 || (Number.isSafeInteger(pids[0]) && pids[0] > 1)),
    "OPERATOR_LABEL_PID_UNCONFIRMED",
  );
  return { loaded: true, ...(pids.length ? { pid: pids[0] } : {}) };
}

export async function resolveOperatorOwnerRoots(registry, io, uid) {
  const current = new Map();
  for (const contract of registry.labels.values()) {
    const status = await io.queryLabel(contract);
    if (!status.loaded) continue;
    assert(
      Number.isSafeInteger(status.pid) && status.pid > 1,
      "OPERATOR_ROOT_UNCONFIRMED",
    );
    const actual = await io.queryProcess(status.pid);
    assert(
      actual?.uid === uid &&
        actual.pid === status.pid &&
        Number.isSafeInteger(actual.parent) &&
        actual.parent > 0 &&
        actual.command === contract.expectedExecutable &&
        Number.isSafeInteger(actual.group) &&
        actual.group > 1 &&
        typeof actual.start === "string" &&
        actual.start.length >= 10,
      "OPERATOR_ROOT_UNCONFIRMED",
    );
    current.set(actual.pid, {
      ...actual,
      phase: "confirmed",
      role: "qualification",
      label: contract.label,
    });
  }
  for (const record of registry.roots.values()) {
    if (current.has(record.pid)) continue;
    const actual = await io.queryProcess(record.pid);
    if (!actual) continue;
    assert(
      operatorRootIdentityMatches(record, actual, uid),
      "OPERATOR_ROOT_UNCONFIRMED",
    );
    current.set(actual.pid, {
      ...actual,
      phase: "confirmed",
      role: record.role,
      ...(record.label ? { label: record.label } : {}),
    });
  }
  return [...current.values()];
}

async function readOperatorProcess(pid) {
  if (!alive(pid)) return undefined;
  try {
    const { stdout } = await command("/bin/ps", [
      "-ww",
      "-p",
      String(pid),
      "-o",
      "uid=,pid=,ppid=,pgid=,lstart=,comm=",
    ]);
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u.exec(
        stdout,
      );
    assert(
      match && Number(match[2]) === pid,
      "OPERATOR_PROCESS_IDENTITY_UNCONFIRMED",
    );
    return {
      uid: Number(match[1]),
      pid,
      parent: Number(match[3]),
      group: Number(match[4]),
      start: match[5],
      command: match[6],
    };
  } catch {
    if (!alive(pid)) return undefined;
    throw new Error("OPERATOR_PROCESS_IDENTITY_UNCONFIRMED");
  }
}

async function readOperatorLabel(contract) {
  let stdout = "",
    code = 0;
  try {
    ({ stdout } = await execute(
      "/bin/launchctl",
      ["print", `gui/${contract.uid}/${contract.label}`],
      {
        timeout: 5000,
        maxBuffer: 128 * 1024,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      },
    ));
  } catch (error) {
    code = error.code;
  }
  return parseOperatorLabelSnapshot(stdout, code, contract);
}

export function ownedGroupSignalDecision(expected, current) {
  if (current?.groupAlive === false) return "EXITED";
  if (
    current?.groupAlive !== true ||
    !expected ||
    !Number.isSafeInteger(expected.group) ||
    expected.group <= 1 ||
    !Number.isSafeInteger(expected.uid) ||
    expected.uid < 0 ||
    expected.uid !== process.getuid?.() ||
    expected.uid !== current.uid ||
    expected.group !== current.group ||
    expected.processGroup !== expected.group ||
    current.processGroup !== expected.group ||
    typeof expected.startIdentity !== "string" ||
    !expected.startIdentity ||
    expected.startIdentity !== current.startIdentity
  )
    return "OWNERSHIP_UNCONFIRMED";
  return "SIGNAL_OWNED_GROUP";
}

export function qualificationExitConfirmed(state) {
  return [
    state?.ownershipConfirmed,
    state?.childrenExited,
    state?.pidsExited,
    state?.groupsExited,
  ].every((value) => value === true);
}

async function processStartIdentity(pid) {
  assert(Number.isSafeInteger(pid) && pid > 1, "OWNED_PROCESS_ID_INVALID");
  if (!alive(pid)) return undefined;
  try {
    const { stdout } = await command("/bin/ps", [
      "-p",
      String(pid),
      "-o",
      "uid=",
      "-o",
      "pgid=",
      "-o",
      "lstart=",
    ]);
    const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+(.{10,100})$/u);
    assert(match, "OWNED_PROCESS_IDENTITY_UNCONFIRMED");
    return {
      uid: Number(match[1]),
      processGroup: Number(match[2]),
      startIdentity: match[3],
    };
  } catch {
    if (!alive(pid)) return undefined;
    throw new Error("OWNED_PROCESS_IDENTITY_UNCONFIRMED");
  }
}

export function handoverComponentSource() {
  return `
import assert from 'node:assert/strict';
import { readFile, writeFile, lstat, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
assert(plan.run_mps === true && plan.host_handover_approved === true, 'HOST_HANDOVER_APPROVAL_REQUIRED');
const load = async path => import(pathToFileURL(path).href);
const base = join(plan.app, 'dist/src');
const { WorkerRuntime } = await load(join(base,'runtime/worker-runtime.js'));
const { MachineSupervisor } = await load(join(base,'agent/machine-supervisor.js'));
const { WorkerControlPlaneClient } = await load(join(base,'runtime/control-plane-client.js'));
const { IsolatedWorkerTransferClient } = await load(join(base,'runtime/isolated-transfers.js'));
const { MacPersonalAdmission } = await load(join(base,'runtime/personal-admission.js'));
const { loadUpdateState } = await load(join(base,'platform/macos/user-updater.js'));
const { loadPersonalReservation } = await load(join(base,'runtime/personal-reservation.js'));
const { runLocalEngine, retireLocalEngine, acquireWorkerAdmission } = await load(plan.projection);
const { createAcceptanceFixture } = await load(plan.backend_fixture);
const input = await readFile(plan.input);
const events = [], trace = [];
let expectedReservation, hostUpdateStateRead=false;
const stopping = new AbortController();
process.once('SIGTERM', () => stopping.abort());
process.once('SIGINT', () => stopping.abort());
const begun = performance.now();
let enabled = false, failed, lease, personalPid, outcome, primaryFailure;
const fixture = createAcceptanceFixture({config:{machineId:plan.machine_id},credential:plan.credential,input,recipes:plan.recipes,outputPath:plan.output_prefix,jobsPerSlot:3,claimsEnabled:()=>enabled});
await new Promise(done => fixture.server.listen(0,'127.0.0.1',done));
const slot={workerId:plan.worker_id,gpuId:'gpu0',slotIndex:0,recipeIds:['kim-vocals-v2'],provider:'mps'};
const supervisor=new MachineSupervisor([{...slot,child:{command:plan.python,args:['-m','musicmute_engine.child','--model-cache-root',plan.models,'--provider','mps'],cwd:plan.engine,env:{MUSICMUTE_PROVIDER:'mps'},trustedExecutableDirectory:dirname(plan.ffmpeg),requestTimeoutMs:plan.timeout_ms}}],1);
const admission=new MacPersonalAdmission(plan.host_state);
const updateBlocksQualification=${workerUpdateBlocksQualification.toString()};
const maintenancePending=async()=>{for(const name of ['app-maintenance.json','app-preparation.json']){try{await lstat(join(plan.host_state,name));return true;}catch(error){if(error.code!=='ENOENT')throw error;}}hostUpdateStateRead=true;return updateBlocksQualification(await loadUpdateState(join(plan.host_state,'update.json')));};
const runtime=new WorkerRuntime({machineId:plan.machine_id,slots:[slot],validatedMaxWorkersPerGpu:1,workRoot:plan.work,modelCacheRoot:plan.models,ffmpegPath:plan.ffmpeg,ffprobePath:plan.ffprobe,localRuntimeStatusPath:plan.status,personalAdmission:admission,deferPreloadForMaintenance:true,maintenancePending,idlePollMinimumMs:100,idlePollMaximumMs:100,onEvent:event=>{events.push(event);}},new WorkerControlPlaneClient({baseUrl:'http://127.0.0.1:'+fixture.server.address().port,credential:plan.credential,allowInsecureLoopback:true}),new IsolatedWorkerTransferClient({workRoot:plan.work,allowInsecureLoopback:true}),supervisor);
let run=Promise.resolve();
const jobs=()=>fixture.snapshot().jobs.filter(job=>job.slotIndex===0);
async function until(check) { for (;;) { if(failed) throw failed; if(stopping.signal.aborted) throw new Error('HANDOVER_CANCELLED'); if(performance.now()-begun>plan.timeout_ms) throw new Error('HANDOVER_TIMEOUT'); assert.equal(await maintenancePending(),false,'HOST_MAINTENANCE_ACTIVE'); if(await check()) return; await delay(25); } }
async function mark(phase,extra={}) { trace.push({phase,since_start_ms:performance.now()-begun,...extra}); await writeFile(plan.progress+'.tmp',JSON.stringify({phase,trace,expected_reservation:expectedReservation})+'\\n',{mode:0o600}); await rename(plan.progress+'.tmp',plan.progress); }
let personalResult;
function alive(pid,group=false){try{process.kill(group?-pid:pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
try {
 assert.equal(await maintenancePending(),false,'HOST_MAINTENANCE_ACTIVE');
 run=runtime.run(stopping.signal).catch(error=>{failed=error;});
 await until(()=>events.some(event=>event.kind==='started'));
 await mark('fleet-ready');
 enabled=true; runtime.hintAvailableWork();
 await until(()=>jobs()[0].status==='running' && events.some(event=>event.kind==='attempt-started'));
 const firstChild=supervisor.child(plan.worker_id), firstIncarnation=firstChild.incarnation;
 await mark('personal-request-during-accepted-fleet-job',{first_job_status:jobs()[0].status});
 lease=await acquireWorkerAdmission({signal:stopping.signal,workerRoot:plan.host_worker_root,timeoutMs:plan.timeout_ms,onWaiting:()=>trace.push({phase:'personal-waiting',since_start_ms:performance.now()-begun})});
 assert.equal(jobs()[0].status,'ready','ACCEPTED_FLEET_JOB_INTERRUPTED');
 assert.equal(firstChild.isAlive(),false,'FLEET_CHILD_NOT_EXITED_BEFORE_PERSONAL');
 assert.equal(jobs().filter(job=>job.status==='ready').length,1,'FLEET_CLAIM_NOT_FENCED');
 expectedReservation=await loadPersonalReservation(plan.host_state);
 assert.equal(expectedReservation?.client_pid,process.pid,'HOST_RESERVATION_CLIENT_INVALID');
 await mark('personal-granted-after-fleet-exit',{first_child_incarnation:firstIncarnation});
 const personal=plan.personal_config;
 assert.equal(await maintenancePending(),false,'HOST_MAINTENANCE_ACTIVE');
 personalResult=await runLocalEngine(personal,plan.personal_input,plan.personal_work,plan.input_base64,{signal:AbortSignal.any([stopping.signal,lease.signal]),onEvent:event=>trace.push({phase:'personal-engine-event',stage:event.stage}),onSpawn:pid=>{personalPid=pid;},beforeProcess:async(pid,endpoint)=>{assert.equal(await maintenancePending(),false,'HOST_MAINTENANCE_ACTIVE');assert.equal(pid,personalPid);assert(alive(pid,true),'PERSONAL_PRIVATE_GROUP_UNCONFIRMED');await lease.registerEngine(pid,endpoint);const saved=await loadPersonalReservation(plan.host_state);assert.equal(saved?.engine_pid,pid,'PERSONAL_PROCESS_BEFORE_DURABLE_REGISTRATION');assert.equal(saved?.phase,'active');expectedReservation=saved;await mark('personal-registered-before-process',{engine_pid:pid,private_pgid:pid});}});
 assert(personalResult.trimEnabled===false && personalResult.removedSamples===0 && personalResult.sourceSamples===personalResult.outputSamples && personalResult.modelDigest===plan.model_sha,'PERSONAL_FULL_TIMELINE_INVALID');
 await mark('personal-completed');
 await retireLocalEngine(personal,personalPid);
 await until(()=>!alive(personalPid) && !alive(personalPid,true));
 await mark('personal-engine-positively-exited');
 await lease.release(); lease=undefined;
 assert.equal(await loadPersonalReservation(plan.host_state),undefined,'HOST_RESERVATION_NOT_RELEASED');
 await mark('personal-reservation-released');
 await until(()=>jobs().every(job=>job.status==='ready') && events.filter(event=>event.kind==='attempt-succeeded').length===3);
 const ready=events.filter(event=>event.kind==='model-ready'), attempts=events.filter(event=>event.kind==='attempt-started');
 assert.equal(ready.length,2,'HANDOVER_MODEL_READY_COUNT_INVALID');
 assert.equal(ready[0].loadReason,'initial-start');assert.equal(ready[1].loadReason,'slot-recovery');
 assert.notEqual(ready[0].childIncarnation,ready[1].childIncarnation);
 assert.equal(attempts.length,3);assert.equal(attempts[0].childIncarnation,ready[0].childIncarnation);
 assert(attempts.slice(1).every(event=>event.childIncarnation===ready[1].childIncarnation && event.modelLoadState==='preloaded'),'RESUMED_FLEET_WARM_REUSE_INVALID');
 assert(!events.some(event=>['attempt-failed','attempt-stopped','child-recovery-scheduled','slot-unavailable'].includes(event.kind)),'HANDOVER_CONSUMED_FAILURE_PATH');
 assert.equal(fixture.snapshot().maxActiveAttempts,1);
 await mark('fleet-resumed-and-two-warm-jobs-completed');
 outcome={scope:'COPIED_RUNTIME_ACTUAL_HOST_ADMISSION_EXACT_BUNDLED_COMPONENT_PROJECTION',passed:true,trace,events,jobs:jobs(),personal:personalResult,host_credentials_lifecycle_read:false,global_gpu_exclusivity_proven:false};
} catch(error) {
 primaryFailure=error;
} finally {
 const cleanupErrors=[];
 const clean=async(name,action)=>{try{await action();}catch{cleanupErrors.push(name);}};
 let personalExited=personalPid===undefined;
 if(personalPid) await clean('PERSONAL_EXIT_UNCONFIRMED',async()=>{await retireLocalEngine(plan.personal_config,personalPid);const end=performance.now()+15000;while(alive(personalPid)||alive(personalPid,true)){assert(performance.now()<end,'PERSONAL_EXIT_UNCONFIRMED');await delay(25);}personalExited=true;});
 if(lease && personalExited) await clean('PERSONAL_RELEASE_FAILED',()=>lease.release());
 stopping.abort();
 await clean('FLEET_STOP_FAILED',()=>runtime.stop());
 await clean('FLEET_RUN_EXIT_FAILED',()=>run);
 await clean('FIXTURE_PERSIST_FAILED',async()=>fixture.persist());
 await clean('FIXTURE_CLOSE_FAILED',()=>new Promise(done=>{fixture.server.close(done);fixture.server.closeAllConnections();}));
 const receipt={...(outcome??{scope:'COPIED_RUNTIME_ACTUAL_HOST_ADMISSION_EXACT_BUNDLED_COMPONENT_PROJECTION',trace}),passed:!!outcome&&!primaryFailure&&cleanupErrors.length===0,cleanup_errors:cleanupErrors,personal_exit_confirmed:personalExited,host_update_state_metadata_read_attempted:hostUpdateStateRead,host_update_state_record_emitted:false,global_gpu_exclusivity_proven:false};
 if(primaryFailure)receipt.failure_code=/^[A-Z][A-Z0-9_]{0,95}$/.test(primaryFailure.message??'')?primaryFailure.message:'COMPONENT_HANDOVER_FAILED';
 await writeFile(plan.result,JSON.stringify(receipt)+'\\n',{mode:0o600,flag:'wx'});
 if(primaryFailure || cleanupErrors.length)process.exitCode=1;
}
`;
}

export function fullTimelineAudioEvidence(probe, pcm) {
  const seconds = Number(probe?.format?.duration);
  assert(
    Number.isFinite(seconds) && Math.abs(seconds - INPUT_SECONDS) <= 0.15,
    "FULL_TIMELINE_DURATION_INVALID",
  );
  const audio = probe?.streams?.filter(
    (stream) => stream.codec_type === "audio",
  );
  assert(
    audio?.length === 1 &&
      audio[0].codec_name === "mp3" &&
      audio[0].sample_rate === String(RATE) &&
      audio[0].channels === 2,
    "OUTPUT_AUDIO_CONTRACT_INVALID",
  );
  assert(
    Buffer.isBuffer(pcm) &&
      pcm.length > 0 &&
      pcm.length % 8 === 0 &&
      Math.abs(pcm.length / 8 / RATE - INPUT_SECONDS) <= 0.15,
    "DECODED_TIMELINE_INVALID",
  );
  for (let offset = 0; offset < pcm.length; offset += 4)
    assert(Number.isFinite(pcm.readFloatLE(offset)), "DECODED_SAMPLES_INVALID");
  return {
    full_timeline: true,
    decoded_frames: pcm.length / 8,
    measured_output_seconds: seconds,
    output_codec: audio[0].codec_name,
    sample_rate: RATE,
    channels: 2,
  };
}

async function decodeOutput(outputPath, decoded, tools, env, upload) {
  const info = await lstat(outputPath);
  assert(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.uid === process.getuid() &&
      !(info.mode & 0o077) &&
      info.size > 0 &&
      info.size <= 2 * 1024 * 1024,
    "OUTPUT_FILE_UNSAFE",
  );
  const probe = JSON.parse(
    (
      await command(
        tools.ffprobe,
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration:stream=codec_type,codec_name,sample_rate,channels",
          "-of",
          "json",
          outputPath,
        ],
        { env },
      )
    ).stdout,
  );
  await command(
    tools.ffmpeg,
    [
      "-nostdin",
      "-v",
      "error",
      "-i",
      outputPath,
      "-f",
      "f32le",
      "-ar",
      String(RATE),
      "-ac",
      "2",
      decoded,
    ],
    { env },
  );
  const proof = fullTimelineAudioEvidence(probe, await readFile(decoded));
  const bytes = await readFile(outputPath);
  const sha = createHash("sha256").update(bytes).digest("base64");
  if (upload) {
    assert.equal(sha, upload.sha256, "OUTPUT_TRANSFER_HASH_INVALID");
    assert.equal(bytes.length, upload.bytes, "OUTPUT_TRANSFER_BYTES_INVALID");
  }
  return { ...proof, output_bytes: bytes.length, output_sha256: sha };
}

function runtimeEvents(bytes) {
  const text = bytes.toString("utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line);
      assert(
        event && typeof event === "object" && typeof event.kind === "string",
        "RUNTIME_EVENT_INVALID",
      );
      return event;
    });
}
async function command(file, args, options = {}) {
  try {
    return await execute(file, args, {
      timeout: 60_000,
      maxBuffer: LIMIT,
      encoding: "utf8",
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONNOUSERSITE: "1",
      },
      ...options,
    });
  } catch {
    throw new Error("MPS_QUALIFICATION_TOOL_FAILED");
  }
}
export function ownedTestReservation(saved, expected, context) {
  if (
    !saved ||
    !expected ||
    !context ||
    saved.phase !== "active" ||
    expected.phase !== "active" ||
    typeof saved.request_id !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(saved.request_id) ||
    saved.request_id !== expected.request_id ||
    saved.client_pid !== context.clientPid ||
    expected.client_pid !== context.clientPid ||
    saved.client_identity !== context.clientIdentity ||
    expected.client_identity !== context.clientIdentity ||
    typeof context.clientIdentity !== "string" ||
    !context.clientIdentity ||
    !Number.isSafeInteger(context.clientPid) ||
    context.clientPid <= 1 ||
    context.clientPid > 2 ** 31 - 1
  )
    return false;
  if (saved.engine_pid === undefined) return expected.engine_pid === undefined;
  return (
    saved.engine_pid === expected.engine_pid &&
    Number.isSafeInteger(saved.engine_pid) &&
    saved.engine_pid > 1 &&
    saved.engine_pid <= 2 ** 31 - 1 &&
    saved.engine_pid !== context.clientPid &&
    Array.isArray(context.ownedPids) &&
    context.ownedPids.includes(saved.engine_pid) &&
    typeof context.engineIdentity === "string" &&
    context.engineIdentity.length > 0 &&
    saved.process_identity === context.engineIdentity &&
    expected.process_identity === context.engineIdentity
  );
}

async function inspectOwnership(sourceHome, ownPids = [], componentContext) {
  const query = async (file, args) => {
    try {
      return {
        ...(await execute(file, args, {
          timeout: 10_000,
          maxBuffer: LIMIT,
          encoding: "utf8",
        })),
        code: 0,
      };
    } catch {
      return { code: 1, stdout: "" };
    }
  };
  let [launchctl, ps] = await Promise.all([
    query("/bin/launchctl", ["list"]),
    query("/bin/ps", ["-axo", "uid=,pid=,ppid=,pgid=,comm="]),
  ]);
  const reservation = join(
    sourceHome,
    "Library/Application Support/MusicMuteWorker/state/personal-admission.json",
  );
  let present = await lstat(reservation).then(
    () => true,
    (error) => (error.code === "ENOENT" ? false : true),
  );
  if (present && componentContext) {
    const module = await import(
      pathToFileURL(componentContext.reservationModule).href
    );
    const state = dirname(reservation),
      deadline = performance.now() + 5000;
    for (;;) {
      const saved = await module.loadPersonalReservation(state);
      if (!saved) {
        present = false;
        break;
      }
      const identity = await module.personalProcessIdentity(
        componentContext.clientPid,
      );
      if (
        saved.client_pid !== componentContext.clientPid ||
        saved.client_identity !== identity
      )
        break;
      const progress = await readJson(componentContext.progressPath);
      const observed = physicalOwnership({
        launchctlCode: launchctl.code,
        launchctlOutput: launchctl.stdout,
        psCode: ps.code,
        psOutput: ps.stdout,
        uid: process.getuid(),
        ownPids,
        personalReservationPresent: false,
      });
      const engineIdentity =
        saved.engine_pid === undefined
          ? undefined
          : await module.personalProcessIdentity(saved.engine_pid);
      if (
        ownedTestReservation(saved, progress?.expected_reservation, {
          clientPid: componentContext.clientPid,
          clientIdentity: identity,
          engineIdentity,
          ownedPids: observed.owned_pids ?? [],
        })
      ) {
        present = false;
        break;
      }
      if (performance.now() >= deadline) break;
      await delay(25);
      [launchctl, ps] = await Promise.all([
        query("/bin/launchctl", ["list"]),
        query("/bin/ps", ["-axo", "uid=,pid=,ppid=,pgid=,comm="]),
      ]);
    }
  }
  return physicalOwnership({
    launchctlCode: launchctl.code,
    launchctlOutput: launchctl.stdout,
    psCode: ps.code,
    psOutput: ps.stdout,
    uid: process.getuid(),
    ownPids,
    personalReservationPresent: present,
  });
}
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  assert(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid() &&
      (info.mode & 0o077) === 0,
    "MPS_DIRECTORY_UNSAFE",
  );
}

export async function acquireExistingHostUpdateLock(support) {
  assert(
    isAbsolute(support) && (await realpath(support)) === support,
    "HOST_APP_SUPPORT_UNSAFE",
  );
  const folder = await lstat(support);
  assert(
    folder.isDirectory() &&
      !folder.isSymbolicLink() &&
      folder.uid === process.getuid() &&
      (folder.mode & 0o777) === 0o700,
    "HOST_APP_SUPPORT_UNSAFE",
  );
  const path = join(support, "update.lock");
  const regular = (info) =>
    info.isFile() &&
    !info.isSymbolicLink() &&
    info.nlink === 1 &&
    info.uid === process.getuid() &&
    (info.mode & 0o777) === 0o600;
  let named;
  try {
    named = await lstat(path);
  } catch {
    throw new Error("HOST_APP_UPDATE_LOCK_UNAVAILABLE");
  }
  assert(regular(named), "HOST_APP_UPDATE_LOCK_UNSAFE");
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | 0x20,
    );
  } catch (error) {
    throw new Error(
      ["EAGAIN", "EWOULDBLOCK"].includes(error.code)
        ? "HOST_APP_UPDATE_LOCK_BUSY"
        : "HOST_APP_UPDATE_LOCK_UNAVAILABLE",
    );
  }
  try {
    const opened = await handle.stat(),
      after = await lstat(path);
    assert(
      regular(opened) &&
        regular(after) &&
        opened.dev === named.dev &&
        opened.ino === named.ino &&
        opened.dev === after.dev &&
        opened.ino === after.ino,
      "HOST_APP_UPDATE_LOCK_UNSAFE",
    );
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function stageComponentProjection({
  appPath,
  root,
  tools,
  env,
  manifest,
  runtimeRoot,
  modelRoot,
  copiedApp,
}) {
  const bundle = await realpath(appPath);
  assert(bundle.endsWith(".app"), "QUALIFICATION_APP_INVALID");
  await command("/usr/bin/codesign", ["--verify", "--strict", bundle]);
  const resources = join(bundle, "Contents/Resources");
  const sealedService = await verifyCompressedWorkerService(
    join(resources, "worker/service"),
  );
  assert.equal(
    sealedService.service.payload_sha256,
    manifest.payload_sha256,
    "APP_SERVICE_SOURCE_MISMATCH",
  );
  const bootstrapPath = join(resources, "runtime-bootstrap.json");
  const info = await lstat(bootstrapPath);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.size <= 16 * 1024 * 1024,
    "APP_BOOTSTRAP_UNSAFE",
  );
  const bootstrap = JSON.parse(await readFile(bootstrapPath, "utf8"));
  assert.equal(
    bootstrap.runtime.id,
    basename(dirname(dirname(runtimeRoot))),
    "APP_RUNTIME_SOURCE_MISMATCH",
  );
  const code = join(root, "component-code");
  await privateDirectory(code);
  const originalPath = join(code, "original-host.js"),
    projectionPath = join(code, "host-components.mjs");
  const original = await readFile(join(resources, "companion/host.js"));
  assert(original.length <= 8 * 1024 * 1024, "HOST_COMPONENT_TOO_LARGE");
  const projected = projectBundledHost(original);
  await writeFile(originalPath, original, { flag: "wx", mode: 0o400 });
  await writeFile(projectionPath, projected.projection, {
    flag: "wx",
    mode: 0o400,
  });
  const sandbox =
    "(version 1) (allow default) (deny file-write*) (deny network*) (deny process-fork)";
  const check = await command(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      sandbox,
      tools.node,
      "--input-type=module",
      "-e",
      `const module = await import(${JSON.stringify(pathToFileURL(projectionPath).href)}); for (const name of ${JSON.stringify(projected.evidence.appended_exports)}) if (typeof module[name] !== 'function') throw new Error('COMPONENT_API_INVALID'); console.log(JSON.stringify({exports:Object.keys(module)}));`,
    ],
    { env },
  );
  assert.deepEqual(
    JSON.parse(check.stdout).exports.sort(),
    projected.evidence.appended_exports.toSorted(),
    "COMPONENT_IMPORT_INVALID",
  );
  const personalCode = join(code, "personal-engine");
  await privateDirectory(personalCode);
  const files = {};
  for (const name of ["local_pipeline.py", "local_engine_service.py"]) {
    const source = join(resources, "engine", name),
      copied = join(personalCode, name);
    await copyFile(source, copied, constants.COPYFILE_FICLONE);
    await chmod(copied, 0o400);
    assert.equal(await hashFile(copied), await hashFile(source));
    files[name] = await hashFile(copied);
  }
  const launcherPath = join(code, "prepared-python");
  const launcher = qualificationPythonLauncher(tools.python, env);
  await writeFile(launcherPath, launcher, { flag: "wx", mode: 0o500 });
  const personalRoot = join(
    root,
    "home/Library/Application Support/MusicMuteLocal",
  );
  for (const path of [
    personalRoot,
    join(personalRoot, "cache"),
    join(personalRoot, "logs"),
  ])
    await privateDirectory(path);
  const personalConfig = {
    root: personalRoot,
    cache_root: join(personalRoot, "cache"),
    logs_root: join(personalRoot, "logs"),
    app_resources: resources,
    runtime_id: bootstrap.runtime.id,
    runtime_root: dirname(runtimeRoot),
    node_path: tools.node,
    python_path: launcherPath,
    update_lease_python_path: tools.python,
    ffmpeg_path: tools.ffmpeg,
    ffprobe_path: tools.ffprobe,
    models_root: modelRoot,
    runner_path: join(personalCode, "local_pipeline.py"),
    engine_root: join(copiedApp, "engine"),
  };
  return {
    projectionPath,
    personalConfig,
    evidence: {
      ...projected.evidence,
      projection_file: projectionPath,
      original_file: originalPath,
      sandbox_import_verified: true,
      sandbox_file_writes_allowed: false,
      sandbox_network_allowed: false,
      sandbox_process_fork_allowed: false,
      launcher_file: launcherPath,
      launcher_sha256: createHash("sha256").update(launcher).digest("hex"),
      launcher_executes_exact_prepared_python: tools.python,
      launcher_preserves_pid_via_exec: true,
      personal_engine_files_sha256: files,
      app_bundle: bundle,
      sealed_service_payload_sha256: sealedService.service.payload_sha256,
      runtime_id: bootstrap.runtime.id,
    },
  };
}
async function readJson(path) {
  try {
    const info = await lstat(path);
    assert(
      info.isFile() && !info.isSymbolicLink() && info.size <= LIMIT,
      "MPS_STATE_UNSAFE",
    );
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
function ownedChild(file, args, options) {
  const child = spawn(file, args, {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = Buffer.alloc(0),
    stderrBytes = 0,
    overflow = false;
  child.stdout.on("data", (bytes) => {
    if (stdout.length + bytes.length > LIMIT) {
      overflow = true;
      child.kill("SIGTERM");
    } else stdout = Buffer.concat([stdout, bytes]);
  });
  child.stderr.on("data", (bytes) => {
    stderrBytes += bytes.length;
    if (stderrBytes > LIMIT) {
      overflow = true;
      child.kill("SIGTERM");
    }
  });
  child.stdin.on("error", () => {});
  const ended = new Promise((resolve_) => {
    child.once("error", () => resolve_({ code: null, signal: "START_FAILED" }));
    child.once("close", (code, signal) => resolve_({ code, signal }));
  });
  return {
    child,
    ended,
    result: () => ({ stdout, stderr_bytes: stderrBytes, overflow }),
  };
}
async function stopOwned(process_) {
  if (
    !process_ ||
    process_.child.exitCode !== null ||
    process_.child.signalCode !== null
  )
    return;
  process_.child.kill("SIGTERM");
  const exited = await Promise.race([
    process_.ended.then(() => true),
    delay(10_000).then(() => false),
  ]);
  if (!exited) process_.child.kill("SIGKILL");
  await process_.ended;
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw new Error("OWNED_PROCESS_EXIT_UNCONFIRMED");
  }
}
function groupAlive(group) {
  assert(Number.isSafeInteger(group) && group > 1, "OWNED_GROUP_INVALID");
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw new Error("OWNED_GROUP_EXIT_UNCONFIRMED");
  }
}

/** Default only stages/checks. MPS requires an explicit flag AND idle physical ownership. */
export async function qualifyCopiedWorkerMps({
  serviceRoot,
  runtimeRoot,
  modelPath,
  runMps = false,
  appPath,
  componentHandover = false,
  hostHandoverApproved = false,
  operatorAcceptance = false,
}) {
  assert(
    [runMps, componentHandover, hostHandoverApproved, operatorAcceptance].every(
      (value) => typeof value === "boolean",
    ),
    "QUALIFICATION_FLAGS_MUST_BE_BOOLEAN",
  );
  assert(
    process.platform === "darwin" && process.arch === "arm64",
    "MACOS_ARM64_REQUIRED",
  );
  for (const path of [serviceRoot, runtimeRoot, modelPath])
    assert(
      typeof path === "string" && isAbsolute(path),
      "ABSOLUTE_PATH_REQUIRED",
    );
  assert(
    !(componentHandover || operatorAcceptance) ||
      (runMps === true &&
        hostHandoverApproved === true &&
        typeof appPath === "string" &&
        isAbsolute(appPath)),
    "HOST_HANDOVER_APPROVAL_REQUIRED",
  );
  const sourceHome = homedir();
  const root = join(
    repository,
    "output/worker-mps-proof.noindex",
    randomUUID(),
  );
  await privateDirectory(root);
  serviceRoot = await realpath(serviceRoot);
  runtimeRoot = await realpath(runtimeRoot);
  const report = {
    schema_version: 1,
    scope:
      "COPIED_PRODUCTION_SERVICE_SYNTHETIC_AUDIO_LOOPBACK_BACKEND_REAL_MPS_IF_SAFE",
    passed: false,
    preflight_passed: false,
    inference_run: false,
    installed_service_changed: false,
    account_used: false,
    keychain_used: false,
    public_backend_used: false,
    output: root,
    source_service_root: serviceRoot,
    prepared_runtime_root: runtimeRoot,
    harness_sha256: await hashFile(new URL(import.meta.url)),
    timings_scope:
      "cold model loading and warmup readiness, then three sequential full jobs on one preloaded persistent MPS child",
  };
  let service,
    controller,
    fixture,
    component,
    hostUpdateLock,
    runCancellation,
    componentObservation;
  const descendants = new Set();
  const groups = new Set();
  const groupIdentities = new Map();
  const groupHistory = [];
  const operatorRegistry = { labels: new Map(), roots: new Map(), history: [] };
  let cleanupOperator;
  const inspectCurrentOwnership = async (ownPids = [], componentContext) => {
    let verified = [],
      unknown = false;
    const deadline = performance.now() + 5000;
    for (;;) {
      try {
        verified = await resolveOperatorOwnerRoots(
          operatorRegistry,
          { queryLabel: readOperatorLabel, queryProcess: readOperatorProcess },
          process.getuid(),
        );
        break;
      } catch {
        if (performance.now() >= deadline) {
          unknown = true;
          break;
        }
        await delay(25);
      }
    }
    const owner = await inspectOwnership(
      sourceHome,
      [...ownPids, ...verified.map((row) => row.pid)],
      componentContext,
    );
    if (owner.owned_groups)
      owner.owned_groups = [
        ...new Set([
          ...owner.owned_groups,
          ...verified
            .filter((row) => row.pid === row.group)
            .map((row) => row.group),
        ]),
      ];
    if (unknown) {
      owner.safe = false;
      owner.reason = "OPERATOR_ROOT_UNCONFIRMED";
    }
    return owner;
  };
  const rememberOwnedGroups = async (owner) => {
    for (const group of owner.owned_groups) {
      groups.add(group);
      const identity = await processStartIdentity(group);
      if (!identity && !groupAlive(group)) continue;
      assert(
        identity?.uid === process.getuid() &&
          identity.processGroup === group &&
          owner.owned_processes.some(
            (row) =>
              row.pid === group &&
              row.group === group &&
              row.uid === identity.uid,
          ),
        "OWNED_GROUP_IDENTITY_UNCONFIRMED",
      );
      const record = { group, ...identity };
      const prior = groupIdentities.get(group);
      assert(
        !prior || prior.startIdentity === record.startIdentity,
        "OWNED_GROUP_IDENTITY_CHANGED",
      );
      if (!prior) groupHistory.push(record);
      groupIdentities.set(group, record);
    }
  };
  try {
    report.phase = "SERVICE_INVENTORY";
    const manifest = await verifyWorkerService(serviceRoot);
    const copy = join(root, "external-service");
    await privateDirectory(copy);
    await cp(join(serviceRoot, "app"), join(copy, "app"), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    await copyFile(
      join(serviceRoot, "service-manifest.json"),
      join(copy, "service-manifest.json"),
    );
    assert.equal(
      (await verifyWorkerService(copy)).payload_sha256,
      manifest.payload_sha256,
    );
    const tools = {};
    report.phase = "PREPARED_TOOLS";
    for (const [name, path] of Object.entries({
      node: "node/bin/node",
      python: "python/bin/python3",
      ffmpeg: "bin/ffmpeg",
      ffprobe: "bin/ffprobe",
    })) {
      const actual = await realpath(join(runtimeRoot, path));
      const info = await lstat(actual);
      assert(
        actual.startsWith(`${runtimeRoot}/`) &&
          info.isFile() &&
          (info.mode & 0o022) === 0 &&
          (info.mode & 0o111) !== 0,
        "PREPARED_TOOL_UNSAFE",
      );
      await command("/usr/bin/codesign", ["--verify", "--strict", actual]);
      tools[name] = actual;
    }
    report.tool_versions = {
      node: (await command(tools.node, ["--version"])).stdout.trim(),
      python: (await command(tools.python, ["--version"])).stdout.trim(),
    };
    assert(
      report.tool_versions.node.startsWith("v24."),
      "PREPARED_NODE_INCOMPATIBLE",
    );
    for (const entry of manifest.entries.filter(
      (entry) =>
        entry.kind === "file" && /\.(?:node|dylib|so)$/u.test(entry.path),
    ))
      await command("/usr/bin/codesign", [
        "--verify",
        "--strict",
        join(copy, entry.path),
      ]);
    report.phase = "FIXED_MODEL";
    const model = await lstat(modelPath);
    assert(
      model.isFile() &&
        !model.isSymbolicLink() &&
        model.size === MODEL_BYTES &&
        model.uid === process.getuid() &&
        !(model.mode & 0o022),
      "FIXED_MODEL_UNSAFE",
    );
    assert.equal(
      await hashFile(modelPath),
      MODEL_SHA256,
      "FIXED_MODEL_HASH_INVALID",
    );
    const home = join(root, "home"),
      temporary = join(root, "tmp"),
      modelRoot = join(home, "models"),
      modelCopy = join(modelRoot, MODEL_SHA256, "Kim_Vocal_2.onnx");
    for (const path of [home, temporary, dirname(modelCopy)])
      await privateDirectory(path);
    const env = qualificationEnvironment(home, temporary, runtimeRoot);
    for (const name of [
      "XDG_CACHE_HOME",
      "MPLCONFIGDIR",
      "NUMBA_CACHE_DIR",
      "PYTHONPYCACHEPREFIX",
    ])
      await privateDirectory(env[name]);
    report.private_caches = Object.fromEntries(
      [
        "XDG_CACHE_HOME",
        "MPLCONFIGDIR",
        "NUMBA_CACHE_DIR",
        "PYTHONPYCACHEPREFIX",
      ].map((name) => [name, env[name]]),
    );
    await copyFile(modelPath, modelCopy, constants.COPYFILE_FICLONE);
    await chmod(modelCopy, 0o400);
    assert.equal(await hashFile(modelCopy), MODEL_SHA256);
    const input = syntheticWav(),
      inputPath = join(root, "owned-input.wav");
    await writeFile(inputPath, input, { mode: 0o600, flag: "wx" });
    report.payload_sha256 = manifest.payload_sha256;
    report.service_version = manifest.worker_version;
    report.model_sha256 = MODEL_SHA256;
    report.input = {
      generated: true,
      bytes: input.length,
      seconds: INPUT_SECONDS,
      sha256: createHash("sha256").update(input).digest("hex"),
      leading_silence_seconds: 1,
      trailing_silence_seconds: 1,
    };
    let componentEntry;
    if (appPath) {
      report.phase = "COMPONENT_PROJECTION";
      componentEntry = await stageComponentProjection({
        appPath,
        root,
        tools,
        env,
        manifest,
        runtimeRoot,
        modelRoot,
        copiedApp: join(copy, "app"),
      });
      report.component_projection = componentEntry.evidence;
    }
    report.component_handover = {
      requested: componentHandover,
      host_coordination_approved: hostHandoverApproved,
      executed: false,
      scope: "COMPONENT_ENTRY_SEPARATE_FROM_EXACT_CLI_SMOKE",
      global_gpu_exclusivity_proven: false,
    };
    report.operator_acceptance = {
      requested: operatorAcceptance,
      executed: false,
      scope:
        "ISOLATED_ORIGINAL_OPERATORS_SEPARATE_FROM_FLEET_AND_COMPONENT_ENTRIES",
    };
    report.phase = "PHYSICAL_GPU_OWNERSHIP";
    report.ownership = await inspectCurrentOwnership([process.pid]);
    report.preflight_passed = true;
    if (!runMps || !report.ownership.safe) {
      report.outcome = report.ownership.safe
        ? "READY_FOR_EXPLICIT_MPS_RUN"
        : "GPU_OWNERSHIP_UNAVAILABLE";
      return report;
    }
    // This is an existing-file advisory lease, never setup or profile mutation.
    // Default preflight cannot enter this branch. A busy accepted/paused helper
    // is refused immediately; no request or app is cancelled.
    runCancellation = qualificationRunCancellation();
    runCancellation.signal.throwIfAborted();
    hostUpdateLock = await acquireExistingHostUpdateLock(
      join(sourceHome, "Library/Application Support/MusicMuteLocal"),
    );
    report.host_update_lock = {
      exclusive_existing_file_lease: true,
      acquired_after_explicit_mps_request: true,
      file_created_or_unlinked: false,
      settings_changed: false,
      prevents_this_profile_legacy_helpers_with_shared_update_leases: true,
      cross_user_global_gpu_exclusivity_proven: false,
      sigkill_cannot_preserve_advisory_lease: true,
    };
    const app = join(copy, "app"),
      engine = join(app, "engine");
    const recipes = JSON.parse(
      (
        await command(
          tools.python,
          [
            "-I",
            "-B",
            "-c",
            "import sys,json;sys.path.insert(0,sys.argv[1]);from musicmute_engine.recipes import recipe_snapshot;print(json.dumps([recipe_snapshot('kim-vocals-v2',False),recipe_snapshot('kim-vocals-v2-trim',True)]))",
            engine,
          ],
          { env },
        )
      ).stdout,
    );
    assert.equal(recipes[0].trimEnabled, false);
    const state = join(home, "state"),
      configRoot = join(root, "config"),
      work = join(home, "work");
    for (const path of [state, configRoot, work]) await privateDirectory(path);
    const credential = randomBytes(32).toString("base64url"),
      machineId = randomUUID(),
      workerId = randomUUID();
    let claimsEnabled = false;
    const fixtureStarted = performance.now();
    fixture = createAcceptanceFixture({
      config: { machineId },
      credential,
      input,
      recipes,
      outputPath: join(root, "job"),
      claimsEnabled: () => claimsEnabled,
      jobsPerSlot: 3,
    });
    fixture.server.listen(0, "127.0.0.1");
    await once(fixture.server, "listening");
    const statusPath = join(state, "runtime-status.json"),
      configPath = join(configRoot, "runtime.json"),
      credentialPath = join(configRoot, "synthetic-credential");
    await writeFile(credentialPath, credential + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        machineId,
        backendBaseUrl: `http://127.0.0.1:${fixture.server.address().port}`,
        credentialFile: credentialPath,
        allowInsecureLoopback: true,
        workRoot: work,
        modelCacheRoot: modelRoot,
        engineRoot: engine,
        pythonPath: tools.python,
        ffmpegPath: tools.ffmpeg,
        ffprobePath: tools.ffprobe,
        localRuntimeStatusPath: statusPath,
        validatedMaxWorkersPerGpu: 1,
        slots: [
          {
            workerId,
            gpuId: "gpu0",
            slotIndex: 0,
            recipeIds: ["kim-vocals-v2"],
            provider: "mps",
          },
        ],
      }),
      { mode: 0o600, flag: "wx" },
    );
    report.phase = "MPS_STARTUP";
    const lastOwnership = await inspectCurrentOwnership([process.pid]);
    assert(lastOwnership.safe, "GPU_OWNERSHIP_CHANGED_BEFORE_START");
    runCancellation.signal.throwIfAborted();
    const started = performance.now(),
      stages = [];
    service = ownedChild(
      tools.node,
      [join(app, "dist/src/cli/main.js"), "run", "--config", configPath],
      { env, cwd: app },
    );
    report.model_startup_attempted = true;
    let lastStage,
      lastOwnerCheck = 0;
    const check = async () => {
      runCancellation.signal.throwIfAborted();
      assert(
        service.child.exitCode === null &&
          service.child.signalCode === null &&
          !service.result().overflow,
        "COPIED_SERVICE_EXITED",
      );
      if (performance.now() - started > TIMEOUT_MS)
        throw new Error("MPS_QUALIFICATION_TIMEOUT");
      const status = await readJson(statusPath);
      if (status?.childState && status.childState !== lastStage) {
        stages.push({
          stage: status.childState,
          since_start_ms: performance.now() - started,
        });
        lastStage = status.childState;
      }
      if (performance.now() - lastOwnerCheck > 1000) {
        const owner = await inspectCurrentOwnership([
          process.pid,
          service.child.pid,
        ]);
        // Only the same-user process-parent tree can establish an owned engine.
        assert(owner.safe, "GPU_OWNERSHIP_CHANGED_DURING_RUN");
        for (const pid of owner.owned_pids)
          if (pid !== process.pid) descendants.add(pid);
        await rememberOwnedGroups(owner);
        report.owned_process_identity = owner.owned_processes;
        lastOwnerCheck = performance.now();
      }
      return status;
    };
    while ((await check())?.childState !== "ready") await delay(25);
    report.inference_run = true;
    lastOwnerCheck = 0;
    await check();
    const initialEngine = report.owned_process_identity.filter(
      (row) => row.role === "engine",
    );
    const initialGuardian = report.owned_process_identity.filter(
      (row) => row.role === "guardian",
    );
    assert(
      initialEngine.length === 1 &&
        initialGuardian.length === 1 &&
        initialEngine[0].parent === initialGuardian[0].pid &&
        initialEngine[0].group === initialGuardian[0].group,
      "FLEET_GUARDIAN_IDENTITY_INVALID",
    );
    report.initial_fleet_process_identity = {
      engine: initialEngine[0],
      guardian: initialGuardian[0],
    };
    report.cold_startup_stages = stages;
    report.phase = "CONTROLLER_EOF";
    const requestId = randomUUID();
    controller = ownedChild(
      tools.node,
      [join(app, "dist/src/cli/app-control.js")],
      { env, cwd: app },
    );
    controller.child.stdin.end(
      JSON.stringify({
        protocol_version: 1,
        request_id: requestId,
        type: "COMMAND",
        command: "versions",
        parameters: {},
      }) + "\n",
    );
    const controllerExit = await Promise.race([
      controller.ended,
      delay(30_000).then(() => {
        throw new Error("CONTROLLER_EOF_TIMEOUT");
      }),
    ]);
    assert.equal(controllerExit.code, 0);
    assert(!controller.result().overflow);
    const frame = JSON.parse(controller.result().stdout.toString("utf8"));
    assert(
      frame.request_id === requestId && frame.type === "RESULT",
      "CONTROLLER_REPLY_INVALID",
    );
    assert.equal(fixture.snapshot().jobs[0].status, "waiting");
    assert.equal(fixture.snapshot().jobs[0].claimedAtMs, null);
    await check();
    const controllerExited = performance.now();
    report.controller_eof_exit_ms = performance.now() - started;
    report.phase = "FULL_TIMELINE_JOB";
    claimsEnabled = true;
    const fleetJobs = () =>
      fixture.snapshot().jobs.filter((job) => job.slotIndex === 0);
    while (!fleetJobs().every((job) => job.status === "ready")) {
      assert(
        fleetJobs().every((job) => job.status !== "failed"),
        "REAL_MPS_JOB_FAILED",
      );
      await check();
      await delay(25);
    }
    const jobs = fleetJobs();
    while (
      runtimeEvents(service.result().stdout).filter(
        (event) => event.kind === "attempt-succeeded",
      ).length < 3
    ) {
      await check();
      await delay(25);
    }
    lastOwnerCheck = 0;
    await check();
    const finalEngine = report.owned_process_identity.filter(
      (row) => row.role === "engine",
    );
    const finalGuardian = report.owned_process_identity.filter(
      (row) => row.role === "guardian",
    );
    assert.deepEqual(finalEngine, initialEngine, "WARM_ENGINE_PROCESS_CHANGED");
    assert.deepEqual(
      finalGuardian,
      initialGuardian,
      "WARM_GUARDIAN_PROCESS_CHANGED",
    );
    assert(
      jobs.every((job) => job.claimedAtMs + fixtureStarted >= controllerExited),
      "JOB_STARTED_BEFORE_CONTROLLER_EXIT",
    );
    for (let index = 1; index < jobs.length; index++)
      assert(
        jobs[index].claimedAtMs >= jobs[index - 1].completedAtMs,
        "WARM_JOBS_OVERLAPPED",
      );
    assert.equal(fixture.snapshot().maxActiveAttempts, 1);
    report.warm_reuse = warmFleetEvidence(
      runtimeEvents(service.result().stdout),
      jobs,
    );
    report.phase = "OUTPUT_DECODING";
    report.jobs = [];
    for (const [index, job] of jobs.entries()) {
      runCancellation.signal.throwIfAborted();
      const outputPath = join(root, `job.${index * 2}.mp3`),
        decoded = join(root, `decoded-vocals-${index}.f32le`);
      const decodedProof = await decodeOutput(
        outputPath,
        decoded,
        tools,
        env,
        job.upload,
      );
      report.jobs.push({
        status: job.status,
        recipe: job.completion.recipeId,
        ...decodedProof,
        stage_timings: job.completion.stageTimings,
        execution_timings: job.completion.executionTimings,
      });
    }
    report.owned_private_groups = [...groupHistory];
    assert(groups.size >= 1, "PRIVATE_GUARDIAN_GROUP_UNOBSERVED");
    report.service_remained_alive_after_controller_exit =
      service.child.exitCode === null;
    assert(report.service_remained_alive_after_controller_exit);
    report.exact_cli_smoke_passed = true;
    if (componentHandover) {
      runCancellation.signal.throwIfAborted();
      // Canonical admission is opened only after an explicitly approved run,
      // positive idle observation, and exit of the separate CLI cohort.
      await stopOwned(service);
      const deadline = performance.now() + 10_000;
      while ([...groups].some(groupAlive) || [...descendants].some(alive)) {
        assert(
          performance.now() <= deadline,
          "CLI_GROUP_EXIT_UNCONFIRMED_BEFORE_HANDOVER",
        );
        await delay(25);
      }
      // Exact-CLI identities are retired only after positive PID/group exit.
      groups.clear();
      groupIdentities.clear();
      descendants.clear();
      assert(
        (await inspectCurrentOwnership([process.pid])).safe,
        "GPU_OWNERSHIP_CHANGED_BEFORE_HANDOVER",
      );
      const folder = join(root, "component-handover"),
        work = join(folder, "fleet-work"),
        personalWork = join(
          componentEntry.personalConfig.cache_root,
          "jobs",
          randomUUID(),
        );
      for (const path of [folder, work, personalWork])
        await privateDirectory(path);
      const personalInput = join(personalWork, "source.wav");
      await copyFile(inputPath, personalInput, constants.COPYFILE_FICLONE);
      await chmod(personalInput, 0o600);
      assert.equal(
        (await lstat(personalInput)).nlink,
        1,
        "PERSONAL_INPUT_HARDLINK_UNSAFE",
      );
      const source = join(folder, "component-entry.mjs"),
        planPath = join(folder, "plan.json"),
        resultPath = join(folder, "result.json");
      await writeFile(source, handoverComponentSource(), {
        flag: "wx",
        mode: 0o400,
      });
      await command(tools.node, ["--check", source], { env });
      const hostWorkerRoot = join(
        sourceHome,
        "Library/Application Support/MusicMuteWorker",
      );
      await writeFile(
        planPath,
        JSON.stringify({
          run_mps: true,
          host_handover_approved: hostHandoverApproved,
          app: app,
          projection: componentEntry.projectionPath,
          backend_fixture: resolve(
            repository,
            "../worker/scripts/service-acceptance-fixture.mjs",
          ),
          input: inputPath,
          personal_input: personalInput,
          input_base64: createHash("sha256").update(input).digest("base64"),
          recipes,
          credential: randomBytes(32).toString("base64url"),
          machine_id: randomUUID(),
          worker_id: randomUUID(),
          models: modelRoot,
          model_sha: MODEL_SHA256,
          python: tools.python,
          engine,
          ffmpeg: tools.ffmpeg,
          ffprobe: tools.ffprobe,
          timeout_ms: TIMEOUT_MS,
          host_worker_root: hostWorkerRoot,
          host_state: join(hostWorkerRoot, "state"),
          work,
          personal_work: personalWork,
          status: join(folder, "runtime-status.json"),
          progress: join(folder, "progress.json"),
          output_prefix: join(folder, "job"),
          result: resultPath,
          personal_config: componentEntry.personalConfig,
        }) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      report.phase = "COMPONENT_HANDOVER";
      runCancellation.signal.throwIfAborted();
      report.component_handover.executed = true;
      report.component_handover.actual_host_socket_and_journal_used = true;
      component = ownedChild(tools.node, [source, planPath], {
        env,
        cwd: folder,
      });
      componentObservation = {
        clientPid: component.child.pid,
        progressPath: join(folder, "progress.json"),
        reservationModule: join(
          app,
          "dist/src/runtime/personal-reservation.js",
        ),
      };
      const begun = performance.now();
      while (
        component.child.exitCode === null &&
        component.child.signalCode === null
      ) {
        runCancellation.signal.throwIfAborted();
        assert(
          performance.now() - begun < TIMEOUT_MS &&
            !component.result().overflow,
          "COMPONENT_HANDOVER_TIMEOUT",
        );
        const owner = await inspectCurrentOwnership(
          [process.pid, component.child.pid],
          componentObservation,
        );
        assert(owner.safe, "GPU_OWNERSHIP_CHANGED_DURING_HANDOVER");
        for (const pid of owner.owned_pids)
          if (pid !== process.pid) descendants.add(pid);
        await rememberOwnedGroups(owner);
        await delay(250);
      }
      const ended = await component.ended;
      assert(
        ended.code === 0 && !ended.signal && !component.result().overflow,
        "COMPONENT_HANDOVER_FAILED",
      );
      const result = await readJson(resultPath);
      assert(
        result?.passed === true &&
          result.global_gpu_exclusivity_proven === false,
        "COMPONENT_HANDOVER_RESULT_INVALID",
      );
      assert(
        result.personal_exit_confirmed === true,
        "PERSONAL_EXIT_UNCONFIRMED",
      );
      const personalOutput = result.personal?.outputPath;
      assert(
        typeof personalOutput === "string" &&
          personalOutput.startsWith(personalWork + "/") &&
          (await realpath(personalOutput)) === personalOutput,
        "PERSONAL_OUTPUT_PATH_INVALID",
      );
      result.personal_audio = await decodeOutput(
        personalOutput,
        join(folder, "personal-decoded.f32le"),
        tools,
        env,
      );
      result.fleet_audio = [];
      assert.equal(result.jobs?.length, 3, "HANDOVER_JOBS_INVALID");
      for (const [index, job] of result.jobs.entries()) {
        assert(job.status === "ready", "HANDOVER_JOB_NOT_READY");
        result.fleet_audio.push(
          await decodeOutput(
            join(folder, `job.${index * 2}.mp3`),
            join(folder, `fleet-decoded-${index}.f32le`),
            tools,
            env,
            job.upload,
          ),
        );
      }
      report.component_handover.result = result;
    }
    if (operatorAcceptance) {
      // Every previous disposable cohort must exit before operator qualification.
      await stopOwned(service);
      await stopOwned(component);
      const previousExitDeadline = performance.now() + 15000;
      while ([...groups].some(groupAlive) || [...descendants].some(alive)) {
        runCancellation.signal.throwIfAborted();
        assert(
          performance.now() < previousExitDeadline,
          "PRIOR_COHORT_EXIT_UNCONFIRMED",
        );
        await delay(25);
      }
      groups.clear();
      groupIdentities.clear();
      descendants.clear();
      const operatorRoot = join(root, "operator-acceptance");
      const modulePath = join(
        repository,
        "scripts/worker-operator-acceptance.mjs",
      );
      const operators = await import(pathToFileURL(modulePath).href);
      const options = {
        serviceRoot: copy,
        resourcesRoot: join(
          componentEntry.evidence.app_bundle,
          "Contents/Resources",
        ),
        preparedSupportRoot: resolve(runtimeRoot, "../../../../.."),
        fixturePath: join(
          sourceHome,
          "Library/Application Support/MusicMuteWorker/state/qualification.wav",
        ),
        outputRoot: operatorRoot,
      };
      const observe = async () => {
        assert(hostUpdateLock, "OPERATOR_HOST_LEASE_REQUIRED");
        const owner = await inspectCurrentOwnership([process.pid]);
        assert(owner.safe, "OPERATOR_GPU_OWNERSHIP_UNCONFIRMED");
        for (const pid of owner.owned_pids)
          if (pid !== process.pid) descendants.add(pid);
        await rememberOwnedGroups(owner);
        return owner;
      };
      const register = async (record) => {
        assert(hostUpdateLock, "OPERATOR_HOST_LEASE_REQUIRED");
        if (record.phase === "pending-label") {
          const contract = operatorPendingContract(
            record,
            operatorRoot,
            process.getuid(),
          );
          assert(
            !operatorRegistry.labels.has(contract.label),
            "OPERATOR_LABEL_REUSED",
          );
          assert(
            !(await readOperatorLabel(contract)).loaded,
            "OPERATOR_LABEL_COLLISION",
          );
          const info = await lstat(contract.plistPath);
          assert(
            info.isFile() &&
              !info.isSymbolicLink() &&
              info.nlink === 1 &&
              info.uid === process.getuid() &&
              (info.mode & 0o777) === 0o600 &&
              (await realpath(contract.plistPath)) === contract.plistPath,
            "OPERATOR_PLIST_UNSAFE",
          );
          const plist = JSON.parse(
            (
              await command("/usr/bin/plutil", [
                "-convert",
                "json",
                "-o",
                "-",
                contract.plistPath,
              ])
            ).stdout,
          );
          const expected = await realpath(
            join(
              operatorRoot,
              "home/Library/Application Support/MusicMuteLocal/runtime/releases",
              componentEntry.evidence.runtime_id,
              "runtime/runtime",
              relative(runtimeRoot, tools.python),
            ),
          );
          assert(
            plist.Label === contract.label &&
              plist.ProgramArguments?.[1] === "-m" &&
              plist.ProgramArguments[2] === "musicmute_engine.qualification" &&
              (await realpath(plist.ProgramArguments[0])) === expected &&
              contract.expectedExecutable === expected,
            "OPERATOR_QUALIFICATION_ENTRY_CHANGED",
          );
          assert.equal(
            await hashFile(expected),
            await hashFile(tools.python),
            "OPERATOR_PREPARED_PYTHON_CHANGED",
          );
          await command("/usr/bin/codesign", [
            "--verify",
            "--strict",
            expected,
          ]);
          for (const path of [
            dirname(contract.reportPath),
            contract.releaseRoot,
          ])
            assert(
              (await realpath(path)) === path,
              "OPERATOR_CANONICAL_PATH_REQUIRED",
            );
          operatorRegistry.labels.set(contract.label, contract);
        } else {
          assert(
            record.phase === "confirmed" &&
              ["operator-runner", "qualification"].includes(record.role),
            "OPERATOR_ROOT_ROLE_INVALID",
          );
          const actual = await readOperatorProcess(record.pid);
          assert(
            operatorRootIdentityMatches(record, actual, process.getuid()),
            "OPERATOR_ROOT_IDENTITY_CHANGED",
          );
          if (record.role === "operator-runner")
            assert(
              actual.command === tools.node && actual.group === actual.pid,
              "OPERATOR_RUNNER_EXECUTABLE_CHANGED",
            );
          else {
            const contract = operatorRegistry.labels.get(record.label);
            assert(
              contract &&
                (await readOperatorLabel(contract)).pid === actual.pid &&
                actual.command === contract.expectedExecutable,
              "OPERATOR_QUALIFICATION_ROOT_CHANGED",
            );
          }
          operatorRegistry.roots.set(record.pid, { ...record });
          operatorRegistry.history.push({ ...record });
          if (record.role === "operator-runner")
            report.operator_acceptance.executed = true;
        }
      };
      cleanupOperator = async () => {
        // Only independently validated exact UUID labels can be booted out.
        const bootout = async (contract) => {
          const status = await readOperatorLabel(contract);
          if (!status.loaded) return;
          try {
            await execute(
              "/bin/launchctl",
              ["bootout", `gui/${contract.uid}/${contract.label}`],
              {
                timeout: 5000,
                maxBuffer: 128 * 1024,
                env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
              },
            );
          } catch (error) {
            assert(
              [3, 113].includes(error.code),
              "OPERATOR_LABEL_BOOTOUT_FAILED",
            );
          }
        };
        let error;
        for (const contract of operatorRegistry.labels.values())
          try {
            await bootout(contract);
          } catch (value) {
            error ??= value;
          }
        for (const record of operatorRegistry.roots.values())
          if (record.role === "operator-runner") {
            const actual = await readOperatorProcess(record.pid);
            if (actual) {
              assert(
                operatorRootIdentityMatches(record, actual, process.getuid()),
                "OPERATOR_RUNNER_EXIT_UNCONFIRMED",
              );
              process.kill(record.pid, "SIGTERM");
            }
          }
        const end = performance.now() + 15000;
        for (;;) {
          const rootsAlive = [];
          for (const record of operatorRegistry.roots.values()) {
            const actual = await readOperatorProcess(record.pid);
            if (actual) {
              assert(
                operatorRootIdentityMatches(record, actual, process.getuid()),
                "OPERATOR_ROOT_RECYCLED_DURING_CLEANUP",
              );
              rootsAlive.push(record);
            }
          }
          if (rootsAlive.length === 0) break;
          assert(performance.now() < end, "OPERATOR_ROOT_EXIT_UNCONFIRMED");
          await delay(25);
        }
        // A queued bootstrap cannot outlive its private runner group.
        for (const group of groups)
          if (groupAlive(group)) {
            const current = {
              groupAlive: true,
              group,
              ...(await processStartIdentity(group)),
            };
            assert(
              ownedGroupSignalDecision(groupIdentities.get(group), current) ===
                "SIGNAL_OWNED_GROUP",
              "OPERATOR_GROUP_OWNERSHIP_UNCONFIRMED",
            );
            process.kill(-group, "SIGTERM");
          }
        while ([...groups].some(groupAlive)) {
          assert(performance.now() < end, "OPERATOR_GROUP_EXIT_UNCONFIRMED");
          await delay(25);
        }
        for (const contract of operatorRegistry.labels.values())
          await bootout(contract);
        for (const contract of operatorRegistry.labels.values())
          assert(
            !(await readOperatorLabel(contract)).loaded,
            "OPERATOR_LABEL_EXIT_UNCONFIRMED",
          );
        assert(!error, "OPERATOR_CLEANUP_FAILED");
        const owner = await inspectCurrentOwnership([process.pid]);
        assert(owner.safe, "OPERATOR_CLEANUP_OWNER_UNCONFIRMED");
        return { confirmed: true };
      };
      const assertSafe = async () => {
        runCancellation.signal.throwIfAborted();
        await observe();
      };
      let finished = false,
        operatorResult,
        operatorFailure;
      report.phase = "ORIGINAL_OPERATOR_ACCEPTANCE";
      report.operator_acceptance.module_sha256 = await hashFile(modulePath);
      report.operator_acceptance.execution_attempted = true;
      const operation = operators
        .runWorkerOperatorAcceptance(options, {
          approved: true,
          signal: runCancellation.signal,
          authorize: async (plan) =>
            operatorAcceptance &&
            hostHandoverApproved &&
            !!hostUpdateLock &&
            plan.payload_sha256 === manifest.payload_sha256 &&
            plan.runtime_id === componentEntry.evidence.runtime_id &&
            Object.keys(options).every(
              (key) => plan.options[key] === options[key],
            ),
          assertSafe,
          registerRoot: register,
          observeDescendants: observe,
          cleanupOwned: cleanupOperator,
        })
        .then(
          (value) => {
            operatorResult = value;
            finished = true;
          },
          (error) => {
            operatorFailure = error;
            finished = true;
          },
        );
      try {
        while (!finished) {
          await assertSafe();
          await delay(250);
        }
        await operation;
      } catch (error) {
        runCancellation.cancel();
        await operation;
        throw error;
      }
      if (operatorFailure) throw operatorFailure;
      report.operator_acceptance.result = operatorResult;
      report.operator_acceptance.confirmed_root_history =
        operatorRegistry.history;
    }
    runCancellation.signal.throwIfAborted();
    report.passed = true;
    report.outcome =
      "COPIED_SERVICE_THREE_WARM_MPS_JOBS_COMPLETED_AFTER_CONTROLLER_EOF";
    return report;
  } catch (error) {
    report.passed = false;
    report.outcome = /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.message ?? "")
      ? error.message
      : "MPS_QUALIFICATION_FAILED";
    throw error;
  } finally {
    const cleanupErrors = [];
    let cleanupOwnershipConfirmed = !hostUpdateLock;
    const clean = async (name, action) => {
      try {
        await action();
      } catch {
        cleanupErrors.push(name);
      }
    };
    const discoverCleanupOwnership = async () => {
      if (!hostUpdateLock) return;
      const running = (owned) =>
        owned &&
        owned.child.exitCode === null &&
        owned.child.signalCode === null &&
        Number.isSafeInteger(owned.child.pid);
      try {
        const roots = [
          process.pid,
          ...[service, component]
            .filter(running)
            .map((owned) => owned.child.pid),
        ];
        const owner = await inspectCurrentOwnership(
          roots,
          running(component) ? componentObservation : undefined,
        );
        assert(
          owner.owned_pids && owner.owned_groups,
          "CLEANUP_GPU_OWNER_QUERY_UNAVAILABLE",
        );
        for (const pid of owner.owned_pids)
          if (pid !== process.pid) descendants.add(pid);
        await rememberOwnedGroups(owner);
        cleanupOwnershipConfirmed = owner.safe === true;
      } catch {
        cleanupOwnershipConfirmed = false;
      }
      report.cleanup_gpu_ownership_confirmed = cleanupOwnershipConfirmed;
    };
    // Only approved runs can have this FD. Discover new private children before
    // stopping parents, then refuse stale sampled sets as proof after parent loss.
    await discoverCleanupOwnership();
    if (cleanupOperator)
      await clean("OPERATOR_EXIT_UNCONFIRMED", cleanupOperator);
    for (const owned of [controller, service, component])
      await clean("OWNED_PROCESS_STOP_FAILED", () => stopOwned(owned));
    await discoverCleanupOwnership();
    for (const group of groups)
      await clean("OWNED_GROUP_STOP_FAILED", async () => {
        try {
          const current = groupAlive(group)
            ? {
                groupAlive: true,
                group,
                ...(await processStartIdentity(group)),
              }
            : { groupAlive: false };
          const decision = ownedGroupSignalDecision(
            groupIdentities.get(group),
            current,
          );
          if (decision === "SIGNAL_OWNED_GROUP")
            process.kill(-group, "SIGKILL");
          else
            assert(decision === "EXITED", "OWNED_GROUP_IDENTITY_UNCONFIRMED");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      });
    const allExited = () => {
      try {
        return qualificationExitConfirmed({
          ownershipConfirmed: cleanupOwnershipConfirmed,
          childrenExited: [controller, service, component].every(
            (owned) =>
              !owned ||
              owned.child.exitCode !== null ||
              owned.child.signalCode !== null,
          ),
          pidsExited: ![...descendants].some(alive),
          groupsExited: ![...groups].some(groupAlive),
        });
      } catch {
        return false;
      }
    };
    const deadline = performance.now() + 10_000;
    while (!allExited() && performance.now() < deadline) {
      await delay(250);
      await discoverCleanupOwnership();
    }
    await discoverCleanupOwnership();
    report.owned_private_groups = [...groupHistory];
    report.operator_root_history = operatorRegistry.history;
    report.owned_processes_stopped = allExited();
    if (!report.owned_processes_stopped || cleanupErrors.length) {
      report.cleanup_error = "OWNED_PROCESS_EXIT_UNCONFIRMED";
      if (report.passed) report.outcome = report.cleanup_error;
      report.passed = false;
    }
    if (fixture) {
      await clean("FIXTURE_PERSIST_FAILED", async () => fixture.persist());
      await clean(
        "FIXTURE_CLOSE_FAILED",
        () =>
          new Promise((resolve_) => {
            fixture.server.close(resolve_);
            fixture.server.closeAllConnections();
          }),
      );
    }
    if (hostUpdateLock && !report.owned_processes_stopped) {
      report.host_update_lock.retained_for_unconfirmed_owned_process_exit = true;
      await clean("CLEANUP_PENDING_WRITE_FAILED", () =>
        writeFile(
          join(root, "cleanup-pending.json"),
          JSON.stringify(report) + "\n",
          { mode: 0o600, flag: "wx" },
        ),
      );
      // Retain the actual descriptor even after signal/cleanup failures.
      // Unknown process/group state cannot permit a new legacy helper start.
      while (!allExited()) {
        await delay(1000);
        await discoverCleanupOwnership();
      }
      report.owned_processes_stopped = true;
    }
    if (hostUpdateLock && report.owned_processes_stopped) {
      await clean("HOST_UPDATE_LOCK_RELEASE_FAILED", async () => {
        await hostUpdateLock.close();
        hostUpdateLock = undefined;
        report.host_update_lock.released_after_positive_group_exit = true;
      });
    }
    if (cleanupErrors.length) {
      report.cleanup_errors = cleanupErrors;
      report.passed = false;
    }
    try {
      await writeFile(
        join(root, "acceptance.json"),
        JSON.stringify(report, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    } finally {
      if (report.owned_processes_stopped && !hostUpdateLock)
        runCancellation?.close();
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const values = parseQualificationArguments(process.argv.slice(2));
    const report = await qualifyCopiedWorkerMps(values);
    process.stdout.write(
      JSON.stringify({
        outcome: report.outcome,
        passed: report.passed,
        preflight_passed: report.preflight_passed,
        inference_run: report.inference_run,
        ownership: report.ownership,
        evidence: join(report.output, "acceptance.json"),
      }) + "\n",
    );
    if (values.runMps && !report.passed) process.exitCode = 2;
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,95}$/u.test(error.message ?? "")
      ? error.message
      : "MPS_QUALIFICATION_FAILED";
    process.stderr.write(
      JSON.stringify({ code, inference_success_proven: false }) + "\n",
    );
    process.exitCode = 1;
  }
}
