import { Types } from 'mongoose';
import { presentJob } from './jobs.presenter.js';
import type { Job } from './job.schema.js';

const job = {
  _id: new Types.ObjectId(),
  requestId: '12345678-1234-4567-8123-123456789abc',
  status: 'ready',
  createdAt: new Date('2026-09-10T10:00:00Z'),
  updatedAt: new Date('2026-09-10T10:01:00Z'),
  finishedAt: new Date('2026-09-10T10:01:00Z'),
  inputReservation: { extension: 'mp3', bytes: 100, durationSeconds: 10 },
  inputObject: null,
  outputObject: null,
} as Job;

describe('audio experience job presentation', () => {
  it('preserves the source and renamed display name plus intake reference', () => {
    const named = { ...job, sourceTitle: 'Interview', displayName: 'My voice' };
    expect(presentJob(named)).toMatchObject({
      requestId: job.requestId,
      sourceTitle: 'Interview',
      displayName: 'My voice',
    });
  });

  it('keeps legacy names and processing measurements unavailable', () => {
    expect(presentJob(job)).toMatchObject({
      sourceTitle: null,
      displayName: null,
      timing: { processingElapsedMs: null, totalElapsedMs: null },
    });
  });

  it('separates recorded processing time from queue and upload time', () => {
    expect(
      presentJob({
        ...job,
        clientStartedAt: new Date('2026-09-10T09:59:50Z'),
        processingAccumulatedMs: 20_000,
        processingElapsedApproximate: false,
      } as Job),
    ).toMatchObject({
      timing: {
        processingElapsedMs: 20_000,
        totalElapsedMs: 70_000,
        totalElapsedApproximate: true,
      },
    });
  });

  it('does not manufacture a total when the client clock is ahead', () => {
    expect(
      presentJob({
        ...job,
        clientStartedAt: new Date('2026-09-11T10:00:00Z'),
      } as Job),
    ).toMatchObject({ timing: { totalElapsedMs: null } });
  });

  it('never exposes worker ownership or frozen internal recipe fields', () => {
    const presented = presentJob({
      ...job,
      attemptNumber: 2,
      recipeSnapshot: { recipeId: 'kim-vocal-2-v1' },
      retryEligibility: { eligible: true, attemptsRemaining: 1 },
      currentExecution: {
        attemptId: '75438e3a-bda0-4521-a789-2b46473080e3',
        machineId: 'a4262cac-424d-495e-8ead-d04e19fab479',
      },
    } as Job) as Record<string, unknown>;
    expect(presented).not.toHaveProperty('attemptNumber');
    expect(presented).not.toHaveProperty('recipeSnapshot');
    expect(presented).not.toHaveProperty('retryEligibility');
    expect(presented).not.toHaveProperty('currentExecution');
  });
});
