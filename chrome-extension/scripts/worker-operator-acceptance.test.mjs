import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { inventoryWorkerService } from "./worker-service-artifact.mjs";
import {
  OPERATOR_FIXTURE,
  attachOperatorCancellation,
  dispatchOriginalOperatorSteps,
  operatorLaunchctlArguments,
  operatorOptions,
  operatorProcessIdentity,
  parseOperatorArguments,
  projectOperatorQualificationPlist,
  runWorkerOperatorAcceptance,
  verifyOperatorFixture,
  waitForOperatorExecutable,
} from "./worker-operator-acceptance.mjs";

const fixtureSource = join(
  homedir(),
  "Library/Application Support/MusicMuteWorker/state/qualification.wav",
);
async function isolated(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "mm-operator-unit-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    serviceRoot: join(root, "service"),
    resourcesRoot: join(root, "resources"),
    preparedSupportRoot: join(root, "prepared"),
    fixturePath: join(root, "qualification.wav"),
    outputRoot: join(root, "new-output"),
  };
  for (const path of [
    options.serviceRoot,
    options.resourcesRoot,
    options.preparedSupportRoot,
  ])
    await mkdir(path, { mode: 0o700 });
  const packageText = JSON.stringify({
    name: "@music-mute/worker",
    version: "0.1.3",
    type: "module",
  });
  const files = [
    "package.json",
    "dist/package.json",
    "dist/src/cli/main.js",
    "dist/src/cli/app-control.js",
    "dist/src/agent/process-guardian.js",
    "dist/src/runtime/worker-runtime.js",
    "dist/src/runtime/personal-admission.js",
    "dist/protocol/v1/protocol.js",
    "engine/musicmute_engine/__main__.py",
    "engine/musicmute_engine/service_doctor.py",
    "engine/musicmute_engine/qualification.py",
    "engine/musicmute_engine/pipeline.py",
    "engine/musicmute_engine/separator.py",
    "LICENSE",
  ];
  for (const name of files) {
    const path = join(options.serviceRoot, "app", name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      name.endsWith("package.json")
        ? packageText
        : "// NEVER EXECUTE THIS SYNTHETIC FIXTURE\n",
      { mode: 0o644 },
    );
  }
  const entries = await inventoryWorkerService(options.serviceRoot);
  const manifest = {
    schema_version: 1,
    platform: "darwin",
    architecture: "arm64",
    worker_version: "0.1.3",
    api_version: 1,
    entries,
    payload_sha256: createHash("sha256")
      .update(JSON.stringify(entries))
      .digest("hex"),
  };
  await writeFile(
    join(options.serviceRoot, "service-manifest.json"),
    JSON.stringify(manifest),
  );
  await mkdir(join(options.resourcesRoot, "worker/service"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    join(options.resourcesRoot, "worker/service/service-manifest.json"),
    JSON.stringify(manifest),
  );
  await writeFile(
    join(options.resourcesRoot, "runtime-bootstrap.json"),
    JSON.stringify({
      schema_version: 1,
      runtime: { id: "fixture-runtime-v1", platform: "darwin", arch: "arm64" },
    }),
  );
  await copyFile(fixtureSource, options.fixturePath);
  return options;
}
const label = `com.musicmute.qualification.${randomUUID()}`;

test("closed plan flags cannot authorize standalone execution or arbitrary paths", () => {
  const value = {
    serviceRoot: "/tmp/service",
    resourcesRoot: "/tmp/resources",
    preparedSupportRoot: "/tmp/prepared",
    fixturePath: "/tmp/qualification.wav",
    outputRoot: "/tmp/new-output",
  };
  assert.deepEqual(operatorOptions(value), value);
  for (const invalid of [
    { ...value, run: true },
    { ...value, outputRoot: "/" },
    { ...value, outputRoot: "relative" },
    { ...value, fixturePath: "/tmp/a\nsecret" },
    { ...value, resourcesRoot: "/tmp/../resources" },
  ])
    assert.throws(() => operatorOptions(invalid));
  for (const args of [
    ["--run"],
    ["--private-runner"],
    ["--execute", "true"],
    ["--service-root", "/tmp/a", "--service-root", "/tmp/b"],
  ])
    assert.throws(() => parseOperatorArguments(args));
});

test("only a unique qualification plist can be projected; fleet and canonical targets are refused", () => {
  const plist =
    "<string>com.musicmute.worker</string><string>musicmute_engine.qualification</string>";
  assert(projectOperatorQualificationPlist(plist, label).includes(label));
  for (const invalid of [
    plist + "<key>KeepAlive</key>",
    plist + "<string>com.musicmute.worker</string>",
    plist.replace("qualification", "child"),
  ])
    assert.throws(() => projectOperatorQualificationPlist(invalid, label));
  for (const action of ["kill", "kickstart", "enable", "disable"])
    assert.throws(() => operatorLaunchctlArguments(action, 501, label));
  assert.throws(() =>
    operatorLaunchctlArguments("bootout", 501, "com.musicmute.worker"),
  );
  assert.throws(() =>
    operatorLaunchctlArguments(
      "print",
      501,
      `com.musicmute.qualification.${"-".repeat(36)}`,
    ),
  );
  assert.deepEqual(operatorLaunchctlArguments("bootout", 501, label), [
    "bootout",
    `gui/501/${label}`,
  ]);
});

test("root ownership requires matching PID, UID, start identity and safe process group", () => {
  const row = `${process.getuid()} 123 1 123 Tue Oct  6 01:23:45 2026 /private/prepared/python3`;
  assert.equal(
    operatorProcessIdentity(row, 123).start,
    "Tue Oct  6 01:23:45 2026",
  );
  assert.throws(() => operatorProcessIdentity(row, 124));
  assert.throws(() =>
    operatorProcessIdentity(row.replace(String(process.getuid()), "0"), 123),
  );
  assert.throws(() =>
    operatorProcessIdentity(row.replace(" 123 Tue", " 1 Tue"), 123),
  );
  assert.throws(() => operatorProcessIdentity("unknown", 123));
});

test("cancellation invokes owned cleanup once and removing the subscription is effective", () => {
  const controller = new AbortController();
  let stops = 0;
  attachOperatorCancellation(controller.signal, () => stops++);
  controller.abort();
  controller.abort();
  assert.equal(stops, 1);
  assert.throws(() =>
    attachOperatorCancellation(controller.signal, () => stops++),
  );
  const second = new AbortController();
  const remove = attachOperatorCancellation(second.signal, () => stops++);
  remove();
  second.abort();
  assert.equal(stops, 1);
});

test("qualification PID registration waits out proxy/root startup and requires the exact prepared executable", async () => {
  const expected = "/private/owned/prepared/python3.13";
  const ready = { uid: process.getuid(), pid: 123, command: expected };
  const records = [
    { uid: 0, pid: 123, command: "/usr/libexec/xpcproxy" },
    { uid: process.getuid(), pid: 123, command: "/usr/libexec/xpcproxy" },
    ready,
  ];
  let pauses = 0;
  assert.equal(
    await waitForOperatorExecutable(
      async () => records.shift(),
      expected,
      3,
      async () => pauses++,
    ),
    ready,
  );
  assert.equal(pauses, 2);
  await assert.rejects(
    waitForOperatorExecutable(
      async () => ({
        uid: process.getuid(),
        pid: 123,
        command: "/usr/bin/python3",
      }),
      expected,
      2,
      async () => {},
    ),
    /PID_UNCONFIRMED/u,
  );
});

test("failed genuine two-worker dispatch cannot select capacity two or create a forced PASS", async () => {
  const calls = [];
  const run = async (command, args, context) => {
    calls.push({ command, args });
    if (command === "benchmark" && args[1] === "2")
      throw new Error("hardware gate failed");
    context.stdout(JSON.stringify({ status: "PASS" }));
    return 0;
  };
  await assert.rejects(
    dispatchOriginalOperatorSteps(
      run,
      { fixturePath: "/private/owned/qualification.wav" },
      "/private/owned",
    ),
    /hardware gate failed/u,
  );
  assert.equal(calls.length, 4);
  assert(calls.every((call) => call.command !== "capacity"));
});

test("original dispatcher receives closed genuine command arguments with no inference/qualification overrides", async () => {
  const calls = [];
  const context = {
    fixturePath: "/private/isolated/qualification.wav",
    layout: {},
    launchAgent: {},
  };
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    for (const forbidden of [
      "benchmark",
      "benchmarkFile",
      "qualify",
      "capacityBenchmark",
      "runProcess",
      "beforeWorkerLoad",
    ])
      assert(!Object.hasOwn(options, forbidden));
    options.stdout(
      JSON.stringify(
        command === "capacity"
          ? { workerIds: args[1] === "1" ? ["first"] : ["first", "second"] }
          : { status: "PASS" },
      ),
    );
    return 0;
  };
  const result = await dispatchOriginalOperatorSteps(
    run,
    context,
    "/private/isolated",
  );
  assert.deepEqual(
    calls.map((call) => call.command),
    [
      "benchmark",
      "benchmark-file",
      "benchmark-file",
      "benchmark",
      "capacity",
      "capacity",
      "capacity",
    ],
  );
  assert.equal(
    calls[1].args[calls[1].args.indexOf("--recipe") + 1],
    "kim-vocals-v2",
  );
  assert.equal(
    calls[2].args[calls[2].args.indexOf("--recipe") + 1],
    "kim-vocals-v2-trim",
  );
  assert.deepEqual(calls[0].args, ["--workers", "1", "--json"]);
  assert.deepEqual(calls[3].args, ["--workers", "2", "--json"]);
  assert.equal(result.length, 7);
  await assert.rejects(
    dispatchOriginalOperatorSteps(run, context, "/private/isolated", () => {
      throw new Error("cancelled");
    }),
    /cancelled/u,
  );
});

test(
  "default validation never creates output, forks, calls approval hooks or executes fixture modules",
  { skip: !existsSync(fixtureSource) },
  async (t) => {
    const options = await isolated(t);
    const forbidden = () => {
      throw new Error("EXECUTION_FORBIDDEN");
    };
    const plan = await runWorkerOperatorAcceptance(options, {
      authorize: forbidden,
      assertSafe: forbidden,
      registerRoot: forbidden,
    });
    assert.equal(plan.execution_started, false);
    assert.equal(plan.fixture.sha256, OPERATOR_FIXTURE.sha256);
    await assert.rejects(lstat(options.outputRoot), { code: "ENOENT" });
    await assert.rejects(
      runWorkerOperatorAcceptance(options, { approved: true }),
      /OPERATOR_APPROVED_CONTEXT_REQUIRED/u,
    );
  },
);

test(
  "aborted approved context and mismatching code/fixture fail before child creation",
  { skip: !existsSync(fixtureSource) },
  async (t) => {
    const options = await isolated(t);
    const controller = new AbortController();
    controller.abort();
    const forbidden = () => {
      throw new Error("EXECUTION_FORBIDDEN");
    };
    await assert.rejects(
      runWorkerOperatorAcceptance(options, {
        approved: true,
        signal: controller.signal,
        authorize: forbidden,
        assertSafe: forbidden,
        registerRoot: forbidden,
        observeDescendants: forbidden,
        cleanupOwned: forbidden,
      }),
    );
    await assert.rejects(lstat(options.outputRoot), { code: "ENOENT" });
    await writeFile(options.fixturePath, Buffer.alloc(OPERATOR_FIXTURE.bytes));
    await assert.rejects(
      verifyOperatorFixture(options.fixturePath),
      /IDENTITY_CHANGED/u,
    );
    await copyFile(fixtureSource, options.fixturePath);
    const manifestPath = join(
      options.resourcesRoot,
      "worker/service/service-manifest.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath));
    manifest.payload_sha256 = "f".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      runWorkerOperatorAcceptance(options),
      /SERVICE_IDENTITY_CHANGED/u,
    );
  },
);

test(
  "cancellation during runner creation still terminates the owned child and awaits cleanup",
  { skip: !existsSync(fixtureSource) },
  async (t) => {
    const options = await isolated(t),
      controller = new AbortController();
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    let killed = 0,
      cleaned = 0;
    child.kill = (signal) => {
      killed++;
      child.signalCode = signal;
      child.emit("exit", null, signal);
    };
    const context = {
      approved: true,
      signal: controller.signal,
      authorize: async () => true,
      assertSafe: async () => {},
      registerRoot: () => {
        throw new Error("NO_IDENTITY_REGISTERED");
      },
      observeDescendants: () => {
        throw new Error("NO_IDENTITY_REGISTERED");
      },
      cleanupOwned: async (records) => {
        cleaned++;
        assert.deepEqual(records.roots, []);
        return { confirmed: true };
      },
    };
    await assert.rejects(
      runWorkerOperatorAcceptance(options, context, {
        forkChild: () => {
          controller.abort();
          return child;
        },
      }),
    );
    assert.equal(killed, 1);
    assert.equal(cleaned, 1);
  },
);

test("standalone execution flag is rejected with a bounded safe error", async () => {
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      join(import.meta.dirname, "worker-operator-acceptance.mjs"),
      "--run",
    ]),
    (error) =>
      error.stderr.trim() === "OPERATOR_PLAN_INVALID" && error.stdout === "",
  );
});
