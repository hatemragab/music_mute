import { createHash } from 'node:crypto';
import type { WorkerRecipeId } from '../worker-fleet/protocol/v1/protocol.js';
import type { WorkerRecipeSnapshot } from './job.types.js';

export const QUALIFIED_MODEL_DIGEST =
  'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b';
export const QUALIFIED_MODEL_BYTES = 66_759_214;
export const DEFAULT_WORKER_RECIPE_ID = 'kim-vocals-trim-v1' as const;

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

function createRecipe(
  recipeId: WorkerRecipeId,
  trimEnabled: boolean,
  denoiseEnabled: boolean,
): Readonly<WorkerRecipeSnapshot> {
  const stepIds: WorkerRecipeSnapshot['stepIds'] = [
    'prepare-pcm16-stereo-44100-v1',
    'separate-kim-vocal-2-v1',
    ...(denoiseEnabled ? (['denoise-afftdn-conservative-v1'] as const) : []),
    ...(trimEnabled ? (['trim-vocal-gaps-v1'] as const) : []),
    'encode-mp3-192k-v1',
    'validate-audio-v1',
  ];
  const material: Omit<WorkerRecipeSnapshot, 'recipeDigest'> = {
    recipeId,
    recipeRevision: 1,
    protocolVersion: 1,
    modelFilename: 'Kim_Vocal_2.onnx',
    modelDigest: QUALIFIED_MODEL_DIGEST,
    modelBytes: QUALIFIED_MODEL_BYTES,
    preparationProfileId: 'pcm16-stereo-44100-v1',
    stepIds,
    trimEnabled,
    denoiseEnabled,
    denoisePresetId: denoiseEnabled ? 'afftdn-conservative-v1' : null,
    trimProfileId: trimEnabled ? 'trim-vocal-gaps-v1' : null,
    outputFormat: 'mp3',
    outputBitrateKbps: 192,
  };
  return Object.freeze({
    ...material,
    stepIds: Object.freeze([
      ...stepIds,
    ]) as unknown as WorkerRecipeSnapshot['stepIds'],
    recipeDigest: createHash('sha256')
      .update(canonical(material))
      .digest('hex'),
  });
}

export const WORKER_RECIPES: Readonly<
  Record<WorkerRecipeId, Readonly<WorkerRecipeSnapshot>>
> = Object.freeze({
  'kim-vocals-v1': createRecipe('kim-vocals-v1', false, false),
  'kim-vocals-trim-v1': createRecipe('kim-vocals-trim-v1', true, false),
  'kim-vocals-denoise-v1': createRecipe('kim-vocals-denoise-v1', false, true),
  'kim-vocals-denoise-trim-v1': createRecipe(
    'kim-vocals-denoise-trim-v1',
    true,
    true,
  ),
});

export function workerRecipeSnapshot(
  recipeId: WorkerRecipeId,
): WorkerRecipeSnapshot {
  const recipe = WORKER_RECIPES[recipeId];
  return { ...recipe, stepIds: [...recipe.stepIds] };
}
