import { model } from 'mongoose';
import { JobSchema } from './job.schema.js';

const Job = model('JobSchemaBoundaryFixture', JobSchema);

describe('durable job schema boundaries', () => {
  it('uses the same Unicode title length limit as HTTP validation', () => {
    const valid = new Job({
      sourceTitle: '🎵'.repeat(200),
      displayName: '🎵'.repeat(200),
    });
    expect(valid.validateSync()?.errors).not.toHaveProperty('sourceTitle');
    expect(valid.validateSync()?.errors).not.toHaveProperty('displayName');
    expect(
      new Job({ sourceTitle: '🎵'.repeat(201) }).validateSync()?.errors,
    ).toHaveProperty('sourceTitle');
  });
  it('accepts only canonical YouTube source URLs', () => {
    const valid = new Job({
      sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    });
    expect(valid.validateSync()?.errors).not.toHaveProperty('sourceUrl');
    expect(
      new Job({
        sourceUrl: 'https://example.test/watch?v=jNQXAC9IVRw',
      }).validateSync()?.errors,
    ).toHaveProperty('sourceUrl');
  });
  it('rejects unknown job fields rather than persisting attacker-selected data', () => {
    expect(() => new Job({ presignedUrl: 'https://untrusted.test' })).toThrow();
  });
  it('requires ownership and an input reservation', () => {
    expect(new Job({ status: 'queued' }).validateSync()?.errors).toHaveProperty(
      'userId',
    );
    expect(new Job({ status: 'queued' }).validateSync()?.errors).toHaveProperty(
      'inputReservation',
    );
  });
  it('does not persist an unknown lifecycle state', () => {
    expect(
      new Job({ status: 'deleted' }).validateSync()?.errors,
    ).toHaveProperty('status');
  });
  it('contains no worker ownership or claim queue fields and indexes', () => {
    for (const path of [
      'workerId',
      'attemptId',
      'sessionId',
      'generation',
      'leaseExpiresAt',
      'outputReservation',
      'queueOrder',
    ]) {
      expect(JobSchema.path(path)).toBeUndefined();
    }
    const indexes = JobSchema.indexes();
    expect(indexes.some(([fields]) => 'workerId' in fields)).toBe(false);
    expect(indexes.some(([, options]) => options.name === 'jobs_fifo')).toBe(
      false,
    );
  });
});
