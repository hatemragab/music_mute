import { describe, expect, it } from 'vitest';
import { assertExecutionEvidence } from './execution-evidence.js';
const now = new Date('2026-09-13T12:01:00Z');
const start = new Date('2026-09-13T12:00:00Z');
const evidence = {
  eventId: 'event',
  separatorExecutionSeconds: 20,
  processingStartedAt: start.toISOString(),
  measuredAudioSeconds: 30,
  stoppedConfirmed: true,
};
describe('trusted cumulative separator timing', () => {
  it('accepts bounded cumulative time', () =>
    expect(() =>
      assertExecutionEvidence(evidence, 'event', 10, start, now),
    ).not.toThrow());
  it.each([NaN, Infinity, -1, 9, 100])(
    'rejects invalid or regressing execution %s',
    (separatorExecutionSeconds) =>
      expect(() =>
        assertExecutionEvidence(
          { ...evidence, separatorExecutionSeconds },
          'event',
          10,
          start,
          now,
        ),
      ).toThrow(),
  );
  it('rejects evidence from another event and unknown measurements', () => {
    expect(() =>
      assertExecutionEvidence(evidence, 'other', 10, start, now),
    ).toThrow();
    expect(() =>
      assertExecutionEvidence(
        { ...evidence, measuredAudioSeconds: NaN },
        'event',
        10,
        start,
        now,
      ),
    ).toThrow();
  });
});
