import type { Job } from './job.schema.js';
import { closeProcessingInterval, presentJobTiming } from './job-timing.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 10, 0, 0, seconds));
const base = {
  createdAt: at(0),
  clientStartedAt: at(0),
  status: 'processing',
  processingAccumulatedMs: 0,
  processingIntervalStartedAt: at(35),
  processingObservedAt: at(45),
  leaseExpiresAt: at(100),
} as Job;

describe('processing interval accounting', () => {
  it('counts only separation, closes once, and survives repeated presentation', () => {
    const closed = {
      ...base,
      ...closeProcessingInterval(base, at(55)),
      finishedAt: at(59),
    };
    expect(presentJobTiming(closed, at(80)).processingElapsedMs).toBe(20_000);
    expect(closeProcessingInterval(closed, at(90))).toEqual({});
  });
  it('caps interruption at the last observation then sums the next attempt without offline time', () => {
    const interrupted = {
      ...base,
      ...closeProcessingInterval(base, at(120), true),
    };
    expect(interrupted.processingAccumulatedMs).toBe(10_000);
    const resumed = {
      ...interrupted,
      processingIntervalStartedAt: at(200),
      leaseExpiresAt: at(260),
    };
    const done = { ...resumed, ...closeProcessingInterval(resumed, at(220)) };
    expect(presentJobTiming(done, at(240))).toMatchObject({
      processingElapsedMs: 30_000,
      processingElapsedApproximate: true,
    });
  });
  it('does not extrapolate active progress past an expired lease', () => {
    expect(presentJobTiming(base, at(150))).toMatchObject({
      processingElapsedMs: 10_000,
      processingElapsedApproximate: true,
    });
  });
});
