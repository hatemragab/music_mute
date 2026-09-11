import type { Connection } from 'mongoose';
import { getDeviceStatistics, statisticsSince } from './device-statistics.js';

describe('device statistics', () => {
  it('returns installation and distinct-user counts separately', async () => {
    const since = new Date('2026-08-09T00:00:00.000Z');
    const toArray = vi.fn().mockResolvedValue([
      {
        totals: [{ installations: 3, users: 2 }],
        groups: [
          {
            platform: 'ios',
            appVersion: '1.2.0',
            buildNumber: 12,
            installations: 2,
            users: 1,
          },
          {
            platform: 'android',
            appVersion: '1.1.0',
            buildNumber: 11,
            installations: 1,
            users: 1,
          },
        ],
      },
    ]);
    const aggregate = vi.fn().mockReturnValue({ toArray });
    const connection = {
      db: {
        collection: () => ({ aggregate }),
      },
    } as unknown as Connection;

    const result = await getDeviceStatistics(connection, { since });

    expect(result.totals.installations).toBe(3);
    expect(result.totals.users).toBe(2);
    expect(result.groups).toHaveLength(2);
    expect(result.since).toEqual(since);
    const pipeline = aggregate.mock.calls[0]?.[0];
    expect(pipeline[0]).toEqual({
      $match: { lastSeenAt: { $gte: since } },
    });
    expect(pipeline[1]).toHaveProperty('$facet.groups');
    expect(pipeline[1]).toHaveProperty('$facet.totals');
  });

  it('derives a bounded server-side activity window', () => {
    const now = new Date('2026-09-08T12:00:00.000Z');
    expect(statisticsSince(30, now)).toEqual(
      new Date('2026-08-09T12:00:00.000Z'),
    );
    for (const days of [0, 366, 1.5, Number.NaN])
      expect(() => statisticsSince(days, now)).toThrow();
  });
});
