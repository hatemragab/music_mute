import { describe, expect, it } from 'vitest';
import { validComparisonRanges } from './comparison-ranges.js';

describe('comparison ranges', () => {
  it('accepts ordered retained intervals and rejects ambiguous or unsafe timelines', () => {
    expect(
      validComparisonRanges([
        [0, 441000],
        [882000, 1323000],
      ]),
    ).toBe(true);
    for (const ranges of [
      null,
      [],
      [[0, 0]],
      [[-1, 10]],
      [[0, 1.5]],
      [
        [0, 10],
        [9, 20],
      ],
      [[0, 52920001]],
      [[0, 10, 20]],
    ])
      expect(validComparisonRanges(ranges)).toBe(false);
  });
});
