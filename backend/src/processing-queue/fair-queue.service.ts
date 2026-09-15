import { ProcessingQueuePolicy } from '../admin-settings/queue-policy.schema.js';
import { readQueuePolicy } from '../admin-settings/queue-policy.service.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type ClientSession, type Model, type Types } from 'mongoose';
import { Job } from '../jobs/job.schema.js';

export const AGING_THRESHOLD_SECONDS = 900;
export function schedulingPriority(queuedAt: Date | null, now: Date): number {
  return queuedAt &&
    queuedAt.getTime() <= now.getTime() - AGING_THRESHOLD_SECONDS * 1000
    ? 0
    : 1;
}
export const RUNNING_STATUSES = [
  'validating',
  'processing',
  'uploading_result',
  'interrupted',
  'cancel_requested',
] as const;

@Injectable()
export class FairQueueService {
  constructor(@InjectModel(Job.name) private readonly jobs: Model<Job>) {}

  /** Indexed eligibility lookups precede ranking; no source has preferential treatment. */
  async selectNextEligible(
    now: Date,
    session: ClientSession,
    mediaPolicyVersion?: 2,
    media?: { maxDurationSeconds: number; maxPreparedAudioBytes: number },
  ) {
    const policy = await readQueuePolicy(
      this.jobs.db.model<ProcessingQueuePolicy>(ProcessingQueuePolicy.name),
      session,
    );
    const [selected] = await this.jobs
      .aggregate<{ _id: Types.ObjectId }>([
        {
          $match: {
            status: 'queued',
            deletedAt: null,
            workerId: null,
            ...(media
              ? {
                  $expr: {
                    $and: [
                      {
                        $lte: [
                          {
                            $ifNull: [
                              '$measuredDurationSeconds',
                              '$inputReservation.durationSeconds',
                            ],
                          },
                          media.maxDurationSeconds,
                        ],
                      },
                      {
                        $lte: [
                          '$inputReservation.bytes',
                          media.maxPreparedAudioBytes,
                        ],
                      },
                    ],
                  },
                }
              : {}),
            $or: [
              { 'admissionSnapshot.policyVersion': { $ne: 2 } },
              ...(mediaPolicyVersion === 2
                ? [
                    {
                      'admissionSnapshot.policyVersion': 2,
                    },
                  ]
                : []),
            ],
          },
        },
        {
          $lookup: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            as: 'owner',
          },
        },
        { $unwind: '$owner' },
        {
          $match: {
            'owner.status': 'active',
            $or: [
              { 'owner.processingSuspended': { $ne: true } },
              {
                'owner.processingSuspensionExpiresAt': { $ne: null, $lte: now },
              },
            ],
          },
        },
        {
          $lookup: {
            from: 'audio_jobs',
            let: { ownerId: '$userId' },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$userId', '$$ownerId'] },
                  status: { $in: RUNNING_STATUSES },
                },
              },
              { $limit: 1 },
              { $project: { _id: 1 } },
            ],
            as: 'running',
          },
        },
        { $match: { 'running.0': { $exists: false } } },
        {
          $lookup: {
            from: 'processing_execution_usage',
            let: { ownerId: '$userId' },
            pipeline: [
              {
                $match: {
                  $expr: { $eq: ['$userId', '$$ownerId'] },
                  expiresAt: { $gt: now },
                },
              },
              {
                $group: {
                  _id: null,
                  seconds: { $sum: '$executionSeconds' },
                  unknown: {
                    $max: {
                      $cond: [{ $eq: ['$executionSeconds', null] }, 1, 0],
                    },
                  },
                },
              },
            ],
            as: 'usage',
          },
        },
        {
          $set: {
            aged: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$queuedAt', null] },
                    {
                      $lte: [
                        '$queuedAt',
                        new Date(
                          now.getTime() - policy.agingThresholdSeconds * 1000,
                        ),
                      ],
                    },
                  ],
                },
                0,
                1,
              ],
            },
          },
        },
        {
          $set: {
            ageOrder: { $cond: [{ $eq: ['$aged', 0] }, '$queueOrder', null] },
            usageUnknown: {
              $ifNull: [{ $arrayElemAt: ['$usage.unknown', 0] }, 0],
            },
            recentWorkerSeconds: {
              $ifNull: [{ $arrayElemAt: ['$usage.seconds', 0] }, 0],
            },
          },
        },
        // For a shared positive linear cost model, duration order equals estimated cost order.
        {
          $sort: {
            aged: 1,
            ageOrder: 1,
            usageUnknown: 1,
            recentWorkerSeconds: 1,
            'inputReservation.durationSeconds': 1,
            queueOrder: 1,
          },
        },
        { $limit: 1 },
        { $project: { _id: 1 } },
      ])
      .session(session)
      .option({ maxTimeMS: 5000 });
    return selected ? this.jobs.findById(selected._id).session(session) : null;
  }

  async ownerIsRunning(
    userId: Types.ObjectId,
    session: ClientSession,
    excludeJobId: Types.ObjectId,
  ) {
    return Boolean(
      await this.jobs
        .exists({
          userId,
          _id: trusted({ $ne: excludeJobId }),
          status: trusted({ $in: RUNNING_STATUSES }),
        })
        .session(session),
    );
  }
}
