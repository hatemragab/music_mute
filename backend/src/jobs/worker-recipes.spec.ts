import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKER_RECIPE_ID,
  WORKER_RECIPES,
  workerRecipeSnapshot,
} from './worker-recipes.js';

const EXPECTED_DIGESTS = {
  'kim-vocals-v2':
    '4d5075f55c3adad6712d4f823e3455df1189f8fa064d3b173317c3adbc46b17a',
  'kim-vocals-v2-trim':
    '8dc89087f05cfe5e561b66e5091a75cdd50f42a2ebf69cbac374b31e3767b11d',
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
