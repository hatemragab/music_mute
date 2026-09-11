import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import { adminError } from '../admin/admin-errors.js';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import type { AdminActor } from '../admin/admin.types.js';
import { presentAdminJob } from '../admin-jobs/admin-jobs.presenter.js';
import { AdminOverviewService } from '../admin-observability/admin-overview.service.js';
import { Job } from '../jobs/job.schema.js';
import type { JobAttempt } from '../jobs/job-attempt.schema.js';
import { encodeCsv, type CsvCell } from './csv-encoding.js';
import {
  exportQuery,
  MAX_EXPORT_ROWS,
  requireExportCapacity,
  type ExportDataset,
} from './export-query.js';

export const JOB_EXPORT_HEADERS = [
  'id',
  'userId',
  'status',
  'workerId',
  'createdAt',
  'queuedAt',
  'startedAt',
  'finishedAt',
  'elapsedSeconds',
  'errorCode',
] as const;
export const OVERVIEW_EXPORT_HEADERS = [
  'bucketStart',
  'submitted',
  'completed',
  'failed',
  'cancelled',
] as const;
// Positive projection excludes names, source metadata, object identities and URLs before materialization.
export const JOB_EXPORT_PROJECTION = {
  _id: 1,
  userId: 1,
  status: 1,
  workerId: 1,
  createdAt: 1,
  queuedAt: 1,
  validatingAt: 1,
  finishedAt: 1,
  processingAccumulatedMs: 1,
  processingIntervalStartedAt: 1,
  processingObservedAt: 1,
  processingElapsedApproximate: 1,
  leaseExpiresAt: 1,
  'lastError.code': 1,
} as const;

function checkConnected(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Export request was disconnected');
}

@Injectable()
export class AdminExportsService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly overview: AdminOverviewService,
    private readonly operations: AdminOperationsService,
  ) {}

  async export(
    actor: AdminActor,
    dataset: ExportDataset,
    raw: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const permission = dataset === 'jobs' ? 'jobs.read' : 'overview.read';
    if (
      !actor.permissions.includes('exports.read') ||
      !actor.permissions.includes(permission)
    )
      throw adminError('PERMISSION_DENIED');
    checkConnected(signal);
    const asOf = new Date();
    const query = exportQuery(dataset, raw, asOf);
    const operationId = randomUUID();
    const result = await this.operations.run(
      actor,
      {
        operationId,
        route: `GET /admin/exports/${dataset}.csv`,
        request: query.normalized,
        action: `exports.${dataset}`,
        resourceType: 'export',
        reason: null,
      },
      async (session) => {
        checkConnected(signal);
        let rows: CsvCell[][];
        if (dataset === 'jobs') {
          // A single bounded envelope prevents a getMore cursor under the
          // transaction deadline. Each row contains only small, fixed fields.
          const [snapshot] = await this.jobs
            .aggregate<{
              items: (Job & {
                firstAttempt?: Pick<
                  JobAttempt,
                  'startedAt' | 'processingStartedAt'
                >;
              })[];
            }>([
              { $match: query.filter! },
              { $sort: { createdAt: -1, _id: -1 } },
              { $limit: MAX_EXPORT_ROWS + 1 },
              { $project: JOB_EXPORT_PROJECTION },
              {
                $lookup: {
                  from: 'audio_job_attempts',
                  localField: '_id',
                  foreignField: 'jobId',
                  pipeline: [
                    { $sort: { startedAt: 1, _id: 1 } },
                    { $limit: 1 },
                    {
                      $project: {
                        _id: 0,
                        startedAt: 1,
                        processingStartedAt: 1,
                      },
                    },
                  ],
                  as: 'firstAttempts',
                },
              },
              {
                $set: { firstAttempt: { $arrayElemAt: ['$firstAttempts', 0] } },
              },
              { $unset: 'firstAttempts' },
              { $facet: { items: [{ $match: {} }] } },
            ])
            .session(session)
            .option({ maxTimeMS: 5000 });
          const jobs = snapshot?.items ?? [];
          requireExportCapacity(jobs.length);
          checkConnected(signal);
          rows = jobs.map((job) => {
            const value = presentAdminJob(
              job,
              actor,
              null,
              asOf,
              false,
              job.firstAttempt,
            );
            return [
              value.id,
              value.userId,
              value.status,
              value.workerId,
              value.createdAt,
              value.queuedAt,
              value.startedAt,
              value.finishedAt,
              value.elapsedSeconds,
              value.lastError?.code ?? null,
            ];
          });
        } else {
          const series = await this.overview.exportSeries(
            actor,
            query.normalized,
            session,
          );
          requireExportCapacity(series.length);
          checkConnected(signal);
          rows = series.map((row) => [
            row.start,
            row.submitted,
            row.completed,
            row.failed,
            row.cancelled,
          ]);
        }
        const csv = encodeCsv(
          dataset === 'jobs' ? JOB_EXPORT_HEADERS : OVERVIEW_EXPORT_HEADERS,
          rows,
        );
        checkConnected(signal);
        return {
          resourceId: operationId,
          exportMetadata: {
            dataset,
            from: query.range.from.toISOString(),
            to: query.range.to.toISOString(),
            rowCount: rows.length,
          },
          value: {
            csv,
            filename: `${dataset}-${asOf.toISOString().replaceAll(':', '-').replaceAll('.', '-')}.csv`,
          },
        };
      },
    );
    checkConnected(signal);
    if (!result.value) throw adminError('DEPENDENCY_UNAVAILABLE');
    return result.value;
  }
}
