// Synthetic audio only; read an existing prepared runtime/model without installing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  stat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { build } from "esbuild";
const repository = resolve(import.meta.dirname, "..");
const root = join(repository, "output", `local-engine-${randomUUID()}.noindex`);
await mkdir(root, { mode: 0o700, recursive: true });
await chmod(root, 0o700);
const modulePath = join(root, "engine-client.mjs");
await build({
  stdin: {
    contents: `export { runLocalEngine } from "./src/companion/local-engine.ts"; export { LocalMacProvider } from "./src/companion/local-provider.ts";`,
    resolveDir: repository,
  },
  outfile: modulePath,
  bundle: true,
  platform: "node",
  format: "esm",
});
const { runLocalEngine, LocalMacProvider } = await import(modulePath);
const installed = join(homedir(), "Library/Application Support/MusicMuteLocal");
const active = JSON.parse(
  await readFile(join(installed, "runtime/active.json"), "utf8"),
);
const runtime = join(
  installed,
  "runtime/releases",
  active.runtime_id ?? active.id,
  "runtime",
);
const config = {
  root,
  cache_root: join(root, "cache"),
  logs_root: join(root, "logs"),
  models_root: join(installed, "models"),
  runtime_root: runtime,
  runner_path: join(repository, "engine/local_pipeline.py"),
  python_path: join(runtime, "runtime/python/bin/python3"),
  node_path: process.execPath,
  engine_root: join(runtime, "app/engine"),
  ffmpeg_path: join(runtime, "runtime/bin/ffmpeg"),
  ffprobe_path: join(runtime, "runtime/bin/ffprobe"),
};
const results = [];
let pid;
let lastInput;
try {
  for (let index = 0; index < 2; index++) {
    const work = join(root, "cache/jobs", randomUUID());
    await mkdir(work, { mode: 0o700, recursive: true });
    const input = join(work, "source.wav");
    execFileSync(config.ffmpeg_path, [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=8:sample_rate=44100",
      "-ac",
      "2",
      input,
    ]);
    await chmod(input, 0o600);
    lastInput = input;
    const digest = createHash("sha256")
      .update(await readFile(input))
      .digest("base64");
    const start = performance.now();
    const result = await runLocalEngine(config, input, work, digest, {
      signal: AbortSignal.timeout(180000),
      onEvent() {},
      onSpawn(value) {
        if (pid) assert.equal(value, pid);
        pid = value;
      },
    });
    assert.equal(result.localEngineWarm, index === 1);
    assert.equal((await stat(result.outputPath)).mode & 0o777, 0o600);
    assert.equal(
      createHash("sha256")
        .update(await readFile(result.outputPath))
        .digest("base64"),
      result.sha256,
    );
    results.push({
      warm: result.localEngineWarm,
      elapsed_ms: performance.now() - start,
      stages: result.stageTimings,
    });
  }
  const work = join(root, "cache/jobs", randomUUID());
  await mkdir(work, { mode: 0o700, recursive: true });
  const input = join(work, "source.wav");
  await copyFile(lastInput, input);
  let warm = false;
  const audio = await new LocalMacProvider(config).prepareOwnedAudio(
    input,
    8,
    work,
    {
      signal: AbortSignal.timeout(180000),
      onProgress() {},
      onDiagnostic(event) {
        if (event.metrics?.local_engine_warm === true) warm = true;
      },
    },
  );
  assert.equal(warm, true);
  assert.equal(audio.trim_enabled, false);
  assert.equal(
    createHash("sha256")
      .update(await readFile(audio.output_path))
      .digest("hex"),
    audio.sha256,
  );
  results.push({ provider_verified: true, warm, stages: audio.timings_ms });
  await writeFile(
    join(root, "result.json"),
    JSON.stringify({ synthetic: true, results }, null, 2),
  );
  console.log(JSON.stringify({ output: root, results }));
} finally {
  const name = createHash("sha256")
    .update(await realpath(root))
    .digest("hex")
    .slice(0, 24);
  const path = join(
    await realpath("/tmp"),
    `mm-engine-${process.getuid()}-${name}`,
    "engine.sock",
  );
  await new Promise((done) => {
    const socket = createConnection({ path });
    socket.once("error", done);
    socket.once("data", () => socket.end('{"operation":"retire"}\n'));
    socket.once("close", done);
  });
}
