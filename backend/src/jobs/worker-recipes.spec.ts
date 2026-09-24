import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKER_RECIPE_ID,
  WORKER_RECIPES,
  workerRecipeSnapshot,
} from './worker-recipes.js';

const EXPECTED_DIGESTS = {
  'kim-vocals-v2':
    'ebc14b7b566b876246d260fe7807e513b183eb639ad7199c61e50ae8424222c6',
  'kim-vocals-v2-trim':
    'c972a312647859a262ba9390705f7296c9f7a30359c33cefc44a6955356ac590',
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

  it('returns a mutable persistence copy without mutating the catalog', () => {
    const snapshot = workerRecipeSnapshot('kim-vocals-v2-trim');
    snapshot.stepIds.pop();
    expect(WORKER_RECIPES['kim-vocals-v2-trim'].stepIds).toHaveLength(4);
  });
});
