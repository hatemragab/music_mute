import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKER_RECIPE_ID,
  WORKER_RECIPES,
  workerRecipeSnapshot,
} from './worker-recipes.js';

const EXPECTED_DIGESTS = {
  'kim-vocals-v2':
    'af00fff596b93554498142a731c4d161a706614438e0d5643f804c08f49c1ff1',
  'kim-vocals-v2-trim':
    '2989b222ff771dc1abfd44fbe46e37bd65e79478fb410ee2c1b565c122fa6e05',
} as const;

describe('worker recipe catalog', () => {
  it('freezes the plain and trimmed recipes with cross-language digests', () => {
    expect(DEFAULT_WORKER_RECIPE_ID).toBe('kim-vocals-v2-trim');
    expect(Object.keys(WORKER_RECIPES)).toEqual(Object.keys(EXPECTED_DIGESTS));
    for (const [recipeId, digest] of Object.entries(EXPECTED_DIGESTS))
      expect(
        WORKER_RECIPES[recipeId as keyof typeof WORKER_RECIPES].recipeDigest,
      ).toBe(digest);
  });

  it('returns a mutable persistence copy without mutating the catalog', () => {
    const snapshot = workerRecipeSnapshot('kim-vocals-v2-trim');
    snapshot.stepIds.pop();
    expect(WORKER_RECIPES['kim-vocals-v2-trim'].stepIds).toHaveLength(5);
  });
});
