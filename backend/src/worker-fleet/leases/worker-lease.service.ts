import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Types, trusted, type Connection, type Model } from 'mongoose';
import { Job } from '../../jobs/job.schema.js';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import { WorkerAttempt } from '../jobs/worker-attempt.schema.js';
import { WorkerMachine } from '../machines/worker-machine.schema.js';
import { WorkerSlot } from '../machines/worker-slot.schema.js';
import { WorkerFleetPolicy } from '../policy/worker-fleet-policy.schema.js';
import { workerError } from '../worker-errors.js';
import type {
  RenewWorkerLeaseItemDto,
  RenewWorkerLeasesDto,
} from './worker-lease.dto.js';

type LeaseDisposition = 'accepted' | 'expired' | 'cancelled' | 'revoked';
const ACTIVE_ATTEMPTS = ['claimed', 'running', 'uploading'] as const;

@Injectable()
export class WorkerLeaseService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(WorkerMachine.name)
    private readonly machines: Model<WorkerMachine>,
    @InjectModel(WorkerSlot.name)
    private readonly slots: Model<WorkerSlot>,
    @InjectModel(WorkerAttempt.name)
    private readonly attempts: Model<WorkerAttempt>,
    @InjectModel(WorkerFleetPolicy.name)
    private readonly policies: Model<WorkerFleetPolicy>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
  ) {}

  async renew(principal: WorkerPrincipal, dto: RenewWorkerLeasesDto) {
    if (principal.kind !== 'machine')
      throw workerError('WORKER_UNAUTHENTICATED');
    const serverTime = new Date();
    const results = [];
    for (const item of dto.leases) {
      results.push(
        await this.renewOne(
          principal.subjectId,
          dto.sessionId,
          dto.incarnation,
          item,
          serverTime,
        ),
      );
    }
    return {
      requestId: dto.requestId,
      serverTime: serverTime.toISOString(),
      results,
    };
  }

  private async renewOne(
    machineId: string,
    sessionId: string,
    incarnation: string,
    item: RenewWorkerLeaseItemDto,
    now: Date,
  ) {
    const session = await this.connection.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const machine = await this.machines
          .findById(machineId)
          .session(session)
          .lean();
        if (
          !machine ||
          machine.status !== 'active' ||
          machine.currentSession?.sessionId !== sessionId ||
          machine.currentSession.incarnation !== incarnation
        )
          return this.disposition(item, 'revoked');
        const policy = await this.policies
          .findById('worker-fleet')
          .session(session)
          .lean();
        if (!policy) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
        const attempt = await this.attempts
          .findOne({
            _id: item.attemptId,
            jobId: new Types.ObjectId(item.jobId),
            machineId,
            workerId: item.workerId,
            sessionId,
            incarnation,
          })
          .session(session)
          .lean();
        const job = await this.jobs
          .findById(item.jobId)
          .session(session)
          .lean();
        if (
          !job ||
          job.deletedAt ||
          ['cancel_requested', 'cancelled'].includes(job.status)
        )
          return this.disposition(item, 'cancelled');
        if (
          !attempt ||
          !ACTIVE_ATTEMPTS.some((state) => state === attempt.state) ||
          attempt.leaseExpiresAt <= now ||
          attempt.deadlineAt <= now ||
          job.currentExecution?.attemptId !== attempt._id ||
          job.currentExecution.machineId !== machineId ||
          job.currentExecution.workerId !== item.workerId ||
          job.currentExecution.sessionId !== sessionId ||
          job.currentExecution.incarnation !== incarnation ||
          job.currentExecution.leaseExpiresAt <= now
        )
          return this.disposition(item, 'expired');
        const leaseExpiresAt = new Date(
          Math.min(
            attempt.deadlineAt.getTime(),
            now.getTime() + policy.leaseSeconds * 1000,
          ),
        );
        if (leaseExpiresAt <= now) return this.disposition(item, 'expired');
        const attemptFence = await this.attempts.updateOne(
          {
            _id: attempt._id,
            revision: attempt.revision,
            state: trusted({ $in: ACTIVE_ATTEMPTS }),
            leaseExpiresAt: attempt.leaseExpiresAt,
            deadlineAt: trusted({ $gt: now }),
          },
          {
            $set: { leaseExpiresAt, state: 'running' },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (attemptFence.modifiedCount !== 1)
          return this.disposition(item, 'expired');
        const jobFence = await this.jobs.updateOne(
          {
            _id: job._id,
            revision: job.revision,
            status: trusted({ $in: ['processing', 'uploading_result'] }),
            'currentExecution.attemptId': attempt._id,
            'currentExecution.machineId': machineId,
            'currentExecution.workerId': item.workerId,
            'currentExecution.sessionId': sessionId,
            'currentExecution.incarnation': incarnation,
            'currentExecution.leaseExpiresAt': trusted({ $gt: now }),
          },
          {
            $set: {
              'currentExecution.leaseExpiresAt': leaseExpiresAt,
              processingObservedAt: now,
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (jobFence.modifiedCount !== 1) throw workerError('WORKER_CONFLICT');
        const slotFence = await this.slots.updateOne(
          {
            _id: item.workerId,
            machineId,
            sessionId,
            incarnation,
            currentAttemptId: attempt._id,
            state: trusted({ $in: ['reserved', 'busy'] }),
          },
          {
            $set: { state: 'busy', lastSeenAt: now },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (slotFence.modifiedCount !== 1) throw workerError('WORKER_CONFLICT');
        return {
          ...this.disposition(item, 'accepted'),
          leaseExpiresAt: leaseExpiresAt.toISOString(),
        };
      });
      return result ?? this.disposition(item, 'expired');
    } finally {
      await session.endSession();
    }
  }

  private disposition(
    item: RenewWorkerLeaseItemDto,
    disposition: LeaseDisposition,
  ) {
    return {
      jobId: item.jobId,
      attemptId: item.attemptId,
      disposition,
      leaseExpiresAt: null as string | null,
    };
  }
}
