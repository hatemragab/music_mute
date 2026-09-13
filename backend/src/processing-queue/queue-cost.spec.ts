import { describe, expect, it } from 'vitest';
import { estimateCost } from './queue-cost.js';
const model = {
  revision: 'test-only',
  evidenceStatus: 'verified' as const,
  referenceProcessingSecondsPerAudioSecond: 2,
  fixedJobOverheadSeconds: 10,
  measuredAt: '2026-09-13T12:00:00Z',
};
describe('queue cost', () => {
  it('increases with input duration and includes fixed overhead', () => {
    expect(estimateCost(300, model)).toBe(610);
    expect(estimateCost(1800, model)).toBe(3610);
  });
  it.each(['unavailable', 'stale'] as const)(
    'does not treat %s evidence as zero cost',
    (evidenceStatus) => {
      expect(() => estimateCost(300, { ...model, evidenceStatus })).toThrow();
    },
  );
  it.each([NaN, Infinity, 0, -1])('rejects invalid duration %s', (duration) =>
    expect(() => estimateCost(duration, model)).toThrow(),
  );
});
