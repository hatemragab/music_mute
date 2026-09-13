import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUEUE_POLICY,
  validateQueuePolicy,
} from './queue-policy.schema.js';
describe('configurable processing policy safety', () => {
  it('accepts conservative defaults without inventing hardware measurements', () =>
    expect(() => validateQueuePolicy(DEFAULT_QUEUE_POLICY)).not.toThrow());
  it.each([
    { maxDurationSeconds: 1801 },
    { maxPreparedAudioBytes: 100000001 },
    { maxActiveJobsPerUser: 2 },
    { allowanceWindowSeconds: 3600 },
    { maxOutstandingJobs: 0 },
    { agingThresholdSeconds: NaN },
  ])('rejects unsafe policy %j', (patch) =>
    expect(() =>
      validateQueuePolicy({ ...DEFAULT_QUEUE_POLICY, ...patch }),
    ).toThrow(),
  );
});
