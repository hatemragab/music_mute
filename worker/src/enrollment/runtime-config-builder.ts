import {
  WORKER_PLATFORMS,
  WORKER_RECIPE_IDS,
  type WorkerPlatform,
} from "../../protocol/v1/protocol.js";
import {
  createMacServiceLayout,
  DEFAULT_MAC_INSTALL_ROOT,
} from "../platform/macos/launchd.js";
import {
  createWindowsReleaseLayout,
  createWindowsServiceLayout,
  DEFAULT_WINDOWS_INSTALL_ROOT,
} from "../platform/windows/service-definition.js";

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
  workRoot: string;
  modelCacheRoot: string;
  engineRoot: string;
  pythonPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  allowInsecureLoopback: boolean;
  slots: [
    {
      workerId: string;
      gpuId: "gpu0";
      slotIndex: 0;
      recipeIds: [...typeof WORKER_RECIPE_IDS];
      provider: "coreml" | "directml";
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
    const layout = createMacServiceLayout(
      options.installRoot ?? DEFAULT_MAC_INSTALL_ROOT,
    );
    return {
      schemaVersion: 1,
      backendBaseUrl,
      machineId: options.machineId,
      credentialFile: layout.credentialPath,
      workRoot: layout.workRoot,
      modelCacheRoot: layout.modelCacheRoot,
      engineRoot: layout.engineRoot,
      pythonPath: layout.pythonPath,
      ffmpegPath: layout.ffmpegPath,
      ffprobePath: layout.ffprobePath,
      allowInsecureLoopback: options.allowInsecureLoopback === true,
      slots: [
        {
          workerId: options.workerId,
          gpuId: "gpu0",
          slotIndex: 0,
          recipeIds: [...WORKER_RECIPE_IDS],
          provider: "coreml",
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
  if (!url.pathname.startsWith("/") || url.pathname.includes("//"))
    throw new TypeError("Service backend URL path is invalid");
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
  return url.toString();
}

function assertUuid(value: string, label: string): void {
  if (!UUID_V4.test(value)) throw new TypeError(`${label} is invalid`);
}
