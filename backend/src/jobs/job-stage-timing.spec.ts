import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateWorkerAttemptProgressDto } from '../worker-fleet/attempts/worker-attempt.dto.js';
import type { Job } from './job.schema.js';
import {
  closeQueueTiming,
  presentServerStageTimings,
  withAttemptMeasurements,
} from './job-stage-timing.js';

const at = (seconds: number) => new Date(seconds * 1000);
const base = () =>
  ({
    createdAt: at(10),
    serverTimingStartedAt: at(0),
    sourceKind: 'url',
    queuedAt: at(20),
    queueTimingStartedAt: at(20),
    queueAccumulatedMs: 0,
    retryWaitAccumulatedMs: 0,
    attemptNumber: 0,
    importStageTimings: [
      { stage: 'source-download', durationMs: 8_000, complete: true },
    ],
  }) as Job;

describe('authoritative stage timings', () => {
  it('counts queue intervals and retry backoff without counting failed execution', () => {
    let job = base();
    job = { ...job, ...closeQueueTiming(job, at(25)) };
    expect(job.queueAccumulatedMs).toBe(5000);
    expect(closeQueueTiming(job, at(90))).toEqual({});
    job = {
      ...job,
      queuedAt: at(100),
      queueTimingStartedAt: at(100),
      retryEligibility: {
        eligible: true,
        attemptsRemaining: 1,
        nextAttemptAt: at(105),
      },
    };
    job = { ...job, ...closeQueueTiming(job, at(110)) };
    expect(job.queueAccumulatedMs).toBe(10000);
    expect(job.retryWaitAccumulatedMs).toBe(5000);
  });

  it('starts URL totals at import acceptance and ignores client clocks', () => {
    const result = presentServerStageTimings(
      { ...base(), finishedAt: at(30), clientStartedAt: at(-999) },
      at(999),
    );
    expect(result).toMatchObject({ totalMs: 30000, totalComplete: true });
    expect(result?.stages).toContainEqual({
      stage: 'source-download',
      durationMs: 8000,
      complete: true,
    });
  });

  it('keeps legacy and invalid times unavailable instead of making up zeroes', () => {
    expect(
      presentServerStageTimings({ createdAt: at(0) } as Job, at(10)),
    ).toBeNull();
    expect(
      presentServerStageTimings({ ...base(), finishedAt: at(-1) }, at(10))
        ?.totalMs,
    ).toBeNull();
  });

  it('replaces snapshots without double counting and preserves interrupted measurements', () => {
    let job = { ...base(), attemptNumber: 2 };
    const partial = [
      { stage: 'separation', durationMs: 1000, complete: false },
    ];
    job.stageTimingAttempts = withAttemptMeasurements(job, 'first', 1, partial);
    job.stageTimingAttempts = withAttemptMeasurements(job, 'first', 1, partial);
    job.stageTimingAttempts = withAttemptMeasurements(job, 'second', 2, [
      { stage: 'separation', durationMs: 2000, complete: true },
    ]);
    expect(job.stageTimingAttempts).toHaveLength(2);
    expect(presentServerStageTimings(job, at(50))?.stages).toContainEqual({
      stage: 'separation',
      durationMs: 3000,
      complete: false,
    });
    expect(presentServerStageTimings(job, at(50))?.attempts).toHaveLength(2);
    expect(
      JSON.stringify(presentServerStageTimings(job, at(50))),
    ).not.toContain('attemptId');
  });

  it('freezes a cancelled queue and a submission window at server finish', () => {
    const job = {
      ...base(),
      sourceKind: 'file' as const,
      importStageTimings: [],
      finishedAt: at(23),
    };
    expect(presentServerStageTimings(job, at(100))?.stages).toContainEqual({
      stage: 'queue',
      durationMs: 3000,
      complete: true,
    });
    expect(presentServerStageTimings(job, at(100))?.stages).toContainEqual({
      stage: 'submission-window',
      durationMs: 13000,
      complete: false,
    });
  });

  it('does not trust client sourceKind to hide the submission window', () => {
    const job = {
      ...base(),
      importStageTimings: [],
      confirmedUploadAccountedAt: at(20),
    };
    expect(presentServerStageTimings(job, at(30))?.stages).toContainEqual({
      stage: 'submission-window',
      durationMs: 10000,
      complete: true,
    });
  });

  it('validates bounded unique integer snapshots and remains compatible with old workers', async () => {
    const input = {
      requestId: '01ad6d5f-57cd-4bdc-9299-8c99e7391695',
      workerId: '01ad6d5f-57cd-4bdc-9299-8c99e7391695',
      sessionId: '01ad6d5f-57cd-4bdc-9299-8c99e7391695',
      incarnation: '01ad6d5f-57cd-4bdc-9299-8c99e7391695',
      sequence: 1,
      phase: 'preparing',
      phasePercent: null,
    };
    const check = (extra: object) =>
      validate(
        plainToInstance(UpdateWorkerAttemptProgressDto, { ...input, ...extra }),
      );
    expect(await check({})).toEqual([]);
    expect(
      await check({
        executionTimings: [
          { stage: 'input-download', durationMs: 120, complete: true },
        ],
      }),
    ).toEqual([]);
    for (const durationMs of [-1, 0.5, 7_200_001])
      expect(
        await check({
          executionTimings: [
            { stage: 'separation', durationMs, complete: true },
          ],
        }),
      ).not.toEqual([]);
    expect(await check({ executionTimings: null })).not.toEqual([]);
    expect(
      await check({
        executionTimings: Array(2).fill({
          stage: 'separation',
          durationMs: 1,
          complete: true,
        }),
      }),
    ).not.toEqual([]);
  });
});
