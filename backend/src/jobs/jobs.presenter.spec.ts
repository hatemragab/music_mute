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

  it('presents the requested rendition while retaining the immutable worker recipe internally', () => {
    const base = {
      ...job,
      requestedTrimEnabled: true,
      recipeSnapshot: { trimEnabled: false, recipeDigest: 'a'.repeat(64) },
    } as Job;
    expect(presentJob(base)).toMatchObject({
      trimEnabled: true,
      recipeDigest: 'a'.repeat(64),
    });
    const completed = {
      ...base,
      outputRecipeSnapshot: { trimEnabled: true, recipeDigest: 'b'.repeat(64) },
    } as Job;
    expect(presentJob(completed)).toMatchObject({
      trimEnabled: true,
      recipeDigest: 'b'.repeat(64),
    });
    expect(presentJob(completed)).not.toHaveProperty('outputRecipeSnapshot');
    expect(presentJob(completed)).not.toHaveProperty('requestedTrimEnabled');
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

  it('shows only fresh current-attempt public progress', () => {
    const attemptId = '75438e3a-bda0-4521-a789-2b46473080e3';
    const active = {
      ...job,
      status: 'processing',
      currentExecution: { attemptId },
      workerProgress: {
        attemptId,
        sequence: 4,
        phase: 'separating',
        phasePercent: 40,
        observedAt: new Date(),
      },
    } as Job;
    expect(presentJob(active).processingProgress).toMatchObject({
      phase: 'separating',
      phasePercent: 40,
      stale: false,
    });
    expect(
      presentJob({
        ...active,
        currentExecution: { attemptId: '79d83cf4-43db-4536-9422-4665f0686b9c' },
      } as Job).processingProgress,
    ).toBeNull();
    expect(
      presentJob({ ...active, status: 'ready' } as Job).processingProgress,
    ).toBeNull();
  });

  it('never exposes worker ownership or frozen internal recipe fields', () => {
    const presented = presentJob(
      Object.assign(
        {
          ...job,
          attemptNumber: 2,
          recipeSnapshot: { recipeId: 'kim-vocals-v2' },
          retryEligibility: { eligible: true, attemptsRemaining: 1 },
          currentExecution: {
            attemptId: '75438e3a-bda0-4521-a789-2b46473080e3',
            machineId: 'a4262cac-424d-495e-8ead-d04e19fab479',
          },
        } as Job,
        { workerAvailable: true },
      ),
    ) as Record<string, unknown>;
    expect(presented).not.toHaveProperty('attemptNumber');
    expect(presented).not.toHaveProperty('recipeSnapshot');
    expect(presented).not.toHaveProperty('retryEligibility');
    expect(presented).not.toHaveProperty('currentExecution');
    expect(presented).not.toHaveProperty('workerAvailable');
  });
});

it('exposes owner audio integrity metadata but never private keys or arbitrary provider URLs', () => {
  const hash = Buffer.alloc(32, 1).toString('base64');
  const presented = presentJob({
    ...job,
    sourceUrl: 'https://private-provider.invalid/signed',
    processingOrigin: 'local_device',
    measuredOutputDurationSeconds: 10,
    inputReservation: {
      ...job.inputReservation,
      sha256: hash,
      contentType: 'audio/mpeg',
    },
    outputObject: {
      key: 'users/private/output.mp3',
      etag: '"private"',
      bytes: 1234,
      sha256: hash,
      contentType: 'audio/mpeg',
    },
  } as Job);
  expect(presented.sourceUrl).toBeNull();
  expect(presented.output).toMatchObject({
    bytes: 1234,
    sha256: hash,
    durationSeconds: 10,
  });
  expect(presented.localProfileId).toBe('kim-vocal-2-full-timeline-v1');
  expect(JSON.stringify(presented)).not.toContain('users/private');
  expect(JSON.stringify(presented)).not.toContain('private-provider');
  expect(presented.output).not.toHaveProperty('etag');
});
