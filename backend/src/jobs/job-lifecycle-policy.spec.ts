import { JOB_FAILURE_CODES, JOB_STATUSES } from './job.types.js';
import {
  ACTIVE_ADMISSION_STATUSES,
  JOB_CAPACITY_GROUP_BY_STATUS,
  JOB_FAILURE_SOURCES,
  PROCESSING_CAPACITY_STATUSES,
  TERMINAL_JOB_STATUSES,
  WAITING_CAPACITY_STATUSES,
  capacityGroupForStatus,
  resolveJobFailure,
  safeJobFailureMessage,
  settlementForStatus,
} from './job-lifecycle-policy.js';

describe('job lifecycle policy', () => {
  it('classifies every public status into one capacity group', () => {
    expect(Object.keys(JOB_CAPACITY_GROUP_BY_STATUS).sort()).toEqual(
      [...JOB_STATUSES].sort(),
    );
    expect(WAITING_CAPACITY_STATUSES).toEqual(['awaiting_upload', 'queued']);
    expect(PROCESSING_CAPACITY_STATUSES).toEqual([
      'validating',
      'processing',
      'uploading_result',
      'interrupted',
      'cancel_requested',
    ]);
    expect(TERMINAL_JOB_STATUSES).toEqual(['ready', 'failed', 'cancelled']);
    expect(ACTIVE_ADMISSION_STATUSES).toHaveLength(7);
    expect(capacityGroupForStatus('awaiting_upload')).toBe('preparing');
    expect(capacityGroupForStatus('queued')).toBe('queued');
    expect(capacityGroupForStatus('processing')).toBe('processing');
    expect(capacityGroupForStatus('ready')).toBe('terminal');
  });

  it('maps every safe job failure code into the complete source contract', () => {
    for (const code of JOB_FAILURE_CODES) {
      expect(JOB_FAILURE_SOURCES).toContain(code);
      expect(safeJobFailureMessage(code)).toEqual(expect.any(String));
    }
    expect(new Set(JOB_FAILURE_SOURCES).size).toBe(JOB_FAILURE_SOURCES.length);
  });

  it('preserves one reservation through bounded infrastructure retry', () => {
    expect(
      resolveJobFailure('DOWNLOAD_FAILED', {
        retryEligible: true,
        attemptsRemaining: 3,
        attemptNumber: 1,
        maxAttempts: 3,
      }),
    ).toMatchObject({
      classification: 'infrastructure_transient',
      automaticRetry: true,
      settlement: 'preserve',
      cleanup: 'preserve_for_retry',
      publicAction: 'retry_automatically',
    });
  });

  it('turns attempt three into terminal infrastructure failure and release', () => {
    expect(
      resolveJobFailure('LEASE_EXPIRED', {
        retryEligible: true,
        attemptsRemaining: 1,
        attemptNumber: 3,
        maxAttempts: 3,
      }),
    ).toMatchObject({
      classification: 'infrastructure_terminal',
      automaticRetry: false,
      settlement: 'release',
      cleanup: 'cleanup',
      publicFailureCode: 'SEPARATOR_FAILED',
      publicAction: 'retry_later',
    });
  });

  it('never converts client/input or invalid output failures into worker retry', () => {
    expect(resolveJobFailure('INVALID_AUDIO')).toMatchObject({
      classification: 'client_input',
      automaticRetry: false,
      settlement: 'release',
      publicAction: 'replace_input',
    });
    expect(resolveJobFailure('OUTPUT_INVALID')).toMatchObject({
      classification: 'infrastructure_terminal',
      automaticRetry: false,
      settlement: 'release',
    });
  });

  it('separates user actions and policy denial from infrastructure failures', () => {
    expect(resolveJobFailure('USER_CANCELLED')).toMatchObject({
      classification: 'user_action',
      settlement: 'release',
      cleanup: 'cleanup',
    });
    expect(resolveJobFailure('QUEUE_FULL')).toMatchObject({
      classification: 'policy',
      settlement: 'none',
      cleanup: 'none',
    });
  });

  it('defines the only status-based reservation settlement points', () => {
    for (const status of ACTIVE_ADMISSION_STATUSES)
      expect(settlementForStatus(status)).toBe('preserve');
    expect(settlementForStatus('ready')).toBe('consume');
    expect(settlementForStatus('failed')).toBe('release');
    expect(settlementForStatus('cancelled')).toBe('release');
  });

  it('rejects missing or corrupt infrastructure retry context', () => {
    expect(() => resolveJobFailure('SEPARATOR_FAILED')).toThrow(
      'Infrastructure retry context is required',
    );
    expect(() =>
      resolveJobFailure('SEPARATOR_FAILED', {
        retryEligible: true,
        attemptsRemaining: -1,
        attemptNumber: 0,
        maxAttempts: 0,
      }),
    ).toThrow('Invalid infrastructure retry context');
  });
});
