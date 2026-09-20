import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type ClientSession, type Model, type Types } from 'mongoose';
import { Job } from '../jobs/job.schema.js';
import { ACTIVE_ADMISSION_STATUSES } from '../jobs/job-lifecycle-policy.js';
import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { WorkerAttempt } from '../worker-fleet/jobs/worker-attempt.schema.js';
import { WorkerSlot } from '../worker-fleet/machines/worker-slot.schema.js';

@Injectable()
export class RestrictionJobsService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly usage: ProcessingUsageService,
  ) {}

  async cancelNotFinalized(
    accountId: Types.ObjectId,
    session: ClientSession,
  ): Promise<number> {
    const jobs = await this.jobs
      .find({
        userId: accountId,
        deletedAt: null,
        status: trusted({ $in: ACTIVE_ADMISSION_STATUSES }),
      })
      .sort({ _id: 1 })
      .limit(101)
      .session(session);
    if (jobs.length > 100)
      throw new Error(
        'Restricted account has more active jobs than policy permits',
      );
    const now = new Date();
    for (const job of jobs) {
      const execution = job.currentExecution;
      const updated = await this.jobs
        .findOneAndUpdate(
          { _id: job._id, revision: job.revision, deletedAt: null },
          {
            $set: {
              status: 'cancelled',
              currentExecution: null,
              finishedAt: now,
              retryEligibility: job.retryEligibility
                ? {
                    ...job.retryEligibility,
                    eligible: false,
                    attemptsRemaining: 0,
                    nextAttemptAt: null,
                  }
                : null,
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true, returnDocument: 'after' },
        )
        .lean();
      if (!updated) throw new Error('Job changed while applying restriction');
      if (execution) {
        await this.jobs.db.model<WorkerAttempt>(WorkerAttempt.name).updateOne(
          {
            _id: execution.attemptId,
            state: trusted({ $in: ['claimed', 'running', 'uploading'] }),
          },
          {
            $set: {
              state: 'cancelled',
              terminalCode: 'ACCOUNT_RESTRICTED',
              terminalSummary: 'Account processing was restricted',
              finishedAt: now,
              leaseExpiresAt: now,
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        await this.jobs.db.model<WorkerSlot>(WorkerSlot.name).updateOne(
          {
            _id: execution.workerId,
            machineId: execution.machineId,
            sessionId: execution.sessionId,
            incarnation: execution.incarnation,
            currentAttemptId: execution.attemptId,
          },
          {
            $set: { state: 'idle', currentAttemptId: null, lastSeenAt: now },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
      }
      await this.usage.settleJob(updated, session, now);
    }
    return jobs.length;
  }
}
