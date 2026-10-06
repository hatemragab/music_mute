import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  createCompressedWorkerService,
  stageWorkerService,
  verifyCompressedWorkerService,
  verifyWorkerService,
} from "./worker-service-artifact.mjs";

const execute = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-worker-payload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workerRoot = join(root, "worker");
  await mkdir(workerRoot, { mode: 0o755 });
  const put = async (name, value = "export {};\n") => {
    const path = join(workerRoot, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, value, { mode: 0o644 });
  };
  await put(
    "package.json",
    JSON.stringify({
      name: "@music-mute/worker",
      version: "0.1.3",
      type: "module",
      dependencies: { "fixture-dependency": "1.0.0" },
      devDependencies: { "development-only": "1.0.0" },
    }),
  );
  await put("LICENSE", "Synthetic license fixture\n");
  for (const path of [
    "cli/app-control",
    "agent/process-guardian",
    "runtime/worker-runtime",
    "runtime/personal-admission",
  ])
    await put(`dist/src/${path}.js`);
  await put(
    "dist/src/cli/main.js",
    'import { identity } from "fixture-dependency"; import { readFileSync } from "node:fs"; const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url))); process.stdout.write(JSON.stringify({identity,version:pkg.version}));\n',
  );
  await put("dist/protocol/v1/protocol.js");
  for (const name of [
    "__main__",
    "service_doctor",
    "qualification",
    "pipeline",
    "separator",
  ])
    await put(
      `engine/musicmute_engine/${name}.py`,
      "# Synthetic Python module\n",
    );
  await put(
    "engine/musicmute_engine/should-not-copy.onnx",
    "Not model weights\n",
  );
  await put("dist/src/cli/main.js.map", "Synthetic source map\n");
  await put("dist/src/cli/main.d.ts", "Synthetic type declaration\n");
  const installDependencies = async (_, app) => {
    const dependency = join(app, "node_modules", "fixture-dependency");
    await mkdir(dependency, { recursive: true });
    await writeFile(
      join(dependency, "package.json"),
      '{"name":"fixture-dependency","type":"module","exports":"./index.js"}',
    );
    await writeFile(
      join(dependency, "index.js"),
      'export const identity = "isolated-production-closure";\n',
    );
    await writeFile(
      join(dependency, "index.js.map"),
      "Unused production source map\n",
    );
    await writeFile(
      join(dependency, "index.d.ts"),
      "Unused production type declarations\n",
    );
    await writeFile(
      join(app, "node_modules", ".modules.yaml"),
      "storeDir: /a/private/developer/path\n",
    );
    await writeFile(
      join(app, "node_modules", ".pnpm-workspace-state-v1.json"),
      JSON.stringify({
        lastValidatedTimestamp: 1,
        projects: { "/a/private/developer/path": {} },
      }),
    );
  };
  return {
    root,
    workerRoot,
    outputRoot: join(root, "service"),
    installDependencies,
    put,
  };
}

test("complete service executes its production modules without the source checkout", async (t) => {
  const input = await fixture(t);
  const manifest = await stageWorkerService(input);
  assert.equal(manifest.worker_version, "0.1.3");
  assert.ok(
    manifest.entries.some((entry) => entry.path.endsWith("qualification.py")),
  );
  assert.ok(
    manifest.entries.some((entry) =>
      entry.path.includes("fixture-dependency/index.js"),
    ),
  );
  assert.ok(
    !manifest.entries.some((entry) =>
      /\.onnx$|\.map$|\.d\.ts$|\.modules\.yaml$|\.pnpm-workspace-state-v1\.json$/.test(
        entry.path,
      ),
    ),
  );
  assert.equal(
    (await verifyWorkerService(input.outputRoot)).payload_sha256,
    manifest.payload_sha256,
  );
  const pkg = JSON.parse(
    await readFile(join(input.outputRoot, "app/package.json"), "utf8"),
  );
  assert.equal(pkg.devDependencies, undefined);
  await rm(input.workerRoot, { recursive: true });
  const { stdout } = await execute(
    process.execPath,
    [join(input.outputRoot, "app/dist/src/cli/main.js")],
    {
      cwd: input.root,
      timeout: 5000,
      maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    },
  );
  assert.deepEqual(JSON.parse(stdout), {
    identity: "isolated-production-closure",
    version: "0.1.3",
  });
});

test("package-manager validation metadata cannot change the portable payload identity", async (t) => {
  const input = await fixture(t);
  const original = input.installDependencies;
  let installs = 0;
  input.installDependencies = async (...args) => {
    await original(...args);
    installs += 1;
    await writeFile(
      join(args[1], "node_modules", ".pnpm-workspace-state-v1.json"),
      JSON.stringify({
        lastValidatedTimestamp: installs,
        projects: { [`/private/developer-${installs}/checkout`]: {} },
      }),
    );
  };
  const first = await stageWorkerService(input);
  const secondRoot = join(input.root, "second-service");
  const second = await stageWorkerService({ ...input, outputRoot: secondRoot });
  assert.equal(installs, 2);
  assert.equal(first.payload_sha256, second.payload_sha256);
  assert.deepEqual(first.entries, second.entries);
  for (const root of [input.outputRoot, secondRoot]) {
    await assert.rejects(
      readFile(join(root, "app/node_modules/.pnpm-workspace-state-v1.json")),
      { code: "ENOENT" },
    );
    assert.equal(
      (await verifyWorkerService(root)).payload_sha256,
      first.payload_sha256,
    );
  }
});

test("payload verification detects altered code and unexpected files", async (t) => {
  const input = await fixture(t);
  await stageWorkerService(input);
  await writeFile(
    join(input.outputRoot, "app/dist/src/runtime/worker-runtime.js"),
    "export const changed = true;\n",
  );
  await assert.rejects(
    verifyWorkerService(input.outputRoot),
    /WORKER_SERVICE_INVENTORY_MISMATCH/,
  );
});

test("service staging rejects escaping production links without publishing partial output", async (t) => {
  const input = await fixture(t);
  const original = input.installDependencies;
  input.installDependencies = async (...args) => {
    await original(...args);
    await symlink("../../../worker", join(args[1], "node_modules", "foreign"));
  };
  await assert.rejects(
    stageWorkerService(input),
    /WORKER_PAYLOAD_SYMLINK_UNSAFE/,
  );
  await assert.rejects(
    readFile(join(input.outputRoot, "service-manifest.json")),
    { code: "ENOENT" },
  );
});

test("controller-only payload and private credential material are rejected", async (t) => {
  const input = await fixture(t);
  await rm(join(input.workerRoot, "engine/musicmute_engine/qualification.py"));
  await assert.rejects(stageWorkerService(input), /WORKER_SERVICE_INCOMPLETE/);
  await input.put(
    "engine/musicmute_engine/qualification.py",
    "# Qualification fixture\n",
  );
  await input.put(
    "dist/src/runtime/machine.credential",
    "Synthetic forbidden material\n",
  );
  await assert.rejects(
    stageWorkerService(input),
    /WORKER_PAYLOAD_FORBIDDEN_FILE/,
  );
});

test("existing service output is preserved rather than replaced implicitly", async (t) => {
  const input = await fixture(t);
  await stageWorkerService(input);
  const before = await readFile(
    join(input.outputRoot, "service-manifest.json"),
  );
  await assert.rejects(
    stageWorkerService(input),
    /WORKER_SERVICE_OUTPUT_EXISTS/,
  );
  assert.deepEqual(
    await readFile(join(input.outputRoot, "service-manifest.json")),
    before,
  );
});

test("compressed app payload materializes into a complete standalone service", async (t) => {
  const input = await fixture(t);
  const service = await stageWorkerService(input);
  const compact = join(input.root, "compact");
  const archive = await createCompressedWorkerService({
    sourceRoot: input.outputRoot,
    outputRoot: compact,
  });
  assert.equal(archive.payload_sha256, service.payload_sha256);
  assert.equal(
    (await verifyCompressedWorkerService(compact)).archive.sha256,
    archive.sha256,
  );
  const extracted = join(input.root, "extracted");
  await mkdir(extracted);
  await execute(
    "/usr/bin/unzip",
    ["-q", join(compact, "service-payload.zip"), "-d", extracted],
    {
      timeout: 5000,
      maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    },
  );
  await writeFile(
    join(extracted, "service-manifest.json"),
    await readFile(join(compact, "service-manifest.json")),
  );
  assert.equal(
    (await verifyWorkerService(extracted)).payload_sha256,
    service.payload_sha256,
  );
  await rm(input.outputRoot, { recursive: true });
  await rm(input.workerRoot, { recursive: true });
  const { stdout } = await execute(
    process.execPath,
    [join(extracted, "app/dist/src/cli/main.js")],
    {
      timeout: 5000,
      maxBuffer: 4096,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    },
  );
  assert.equal(JSON.parse(stdout).identity, "isolated-production-closure");
  await writeFile(
    join(compact, "service-payload.zip"),
    "Corrupt owned archive\n",
  );
  await assert.rejects(
    verifyCompressedWorkerService(compact),
    /WORKER_SERVICE_ARCHIVE_HASH_INVALID/,
  );
});

test("native dependencies require signing in a detached payload and bind the new bytes", async (t) => {
  const input = await fixture(t);
  const original = input.installDependencies;
  input.installDependencies = async (...args) => {
    await original(...args);
    await writeFile(
      join(args[1], "node_modules/fixture-dependency/parser.node"),
      "Synthetic native fixture\n",
    );
  };
  const service = await stageWorkerService(input);
  const source = join(
    input.outputRoot,
    "app/node_modules/fixture-dependency/parser.node",
  );
  const before = await readFile(source);
  const compact = join(input.root, "compact");
  await assert.rejects(
    createCompressedWorkerService({
      sourceRoot: input.outputRoot,
      outputRoot: compact,
    }),
    /WORKER_NATIVE_SIGNER_REQUIRED/,
  );
  const visited = [];
  const result = await createCompressedWorkerService({
    sourceRoot: input.outputRoot,
    outputRoot: compact,
    signNative: async (path) => {
      visited.push(path);
      assert.notEqual(path, source);
      await writeFile(path, "Synthetic signed native fixture\n");
    },
  });
  assert.equal(visited.length, 1);
  assert.equal(result.native_binaries, 1);
  assert.notEqual(result.payload_sha256, service.payload_sha256);
  assert.deepEqual(await readFile(source), before);
  assert.equal(
    (await verifyCompressedWorkerService(compact)).service.payload_sha256,
    result.payload_sha256,
  );
});
