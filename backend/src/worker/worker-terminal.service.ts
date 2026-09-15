import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { ProcessingUsageLedger } from '../processing-usage/processing-usage.schema.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import {
  type ClientSession,
  type HydratedDocument,
  type Model,
} from 'mongoose';
import { Job } from '../jobs/job.schema.js';
import { JobAttempt } from '../jobs/job-attempt.schema.js';
import { JobReceipt } from '../jobs/job-receipt.schema.js';
import { JobError } from '../job-errors/job-error.schema.js';
import { safeJobMessage } from '../job-errors/safe-job-error.js';
import { objectId, requestHash } from '../jobs/job-request.js';
import { jobError } from '../jobs/job-errors.js';
import { closeProcessingInterval } from '../jobs/job-timing.js';
import type { ObjectIdentity } from '../jobs/job.types.js';
import { NotificationOutbox } from '../notifications/notification-outbox.schema.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { processingIo } from '../processing/processing-io.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { WorkerControl } from './worker-control.schema.js';
import { WorkerCoordinatorService } from './worker-coordinator.service.js';
import type { WorkerIdentity } from './worker-routes.js';
import type {
  WorkerEventDto,
  WorkerFailDto,
  WorkerLocalCleanupDto,
  WorkerStoppedDto,
} from './dto/worker-event.dto.js';

@Injectable()
export class WorkerTerminalService {
  constructor(
    private readonly coordinator: WorkerCoordinatorService,
    private readonly transactions: ProcessingTransactions,
    private readonly storage: StorageTransfersService,
    @InjectModel(JobAttempt.name) private readonly attempts: Model<JobAttempt>,
    @InjectModel(JobReceipt.name) private readonly receipts: Model<JobReceipt>,
    @InjectModel(JobError.name) private readonly errors: Model<JobError>,
    @InjectModel(WorkerControl.name)
    private readonly workers: Model<WorkerControl>,
    @InjectModel(NotificationOutbox.name)
    private readonly outbox: Model<NotificationOutbox>,
    private readonly accountAccess: AccountAccessService,
  ) {}

  async confirmLocalCleanup(
    dto: WorkerLocalCleanupDto,
    identity?: WorkerIdentity,
  ) {
    if (dto.localDataDeleted !== true) throw jobError('JOB_STATE_CONFLICT');
    return this.transactions.run(async (session) => {
      const { identity: owner } = await this.coordinator.authority(
        identity,
        session,
      );
      const jobId = objectId(dto.jobId);
      const attempt = await this.attempts
        .findOne({
          jobId,
          attemptId: dto.attemptId,
          sessionId: dto.sessionId,
          generation: dto.generation,
        })
        .session(session);
      if (!attempt) throw jobError('STALE_ATTEMPT');
      if (this.coordinator.ownerId(attempt.workerId) !== owner.workerId)
        throw jobError('STALE_ATTEMPT');
      if (await this.workers.exists({ activeJobId: jobId }).session(session))
        throw jobError('JOB_ACTIVE');
      await this.attempts.updateMany(
        {
          jobId,
          sessionId: dto.sessionId,
          workerId: owner.workerId,
        },
        { $set: { localDataDeletedAt: new Date() } },
        { session },
      );
      return { status: 'cleaned' as const };
    });
  }

  async receipt(
    dto: WorkerEventDto,
    hash: string,
    session?: ClientSession,
    identity?: WorkerIdentity,
  ): Promise<{ status: string } | null> {
    if (!session)
      return this.transactions.run((current) =>
        this.receipt(dto, hash, current, identity),
      );
    await this.coordinator.assertAttemptOwnership(dto, session, identity);
    const query = this.receipts.findOne({
      jobId: objectId(dto.jobId),
      eventId: dto.eventId,
    });
    if (session) query.session(session);
    const receipt = await query.lean();
    if (receipt && receipt.requestHash !== hash)
      throw jobError('IDEMPOTENCY_CONFLICT');
    return receipt ? { status: receipt.status } : null;
  }

  async complete(dto: WorkerEventDto, identity?: WorkerIdentity) {
    const hash = requestHash({ operation: 'complete', ...dto });
    const prior = await this.receipt(dto, hash, undefined, identity);
    if (prior) return prior;
    const current = await this.transactions.run(async (session) => {
      const { job } = await this.coordinator.current(
        dto,
        session,
        true,
        identity,
      );
      if (job.status !== 'uploading_result')
        throw jobError('JOB_STATE_CONFLICT');
      return job;
    });
    const object = await processingIo(() => this.storage.verifyOutput(current));
    return this.transactions.run(async (session) => {
      const repeated = await this.receipt(dto, hash, session, identity);
      if (repeated) return repeated;
      const { job } = await this.coordinator.current(
        dto,
        session,
        true,
        identity,
      );
      if (job.status !== 'uploading_result')
        throw jobError('JOB_STATE_CONFLICT');
      if (dto.executionEvidence) {
        if (!dto.executionEvidence.stoppedConfirmed)
          throw jobError('JOB_STATE_CONFLICT');
        await this.coordinator.recordExecution(
          job,
          dto.eventId,
          dto.executionEvidence,
          session,
        );
      }
      await this.finalize(job, 'ready', session, object);
      await this.record(dto, hash, 'complete', 'ready', session);
      return { status: 'ready' as const };
    });
  }

  async stopped(
    dto: WorkerStoppedDto | WorkerFailDto,
    operation: 'cancelled' | 'fail',
    identity?: WorkerIdentity,
  ) {
    const hash = requestHash({ operation, ...dto });
    return this.transactions.run(async (session) => {
      const prior = await this.receipt(dto, hash, session, identity);
      if (prior) return prior;
      const { job } = await this.coordinator.current(
        dto,
        session,
        true,
        identity,
      );
      if (dto.stopped !== true) throw jobError('JOB_STATE_CONFLICT');
      if (dto.executionEvidence) {
        if (!dto.executionEvidence.stoppedConfirmed)
          throw jobError('JOB_STATE_CONFLICT');
        await this.coordinator.recordExecution(
          job,
          dto.eventId,
          dto.executionEvidence,
          session,
        );
      }
      if (operation === 'cancelled' && job.status !== 'cancel_requested')
        throw jobError('JOB_STATE_CONFLICT');
      if (operation === 'fail') {
        const failure = dto as WorkerFailDto;
        const message = safeJobMessage(failure.code);
        if (!message) throw jobError('JOB_STATE_CONFLICT');
        const now = new Date();
        await this.errors.create(
          [
            {
              jobId: job._id,
              eventId: dto.eventId,
              attemptId: dto.attemptId,
              generation: dto.generation,
              classification: 'processing',
              code: failure.code,
              message,
              stage: failure.stage,
              exitCode: failure.exitCode ?? null,
              createdAt: now,
            },
          ],
          { session },
        );
        if (job.status !== 'cancel_requested')
          job.lastError = { code: failure.code, message, at: now };
      }
      const status = job.status === 'cancel_requested' ? 'cancelled' : 'failed';
      await this.finalize(job, status, session);
      await this.record(dto, hash, operation, status, session);
      return { status };
    });
  }

  async finalize(
    job: HydratedDocument<Job>,
    status: 'ready' | 'failed' | 'cancelled',
    session: ClientSession,
    output?: ObjectIdentity,
  ) {
    if (status === 'ready')
      await this.accountAccess.assertActive(job.userId, session);
    const now = new Date();
    const timing = closeProcessingInterval(job, now);
    job.set({
      ...timing,
      status,
      finishedAt: now,
      leaseExpiresAt: null,
      revision: job.revision + 1,
      ...(output ? { outputObject: output } : {}),
    });
    await job.save({ session });
    await new ProcessingUsageService(
      this.attempts.db.model<ProcessingUsageLedger>(ProcessingUsageLedger.name),
      this.attempts.db.model<Job>(Job.name),
    ).settleJob(job, session);
    const released = await this.workers.updateOne(
      {
        _id: this.coordinator.ownerId(job.workerId),
        activeJobId: job._id,
        attemptId: job.attemptId,
        sessionId: job.sessionId,
        generation: job.generation,
      },
      {
        $set: {
          activeJobId: null,
          attemptId: null,
          sessionId: null,
          leaseExpiresAt: null,
          lastSeenAt: now,
        },
      },
      { session },
    );
    if (released.matchedCount !== 1) throw jobError('STALE_ATTEMPT');
    await this.attempts.updateOne(
      { attemptId: job.attemptId },
      {
        $set: {
          endedAt: now,
          outcome: status,
          ...(timing.processingFinishedAt
            ? { processingEndedAt: timing.processingFinishedAt }
            : {}),
        },
      },
      { session },
    );
    if (status !== 'cancelled')
      await this.outbox.create(
        [{ jobId: job._id, userId: job.userId, outcome: status }],
        { session },
      );
  }

  async record(
    dto: WorkerEventDto,
    hash: string,
    operation: 'complete' | 'fail' | 'cancelled',
    status: 'ready' | 'failed' | 'cancelled',
    session: ClientSession,
  ) {
    await this.receipts.create(
      [
        {
          jobId: objectId(dto.jobId),
          eventId: dto.eventId,
          attemptId: dto.attemptId,
          requestHash: hash,
          operation,
          status,
          createdAt: new Date(),
        },
      ],
      { session },
    );
  }
}
