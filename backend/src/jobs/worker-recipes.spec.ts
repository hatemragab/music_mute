import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKER_RECIPE_ID,
  WORKER_RECIPES,
  workerRecipeSnapshot,
} from './worker-recipes.js';

const EXPECTED_DIGESTS = {
  'kim-vocals-v1':
    '6028cde28fb5630630553881d15651cab4cd688ae49eb2935c25ed8e2acdd551',
  'kim-vocals-trim-v1':
    '1a70379331fafb360f4cd388e17f4c6ce511031e4082f34ba63676957d8c34c3',
  'kim-vocals-denoise-v1':
    '5d6d9256e173c38e844e9714a61469311cd7afc53a5a71e64b666d56f81848d3',
  'kim-vocals-denoise-trim-v1':
    '11108d3034ab11a5a099863d2832268de44cea000d5a46c335b826cac2c78be5',
} as const;

describe('worker recipe catalog', () => {
  it('freezes the four D2 combinations and their cross-language digests', () => {
    expect(DEFAULT_WORKER_RECIPE_ID).toBe('kim-vocals-trim-v1');
    expect(Object.keys(WORKER_RECIPES)).toEqual(Object.keys(EXPECTED_DIGESTS));
    for (const [recipeId, digest] of Object.entries(EXPECTED_DIGESTS))
      expect(
        WORKER_RECIPES[recipeId as keyof typeof WORKER_RECIPES].recipeDigest,
      ).toBe(digest);
  });

  it('returns a mutable persistence copy without mutating the catalog', () => {
    const snapshot = workerRecipeSnapshot('kim-vocals-trim-v1');
    snapshot.stepIds.pop();
    expect(WORKER_RECIPES['kim-vocals-trim-v1'].stepIds).toHaveLength(5);
  });
});
