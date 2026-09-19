import { describe, expect, it } from 'vitest';
import { normalizeJobMetadata } from './job-metadata.js';

const standard = {
  policyVersion: 2 as const,
  preparationProfileId: 'preserve-or-aac-lc-256-v1',
  source: 'audio_file' as const,
};

describe('job source metadata', () => {
  it('retains a canonical YouTube URL for URL-backed jobs', () => {
    expect(
      normalizeJobMetadata({
        ...standard,
        sourceTitle: 'Interview',
        sourceKind: 'url',
        sourceUrl: '  https://www.youtube.com/watch?v=jNQXAC9IVRw  ',
      }),
    ).toEqual({
      ...standard,
      sourceTitle: 'Interview',
      sourceKind: 'url',
      sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    });
  });

  it('rejects source URLs on non-URL jobs and unsafe URL shapes', () => {
    expect(() =>
      normalizeJobMetadata({
        ...standard,
        sourceKind: 'file',
        sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      }),
    ).toThrow();
    expect(() =>
      normalizeJobMetadata({
        ...standard,
        sourceKind: 'url',
        sourceUrl: 'https://youtube.com/watch?v=jNQXAC9IVRw',
      }),
    ).toThrow();
  });
});

describe('versioned preparation metadata', () => {
  it('preserves an explicit supported profile and source in the idempotency identity', () => {
    const metadata = {
      policyVersion: 2,
      preparationProfileId: 'preserve-or-aac-lc-256-v1',
      source: 'video_file',
    };
    expect(normalizeJobMetadata(metadata as never)).toEqual(metadata);
  });
  it('rejects an unknown version or profile instead of silently using legacy admission', () => {
    expect(() => normalizeJobMetadata({ policyVersion: 3 } as never)).toThrow();
    expect(() =>
      normalizeJobMetadata({
        policyVersion: 2,
        preparationProfileId: 'unknown',
        source: 'audio_file',
      } as never),
    ).toThrow();
  });
});
