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
  it('accepts a valid audio declaration and the inclusive standard boundary', () => {
    expect(() => assertInputDeclaration(input)).not.toThrow();
    expect(() =>
      assertInputDeclaration({
        ...input,
        bytes: 50_000_000,
        durationSeconds: 1_200,
      }),
    ).not.toThrow();
  });
  it.each([0, -1, 50_000_001, 50_000_002, 1.5, NaN, Infinity])(
    'rejects invalid byte count %s',
    (bytes) => {
      expect(() => assertInputDeclaration({ ...input, bytes })).toThrow();
    },
  );
  it.each([0, -1, 1_200.001, 1_201, NaN, Infinity])(
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
  it('uses the same inclusive ceiling for measured duration', () => {
    expect(() => assertMeasuredDuration(299.9, 300)).not.toThrow();
    expect(() => assertMeasuredDuration(300, 300)).not.toThrow();
    expect(() => assertMeasuredDuration(300.001, 300)).toThrow();
    expect(() => assertMeasuredDuration(1_200)).not.toThrow();
  });
});
