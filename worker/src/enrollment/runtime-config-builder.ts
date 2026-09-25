import {
  WORKER_PLATFORMS,
  WORKER_RECIPE_IDS,
  type WorkerPlatform,
  type WorkerRecipeId,
} from "../../protocol/v1/protocol.js";
import { homedir } from "node:os";
import { createMacUserLayout } from "../platform/macos/user-paths.js";
import {
  createWindowsReleaseLayout,
  createWindowsServiceLayout,
  DEFAULT_WINDOWS_INSTALL_ROOT,
} from "../platform/windows/service-definition.js";
import { MAC_RECIPE_IDS } from "../platform/macos/runtime-recipes.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ServiceRuntimeConfigOptions {
  platform: WorkerPlatform;
  backendBaseUrl: string;
  machineId: string;
  workerId: string;
  installRoot?: string;
  releaseVersion?: string;
  allowInsecureLoopback?: boolean;
}

export interface ServiceRuntimeConfigDocument {
  schemaVersion: 1;
  backendBaseUrl: string;
  machineId: string;
  credentialFile: string;
  localLifecyclePath?: string;
  localRuntimeStatusPath?: string;
  workRoot: string;
  modelCacheRoot: string;
  engineRoot: string;
  pythonPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  allowInsecureLoopback: boolean;
  validatedMaxWorkersPerGpu: 1;
  slots: [
    {
      workerId: string;
      gpuId: "gpu0";
      slotIndex: 0;
      recipeIds: WorkerRecipeId[];
      provider: "mps" | "directml";
      directmlDeviceId?: 0;
    },
  ];
}

export function buildServiceRuntimeConfig(
  options: ServiceRuntimeConfigOptions,
): ServiceRuntimeConfigDocument {
  if (!WORKER_PLATFORMS.includes(options.platform))
    throw new TypeError("Service runtime platform is unsupported");
  assertUuid(options.machineId, "Machine ID");
  assertUuid(options.workerId, "Worker ID");
  const backendBaseUrl = validatedBackendBaseUrl(
    options.backendBaseUrl,
    options.allowInsecureLoopback === true,
  );

  if (options.platform === "darwin-arm64") {
    if (options.releaseVersion !== undefined)
      throw new TypeError(
        "Mac runtime config does not accept a release version",
      );
    const layout = createMacUserLayout(options.installRoot ?? homedir());
    return {
      schemaVersion: 1,
      backendBaseUrl,
      machineId: options.machineId,
      credentialFile: layout.credentialPath,
      localLifecyclePath: layout.lifecyclePath,
      localRuntimeStatusPath: layout.runtimeStatusPath,
      workRoot: layout.workRoot,
      modelCacheRoot: layout.modelRoot,
      engineRoot: layout.engineRoot,
      pythonPath: layout.pythonPath,
      ffmpegPath: layout.ffmpegPath,
      ffprobePath: layout.ffprobePath,
      allowInsecureLoopback: options.allowInsecureLoopback === true,
      validatedMaxWorkersPerGpu: 1,
      slots: [
        {
          workerId: options.workerId,
          gpuId: "gpu0",
          slotIndex: 0,
          recipeIds: [...MAC_RECIPE_IDS],
          provider: "mps",
        },
      ],
    };
  }

  const releaseVersion = options.releaseVersion;
  if (releaseVersion === undefined)
    throw new TypeError("Windows runtime config requires a release version");
  const layout = createWindowsServiceLayout(
    options.installRoot ?? DEFAULT_WINDOWS_INSTALL_ROOT,
  );
  const release = createWindowsReleaseLayout(layout, releaseVersion);
  return {
    schemaVersion: 1,
    backendBaseUrl,
    machineId: options.machineId,
    credentialFile: layout.credentialPath,
    workRoot: layout.workRoot,
    modelCacheRoot: layout.modelCacheRoot,
    engineRoot: release.engineRoot,
    pythonPath: release.pythonPath,
    ffmpegPath: release.ffmpegPath,
    ffprobePath: release.ffprobePath,
    allowInsecureLoopback: options.allowInsecureLoopback === true,
    validatedMaxWorkersPerGpu: 1,
    slots: [
      {
        workerId: options.workerId,
        gpuId: "gpu0",
        slotIndex: 0,
        recipeIds: [...WORKER_RECIPE_IDS],
        provider: "directml",
        directmlDeviceId: 0,
      },
    ],
  };
}

function validatedBackendBaseUrl(
  value: string,
  allowInsecureLoopback: boolean,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Service backend URL is invalid");
  }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.protocol !== "https:" && !(allowInsecureLoopback && loopback))
  )
    throw new TypeError("Service backend URL is unsafe");
  if (url.pathname !== "/" || url.search !== "")
    throw new TypeError("Service backend URL must be an API origin");
  return url.toString();
}

function assertUuid(value: string, label: string): void {
  if (!UUID_V4.test(value)) throw new TypeError(`${label} is invalid`);
}
