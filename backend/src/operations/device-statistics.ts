import type { Connection } from 'mongoose';
import type { Platform } from '../auth/auth.types.js';

const DAY_MS = 86_400_000;

export interface DeviceStatisticsGroup {
  platform: Platform;
  appVersion: string;
  buildNumber: number;
  installations: number;
  users: number;
}

export interface DeviceStatistics {
  since: Date;
  totals: { installations: number; users: number };
  groups: DeviceStatisticsGroup[];
}

export function statisticsSince(days: number, now = new Date()): Date {
  if (
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > 365 ||
    !Number.isFinite(now.getTime())
  )
    throw new TypeError('INVALID_STATISTICS_WINDOW');
  return new Date(now.getTime() - days * DAY_MS);
}

export async function getDeviceStatistics(
  connection: Connection,
  options: { since: Date },
): Promise<DeviceStatistics> {
  if (
    !(options.since instanceof Date) ||
    !Number.isFinite(options.since.getTime())
  )
    throw new TypeError('INVALID_STATISTICS_BOUNDARY');
  if (!connection.db) throw new Error('AUTH_DATABASE_UNAVAILABLE');

  const [result] = await connection.db
    .collection('user_devices')
    .aggregate<{
      totals: Array<{ installations: number; users: number }>;
      groups: DeviceStatisticsGroup[];
    }>([
      { $match: { lastSeenAt: { $gte: options.since } } },
      {
        $facet: {
          groups: [
            {
              $group: {
                _id: {
                  platform: '$platform',
                  appVersion: '$appVersion',
                  buildNumber: '$buildNumber',
                },
                installations: { $sum: 1 },
                userIds: { $addToSet: '$userId' },
              },
            },
            {
              $project: {
                _id: 0,
                platform: '$_id.platform',
                appVersion: '$_id.appVersion',
                buildNumber: '$_id.buildNumber',
                installations: 1,
                users: { $size: '$userIds' },
              },
            },
            { $sort: { platform: 1, buildNumber: -1, appVersion: 1 } },
          ],
          totals: [
            {
              $group: {
                _id: null,
                installations: { $sum: 1 },
                userIds: { $addToSet: '$userId' },
              },
            },
            {
              $project: {
                _id: 0,
                installations: 1,
                users: { $size: '$userIds' },
              },
            },
          ],
        },
      },
    ])
    .toArray();

  return {
    since: options.since,
    totals: result?.totals[0] ?? { installations: 0, users: 0 },
    groups: result?.groups ?? [],
  };
}
