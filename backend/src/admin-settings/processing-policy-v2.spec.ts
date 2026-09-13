import { describe, expect, it } from 'vitest';
import {
  assertPreparedAudioV2,
  normalizeProcessingPolicyV2,
} from './processing-policy-v2.js';

describe('version two physical limits', () => {
  it('accepts inclusive physical boundaries when evidence is verified', () => {
    expect(() =>
      assertPreparedAudioV2(
        { bytes: 100_000_000, durationSeconds: 1800 },
        { evidenceStatus: 'verified' },
      ),
    ).not.toThrow();
  });
  it.each([0, -1, NaN, Infinity, 1800.001])(
    'rejects unsafe duration %s',
    (durationSeconds) => {
      expect(() =>
        assertPreparedAudioV2(
          { bytes: 100, durationSeconds },
          { evidenceStatus: 'verified' },
        ),
      ).toThrow();
    },
  );
  it.each([0, -1, NaN, Infinity, 1.5, 100_000_001])(
    'rejects unsafe bytes %s',
    (bytes) => {
      expect(() =>
        assertPreparedAudioV2(
          { bytes, durationSeconds: 1 },
          { evidenceStatus: 'verified' },
        ),
      ).toThrow();
    },
  );
  it('does not authorize expansion from unavailable measurements', () => {
    expect(() =>
      assertPreparedAudioV2(
        { bytes: 100, durationSeconds: 1 },
        { evidenceStatus: 'unavailable' },
      ),
    ).toThrow();
    const policy = normalizeProcessingPolicyV2({
      revision: 0,
      acceptNewJobs: true,
      messageEn: '',
      messageAr: null,
    });
    expect(policy.acceptNewJobs).toBe(false);
    expect(policy.acceptLongJobs).toBe(false);
    expect(policy.limits.maxLocalSourceBytes).toBeNull();
    expect(policy.limits.maxDurationSeconds).toBe(1800);
  });
  it('rejects corrupted revisions instead of guessing', () => {
    expect(() =>
      normalizeProcessingPolicyV2({
        revision: NaN,
        acceptNewJobs: true,
        messageEn: '',
        messageAr: null,
      }),
    ).toThrow();
  });
});
