import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  WORKER_RECIPE_IDS,
  type WorkerRecipeId,
} from "../../protocol/v1/protocol.js";
import {
  runtimePlatformAdapter,
  type RuntimePlatformAdapter,
} from "../platform/runtime-adapter.js";
import type { RuntimeSlotDefinition } from "./worker-runtime.js";

const CONFIG_LIMIT_BYTES = 64 * 1024;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONFIG_KEYS = new Set([
  "schemaVersion",
  "backendBaseUrl",
  "machineId",
  "credentialFile",
  "localLifecyclePath",
  "localRuntimeStatusPath",
  "workRoot",
  "modelCacheRoot",
  "engineRoot",
  "pythonPath",
  "ffmpegPath",
  "ffprobePath",
  "allowInsecureLoopback",
  "slots",
]);
const SLOT_KEYS = new Set([
  "workerId",
  "gpuId",
  "slotIndex",
  "recipeIds",
  "provider",
  "directmlDeviceId",
]);

export interface RuntimeConfig {
  backendBaseUrl: string;
  machineId: string;
  credentialFile: string;
  credential: string;
  localLifecyclePath?: string;
  localRuntimeStatusPath?: string;
  workRoot: string;
  modelCacheRoot: string;
  engineRoot: string;
  pythonPath: string;
  ffmpegPath: string;
  ffprobePath: string;
  allowInsecureLoopback: boolean;
  slots: RuntimeSlotDefinition[];
}

export async function loadRuntimeConfig(
  path: string,
  host: { platform: NodeJS.Platform; arch: string } = process,
): Promise<RuntimeConfig> {
  assertAbsolute(path, "Runtime config path");
  const configInfo = await lstat(path);
  if (
    !configInfo.isFile() ||
    configInfo.isSymbolicLink() ||
    configInfo.size < 2 ||
    configInfo.size > CONFIG_LIMIT_BYTES
  )
    throw new TypeError("Runtime config file is unsafe");
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new TypeError("Runtime config is not valid JSON");
  }
  const value = strictRecord(decoded, CONFIG_KEYS, "Runtime config");
  if (value.schemaVersion !== 1)
    throw new TypeError("Runtime config schema is unsupported");
  const adapter = runtimePlatformAdapter(host);
  const credentialFile = requiredText(
    value.credentialFile,
    "credentialFile",
    4096,
  );
  assertAbsolute(credentialFile, "Credential file path");
  const credentialInfo = await lstat(credentialFile);
  if (
    !credentialInfo.isFile() ||
    credentialInfo.isSymbolicLink() ||
    credentialInfo.size < 43 ||
    credentialInfo.size > 128 ||
    !adapter.credentialModeIsSafe(credentialInfo.mode)
  )
    throw new TypeError("Machine credential file is unsafe");
  const credential = (await readFile(credentialFile, "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(credential))
    throw new TypeError("Machine credential is invalid");
  if (
    !Array.isArray(value.slots) ||
    value.slots.length < 1 ||
    value.slots.length > 16
  )
    throw new TypeError("Runtime slots are invalid");
  const slots = value.slots.map((slot, index) =>
    parseSlot(slot, index, adapter),
  );
  if (
    value.allowInsecureLoopback !== undefined &&
    typeof value.allowInsecureLoopback !== "boolean"
  )
    throw new TypeError("allowInsecureLoopback is invalid");
  const paths = {
    workRoot: requiredText(value.workRoot, "workRoot", 4096),
    modelCacheRoot: requiredText(value.modelCacheRoot, "modelCacheRoot", 4096),
    engineRoot: requiredText(value.engineRoot, "engineRoot", 4096),
    pythonPath: requiredText(value.pythonPath, "pythonPath", 4096),
    ffmpegPath: requiredText(value.ffmpegPath, "ffmpegPath", 4096),
    ffprobePath: requiredText(value.ffprobePath, "ffprobePath", 4096),
  };
  for (const [name, current] of Object.entries(paths))
    assertAbsolute(current, name);
  const localLifecyclePath =
    value.localLifecyclePath === undefined
      ? undefined
      : requiredText(value.localLifecyclePath, "localLifecyclePath", 4096);
  if (localLifecyclePath !== undefined)
    assertAbsolute(localLifecyclePath, "localLifecyclePath");
  const localRuntimeStatusPath =
    value.localRuntimeStatusPath === undefined
      ? undefined
      : requiredText(
          value.localRuntimeStatusPath,
          "localRuntimeStatusPath",
          4096,
        );
  if (localRuntimeStatusPath !== undefined)
    assertAbsolute(localRuntimeStatusPath, "localRuntimeStatusPath");
  return {
    backendBaseUrl: requiredText(value.backendBaseUrl, "backendBaseUrl", 2048),
    machineId: uuid(value.machineId, "machineId"),
    credentialFile,
    credential,
    ...(localLifecyclePath === undefined ? {} : { localLifecyclePath }),
    ...(localRuntimeStatusPath === undefined ? {} : { localRuntimeStatusPath }),
    ...paths,
    allowInsecureLoopback: value.allowInsecureLoopback === true,
    slots,
  };
}

function parseSlot(
  value: unknown,
  index: number,
  adapter: RuntimePlatformAdapter,
): RuntimeSlotDefinition {
  const slot = strictRecord(value, SLOT_KEYS, `slots[${index}]`);
  if (
    !Array.isArray(slot.recipeIds) ||
    slot.recipeIds.length < 1 ||
    slot.recipeIds.length > 16
  )
    throw new TypeError(`slots[${index}].recipeIds is invalid`);
  const recipeIds = slot.recipeIds.map((recipe, recipeIndex) => {
    if (
      typeof recipe !== "string" ||
      !WORKER_RECIPE_IDS.includes(recipe as WorkerRecipeId)
    )
      throw new TypeError(
        `slots[${index}].recipeIds[${recipeIndex}] is invalid`,
      );
    return recipe as WorkerRecipeId;
  });
  if (new Set(recipeIds).size !== recipeIds.length)
    throw new TypeError(`slots[${index}].recipeIds contains duplicates`);
  const provider = slot.provider;
  if (provider !== adapter.provider)
    throw new TypeError(`slots[${index}].provider is invalid`);
  const directmlDeviceId =
    slot.directmlDeviceId === undefined
      ? undefined
      : safeInteger(
          slot.directmlDeviceId,
          `slots[${index}].directmlDeviceId`,
          0,
          15,
        );
  if (!adapter.deviceIdIsSafe(directmlDeviceId))
    throw new TypeError(`slots[${index}].directmlDeviceId is invalid`);
  return {
    workerId: uuid(slot.workerId, `slots[${index}].workerId`),
    gpuId: requiredText(slot.gpuId, `slots[${index}].gpuId`, 128),
    slotIndex: safeInteger(slot.slotIndex, `slots[${index}].slotIndex`, 0, 15),
    recipeIds,
    provider: adapter.provider,
    ...(directmlDeviceId === undefined ? {} : { directmlDeviceId }),
  };
}

function strictRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.has(key)))
    throw new TypeError(`${label} contains an unknown field`);
  return result;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  )
    throw new TypeError(`${label} is invalid`);
  return value;
}

function uuid(value: unknown, label: string): string {
  const result = requiredText(value, label, 36);
  if (!UUID_V4.test(result)) throw new TypeError(`${label} is invalid`);
  return result;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  )
    throw new TypeError(`${label} is invalid`);
  return value as number;
}

function assertAbsolute(value: string, label: string): void {
  if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute`);
}
