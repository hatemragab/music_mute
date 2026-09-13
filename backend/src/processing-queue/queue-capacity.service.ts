import { qualificationReady } from '../admin-settings/processing-qualification.js';
import type { AdmissionSnapshot } from '../jobs/job.types.js';
import { ProcessingQueuePolicy } from '../admin-settings/queue-policy.schema.js';
import { readQueuePolicy } from '../admin-settings/queue-policy.service.js';
import { ProcessingAdmissionFence } from '../admin-settings/processing-settings.schema.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type ClientSession, type Model } from 'mongoose';
import { Job } from '../jobs/job.schema.js';
import { ACTIVE_ADMISSION_STATUSES } from '../jobs/job-state.js';
import { jobError } from '../jobs/job-errors.js';

/** These are bounded legacy admission guardrails, not hardware throughput estimates. */
export const LEGACY_QUEUE_LIMITS = {
  maxOutstandingJobs: 100,
  maxOutstandingAudioSeconds: 60_000,
} as const;
@Injectable()
export class QueueCapacityService {
  constructor(@InjectModel(Job.name) private readonly jobs: Model<Job>) {}

  async readSummary(session?: ClientSession) {
    const policy = await readQueuePolicy(
      this.jobs.db.model<ProcessingQueuePolicy>(ProcessingQueuePolicy.name),
      session,
    );
    const [totals] = await this.jobs
      .aggregate<{
        shortJobs: number;
        shortAudioSeconds: number;
        longJobs: number;
        longAudioSeconds: number;
        outstandingJobs: number;
        outstandingAudioSeconds: number;
        queuedJobs: number;
        queuedAudioSeconds: number;
        oldestQueuedAt: Date | null;
      }>([
        { $match: { status: { $in: ACTIVE_ADMISSION_STATUSES } } },
        {
          $group: {
            _id: null,
            outstandingJobs: { $sum: 1 },
            ...Object.fromEntries(
              ['short', 'long'].flatMap((kind) => {
                const duration = {
                  $ifNull: [
                    '$measuredDurationSeconds',
                    '$inputReservation.durationSeconds',
                  ],
                };
                const condition = {
                  [kind === 'short' ? '$lte' : '$gt']: [duration, 600],
                };
                return [
                  [`${kind}Jobs`, { $sum: { $cond: [condition, 1, 0] } }],
                  [
                    `${kind}AudioSeconds`,
                    { $sum: { $cond: [condition, { $ceil: duration }, 0] } },
                  ],
                ];
              }),
            ),
            outstandingAudioSeconds: {
              $sum: {
                $ceil: {
                  $ifNull: [
                    '$measuredDurationSeconds',
                    '$inputReservation.durationSeconds',
                  ],
                },
              },
            },
            queuedJobs: {
              $sum: { $cond: [{ $eq: ['$status', 'queued'] }, 1, 0] },
            },
            queuedAudioSeconds: {
              $sum: {
                $cond: [
                  { $eq: ['$status', 'queued'] },
                  {
                    $ceil: {
                      $ifNull: [
                        '$measuredDurationSeconds',
                        '$inputReservation.durationSeconds',
                      ],
                    },
                  },
                  0,
                ],
              },
            },
            oldestQueuedAt: {
              $min: {
                $cond: [{ $eq: ['$status', 'queued'] }, '$queuedAt', null],
              },
            },
          },
        },
      ])
      .session(session ?? null)
      .option({ maxTimeMS: 5000 });
    return {
      ...(totals ?? {
        outstandingJobs: 0,
        outstandingAudioSeconds: 0,
        queuedJobs: 0,
        queuedAudioSeconds: 0,
        oldestQueuedAt: null,
      }),
      shortLongThresholdSeconds: 600,
      distribution: {
        short: {
          jobs: totals?.shortJobs ?? 0,
          audioSeconds: totals?.shortAudioSeconds ?? 0,
        },
        long: {
          jobs: totals?.longJobs ?? 0,
          audioSeconds: totals?.longAudioSeconds ?? 0,
        },
      },
      rejectionSummary: null,
      limits: {
        maxOutstandingJobs: policy.maxOutstandingJobs,
        maxOutstandingAudioSeconds: policy.maxOutstandingAudioSeconds,
      },
      estimatedWorkerSeconds: qualificationReady(
        policy.qualification,
        new Date(),
      )
        ? Math.ceil(
            (totals?.outstandingAudioSeconds ?? 0) *
              policy.qualification.referenceProcessingSecondsPerAudioSecond +
              (totals?.outstandingJobs ?? 0) *
                policy.qualification.fixedJobOverheadSeconds,
          )
        : null,
      estimatedWaitRange: null,
      evidenceStatus: policy.qualification
        ? qualificationReady(policy.qualification, new Date())
          ? 'verified'
          : 'stale'
        : 'unavailable',
      checkedAt: new Date().toISOString(),
    };
  }

  /** Existing global admission fence must have been written in this transaction. Jobs are the unique durable reservations. */
  async assertCapacity(
    duration: number,
    session: ClientSession,
    excludeJobId?: string | Types.ObjectId,
    accepted?: AdmissionSnapshot,
  ) {
    await this.jobs.db
      .model<ProcessingAdmissionFence>(ProcessingAdmissionFence.name)
      .updateOne(
        { _id: 'settings' },
        { $inc: { revision: 1 } },
        { upsert: true, session, setDefaultsOnInsert: true },
      );
    const totals = await this.readSummary(session);
    let priorDuration = 0;
    if (excludeJobId) {
      const prior = await this.jobs
        .findById(excludeJobId)
        .session(session)
        .lean();
      if (prior && ACTIVE_ADMISSION_STATUSES.includes(prior.status))
        priorDuration = Math.ceil(
          prior.measuredDurationSeconds ??
            prior.inputReservation.durationSeconds,
        );
    }
    const policy = await readQueuePolicy(
      this.jobs.db.model<ProcessingQueuePolicy>(ProcessingQueuePolicy.name),
      session,
    );
    const limits = accepted?.queueLimits ?? totals.limits;
    const qualification =
      accepted?.qualification ??
      (qualificationReady(policy.qualification, new Date())
        ? policy.qualification
        : null);
    const jobs = totals.outstandingJobs + (excludeJobId ? 0 : 1);
    const audio =
      totals.outstandingAudioSeconds - priorDuration + Math.ceil(duration);
    if (
      qualification &&
      Math.ceil(
        audio * qualification.referenceProcessingSecondsPerAudioSecond +
          jobs * qualification.fixedJobOverheadSeconds,
      ) > qualification.maxOutstandingEstimatedWorkerSeconds
    )
      throw jobError('PROCESSING_QUEUE_FULL');
    if (
      totals.outstandingJobs + (excludeJobId ? 0 : 1) >
        limits.maxOutstandingJobs ||
      totals.outstandingAudioSeconds - priorDuration + Math.ceil(duration) >
        limits.maxOutstandingAudioSeconds
    )
      throw jobError('PROCESSING_QUEUE_FULL');
  }
}
