import {
  assertInputDeclaration,
  assertMeasuredDuration,
  nextCancellationState,
} from './job-state.js';

const input = {
  extension: 'mp3' as const,
  contentType: 'audio/mpeg',
  bytes: 1024,
  durationSeconds: 30,
  sha256: Buffer.alloc(32).toString('base64'),
};

describe('processing input boundaries', () => {
  it('accepts a valid audio declaration and the last permitted byte', () => {
    expect(() => assertInputDeclaration(input)).not.toThrow();
    expect(() =>
      assertInputDeclaration({
        ...input,
        bytes: 29_999_999,
        durationSeconds: 599.999,
      }),
    ).not.toThrow();
  });
  it.each([0, -1, 30_000_000, 30_000_001, 1.5, NaN, Infinity])(
    'rejects invalid byte count %s',
    (bytes) => {
      expect(() => assertInputDeclaration({ ...input, bytes })).toThrow();
    },
  );
  it.each([0, -1, 600, 601, NaN, Infinity])(
    'rejects invalid duration %s',
    (durationSeconds) => {
      expect(() =>
        assertInputDeclaration({ ...input, durationSeconds }),
      ).toThrow();
    },
  );
  it.each([
    '',
    'not-a-checksum',
    Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'),
  ])('rejects invalid SHA-256 %s', (sha256) => {
    expect(() => assertInputDeclaration({ ...input, sha256 })).toThrow();
  });
  it('rejects an extension/type mismatch and unknown containers', () => {
    expect(() =>
      assertInputDeclaration({ ...input, contentType: 'video/mp4' }),
    ).toThrow();
    expect(() =>
      assertInputDeclaration({ ...input, extension: '../mp3' } as never),
    ).toThrow();
  });
});

describe('cancellation state rules', () => {
  it.each([
    'awaiting_upload',
    'queued',
    'validating',
    'processing',
    'uploading_result',
    'interrupted',
    'cancel_requested',
    'cancelled',
  ] as const)('immediately cancels %s', (state) => {
    expect(nextCancellationState(state)).toBe('cancelled');
  });
  it.each(['ready', 'failed'] as const)('preserves terminal %s', (state) => {
    expect(() => nextCancellationState(state)).toThrow();
  });
});

describe('captured duration limits', () => {
  it('uses the accepted exclusive ceiling for measured duration', () => {
    expect(() => assertMeasuredDuration(299.9, 300)).not.toThrow();
    expect(() => assertMeasuredDuration(300, 300)).toThrow();
    expect(() => assertMeasuredDuration(500, 600)).not.toThrow();
  });
});
