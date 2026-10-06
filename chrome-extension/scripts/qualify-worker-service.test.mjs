import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { qualifyWorkerBackgroundService } from "./qualify-worker-service.mjs";

const supplied = {
  serviceRoot: process.env.MUSICMUTE_SERVICE_ACCEPTANCE_ROOT,
  nodePath: process.env.MUSICMUTE_SERVICE_ACCEPTANCE_NODE ?? process.execPath,
  pythonPath:
    process.env.MUSICMUTE_SERVICE_ACCEPTANCE_PYTHON ?? "/usr/bin/python3",
};

function integrationAvailable(t) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    t.skip("Service acceptance requires macOS ARM64");
    return false;
  }
  if (!supplied.serviceRoot) {
    t.skip(
      "Set MUSICMUTE_SERVICE_ACCEPTANCE_ROOT to a verified extracted service payload",
    );
    return false;
  }
  return true;
}

function assertExited(pid) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}

test("rejects unsupported scenarios, faults and nonabsolute paths before executing anything", async () => {
  await assert.rejects(
    qualifyWorkerBackgroundService({ scenario: "installed-service" }),
    /INVALID_ACCEPTANCE_SCENARIO/,
  );
  await assert.rejects(
    qualifyWorkerBackgroundService({ fault: "real-model" }),
    /INVALID_ACCEPTANCE_FAULT/,
  );
  await assert.rejects(
    qualifyWorkerBackgroundService({ serviceMode: "installed-worker" }),
    /INVALID_ACCEPTANCE_SERVICE_MODE/,
  );
  await assert.rejects(
    qualifyWorkerBackgroundService({ serviceRoot: "relative/path" }),
    /ABSOLUTE_ACCEPTANCE_PATH_REQUIRED/,
  );
});

test(
  "temporary uniquely labeled LaunchAgent runs at bootstrap, survives controller exit and restarts after crash",
  { timeout: 90_000 },
  async (t) => {
    if (!integrationAvailable(t)) return;
    if (process.env.MUSICMUTE_SERVICE_ACCEPTANCE_LAUNCH_AGENT !== "true") {
      t.skip(
        "Explicit MUSICMUTE_SERVICE_ACCEPTANCE_LAUNCH_AGENT=true is required for a temporary qualification label",
      );
      return;
    }
    const report = await qualifyWorkerBackgroundService({
      ...supplied,
      serviceMode: "launch-agent",
      scenario: "controller-kill",
    });
    assert.equal(report.service_mode, "launch-agent");
    assert.match(
      report.temporary_launch_agent.label,
      /^com\.musicmute\.qualification\.[a-f0-9-]{36}$/u,
    );
    assert.equal(report.temporary_launch_agent.run_at_load_observed, true);
    assert.equal(
      report.temporary_launch_agent.keep_alive_restarted_after_supervisor_death,
      true,
    );
    assert.equal(
      report.temporary_launch_agent.exact_label_bootout_confirmed,
      true,
    );
    assert.equal(
      report.temporary_launch_agent.installed_in_launch_agents_directory,
      false,
    );
    assert.equal(report.temporary_launch_agent.login_or_reboot_tested, false);
    assert.equal(report.completions, 1);
    assert.equal(report.real_inference, false);
    assert.equal(report.installed_launch_agent, false);
  },
);

for (const scenario of ["controller-eof", "controller-kill"]) {
  test(
    `copied service completes the accepted attempt after ${scenario} and GUI removal`,
    { timeout: 90_000 },
    async (t) => {
      if (!integrationAvailable(t)) return;
      let processes;
      const report = await qualifyWorkerBackgroundService({
        ...supplied,
        scenario,
        onFixtureProcesses: (value) => {
          processes = value;
        },
      });
      assert.equal(report.scenario, scenario);
      assert.match(report.service_payload_sha256, /^[a-f0-9]{64}$/u);
      assert.equal(report.same_service_pid, true);
      assert.equal(report.same_accepted_attempt, true);
      assert.equal(report.controller_exited_before_completion, true);
      assert.equal(report.gui_folder_removed_before_completion, true);
      assert.equal(report.process_invocations, 1);
      assert.equal(report.input_downloads, 1);
      assert.equal(report.conditional_output_uploads, 1);
      assert.equal(report.completions, 1);
      assert.equal(
        report.process_group_confirmed_gone_after_supervisor_death,
        true,
      );
      assert.equal(report.real_inference, false);
      assert.equal(report.installed_launch_agent, false);
      assert.equal(report.telemetry_disabled, true);
      assert.equal(report.complete_copied_inventory_verified, true);
      assert.ok(report.service_entries > 100);
      assert.ok(processes);
      for (const pid of [
        processes.service,
        processes.controller,
        ...processes.children,
      ])
        assertExited(pid);
    },
  );
}

test(
  "unexpected processed bytes fail acceptance and still clean the owned process group",
  { timeout: 90_000 },
  async (t) => {
    if (!integrationAvailable(t)) return;
    let processes;
    await assert.rejects(
      qualifyWorkerBackgroundService({
        ...supplied,
        fault: "unexpected-output",
        onFixtureProcesses: (value) => {
          processes = value;
        },
      }),
      /BACKGROUND_OUTPUT_MISMATCH/,
    );
    assert.ok(processes);
    for (const pid of [
      processes.service,
      processes.controller,
      ...processes.children,
    ])
      assertExited(pid);
  },
);

test(
  "tampered service code is rejected before any service processes are launched",
  { timeout: 30_000 },
  async (t) => {
    if (!integrationAvailable(t)) return;
    const root = await mkdtemp(join(tmpdir(), "mm-background-tamper-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const payload = join(root, "payload");
    await cp(supplied.serviceRoot, payload, {
      recursive: true,
      verbatimSymlinks: true,
    });
    await writeFile(
      join(payload, "app/dist/src/runtime/worker-runtime.js"),
      "throw new Error('owned tampered fixture');\n",
    );
    let launched = false;
    await assert.rejects(
      qualifyWorkerBackgroundService({
        ...supplied,
        serviceRoot: payload,
        onFixtureProcesses: () => {
          launched = true;
        },
      }),
      /WORKER_SERVICE_INVENTORY_MISMATCH/,
    );
    assert.equal(launched, false);
  },
);
