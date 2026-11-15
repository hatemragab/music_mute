import { win32 } from "node:path";
import type { LocalConfig } from "./config.js";
import {
  localPlatform,
  safeWindowsAbsolutePath,
  windowsLocalPaths,
  type LocalHostIdentity,
} from "../shared/local-platform.js";

export interface WindowsConfigInput {
  host: LocalHostIdentity;
  localAppData: string;
  appResources: string;
  releaseId: string;
  directmlDeviceId: number;
}

/** Resolve a verified installation's paths; this does not grant readiness or authenticate a release. */
export function windowsLocalConfig(input: WindowsConfigInput): LocalConfig {
  const platform = localPlatform(input.host);
  if (
    platform.platform !== "win32" ||
    !safeWindowsAbsolutePath(input.appResources) ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(input.releaseId) ||
    !Number.isInteger(input.directmlDeviceId) ||
    input.directmlDeviceId < 0 ||
    input.directmlDeviceId > 15
  )
    throw new TypeError("INVALID_LOCAL_CONFIG");
  const paths = windowsLocalPaths(input.localAppData);
  const runtime = win32.join(paths.runtimeRoot, "releases", input.releaseId);
  const python = win32.join(runtime, "runtime", "python", "python.exe");
  const youtube = win32.join(runtime, "tools", "youtube");
  return {
    platform: "win32",
    runtime_provider: "directml",
    directml_device_id: input.directmlDeviceId,
    app_resources: input.appResources,
    runtime_id: input.releaseId,
    runtime_root: runtime,
    root: paths.root,
    cache_root: paths.cacheRoot,
    logs_root: paths.logsRoot,
    models_root: paths.modelsRoot,
    node_path: win32.join(runtime, "runtime", "node", "node.exe"),
    python_path: python,
    ffmpeg_path: win32.join(runtime, "runtime", "bin", "ffmpeg.exe"),
    ffprobe_path: win32.join(runtime, "runtime", "bin", "ffprobe.exe"),
    yt_dlp_path: python,
    downloader_bundle_root: win32.join(runtime, "tools", "downloader"),
    downloader_bootstrap_path: win32.join(
      runtime,
      "tools",
      "downloader",
      "downloader_bootstrap.py",
    ),
    js_runtime_path: win32.join(youtube, "bin", "deno.exe"),
    js_runtime_kind: "deno",
    youtube_runtime_root: youtube,
    update_lease_python_path: python,
    engine_root: win32.join(runtime, "app", "engine"),
    runner_path: win32.join(input.appResources, "engine", "local_pipeline.py"),
  };
}
