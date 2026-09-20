import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import { Job } from '../jobs/job.schema.js';
import { Release } from '../releases/release.schema.js';
import { parseOverviewRange, utcDays } from './overview-query.js';
import type { OverviewSnapshot } from './overview.types.js';

interface CountRow {
  _id?: string;
  count: number;
}
interface TimingRow {
  mean: number | null;
  count: number;
}
interface SubmissionStats {
  total: CountRow[];
  users: CountRow[];
  daily: CountRow[];
  timing: TimingRow[];
}
interface FinishStats {
  counts: CountRow[];
  daily: { _id: { day: string; status: string }; count: number }[];
  timing: TimingRow[];
}
interface QueueStats {
  waiting: CountRow[];
  processing: CountRow[];
  oldest: { queuedAt: Date }[];
}
const day = (field: string) => ({
  $dateToString: {
    date: field,
    format: '%Y-%m-%dT00:00:00.000Z',
    timezone: 'UTC',
  },
});
const validDate = (field: string) => ({ $eq: [{ $type: field }, 'date'] });

function dailySeries(
  from: Date,
  to: Date,
  submitted: CountRow[] = [],
  finished: FinishStats['daily'] = [],
): OverviewSnapshot['series'] {
  const series = utcDays(from, to).map((start) => ({
    start,
    submitted: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  }));
  const seriesMap = new Map(series.map((row) => [row.start, row]));
  for (const row of submitted) {
    const target = seriesMap.get(row._id!);
    if (target) target.submitted = row.count;
  }
  for (const row of finished) {
    const target = seriesMap.get(row._id.day),
      field =
        row._id.status === 'ready'
          ? 'completed'
          : row._id.status === 'failed'
            ? 'failed'
            : 'cancelled';
    if (target) target[field] = row.count;
  }
  return series;
}

@Injectable()
export class AdminOverviewService {
  private readonly cache = new Map<
    string,
    { until: number; value: Promise<OverviewSnapshot> }
  >();
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    @InjectModel(Release.name) private readonly releases: Model<Release>,
  ) {}
  async read(
    actor: AdminActor,
    raw: Record<string, unknown>,
  ): Promise<OverviewSnapshot> {
    if (!actor.permissions.includes('overview.read'))
      throw adminError('PERMISSION_DENIED');
    const range = parseOverviewRange(raw),
      releaseRead = actor.permissions.includes('releases.read');
    const key = `${range.from.toISOString()}/${range.to.toISOString()}/${releaseRead}`;
    const prior = this.cache.get(key);
    if (prior && prior.until > Date.now())
      return structuredClone(await prior.value);
    this.cache.delete(key);
    if (this.cache.size >= 50)
      this.cache.delete(this.cache.keys().next().value!);
    const entry = {
      until: Date.now() + 10000,
      value: this.query(range.from, range.to, releaseRead),
    };
    this.cache.set(key, entry);
    try {
      return structuredClone(await entry.value);
    } catch {
      if (this.cache.get(key) === entry) this.cache.delete(key);
      throw adminError('DEPENDENCY_UNAVAILABLE');
    }
  }

  /** Uncached CSV series gathered on the caller's audited snapshot transaction. */
  async exportSeries(
    actor: AdminActor,
    raw: Record<string, unknown>,
    session: ClientSession,
  ): Promise<OverviewSnapshot['series']> {
    if (!actor.permissions.includes('overview.read'))
      throw adminError('PERMISSION_DENIED');
    if (!session.inTransaction())
      throw new Error('Export series requires a snapshot transaction');
    const { from, to } = parseOverviewRange(raw);
    const [rows] = await this.jobs
      .aggregate<{ submitted: CountRow[]; finished: FinishStats['daily'] }>([
        {
          $match: {
            deletedAt: null,
            $or: [
              { createdAt: { $gte: from, $lt: to } },
              {
                finishedAt: { $gte: from, $lt: to },
                status: { $in: ['ready', 'failed', 'cancelled'] },
              },
            ],
          },
        },
        {
          $facet: {
            submitted: [
              { $match: { createdAt: { $gte: from, $lt: to } } },
              { $group: { _id: day('$createdAt'), count: { $sum: 1 } } },
            ],
            finished: [
              {
                $match: {
                  finishedAt: { $gte: from, $lt: to },
                  status: { $in: ['ready', 'failed', 'cancelled'] },
                },
              },
              {
                $group: {
                  _id: { day: day('$finishedAt'), status: '$status' },
                  count: { $sum: 1 },
                },
              },
            ],
          },
        },
      ])
      .session(session)
      .option({ maxTimeMS: 5000 });
    return dailySeries(from, to, rows?.submitted, rows?.finished);
  }

  private async query(
    from: Date,
    to: Date,
    releaseRead: boolean,
  ): Promise<OverviewSnapshot> {
    const now = new Date();
    const [submittedRows, finishedRows, queueRows, releaseRows] =
      await Promise.all([
        this.jobs
          .aggregate<SubmissionStats>([
            { $match: { createdAt: { $gte: from, $lt: to }, deletedAt: null } },
            {
              $facet: {
                total: [{ $count: 'count' }],
                users: [{ $group: { _id: '$userId' } }, { $count: 'count' }],
                daily: [
                  { $group: { _id: day('$createdAt'), count: { $sum: 1 } } },
                ],
                timing: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          validDate('$queuedAt'),
                          validDate('$validatingAt'),
                          { $gte: ['$validatingAt', '$queuedAt'] },
                          {
                            $or: [
                              { $not: [validDate('$processingStartedAt')] },
                              {
                                $lte: ['$validatingAt', '$processingStartedAt'],
                              },
                            ],
                          },
                        ],
                      },
                    },
                  },
                  {
                    $group: {
                      _id: null,
                      count: { $sum: 1 },
                      mean: {
                        $avg: {
                          $divide: [
                            {
                              $subtract: ['$validatingAt', '$queuedAt'],
                            },
                            1000,
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          ])
          .option({ maxTimeMS: 2000 }),
        this.jobs
          .aggregate<FinishStats>([
            {
              $match: {
                finishedAt: { $gte: from, $lt: to },
                deletedAt: null,
                status: { $in: ['ready', 'failed', 'cancelled'] },
              },
            },
            {
              $facet: {
                counts: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
                daily: [
                  {
                    $group: {
                      _id: { day: day('$finishedAt'), status: '$status' },
                      count: { $sum: 1 },
                    },
                  },
                ],
                timing: [
                  {
                    $match: {
                      processingIntervalStartedAt: null,
                      processingElapsedApproximate: { $ne: true },
                      $expr: {
                        $and: [
                          validDate('$processingStartedAt'),
                          validDate('$processingFinishedAt'),
                          {
                            $gte: [
                              '$processingFinishedAt',
                              '$processingStartedAt',
                            ],
                          },
                          { $isNumber: '$processingAccumulatedMs' },
                          { $gte: ['$processingAccumulatedMs', 0] },
                        ],
                      },
                    },
                  },
                  {
                    $group: {
                      _id: null,
                      count: { $sum: 1 },
                      mean: {
                        $avg: { $divide: ['$processingAccumulatedMs', 1000] },
                      },
                    },
                  },
                ],
              },
            },
          ])
          .option({ maxTimeMS: 2000 }),
        this.jobs
          .aggregate<QueueStats>([
            {
              $match: {
                deletedAt: null,
                status: {
                  $in: [
                    'queued',
                    'validating',
                    'processing',
                    'uploading_result',
                    'cancel_requested',
                  ],
                },
              },
            },
            {
              $lookup: {
                from: 'users',
                localField: 'userId',
                foreignField: '_id',
                pipeline: [{ $project: { status: 1 } }],
                as: 'owner',
              },
            },
            {
              $facet: {
                waiting: [
                  { $match: { status: 'queued', 'owner.status': 'active' } },
                  { $count: 'count' },
                ],
                processing: [
                  { $match: { status: { $ne: 'queued' } } },
                  { $count: 'count' },
                ],
                oldest: [
                  {
                    $match: {
                      status: 'queued',
                      'owner.status': 'active',
                      queuedAt: { $type: 'date', $lte: now },
                    },
                  },
                  { $sort: { queuedAt: 1 } },
                  { $limit: 1 },
                  { $project: { queuedAt: 1 } },
                ],
              },
            },
          ])
          .option({ maxTimeMS: 2000 }),
        releaseRead
          ? this.releases
              .aggregate<{ _id: string; count: number; rejected: number }>([
                {
                  $group: {
                    _id: '$state',
                    count: { $sum: 1 },
                    rejected: {
                      $sum: {
                        $cond: [{ $eq: ['$artifactState', 'rejected'] }, 1, 0],
                      },
                    },
                  },
                },
              ])
              .option({ maxTimeMS: 2000 })
          : Promise.resolve([]),
      ]);
    const submitted = submittedRows[0],
      finished = finishedRows[0],
      queue = queueRows[0];
    const counts = new Map(finished?.counts.map((row) => [row._id, row.count]));
    const series = dailySeries(from, to, submitted?.daily, finished?.daily);
    const queueTiming = submitted?.timing[0],
      processingTiming = finished?.timing[0];
    const oldest = queue?.oldest[0]?.queuedAt;
    return {
      asOf: now.toISOString(),
      from: from.toISOString(),
      to: to.toISOString(),
      counts: {
        submitted: submitted?.total[0]?.count ?? 0,
        processingActiveUsers: submitted?.users[0]?.count ?? 0,
        completed: counts.get('ready') ?? 0,
        failed: counts.get('failed') ?? 0,
        cancelled: counts.get('cancelled') ?? 0,
      },
      queue: {
        waiting: queue?.waiting[0]?.count ?? 0,
        processing: queue?.processing[0]?.count ?? 0,
        oldestWaitSeconds: oldest
          ? (now.getTime() - oldest.getTime()) / 1000
          : null,
      },
      timings: {
        meanQueueWaitSeconds: queueTiming?.mean ?? null,
        meanProcessingSeconds: processingTiming?.mean ?? null,
        sampleCount: {
          queueWait: queueTiming?.count ?? 0,
          processing: processingTiming?.count ?? 0,
        },
      },
      series,
      ...(releaseRead
        ? {
            releaseSummary: {
              draft: releaseRows.find((row) => row._id === 'draft')?.count ?? 0,
              published:
                releaseRows.find((row) => row._id === 'published')?.count ?? 0,
              withdrawn:
                releaseRows.find((row) => row._id === 'withdrawn')?.count ?? 0,
              rejectedArtifacts: releaseRows.reduce(
                (sum, row) => sum + row.rejected,
                0,
              ),
            },
          }
        : {}),
    };
  }
}
