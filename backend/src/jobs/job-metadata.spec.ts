import { describe, expect, it } from 'vitest';
import { normalizeJobMetadata } from './job-metadata.js';

describe('job source metadata', () => {
  it('retains a canonical YouTube URL for URL-backed jobs', () => {
    expect(
      normalizeJobMetadata({
        sourceTitle: 'Interview',
        sourceKind: 'url',
        sourceUrl: '  https://www.youtube.com/watch?v=jNQXAC9IVRw  ',
      }),
    ).toEqual({
      sourceTitle: 'Interview',
      sourceKind: 'url',
      sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    });
  });

  it('rejects source URLs on non-URL jobs and unsafe URL shapes', () => {
    expect(() =>
      normalizeJobMetadata({
        sourceKind: 'file',
        sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      }),
    ).toThrow();
    expect(() =>
      normalizeJobMetadata({
        sourceKind: 'url',
        sourceUrl: 'https://youtube.com/watch?v=jNQXAC9IVRw',
      }),
    ).toThrow();
  });
});
