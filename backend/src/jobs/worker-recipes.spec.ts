import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKER_RECIPE_ID,
  WORKER_RECIPES,
  workerRecipeSnapshot,
} from './worker-recipes.js';

const EXPECTED_DIGESTS = {
  'kim-vocals-v2':
    '6adf28da3329ada0d4670c308f163553dc7ad4f9b2d07dad8ec8b86b47fe6e6a',
  'kim-vocals-v2-trim':
    '97198c83fd88101420299121bf6ef0f81d350f6228762c2892d817283241fc04',
} as const;

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
