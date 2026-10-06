import { randomUUID } from "node:crypto";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyCompressedWorkerService } from "./worker-service-artifact.mjs";

/** Exercise final packaged code in the caller's disposable, offline sandbox. */
export async function qualifyPackagedWorker({
  resources,
  home,
  state,
  output,
  node,
  policy,
  env,
  run,
}) {
  const compact = join(resources, "worker/service");
  await verifyCompressedWorkerService(compact);
  const extracted = join(output, "worker-source");
  await mkdir(extracted, { mode: 0o700 });
  const extraction = await run(
    "PACKAGED_WORKER_EXTRACT",
    "/usr/bin/unzip",
    ["-q", join(compact, "service-payload.zip"), "-d", extracted],
    { env },
  );
  if (extraction.exitCode !== 0 || extraction.signal)
    throw new Error("PACKAGED_WORKER_EXTRACTION_FAILED");
  await cp(
    join(compact, "service-manifest.json"),
    join(extracted, "service-manifest.json"),
    { errorOnExist: true, force: false },
  );
  const module = (path) =>
    JSON.stringify(pathToFileURL(join(extracted, "app/dist/src", path)).href);
  const quoted = JSON.stringify;
  const controller = pathToFileURL(
    join(resources, "worker/controller.js"),
  ).href;
  const proofCode = `
import assert from "node:assert/strict";
import { readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runAppControlSession } from ${quoted(controller)};
import { createMacUserLayout, createMacUserDirectories } from ${module("platform/macos/user-paths.js")};
import { stageMacAppService, verifyManagedMacRelease, verifyAppServicePayload,
  resolveMacAppExecutionLayout, publishMacAppRuntimeReference } from ${module("platform/macos/app-installation-binding.js")};
import { writeLaunchAgentPlist } from ${module("platform/macos/launch-agent.js")};
import { APP_COMMANDS } from ${module("platform/macos/app-control-protocol.js")};
const home = ${quoted(home)}, support = ${quoted(state)};
const layout = createMacUserLayout(home);
await createMacUserDirectories(layout);
const source = await verifyAppServicePayload(${quoted(extracted)});
assert.equal(APP_COMMANDS.length, 25);
const staged = await stageMacAppService(layout, ${quoted(resources)}, support);
const binding = await verifyManagedMacRelease(staged.releaseRoot);
assert.equal(binding.schemaVersion, 2);
assert.equal(binding.payloadSha256, source.payload_sha256);
await symlink("releases/" + staged.releaseVersion, layout.currentLink);
await publishMacAppRuntimeReference(layout, staged.releaseRoot);
const execution = await resolveMacAppExecutionLayout(layout);
assert.equal(execution.nodePath, ${quoted(node)});
assert.equal(execution.engineRoot, join(staged.releaseRoot, "app/engine"));
assert.equal(execution.modelRoot, join(support, "models"));
await writeLaunchAgentPlist(execution);
const plist = await readFile(layout.plistPath, "utf8");
const wrapper = await readFile(join(layout.installRoot, "bin/mw"), "utf8");
assert(plist.includes(execution.nodePath));
assert(plist.includes(execution.cliPath));
assert(plist.includes("<key>RunAtLoad</key>"));
assert(plist.includes("<key>KeepAlive</key>"));
assert(wrapper.includes(execution.nodePath));
assert(wrapper.includes(execution.cliPath));
assert(!execution.cliPath.startsWith(${quoted(resources)}));
const reference = JSON.parse(await readFile(join(support, "runtime/consumers", staged.serviceId + ".json"), "utf8"));
assert.equal(reference.runtime_id, binding.base.runtimeId);
assert.equal(reference.worker_root, layout.installRoot);
// A fake service observer prevents even a read of the user's real launchd domain.
const forbidden = async () => { throw new Error("REAL_SERVICE_ACTION_FORBIDDEN"); };
const context = {
  layout,
  host: { platform: "darwin", arch: "arm64", uid: process.getuid(), home },
  launchAgent: { status: async () => ({ loaded: false, running: false }),
    bootstrap: forbidden, bootout: forbidden, kickstart: forbidden }
};
async function session(command, type = "COMMAND", parameters = {}) {
  const input = new PassThrough(), output = new PassThrough();
  const request = { protocol_version: 1, request_id: crypto.randomUUID(), type, command, parameters };
  const frames = [];
  let pending = "";
  output.on("data", chunk => {
    pending += chunk.toString("utf8");
    while (pending.includes("\\n")) {
      const end = pending.indexOf("\\n");
      const frame = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      assert.equal(frame.protocol_version, 1);
      assert.equal(frame.request_id, request.request_id);
      assert.notEqual(frame.type, "ERROR");
      frames.push(frame);
      if (type === "SUBSCRIBE" && frame.type === "SNAPSHOT") input.end();
    }
  });
  const complete = runAppControlSession(input, output, { context, packageVersion: source.worker_version });
  input.write(JSON.stringify(request) + "\\n");
  if (type === "COMMAND") input.end();
  await complete;
  assert.equal(pending, "");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, type === "COMMAND" ? "RESULT" : "SNAPSHOT");
  return frames[0].payload;
}
const versions = await session("versions");
assert.equal(versions.cliVersion, source.worker_version);
const status = await session("status", "COMMAND", { local: true });
assert.equal(status.installed, false);
await session("logs");
await session("status", "SUBSCRIBE");
await session("logs", "SUBSCRIBE", { errors: true, lines: 10 });
console.log(JSON.stringify({
  service_version: source.worker_version,
  release_version: staged.releaseVersion,
  service_id: staged.serviceId,
  payload_sha256: source.payload_sha256,
  commands: APP_COMMANDS,
  controller_imports_and_frames: true,
  copied_code_outside_gui: true,
  prepared_runtime_and_model_verified: true,
  runtime_reference_and_private_support_cli: true,
  status_and_logs_subscriptions_closed: true,
  launchctl_executed: false,
  backend_used: false
}));`;
  const proofPath = join(output, "worker-proof.mjs");
  await writeFile(proofPath, proofCode, { flag: "wx", mode: 0o600 });
  const proof = await run(
    "PACKAGED_WORKER_STAGE_AND_CONTROL",
    "/usr/bin/sandbox-exec",
    ["-p", policy, node, proofPath],
    { env, timeout: 240_000, captureStderr: true },
  );
  if (proof.exitCode !== 0 || proof.signal) {
    // This subprocess is denied real user state and network; keep its bounded
    // fixture diagnostics private, outside the user-facing qualification report.
    await writeFile(join(output, "worker-proof.stderr"), proof.stderr, {
      flag: "wx",
      mode: 0o600,
    });
    throw new Error("PACKAGED_WORKER_CONTROL_FAILED");
  }
  const result = JSON.parse(proof.stdout.toString("utf8"));
  if (
    result.controller_imports_and_frames !== true ||
    result.commands?.length !== 25 ||
    result.launchctl_executed !== false
  )
    throw new Error("PACKAGED_WORKER_CONTROL_INVALID");
  const supportCLI = await run(
    "PACKAGED_WORKER_SUPPORT_CLI_VERSION",
    "/usr/bin/sandbox-exec",
    [
      "-p",
      policy,
      join(home, "Library/Application Support/MusicMuteWorker/bin/mw"),
      "--version",
      "--json",
    ],
    { env },
  );
  if (
    supportCLI.exitCode !== 0 ||
    supportCLI.signal ||
    JSON.parse(supportCLI.stdout.toString("utf8")).cliVersion !==
      result.service_version
  )
    throw new Error("PACKAGED_WORKER_SUPPORT_CLI_INVALID");
  const requestID = randomUUID();
  const smoke = await run(
    "PACKAGED_WORKER_ENTRY_VERSIONS",
    "/usr/bin/sandbox-exec",
    ["-p", policy, node, join(resources, "worker/controller.js")],
    {
      env,
      input: `${JSON.stringify({ protocol_version: 1, request_id: requestID, type: "COMMAND", command: "versions", parameters: {} })}\n`,
    },
  );
  const frame = JSON.parse(smoke.stdout.toString("utf8"));
  if (
    smoke.exitCode !== 0 ||
    smoke.signal ||
    frame.protocol_version !== 1 ||
    frame.request_id !== requestID ||
    frame.type !== "RESULT" ||
    frame.payload?.cliVersion !== result.service_version
  )
    throw new Error("PACKAGED_WORKER_ENTRY_INVALID");
  return {
    ...result,
    actual_controller_entry: true,
    support_cli_executed: true,
  };
}
