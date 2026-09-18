import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { trusted, type Connection, type Model } from 'mongoose';
import { Job } from '../../jobs/job.schema.js';
import { WorkerAttempt } from '../jobs/worker-attempt.schema.js';
import { WorkerSlot } from '../machines/worker-slot.schema.js';
import { WorkerFleetPolicy } from '../policy/worker-fleet-policy.schema.js';
import { workerError } from '../worker-errors.js';

const ACTIVE_ATTEMPTS = ['claimed', 'running', 'uploading'] as const;

@Injectable()
export class WorkerRecoveryService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(WorkerAttempt.name)
    private readonly attempts: Model<WorkerAttempt>,
    @InjectModel(WorkerSlot.name)
    private readonly slots: Model<WorkerSlot>,
    @InjectModel(WorkerFleetPolicy.name)
    private readonly policies: Model<WorkerFleetPolicy>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
  ) {}

  async recoverOne(now = new Date()): Promise<boolean> {
    const observed = await this.attempts
      .findOne({
        state: trusted({ $in: ACTIVE_ATTEMPTS }),
        leaseExpiresAt: trusted({ $lte: now }),
      })
      .sort({ leaseExpiresAt: 1, _id: 1 })
      .maxTimeMS(2000)
      .lean();
    if (!observed) return false;

    const session = await this.connection.startSession();
    try {
      const recovered = await session.withTransaction(async () => {
        const policy = await this.policies
          .findById('worker-fleet')
          .session(session)
          .lean();
        if (!policy) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
        const job = await this.jobs
          .findById(observed.jobId)
          .session(session)
          .lean();
        const ownsJob =
          job?.currentExecution?.attemptId === observed._id &&
          job.currentExecution.machineId === observed.machineId &&
          job.currentExecution.workerId === observed.workerId &&
          job.currentExecution.sessionId === observed.sessionId &&
          job.currentExecution.incarnation === observed.incarnation &&
          job.currentExecution.leaseExpiresAt.getTime() ===
            observed.leaseExpiresAt.getTime();
        const cancelled =
          !job ||
          Boolean(job.deletedAt) ||
          ['cancel_requested', 'cancelled'].includes(job.status);
        const retry =
          Boolean(ownsJob) &&
          !cancelled &&
          job!.retryEligibility?.eligible === true &&
          job!.retryEligibility.attemptsRemaining > 1 &&
          observed.attemptNumber < policy.maxAttempts;

        const attemptFence = await this.attempts.updateOne(
          {
            _id: observed._id,
            revision: observed.revision,
            state: trusted({ $in: ACTIVE_ATTEMPTS }),
            leaseExpiresAt: observed.leaseExpiresAt,
          },
          {
            $set: {
              state: cancelled ? 'cancelled' : 'lost',
              terminalCode: cancelled ? 'CANCELLED' : 'LEASE_EXPIRED',
              terminalSummary: cancelled
                ? 'Job ownership was cancelled'
                : 'Worker lease expired',
              finishedAt: now,
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (attemptFence.modifiedCount !== 1) return false;

        if (ownsJob && job) {
          const nextAttemptAt = retry
            ? new Date(
                now.getTime() +
                  Math.min(60_000, 5_000 * 2 ** (observed.attemptNumber - 1)),
              )
            : null;
          const jobFence = await this.jobs.updateOne(
            {
              _id: job._id,
              revision: job.revision,
              'currentExecution.attemptId': observed._id,
              'currentExecution.leaseExpiresAt': observed.leaseExpiresAt,
            },
            {
              $set: {
                status: cancelled ? 'cancelled' : retry ? 'queued' : 'failed',
                currentExecution: null,
                retryEligibility: {
                  eligible: retry,
                  attemptsRemaining: Math.max(
                    0,
                    (job.retryEligibility?.attemptsRemaining ?? 1) - 1,
                  ),
                  nextAttemptAt,
                },
                ...(cancelled
                  ? { finishedAt: now, lastError: null }
                  : retry
                    ? { queuedAt: now, finishedAt: null, lastError: null }
                    : {
                        finishedAt: now,
                        lastError: {
                          code: 'SEPARATOR_FAILED',
                          message: 'Processing worker became unavailable',
                          at: now,
                        },
                      }),
              },
              $inc: { revision: 1 },
            },
            { session, runValidators: true },
          );
          if (jobFence.modifiedCount !== 1)
            throw workerError('WORKER_CONFLICT');
        }
        await this.slots.updateOne(
          {
            _id: observed.workerId,
            machineId: observed.machineId,
            currentAttemptId: observed._id,
          },
          {
            $set: { state: 'idle', currentAttemptId: null, lastSeenAt: now },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        return true;
      });
      return recovered ?? false;
    } finally {
      await session.endSession();
    }
  }
}
