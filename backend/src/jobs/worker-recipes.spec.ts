import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  DEFAULT_WORKER_RECIPE_ID,
  WORKER_RECIPES,
  isWorkerRecipeSnapshot,
  workerRecipeSnapshot,
} from './worker-recipes.js';

const EXPECTED_DIGESTS = {
  'kim-vocals-v2':
    '6adf28da3329ada0d4670c308f163553dc7ad4f9b2d07dad8ec8b86b47fe6e6a',
  'kim-vocals-v2-trim':
    '97198c83fd88101420299121bf6ef0f81d350f6228762c2892d817283241fc04',
} as const;

function digestFor(material: Record<string, unknown>) {
  return createHash('sha256')
    .update(JSON.stringify(material, Object.keys(material).sort()))
    .digest('hex');
}

describe('worker recipe catalog', () => {
  it('freezes the mandatory WAV trim recipes with cross-language digests', () => {
    expect(DEFAULT_WORKER_RECIPE_ID).toBe('kim-vocals-v2');
    expect(Object.keys(WORKER_RECIPES)).toEqual(Object.keys(EXPECTED_DIGESTS));
    for (const [recipeId, digest] of Object.entries(EXPECTED_DIGESTS))
      expect(
        WORKER_RECIPES[recipeId as keyof typeof WORKER_RECIPES].recipeDigest,
      ).toBe(digest);
  });

  it('freezes the no-trim option with its own cross-language digest', () => {
    const recipe = workerRecipeSnapshot('kim-vocals-v2', false);
    expect(recipe.trimEnabled).toBe(false);
    expect(recipe.trimProfileId).toBeNull();
    expect(recipe.stepIds).not.toContain('trim-vocal-wav-v1');
    expect(recipe.stepIds).toContain('encode-mp3-up-to-160k-v1');
    expect(recipe.recipeDigest).toBe(
      '23e22a5fe3b9a604f7ff5241f0fa7194bacf153fc37df83d83898949610a89d9',
    );
  });
  it('returns a mutable persistence copy without mutating the catalog', () => {
    const snapshot = workerRecipeSnapshot('kim-vocals-v2-trim');
    snapshot.stepIds.pop();
    expect(WORKER_RECIPES['kim-vocals-v2-trim'].stepIds).toHaveLength(4);
  });
});

describe('persisted worker recipe validation', () => {
  it('accepts current catalog snapshots and older self-consistent frozen recipes', () => {
    for (const recipeId of Object.keys(WORKER_RECIPES)) {
      const recipe = workerRecipeSnapshot(
        recipeId as keyof typeof WORKER_RECIPES,
      );
      expect(isWorkerRecipeSnapshot(recipe)).toBe(true);
      expect(
        isWorkerRecipeSnapshot(workerRecipeSnapshot(recipe.recipeId, false)),
      ).toBe(true);
    }
    const { recipeDigest: _digest, ...material } = workerRecipeSnapshot(
      DEFAULT_WORKER_RECIPE_ID,
    );
    const previous = {
      ...material,
      recipeRevision: 5,
      modelDigest: 'f'.repeat(64),
      modelBytes: 66_000_000,
    };
    expect(
      isWorkerRecipeSnapshot({
        ...previous,
        recipeDigest: digestFor(previous),
      }),
    ).toBe(true);
  });

  it('rejects tampering without recomputing the frozen digest', () => {
    const recipe = workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID);
    expect(
      isWorkerRecipeSnapshot({ ...recipe, modelDigest: 'f'.repeat(64) }),
    ).toBe(false);
  });

  it.each([
    { recipeId: 'unknown-recipe' },
    { recipeRevision: 0 },
    { recipeRevision: 1.5 },
    { protocolVersion: 2 },
    { modelFilename: '../model.onnx' },
    { modelDigest: 'invalid' },
    { modelBytes: 0 },
    { modelBytes: Number.MAX_SAFE_INTEGER + 1 },
    { stepIds: ['unknown-step', 'validate-audio-v1'] },
    { stepIds: ['validate-audio-v1', 'validate-audio-v1'] },
    { trimEnabled: 'true' },
    { denoisePresetId: 'unknown-preset' },
    { outputBitrateKbps: 320 },
    { extraField: true },
  ])(
    'rejects invalid bounded material even with a matching digest: %j',
    (invalid) => {
      const { recipeDigest: _digest, ...material } = workerRecipeSnapshot(
        DEFAULT_WORKER_RECIPE_ID,
      );
      const changed = { ...material, ...invalid };
      expect(
        isWorkerRecipeSnapshot({
          ...changed,
          recipeDigest: digestFor(changed),
        }),
      ).toBe(false);
    },
  );

  it('rejects missing recipe fields and non-object values', () => {
    const {
      recipeDigest: _digest,
      trimProfileId: _profile,
      ...material
    } = workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID);
    expect(
      isWorkerRecipeSnapshot({
        ...material,
        recipeDigest: digestFor(material),
      }),
    ).toBe(false);
    for (const invalid of [null, undefined, [], 'recipe'])
      expect(isWorkerRecipeSnapshot(invalid)).toBe(false);
  });
});
