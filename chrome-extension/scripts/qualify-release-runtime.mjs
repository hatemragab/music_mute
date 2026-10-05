// Full synthetic inference with the distribution-signed tools. No user media,
// credentials, browser changes, model downloads or worker-fleet configuration.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  resolveSigningConfiguration,
  verifyDeveloperIdSignature,
} from "./macos-signing.mjs";
import {
  stageExternalRuntimeForQualification,
  verifyExternalRuntimeForQualification,
} from "./external-runtime-qualification.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const digest =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
const modelBytes = 66_759_214;
const output = join(
  root,
  "output/release-runtime-proof",
  `${randomUUID()}.noindex`,
);
const report = {
  schema_version: 1,
  scope: "DEVELOPER_ID_SIGNED_SYNTHETIC_TEN_SECOND_MPS_INFERENCE",
  passed: false,
  network_allowed: false,
  model_downloaded: false,
  user_media_used: false,
  browser_tested: false,
  notarization_proven: false,
};

try {
  assert.ok(
    process.platform === "darwin" && process.arch === "arm64",
    "UNSUPPORTED_PLATFORM",
  );
  const args = process.argv.slice(2);
  assert.ok(
    args.length === 4 &&
      args[0] === "--app" &&
      args[2] === "--model" &&
      isAbsolute(args[1]) &&
      isAbsolute(args[3]),
    "INVALID_RELEASE_RUNTIME_ARGUMENTS",
  );
  const app = await realpath(args[1]);
  const model = await realpath(args[3]);
  const info = await lstat(model);
  assert.ok(
    info.isFile() &&
      info.size === modelBytes &&
      info.uid === process.getuid() &&
      !(info.mode & 0o077),
    "QUALIFICATION_MODEL_UNSAFE",
  );
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(model)) hash.update(chunk);
  assert.equal(hash.digest("hex"), digest, "QUALIFICATION_MODEL_INVALID");
  const signing = await resolveSigningConfiguration({
    release: true,
    identity: process.env.MUSICMUTE_MAC_SIGN_IDENTITY,
    exec,
  });
  const signature = await verifyDeveloperIdSignature(app, signing, {
    exec,
    kind: "app",
  });
  await mkdir(output, { recursive: true, mode: 0o700 });
  const home = join(output, "home");
  const state = join(output, "state");
  const modelRoot = join(state, "models", digest);
  await mkdir(home, { mode: 0o700 });
  await mkdir(modelRoot, { recursive: true, mode: 0o700 });
  await copyFile(
    model,
    join(modelRoot, "Kim_Vocal_2.onnx"),
    constants.COPYFILE_FICLONE,
  );
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
  const node = join(runtimeRoot, "runtime/node/bin/node");
  // The harness stays outside the immutable app. Its own output uses this
  // component's ignored output directory; all engine work uses private state.
  const benchmark = join(root, "dist/companion/benchmark.js");
  const policy = `(version 1) (allow default) (deny network*) (deny file-write* (subpath ${JSON.stringify(dirname(app))})) (deny file-write* (subpath ${JSON.stringify(dirname(activePath))}))`;
  const before = await exec(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", app],
    { timeout: 120_000, maxBuffer: 256 * 1024 },
  );
  assert.equal(
    before.stderr.includes("invalid"),
    false,
    "RELEASE_SIGNATURE_INVALID",
  );
  const bundleModule = pathToFileURL(
    join(root, "dist/companion/downloader-bundle.js"),
  ).href;
  await exec(
    node,
    [
      "--input-type=module",
      "-e",
      `import { verifyDownloaderBundle } from ${JSON.stringify(bundleModule)};
     const uid = process.getuid(); process.getuid = () => uid + 1;
     await verifyDownloaderBundle(${JSON.stringify(join(runtimeRoot, "tools/downloader"))}, true, ${JSON.stringify(join(resources, "engine/downloader_bootstrap.py"))});`,
    ],
    {
      timeout: 30_000,
      maxBuffer: 32 * 1024,
      env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
    },
  );
  report.packaged_downloader_different_user_verified = true;
  const result = await exec(
    "/usr/bin/sandbox-exec",
    ["-p", policy, node, benchmark, "--duration", "10", "--format", "mp3"],
    {
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        TMPDIR: output,
        MUSICMUTE_LOCAL_ROOT: state,
        MUSICMUTE_LOCAL_APP_RESOURCES: resources,
      },
      timeout: 240_000,
      maxBuffer: 512 * 1024,
    },
  );
  const matched = /^(\{[\s\S]*?\n\})\s*\n\{"diagnostics_path":/.exec(
    result.stdout,
  );
  assert.ok(matched, "RELEASE_INFERENCE_RESULT_INVALID");
  const inference = JSON.parse(matched[1]);
  assert.ok(
    inference.passed === true &&
      inference.runtime_scope === "PACKAGED_APP" &&
      inference.source_samples === inference.output_samples &&
      inference.trim_enabled === false,
    "RELEASE_INFERENCE_FAILED",
  );
  await verifyExternalRuntimeForQualification({
    releaseRoot,
    activePath,
    runtime,
    packageResult,
  });
  await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
    timeout: 120_000,
    maxBuffer: 256 * 1024,
  });
  Object.assign(report, {
    passed: true,
    signing: signature,
    signature_intact_after_inference: true,
    runtime_immutable_after_inference: true,
    source_samples: inference.source_samples,
    output_samples: inference.output_samples,
    wall_ms: inference.wall_ms,
    engine_peak_rss_bytes: inference.engine_peak_rss_bytes,
    removed_samples: inference.removed_samples,
    stage_timings: inference.stage_timings,
  });
} catch (error) {
  const code =
    error instanceof Error && /^[A-Z][A-Z_0-9]{2,80}$/.test(error.message)
      ? error.message
      : "RELEASE_RUNTIME_QUALIFICATION_FAILED";
  report.error_code = code;
  // Bounded child stderr is counted, never persisted or displayed verbatim.
  if (typeof error?.stderr === "string")
    report.stderr_bytes = Buffer.byteLength(error.stderr);
  process.exitCode = 1;
}
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(
  join(output, "result.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(
  `${JSON.stringify({ ...report, report_path: join(output, "result.json") }, null, 2)}\n`,
);
