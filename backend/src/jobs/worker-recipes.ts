import { createHash } from 'node:crypto';
import type { WorkerRecipeId } from '../worker-fleet/protocol/v1/protocol.js';
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
    recipeDigest: createHash('sha256')
      .update(canonical(material))
      .digest('hex'),
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
