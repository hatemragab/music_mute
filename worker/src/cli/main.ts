#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerChildProcess } from "../agent/child-process.js";
import { MachineSupervisor } from "../agent/machine-supervisor.js";
import { WorkerControlPlaneClient } from "../runtime/control-plane-client.js";
import { loadRuntimeConfig } from "../runtime/runtime-config.js";
import { WorkerTransferClient } from "../runtime/transfers.js";
import { WorkerRuntime } from "../runtime/worker-runtime.js";
import {
  MACOS_USAGE,
  macosCommandErrorSummary,
  runMacosCommand,
} from "../platform/macos/cli.js";
import {
  WINDOWS_USAGE,
  runWindowsCommand,
  windowsCommandErrorSummary,
} from "../platform/windows/cli.js";
import {
  ENROLLMENT_USAGE,
  enrollmentCommandErrorSummary,
  runEnrollmentCommand,
  runInstallationPreparationCommand,
} from "../enrollment/cli.js";

const command = process.argv[2];

if (command === "protocol-doctor") {
  const workerRoot = resolve(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );
  const child = new WorkerChildProcess({
    command: process.platform === "win32" ? "python" : "python3",
    args: ["-m", "musicmute_engine.child"],
    cwd: resolve(workerRoot, "engine"),
  });
  try {
    await child.start();
    const result = await child.request("ping", {});
    if (result.payload.status !== "ok")
      throw new Error("Protocol check failed");
    console.log("MusicMute worker child protocol: OK");
  } catch {
    console.error("MusicMute worker child protocol: FAILED");
    process.exitCode = 1;
  } finally {
    await child.stop();
  }
} else if (command === "macos") {
  try {
    await runMacosCommand(process.argv.slice(3));
  } catch (error) {
    console.error(
      `MusicMute macOS service command: FAILED (${macosCommandErrorSummary(error)})\n${MACOS_USAGE}`,
    );
    process.exitCode = 1;
  }
} else if (command === "windows") {
  try {
    await runWindowsCommand(process.argv.slice(3));
  } catch (error) {
    console.error(
      `MusicMute Windows service command: FAILED (${windowsCommandErrorSummary(error)})\n${WINDOWS_USAGE}`,
    );
    process.exitCode = 1;
  }
} else if (command === "enroll") {
  try {
    await runEnrollmentCommand(process.argv.slice(3));
  } catch (error) {
    console.error(
      `MusicMute worker enrollment: FAILED (${enrollmentCommandErrorSummary(error)})\n${ENROLLMENT_USAGE}`,
    );
    process.exitCode = 1;
  }
} else if (command === "prepare-installation") {
  try {
    await runInstallationPreparationCommand(process.argv.slice(3));
  } catch (error) {
    console.error(
      `MusicMute worker installation preparation: FAILED (${enrollmentCommandErrorSummary(error)})\n${ENROLLMENT_USAGE}`,
    );
    process.exitCode = 1;
  }
} else if (command === "run") {
  const configIndex = process.argv.indexOf("--config");
  const configPath =
    configIndex < 0 ? undefined : process.argv[configIndex + 1];
  if (!configPath || process.argv.length !== 5) {
    console.error("Usage: musicmute-worker run --config <absolute-path>");
    process.exitCode = 2;
  } else {
    try {
      const config = await loadRuntimeConfig(configPath);
      const supervisor = new MachineSupervisor(
        config.slots.map((slot) => ({
          workerId: slot.workerId,
          gpuId: slot.gpuId,
          child: {
            command: config.pythonPath,
            args: ["-m", "musicmute_engine.child"],
            cwd: config.engineRoot,
            env: { MUSICMUTE_PROVIDER: slot.provider },
            trustedExecutableDirectory: dirname(config.ffmpegPath),
            requestTimeoutMs: 7_200_000,
          },
        })),
      );
      const control = new WorkerControlPlaneClient({
        baseUrl: config.backendBaseUrl,
        credential: config.credential,
        allowInsecureLoopback: config.allowInsecureLoopback,
      });
      const transfers = new WorkerTransferClient({
        allowInsecureLoopback: config.allowInsecureLoopback,
      });
      const runtime = new WorkerRuntime(
        {
          machineId: config.machineId,
          slots: config.slots,
          workRoot: config.workRoot,
          modelCacheRoot: config.modelCacheRoot,
          ffmpegPath: config.ffmpegPath,
          ffprobePath: config.ffprobePath,
          onEvent: (event) => console.log(JSON.stringify(event)),
        },
        control,
        transfers,
        supervisor,
      );
      const stopping = new AbortController();
      const stop = () => stopping.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await runtime.run(stopping.signal);
    } catch {
      console.error("MusicMute worker runtime: FAILED");
      process.exitCode = 1;
    }
  }
} else {
  console.error(
    "Usage: musicmute-worker <protocol-doctor | prepare-installation ... | enroll ... | run --config <absolute-path> | macos ... | windows ...>",
  );
  process.exitCode = 2;
}
