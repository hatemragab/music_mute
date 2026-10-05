import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isWorkerRecipeSnapshot,
  workerRecipeSnapshot,
} from '../jobs/worker-recipes.js';
import { validComparisonRanges } from '../jobs/comparison-ranges.js';
import { trimPcmFile } from './shared-media-derivation.service.js';
import {
  derivedTrimRecipe,
  retainedPcmRanges,
  trimPcm,
  TRIM_SAMPLE_RATE,
} from './shared-media-trim.js';

function pcm(parts: [number, number][]) {
  const frames = parts.reduce(
    (n, [seconds]) => n + Math.round(seconds * TRIM_SAMPLE_RATE),
    0,
  );
  const data = Buffer.alloc(frames * 4);
  let cursor = 0;
  for (const [seconds, amplitude] of parts)
    for (let i = 0; i < Math.round(seconds * TRIM_SAMPLE_RATE); i++, cursor++) {
      data.writeInt16LE(amplitude, cursor * 4);
      data.writeInt16LE(amplitude, cursor * 4 + 2);
    }
  return data;
}
describe('shared full-MP3 trim profile', () => {
  it('creates a valid separately identified recipe with no separation step', () => {
    const full = workerRecipeSnapshot('kim-vocals-v2', false);
    const derived = derivedTrimRecipe(full);
    expect(isWorkerRecipeSnapshot(derived)).toBe(true);
    expect(derived.recipeDigest).not.toBe(full.recipeDigest);
    expect(derived.recipeDigest).not.toBe(
      workerRecipeSnapshot('kim-vocals-v2', true).recipeDigest,
    );
    expect(derived.modelDigest).toBe(full.modelDigest);
    expect(derived.stepIds).not.toContain('separate-kim-vocal-2-wav-v1');
    expect(derived.trimProfileId).toBe('trim-vocal-mp3-v1');
  });
  it('keeps 200ms padding around a 1s interior gap and applies 5ms fades', () => {
    const source = pcm([
      [0.5, 12_000],
      [1, 0],
      [0.5, 12_000],
    ]);
    const result = trimPcm(source);
    expect(result.comparisonRanges).toEqual([
      [0, 30870],
      [57330, 88200],
    ]);
    expect(validComparisonRanges(result.comparisonRanges)).toBe(true);
    expect(result.pcm.length).toBe(Math.round(1.4 * TRIM_SAMPLE_RATE) * 4);
    expect(result.pcm.readInt16LE(Math.round(0.7 * TRIM_SAMPLE_RATE) * 4)).toBe(
      0,
    );
    expect(source.readInt16LE(0)).toBe(12_000);
  });
  it('keeps short gaps and all-silent inputs intact', () => {
    expect(
      retainedPcmRanges(
        pcm([
          [0.2, 5_000],
          [0.5, 0],
          [0.2, 5_000],
        ]),
      ),
    ).toEqual([[0, 39_690]]);
    expect(retainedPcmRanges(pcm([[1, 0]]))).toEqual([[0, TRIM_SAMPLE_RATE]]);
  });
  it('uses the loudest channel to preserve asymmetric vocal signal', () => {
    const source = pcm([[1, 0]]);
    for (let i = 0; i < TRIM_SAMPLE_RATE; i++)
      source.writeInt16LE(1_000, i * 4 + 2);
    expect(retainedPcmRanges(source)).toEqual([[0, TRIM_SAMPLE_RATE]]);
  });
  it('streams the same ranges and PCM bytes as the reference buffer implementation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'musicmute-trim-test-'));
    try {
      const source = pcm([
        [0.8, 0],
        [0.4, 9_003],
        [1, 0],
        [0.4, 9_003],
        [0.8, 0],
      ]);
      const expected = trimPcm(source);
      const path = join(directory, 'input.pcm');
      const output = join(directory, 'trimmed.pcm');
      await writeFile(path, source);
      expect(await trimPcmFile(path, output, source.length / 4)).toEqual(
        retainedPcmRanges(source),
      );
      expect(await readFile(output)).toEqual(expected.pcm);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
