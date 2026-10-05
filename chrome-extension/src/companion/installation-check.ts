import { join } from "node:path";
import {
  CHECK_COMPONENTS,
  type CheckComponent,
  type InstallationCheck,
} from "../shared/installation-check.js";
import {
  inspectLocalReadiness,
  inspectYouTubeReadiness,
  type LocalConfig,
  type ReadinessProbe,
} from "./config.js";
import { runBounded } from "./local-provider.js";
import {
  setupReadinessIdentity,
  updateSetupReadiness,
  type SetupReadiness,
} from "./app-setup.js";

export async function inspectInstalledRuntime(
  config: LocalConfig,
  signal: AbortSignal,
): Promise<void> {
  if (!config.app_resources) throw new Error("PACKAGED_APP_REQUIRED");
  const reply = await runBounded(
    join(config.app_resources, "..", "MacOS", "MusicMuteLocal"),
    ["--check-runtime"],
    {
      signal,
      timeout_ms: 180_000,
      max_output_bytes: 4096,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: process.env.HOME,
        MUSICMUTE_LOCAL_ROOT: config.root,
      },
    },
  );
  let value: unknown;
  try {
    value = JSON.parse(reply.stdout);
  } catch {
    throw new Error("INSTALLATION_CHECK_FAILED");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("ready" in value) ||
    value.ready !== true
  ) {
    const code =
      value && typeof value === "object" && "error_code" in value
        ? value.error_code
        : undefined;
    throw new Error(
      typeof code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(code)
        ? code
        : "INSTALLATION_CHECK_FAILED",
    );
  }
}

/** Called only by the explicit native CHECK command; never a prerequisite to START. */
export async function checkInstallation(
  config: LocalConfig,
  installationId: string,
  signal: AbortSignal,
  publish: (status: InstallationCheck) => void,
  inspect?: Record<CheckComponent, () => Promise<void>>,
): Promise<InstallationCheck> {
  const readinessIdentity = config.app_resources
    ? await setupReadinessIdentity(config)
    : undefined;
  const readiness: SetupReadiness = { errors: {} };
  const youtubeProgress: { probe: ReadinessProbe } = {
    probe: "downloader-version",
  };
  const inspections = inspect ?? {
    runtime: () => inspectInstalledRuntime(config, signal),
    model: () => inspectLocalReadiness(config, signal),
    youtube_tools: () =>
      inspectYouTubeReadiness(config, signal, (event) => {
        if (event.state === "started") youtubeProgress.probe = event.probe;
        if (event.state === "completed") {
          if (event.probe === "downloader-ejs") readiness.downloader = true;
          if (event.probe === "javascript-runtime") readiness.javascript = true;
          if (event.probe === "token-provider") readiness.token_provider = true;
        }
      }),
  };
  const status: InstallationCheck = {
    installation_id: installationId,
    started_at: Date.now(),
    state: "running",
    checks: CHECK_COMPONENTS.map((component) => ({
      component,
      state: "pending",
    })),
  };
  const emit = () => publish(structuredClone(status));
  emit();
  for (const check of status.checks) {
    const started = performance.now();
    check.state = "running";
    emit();
    try {
      if (signal.aborted) throw new Error("CANCELLED");
      await inspections[check.component]();
      if (signal.aborted) throw new Error("CANCELLED");
      check.state = "passed";
    } catch (error) {
      check.state = "failed";
      const code =
        error instanceof Error ? error.message : "INSTALLATION_CHECK_FAILED";
      check.error_code = /^[A-Z][A-Z0-9_]{1,79}$/.test(code)
        ? code
        : "INSTALLATION_CHECK_FAILED";
    }
    check.duration_ms = Math.round(performance.now() - started);
    emit();
    // A damaged executable inventory must not be run by subsequent diagnostic probes.
    if (
      check.state === "failed" &&
      (check.component === "runtime" || signal.aborted)
    )
      break;
  }
  status.state = status.checks.every((check) => check.state === "passed")
    ? "passed"
    : "failed";
  if (
    readinessIdentity &&
    !signal.aborted &&
    !status.checks.some((check) => check.error_code === "CANCELLED")
  ) {
    for (const check of status.checks) {
      if (check.component === "model" && check.state === "passed") {
        readiness.engine = true;
        readiness.model = true;
      }
      if (check.component === "youtube_tools" && check.state === "passed") {
        readiness.downloader = true;
        readiness.javascript = true;
        readiness.token_provider = true;
      }
      if (check.state !== "failed") continue;
      const code = check.error_code ?? "INSTALLATION_CHECK_FAILED";
      const component =
        check.component === "runtime"
          ? "engine"
          : check.component === "model"
            ? code.startsWith("MODEL_")
              ? "model"
              : "engine"
            : code.startsWith("PO_TOKEN_") ||
                youtubeProgress.probe === "token-provider"
              ? "token_provider"
              : code.startsWith("DENO_") ||
                  youtubeProgress.probe === "javascript-runtime"
                ? "javascript"
                : "downloader";
      readiness[component] = false;
      readiness.errors[component] = code;
    }
    try {
      await updateSetupReadiness(config, readinessIdentity, readiness, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
  status.completed_at = Date.now();
  emit();
  return status;
}
