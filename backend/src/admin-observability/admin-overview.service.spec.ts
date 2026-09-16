import { describe, expect, it, vi } from 'vitest';
import { parseOverviewRange } from './overview-query.js';
import { AdminOverviewService } from './admin-overview.service.js';
import type { AdminActor } from '../admin/admin.types.js';

describe('overview date and cache boundaries', () => {
  const range = { from: '2026-09-01T00:00:00Z', to: '2026-09-03T00:00:00Z' };
  it('normalizes explicit offsets and rejects invalid, reversed or excessive intervals', () => {
    expect(
      parseOverviewRange({
        from: '2026-09-01T03:00:00+03:00',
        to: range.to,
      }).from.toISOString(),
    ).toBe('2026-09-01T00:00:00.000Z');
    for (const value of [
      {},
      { ...range, from: '2026-02-30T00:00:00Z' },
      { ...range, from: range.to },
      { ...range, to: '2027-01-01T00:00:00Z' },
      { ...range, bucket: 'hour' },
      { ...range, timezone: 'UTC' },
      { ...range, from: ['bad'] },
    ])
      expect(() => parseOverviewRange(value)).toThrow();
  });
  it('keeps empty durations unknown, caches per permission scope and never caches failures as zero', async () => {
    const model = () => ({
      aggregate: vi.fn(() => ({ option: vi.fn(async () => []) })),
    });
    const jobs = model(),
      releases = model();
    const service = new AdminOverviewService(jobs as never, releases as never);
    const actor = { permissions: ['overview.read'] } as unknown as AdminActor;
    const first = await service.read(actor, range);
    expect(first.timings).toEqual({
      meanQueueWaitSeconds: null,
      meanProcessingSeconds: null,
      sampleCount: { queueWait: 0, processing: 0 },
    });
    expect(first.series).toHaveLength(2);
    expect(first).not.toHaveProperty('releaseSummary');
    expect(await service.read(actor, range)).toEqual(first);
    expect(jobs.aggregate).toHaveBeenCalledTimes(3);
    expect(releases.aggregate).not.toHaveBeenCalled();
    await service.read(
      { ...actor, permissions: ['overview.read', 'releases.read'] },
      range,
    );
    expect(releases.aggregate).toHaveBeenCalledOnce();
    jobs.aggregate.mockImplementationOnce(() => ({
      option: vi.fn(async () => {
        throw new Error('dependency unavailable');
      }),
    }));
    await expect(
      service.read(actor, { ...range, to: '2026-09-04T00:00:00Z' }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
