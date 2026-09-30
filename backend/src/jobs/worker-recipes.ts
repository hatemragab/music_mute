import { createHash } from 'node:crypto';
import {
  WORKER_RECIPE_IDS,
  WORKER_RECIPE_STEP_IDS,
  type WorkerRecipeId,
} from '../worker-fleet/protocol/v1/protocol.js';
import type { WorkerRecipeSnapshot } from './job.types.js';

export const QUALIFIED_MODEL_DIGEST =
  'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b';
export const QUALIFIED_MODEL_BYTES = 66_759_214;
export const DEFAULT_WORKER_RECIPE_ID = 'kim-vocals-v2' as const;

function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  throw new TypeError('Recipe contains a noncanonical value');
}

const RECIPE_FIELDS = [
  'recipeId',
  'recipeRevision',
  'protocolVersion',
  'recipeDigest',
  'modelFilename',
  'modelDigest',
  'modelBytes',
  'inputProfileId',
  'stepIds',
  'trimEnabled',
  'denoiseEnabled',
  'denoisePresetId',
  'trimProfileId',
  'outputFormat',
  'outputBitrateKbps',
] as const satisfies readonly (keyof WorkerRecipeSnapshot)[];

function recipeDigest(material: Omit<WorkerRecipeSnapshot, 'recipeDigest'>) {
  return createHash('sha256').update(canonical(material)).digest('hex');
}

/** Validate persisted recipes without requiring the current deployment's revision. */
export function isWorkerRecipeSnapshot(
  value: unknown,
): value is WorkerRecipeSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const recipe = value as Record<string, unknown>;
  if (
    Object.keys(recipe).length !== RECIPE_FIELDS.length ||
    RECIPE_FIELDS.some((key) => !Object.hasOwn(recipe, key)) ||
    !WORKER_RECIPE_IDS.some((id) => id === recipe.recipeId) ||
    typeof recipe.recipeRevision !== 'number' ||
    !Number.isSafeInteger(recipe.recipeRevision) ||
    recipe.recipeRevision < 1 ||
    recipe.protocolVersion !== 1 ||
    typeof recipe.recipeDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(recipe.recipeDigest) ||
    recipe.modelFilename !== 'Kim_Vocal_2.onnx' ||
    typeof recipe.modelDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(recipe.modelDigest) ||
    typeof recipe.modelBytes !== 'number' ||
    !Number.isSafeInteger(recipe.modelBytes) ||
    recipe.modelBytes < 1 ||
    recipe.inputProfileId !== 'direct-input-v1' ||
    !Array.isArray(recipe.stepIds) ||
    recipe.stepIds.length < 2 ||
    recipe.stepIds.length > 6 ||
    new Set(recipe.stepIds).size !== recipe.stepIds.length ||
    !recipe.stepIds.every((step) =>
      WORKER_RECIPE_STEP_IDS.some((id) => id === step),
    ) ||
    typeof recipe.trimEnabled !== 'boolean' ||
    typeof recipe.denoiseEnabled !== 'boolean' ||
    (recipe.denoisePresetId !== null &&
      recipe.denoisePresetId !== 'afftdn-conservative-v1') ||
    (recipe.trimProfileId !== null &&
      recipe.trimProfileId !== 'trim-vocal-mp3-v1' &&
      recipe.trimProfileId !== 'trim-vocal-wav-v1') ||
    recipe.outputFormat !== 'mp3' ||
    recipe.outputBitrateKbps !== 160
  )
    return false;
  const { recipeDigest: digest, ...material } = value as WorkerRecipeSnapshot;
  return digest === recipeDigest(material);
}

function createRecipe(
  recipeId: WorkerRecipeId,
  trimEnabled = true,
): Readonly<WorkerRecipeSnapshot> {
  const stepIds: WorkerRecipeSnapshot['stepIds'] = [
    'separate-kim-vocal-2-wav-v1',
    ...(trimEnabled ? ['trim-vocal-wav-v1' as const] : []),
    'encode-mp3-up-to-160k-v1',
    'validate-audio-v1',
  ];
  const material: Omit<WorkerRecipeSnapshot, 'recipeDigest'> = {
    recipeId,
    recipeRevision: 6,
    protocolVersion: 1,
    modelFilename: 'Kim_Vocal_2.onnx',
    modelDigest: QUALIFIED_MODEL_DIGEST,
    modelBytes: QUALIFIED_MODEL_BYTES,
    inputProfileId: 'direct-input-v1',
    stepIds,
    trimEnabled,
    denoiseEnabled: false,
    denoisePresetId: null,
    trimProfileId: trimEnabled ? 'trim-vocal-wav-v1' : null,
    outputFormat: 'mp3',
    outputBitrateKbps: 160,
  };
  return Object.freeze({
    ...material,
    stepIds: Object.freeze([
      ...stepIds,
    ]) as unknown as WorkerRecipeSnapshot['stepIds'],
    recipeDigest: recipeDigest(material),
  });
}

export const WORKER_RECIPES: Readonly<
  Record<WorkerRecipeId, Readonly<WorkerRecipeSnapshot>>
> = Object.freeze({
  'kim-vocals-v2': createRecipe('kim-vocals-v2'),
  'kim-vocals-v2-trim': createRecipe('kim-vocals-v2-trim'),
});

export function workerRecipeSnapshot(
  recipeId: WorkerRecipeId,
  trimEnabled = true,
): WorkerRecipeSnapshot {
  const recipe = trimEnabled
    ? WORKER_RECIPES[recipeId]
    : createRecipe(recipeId, false);
  return { ...recipe, stepIds: [...recipe.stepIds] };
}
