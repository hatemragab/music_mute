import { loadLocalConfig, LocalSetupError } from "./config.js";
import { Diagnostics } from "./diagnostics.js";
import { resolveDiagnosticIdentity } from "./diagnostic-identity.js";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { LocalProcessingError } from "./local-provider.js";
import { inspectAppStatus, setupApp } from "./app-setup.js";
import { readAppUiJournal } from "./app-journal.js";
import { boundedAppDiagnosticReply } from "./app-diagnostic-reply.js";

process.umask(0o077);
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
function emit(payload: Record<string, unknown>): void {
  const bytes = JSON.stringify({ protocol_version: 1, ...payload }) + "\n";
  if (Buffer.byteLength(bytes) > 64 * 1024)
    throw new LocalSetupError("APP_REPLY_TOO_LARGE");
  process.stdout.write(bytes);
}
const actions: Record<string, string> = {
  CANCELLED: "Setup was cancelled. You can start again.",
  SETUP_BUSY: "Another MusicMute setup is running. Close it before retrying.",
  MODEL_CACHE_INVALID:
    "Open the model folder in this app, move the damaged Kim_Vocal_2.onnx file aside, then retry setup.",
  MODEL_DOWNLOAD_FAILED: "Check your internet connection and retry setup.",
  MODEL_DOWNLOAD_TIMEOUT:
    "The model download timed out. Check your connection and retry.",
  MODEL_CHECKSUM_INVALID:
    "The model download did not pass verification. Retry setup.",
  FOREIGN_NATIVE_REGISTRATION_EXISTS:
    "Chrome already has another MusicMute helper registration. Review it before replacing it.",
  LOCAL_DIRECTORY_NOT_PRIVATE:
    "MusicMute cannot use this data directory safely. Check its permissions.",
  DISK_SPACE_LOW: "Free disk space on your Mac, then retry setup.",
  MEMORY_LOW: "Close other memory-heavy apps, then retry setup.",
  APP_RUNTIME_NOT_PREPARED:
    "Open MusicMute and choose Prepare my Mac to download the processing tools.",
  APP_RUNTIME_MISSING:
    "The processing tools are missing. Reinstall this version of MusicMute, then retry setup.",
  APP_RUNTIME_INCOMPATIBLE:
    "Open MusicMute and choose Prepare my Mac to install the runtime required by this app update.",
  APP_RUNTIME_DESCRIPTOR_INVALID:
    "The downloaded processing tools are damaged. Open MusicMute and retry Prepare my Mac.",
  APP_RUNTIME_BOOTSTRAP_INVALID:
    "This MusicMute app is incomplete. Reinstall the app, then retry Prepare my Mac.",
  ENGINE_NOT_READY:
    "The Apple GPU check failed. Restart the app; if it repeats, export the local diagnostics.",
  DEV_RUNTIME_INCOMPLETE:
    "The bundled processing tools are incomplete. Reinstall the complete MusicMute Local app.",
  YT_DLP_MISSING:
    "The bundled audio downloader is missing. Reinstall the complete MusicMute Local app.",
  YT_DLP_IDENTITY_INVALID:
    "The audio downloader failed verification. Reinstall the complete MusicMute Local app.",
  DENO_MISSING:
    "The bundled Deno runtime is missing. Reinstall or update MusicMute; no separate Deno installation is needed.",
  DENO_VERSION_INVALID:
    "The YouTube runtime versions do not match. Update the complete MusicMute app.",
  PO_TOKEN_PROVIDER_MISSING:
    "Playback token support is missing. Update or reinstall MusicMute.",
  PO_TOKEN_PROVIDER_INVALID:
    "Playback token support failed verification. Update or reinstall MusicMute.",
  PO_TOKEN_PROVIDER_UNAVAILABLE:
    "Playback token support could not start. Restart MusicMute and export local diagnostics if it repeats.",
  YT_DLP_EJS_MISSING:
    "YouTube challenge scripts are missing or incompatible. Update the complete MusicMute app.",
  TOOL_TIMEOUT:
    "A bundled tool took too long to start. Retry setup; if it repeats, export the local diagnostics.",
  UNSUPPORTED_PLATFORM: "This version requires an Apple Silicon Mac.",
};
let diagnostics: Diagnostics | undefined;
let setupDiagnostics: Diagnostics | undefined;
let desktopDiagnostics: Diagnostics | undefined;
let setupCommand = false;
try {
  const command = process.argv[2];
  if (
    !["status", "setup", "snapshot", "export"].includes(command ?? "") ||
    process.argv.length !== 3
  )
    throw new LocalSetupError("INVALID_APP_COMMAND");
  const config = await loadLocalConfig();
  // Ordinary GUI status has no recorder and must not fingerprint the inventory.
  const diagnosticOptions =
    command === "status" ? {} : { identity: resolveDiagnosticIdentity(config) };
  if (!config.app_resources)
    throw new LocalSetupError("APP_RESOURCES_REQUIRED");
  if (command === "status") {
    emit({ type: "result", status: await inspectAppStatus(config) });
  } else if (command === "setup") {
    setupCommand = true;
    let previousStage: string | undefined;
    let stageStart = performance.now();
    const status = await setupApp(
      config,
      controller.signal,
      (event) => {
        if (!setupDiagnostics) {
          setupDiagnostics = new Diagnostics(join(config.logs_root, "setup"), {
            ...diagnosticOptions,
          });
          setupDiagnostics.record({
            component: "companion",
            severity: "info",
            event: "companion_started",
          });
        }
        const stage =
          event.phase === "model_download"
            ? "model-download"
            : event.phase === "validation"
              ? "runtime-validation"
              : event.phase === "registration"
                ? "registration"
                : "setup";
        if (stage !== previousStage) {
          if (previousStage)
            setupDiagnostics.record({
              component: "companion",
              severity: "info",
              event: "stage_completed",
              metrics: {
                stage: previousStage,
                duration_ms: performance.now() - stageStart,
              },
            });
          setupDiagnostics.record({
            component: "companion",
            severity: "info",
            event: "stage_started",
            metrics: { stage },
          });
          previousStage = stage;
          stageStart = performance.now();
        }
        emit({ type: "progress", ...event });
      },
      (event) => {
        setupDiagnostics?.record({
          component: "companion",
          severity: event.state === "failed" ? "error" : "info",
          event:
            event.state === "failed"
              ? "diagnostic_error"
              : event.state === "started"
                ? "stage_started"
                : "stage_completed",
          ...(event.error_code ? { code: event.error_code } : {}),
          metrics: { stage: event.probe, duration_ms: event.duration_ms },
        });
      },
    );
    emit({ type: "result", status });
  } else {
    diagnostics = new Diagnostics(config.logs_root, {
      readOnly: true,
      ...diagnosticOptions,
    });
    const ui = await readAppUiJournal(config.logs_root);
    setupDiagnostics = new Diagnostics(join(config.logs_root, "setup"), {
      readOnly: true,
      ...diagnosticOptions,
    });
    desktopDiagnostics = new Diagnostics(join(config.logs_root, "desktop"), {
      readOnly: true,
      ...diagnosticOptions,
    });
    const extra = {
      ...ui,
      app_setup_diagnostics: setupDiagnostics.snapshot(),
      app_desktop_diagnostics: desktopDiagnostics.snapshot(),
    };
    if (command === "export") {
      const report = await diagnostics.export(extra);
      emit(
        boundedAppDiagnosticReply(diagnostics.snapshot(), extra, report.path),
      );
    } else emit(boundedAppDiagnosticReply(diagnostics.snapshot(), extra));
  }
} catch (error) {
  const candidate =
    error instanceof LocalSetupError || error instanceof LocalProcessingError
      ? error.code
      : controller.signal.aborted
        ? "CANCELLED"
        : "APP_COMMAND_FAILED";
  const code = /^[A-Z_]{1,60}$/.test(candidate)
    ? candidate
    : "APP_COMMAND_FAILED";
  if (setupCommand)
    setupDiagnostics?.record({
      component: "companion",
      severity: "error",
      event: "diagnostic_error",
      code,
    });
  emit({
    type: "error",
    error_code: code,
    action:
      actions[code] ??
      "Retry setup. If this continues, export the local diagnostic report.",
  });
  process.exitCode = 1;
} finally {
  if (setupCommand)
    setupDiagnostics?.record({
      component: "companion",
      severity: "info",
      event: "companion_stopped",
    });
  setupDiagnostics?.close();
  desktopDiagnostics?.close();
  diagnostics?.close();
}
