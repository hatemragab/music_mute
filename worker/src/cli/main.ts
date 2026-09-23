#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  sanitizeDiagnostic,
  WorkerChildProcess,
} from "../agent/child-process.js";
import { MachineSupervisor } from "../agent/machine-supervisor.js";
import { WorkerControlPlaneClient } from "../runtime/control-plane-client.js";
import { WorkerHintClient } from "../runtime/worker-hint-client.js";
import { loadRuntimeConfig } from "../runtime/runtime-config.js";
import { PackagedRuntimeCommandExecutor } from "../runtime/remote-command-executor.js";
import { WorkerTransferClient } from "../runtime/transfers.js";
import { WorkerRuntime } from "../runtime/worker-runtime.js";
import {
  MAC_PACKAGE_USAGE,
  runMacPackageCommand,
} from "../platform/macos/package-cli.js";
import {
  MAC_USER_USAGE,
  runMacUserCommand,
} from "../platform/macos/user-cli.js";
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
import { createMacUserLayout } from "../platform/macos/user-paths.js";
import {
  appendMacFatalError,
  maintainMacUserLogs,
} from "../platform/macos/operational-logs.js";

const command = process.argv[2];
const macUserCommands = new Set([
  "install",
  "status",
  "start",
  "stop",
  "restart",
  "logs",
  "job",
  "errors",
  "explain",
  "perf",
  "diagnostics",
  "doctor",
  "pause",
  "drain",
  "resume",
  "update",
  "benchmark",
  "benchmark-file",
  "unpair",
  "uninstall",
]);

if (command === "--help" || command === "help") {
  console.log(MAC_USER_USAGE);
} else if (command !== undefined && macUserCommands.has(command)) {
  try {
    process.exitCode = await runMacUserCommand(command, process.argv.slice(3));
  } catch (error) {
    console.error(
      `MusicMute worker command: FAILED (${error instanceof Error ? error.message : "unknown error"})\n${MAC_USER_USAGE}`,
    );
    process.exitCode = error instanceof TypeError ? 2 : 1;
  }
} else if (command === "protocol-doctor") {
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
} else if (command === "package-macos") {
  try {
    await runMacPackageCommand(process.argv.slice(3));
  } catch (error) {
    console.error(
      `MusicMute macOS package: FAILED (${error instanceof Error ? error.message : "operation failed"})\n${MAC_PACKAGE_USAGE}`,
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
    console.error("Usage: mw run --config <absolute-path>");
    process.exitCode = 2;
  } else {
    const logLayout =
      process.platform === "darwin" ? createMacUserLayout(homedir()) : null;
    let nextLogMaintenanceAt = 0;
    const stopping = new AbortController();
    const stop = () => stopping.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      if (logLayout !== null) await maintainMacUserLogs(logLayout);
      const config = await loadRuntimeConfig(configPath);
      const supervisor = new MachineSupervisor(
        config.slots.map((slot) => ({
          workerId: slot.workerId,
          gpuId: slot.gpuId,
          child: {
            command: config.pythonPath,
            args: [
              "-m",
              "musicmute_engine.child",
              "--model-cache-root",
              config.modelCacheRoot,
              "--provider",
              slot.provider,
              "--directml-device-id",
              String(slot.directmlDeviceId ?? 0),
            ],
            cwd: config.engineRoot,
            env: { MUSICMUTE_PROVIDER: slot.provider },
            trustedExecutableDirectory: dirname(config.ffmpegPath),
            requestTimeoutMs: 7_200_000,
          },
        })),
        config.validatedMaxWorkersPerGpu,
      );
      const control = new WorkerControlPlaneClient({
        baseUrl: config.backendBaseUrl,
        credential: config.credential,
        allowInsecureLoopback: config.allowInsecureLoopback,
      });
      const transfers = new WorkerTransferClient({
        allowInsecureLoopback: config.allowInsecureLoopback,
      });
      const primarySlot = config.slots[0]!;
      const commandExecutor = new PackagedRuntimeCommandExecutor({
        workRoot: config.workRoot,
        modelCacheRoot: config.modelCacheRoot,
        engineRoot: config.engineRoot,
        pythonPath: config.pythonPath,
        ffmpegPath: config.ffmpegPath,
        ffprobePath: config.ffprobePath,
        provider: primarySlot.provider,
        ...(primarySlot.directmlDeviceId === undefined
          ? {}
          : { directmlDeviceId: primarySlot.directmlDeviceId }),
        serviceCheck: async () => {
          const response = await supervisor
            .child(primarySlot.workerId)
            .request("ping", {}, 10_000);
          if (response.type !== "result" || response.payload.status !== "ok")
            throw new Error("Worker child health check failed");
        },
      });
      const runtime = new WorkerRuntime(
        {
          machineId: config.machineId,
          slots: config.slots,
          validatedMaxWorkersPerGpu: config.validatedMaxWorkersPerGpu,
          workRoot: config.workRoot,
          ...(config.localLifecyclePath === undefined
            ? {}
            : { localLifecyclePath: config.localLifecyclePath }),
          ...(config.localRuntimeStatusPath === undefined
            ? {}
            : { localRuntimeStatusPath: config.localRuntimeStatusPath }),
          modelCacheRoot: config.modelCacheRoot,
          ffmpegPath: config.ffmpegPath,
          ffprobePath: config.ffprobePath,
          commandExecutor,
          hintClientFactory: (onHint) => new WorkerHintClient(control, onHint),
          onEvent: (event) => {
            console.log(JSON.stringify(event));
            if (logLayout !== null && Date.now() >= nextLogMaintenanceAt) {
              nextLogMaintenanceAt = Date.now() + 60_000;
              void maintainMacUserLogs(logLayout).catch(() => undefined);
            }
          },
        },
        control,
        transfers,
        supervisor,
      );
      await runtime.run(stopping.signal);
    } catch (error) {
      if (!stopping.signal.aborted) {
        if (logLayout !== null)
          await appendMacFatalError(
            logLayout.stderrPath,
            "runtime",
            error,
          ).catch(() => undefined);
        const detail = sanitizeDiagnostic(
          error instanceof Error ? error.message : "Unknown worker failure",
        ).slice(0, 2_000);
        console.error(`MusicMute worker runtime: FAILED (${detail})`);
        process.exitCode = 1;
      }
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
} else {
  console.error(
    `Usage: mw <install | status | start | stop | restart | logs | job | errors | explain | perf | diagnostics | doctor | benchmark | benchmark-file | pause | drain | resume | update | unpair | uninstall | protocol-doctor | prepare-installation ... | enroll ... | run --config <absolute-path> | macos ... | windows ...>`,
  );
  process.exitCode = 2;
}
