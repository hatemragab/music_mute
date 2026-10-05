// Offline qualification: no YouTube, cloud, cookies, account state or inference.
import assert from "node:assert/strict";
import { build } from "esbuild";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { youtubeRuntimeInventory } from "./youtube-runtime-artifacts.mjs";

const source = resolve(import.meta.dirname, "..");
const proof = join(
  source,
  "output/youtube-runtime-proof.noindex",
  randomUUID(),
);
await mkdir(proof, { recursive: true, mode: 0o700 });
const runtimeSetting = process.env.MUSICMUTE_LOCAL_RUNTIME;
assert.ok(
  runtimeSetting && isAbsolute(runtimeSetting),
  "MUSICMUTE_LOCAL_RUNTIME_REQUIRED",
);
const runtime = await realpath(runtimeSetting).catch(() => {
  throw new Error("MUSICMUTE_LOCAL_RUNTIME_UNAVAILABLE");
});
const runtimeInfo = await lstat(runtimeSetting);
assert.ok(
  runtime === runtimeSetting &&
    runtimeInfo.isDirectory() &&
    !runtimeInfo.isSymbolicLink() &&
    runtimeInfo.uid === process.getuid?.() &&
    !(runtimeInfo.mode & 0o022),
  "MUSICMUTE_LOCAL_RUNTIME_UNSAFE",
);
const youtube =
  process.env.MUSICMUTE_YOUTUBE_RUNTIME_TARGET ??
  join(source, "output/youtube-runtime.noindex");
const downloader =
  process.env.MUSICMUTE_LOCAL_DOWNLOADER_TARGET ??
  join(source, "output/downloader-runtime-v2.noindex");
const modulePath = join(proof, "config.mjs");
await build({
  entryPoints: [join(source, "src/companion/config.ts")],
  outfile: modulePath,
  platform: "node",
  target: "node24",
  format: "esm",
  bundle: true,
});
const { inspectYouTubeReadiness } = await import(
  pathToFileURL(modulePath).href
);
const scratch = await mkdtemp(join(proof, "private-state-"));
const config = {
  root: scratch,
  cache_root: join(scratch, "cache"),
  logs_root: join(scratch, "logs"),
  models_root: join(scratch, "models"),
  python_path: join(runtime, "runtime/python/bin/python3"),
  node_path: join(runtime, "runtime/node/bin/node"),
  ffmpeg_path: join(runtime, "runtime/bin/ffmpeg"),
  ffprobe_path: join(runtime, "runtime/bin/ffprobe"),
  yt_dlp_path: join(runtime, "runtime/python/bin/python3"),
  downloader_bundle_root: downloader,
  js_runtime_path: join(youtube, "bin/deno"),
  js_runtime_kind: "deno",
  youtube_runtime_root: youtube,
  engine_root: join(runtime, "app/engine"),
  runner_path: join(source, "engine/local_pipeline.py"),
};
const before = await youtubeRuntimeInventory(youtube);
const events = [];
try {
  await inspectYouTubeReadiness(config, undefined, (event) =>
    events.push(event),
  );
  assert.deepEqual(
    events
      .filter((event) => event.state === "completed")
      .map((event) => event.probe),
    [
      "downloader-version",
      "downloader-help",
      "downloader-ejs",
      "javascript-runtime",
      "token-provider",
    ],
  );
  assert.deepEqual(
    await youtubeRuntimeInventory(youtube),
    before,
    "bundled runtime mutated during offline execution",
  );
  assert.deepEqual(
    await readFile(join(youtube, "identity.json"), "utf8")
      .then(JSON.parse)
      .then((identity) => identity.files),
    before,
  );
  const report = {
    scope: "OFFLINE_BUNDLED_DOWNLOADER_DENO_EJS_PROVIDER_CANVAS",
    ready: true,
    network_calls: 0,
    live_source_requests: 0,
    tool_identity_immutable: true,
    token_cache_disposable: true,
    processing_runtime_source: "EXPLICIT_CANONICAL_EXTERNAL_ROOT",
    probes: events,
    source_identity: "guest-mweb-explicit-pinned-provider-no-browser-cookies",
    limitations: [
      "Synthetic signature/n challenge proves bundled execution, not current YouTube player compatibility or guest acceptance.",
    ],
  };
  await writeFile(
    join(proof, "result.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      ready: true,
      proof: join(proof, "result.json"),
      probes: report.probes
        .filter((event) => event.state === "completed")
        .map((event) => event.probe),
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({ ready: false, error_code: error.code, probes: events }),
  );
  throw error;
} finally {
  await rm(scratch, { recursive: true, force: true });
}
