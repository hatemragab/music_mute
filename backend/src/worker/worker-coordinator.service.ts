import { HttpException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { ClientSession, HydratedDocument, Model } from 'mongoose';
import { isUUID } from 'class-validator';
import { authError } from '../auth/auth.errors.js';
import { Job } from '../jobs/job.schema.js';
import { JobAttempt } from '../jobs/job-attempt.schema.js';
import { JobReceipt } from '../jobs/job-receipt.schema.js';
import { jobError } from '../jobs/job-errors.js';
import { assertMeasuredDuration } from '../jobs/job-state.js';
import { isDuplicateKey, objectId, requestHash } from '../jobs/job-request.js';
import type { WorkerEvent, WorkerSelector } from '../jobs/job.types.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { processingIo } from '../processing/processing-io.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { WorkerControl } from './worker-control.schema.js';
import { WorkerRegistration } from './worker-registration.schema.js';
import { WorkerRegistryService } from './worker-registry.service.js';
import type { WorkerIdentity } from './worker-routes.js';

@Injectable()
export class WorkerCoordinatorService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    @InjectModel(WorkerControl.name)
    private readonly workers: Model<WorkerControl>,
    @InjectModel(JobAttempt.name) private readonly attempts: Model<JobAttempt>,
    private readonly transactions: ProcessingTransactions,
    private readonly config: ConfigService,
    private readonly storage: StorageTransfersService,
    @InjectModel(JobReceipt.name) private readonly receipts: Model<JobReceipt>,
    private readonly accountAccess: AccountAccessService,
    @Optional() private readonly registry?: WorkerRegistryService,
  ) {}

  private get workerRegistry(): WorkerRegistryService {
    return (
      this.registry ??
      new WorkerRegistryService(
        this.jobs.db.model<WorkerRegistration>(WorkerRegistration.name),
        this.workers,
        this.config,
      )
    );
  }

  ownerId(value: string | null | undefined): string {
    return this.workerRegistry.ownerId(value);
  }

  authority(identity: WorkerIdentity | undefined, session: ClientSession) {
    return this.workerRegistry.fence(identity, session);
  }

  touchControl(
    control: HydratedDocument<WorkerControl>,
    session: ClientSession,
  ) {
    return this.workerRegistry.touchControl(control, session);
  }

  async assertAttemptOwnership(
    selector: WorkerSelector,
    session: ClientSession,
    identity?: WorkerIdentity,
  ) {
    const authority = await this.authority(identity, session);
    const attempt = await this.attempts
      .findOne({
        jobId: objectId(selector.jobId),
        attemptId: selector.attemptId,
        sessionId: selector.sessionId,
        generation: selector.generation,
      })
      .session(session);
    if (
      !attempt ||
      this.ownerId(attempt.workerId) !== authority.identity.workerId
    )
      throw jobError('STALE_ATTEMPT');
    return { ...authority, attempt };
  }

  async prepare(): Promise<void> {
    if (this.workerRegistry.mode !== 'legacy') return;
    try {
      await this.workers.updateOne(
        { _id: 'z440' },
        { $setOnInsert: { generation: 0 } },
        { upsert: true },
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  async claim(sessionId: string, identity?: WorkerIdentity) {
    if (!isUUID(sessionId, '4')) throw authError('INVALID_INPUT');
    sessionId = sessionId.toLowerCase();
    await this.prepare();
    const job = await this.transactions.run(async (session) => {
      const {
        control,
        state,
        identity: owner,
      } = await this.authority(identity, session);
      if (control.activeJobId) {
        const current = await this.jobs
          .findById(control.activeJobId)
          .session(session);
        if (
          !current ||
          this.ownerId(current.workerId) !== owner.workerId ||
          control.sessionId !== sessionId ||
          !this.live(current, control)
        ) {
          throw new HttpException(
            {
              statusCode: 409,
              code: 'WORKER_RECOVERY_REQUIRED',
              message: 'The previous assignment requires recovery',
              previousAttemptId: control.attemptId,
              canRecover: Boolean(current && control.sessionId === sessionId),
            },
            409,
          );
        }
        return current;
      }
      const next =
        state === 'draining'
          ? null
          : await this.jobs
              .findOne({ status: 'queued', deletedAt: null, workerId: null })
              .sort({ queueOrder: 1 })
              .session(session);
      if (!next) {
        await this.workers.updateOne(
          { _id: control._id },
          { $set: { lastSeenAt: new Date() } },
          { session },
        );
        return null;
      }
      return this.assign(next, control, sessionId, session, identity);
    });
    return job ? this.assignment(job, identity) : null;
  }

  private live(job: Job, control: WorkerControl): boolean {
    const now = Date.now();
    return Boolean(
      job.leaseExpiresAt &&
      control.leaseExpiresAt &&
      job.leaseExpiresAt.getTime() > now &&
      control.leaseExpiresAt.getTime() > now &&
      job.status !== 'interrupted',
    );
  }

  async current(
    selector: WorkerSelector,
    session: ClientSession,
    requireLive = true,
    identity?: WorkerIdentity,
  ) {
    const {
      control,
      identity: owner,
      state,
    } = await this.assertAttemptOwnership(selector, session, identity);
    const job = await this.jobs
      .findById(objectId(selector.jobId))
      .session(session);
    if (
      !job ||
      job.deletedAt ||
      !control ||
      this.ownerId(job.workerId) !== owner.workerId ||
      control.activeJobId?.toHexString() !== selector.jobId ||
      control.attemptId !== selector.attemptId ||
      control.sessionId !== selector.sessionId ||
      control.generation !== selector.generation ||
      job.attemptId !== selector.attemptId ||
      job.sessionId !== selector.sessionId ||
      job.generation !== selector.generation ||
      (requireLive && !this.live(job, control))
    )
      throw jobError('STALE_ATTEMPT');
    return { job, control, state };
  }

  async heartbeat(selector: WorkerSelector, identity?: WorkerIdentity) {
    return this.transactions.run(async (session) => {
      const { job, control } = await this.current(
        selector,
        session,
        true,
        identity,
      );
      const leaseExpiresAt = this.deadline();
      const now = new Date();
      await this.jobs.updateOne(
        { _id: job._id, revision: job.revision },
        {
          $set: { leaseExpiresAt, processingObservedAt: now },
          $inc: { revision: 1 },
        },
        { session },
      );
      await this.workers.updateOne(
        { _id: control._id },
        { $set: { leaseExpiresAt, lastSeenAt: now } },
        { session },
      );
      return {
        status: job.status,
        cancelRequested: job.status === 'cancel_requested',
        leaseExpiresAt: leaseExpiresAt.toISOString(),
      };
    });
  }

  async stage(
    selector: WorkerEvent,
    report: {
      stage: 'processing';
      durationSeconds: number;
      decodable: true;
      hasAudio: true;
    },
    identity?: WorkerIdentity,
  ) {
    if (
      report.stage !== 'processing' ||
      report.decodable !== true ||
      report.hasAudio !== true ||
      !Number.isFinite(report.durationSeconds) ||
      report.durationSeconds <= 0 ||
      report.durationSeconds >= 600
    )
      throw authError('INVALID_INPUT');
    const hash = requestHash({ operation: 'stage', selector, report });
    return this.transactions.run(async (session) => {
      await this.assertAttemptOwnership(selector, session, identity);
      const receipt = await this.receipts
        .findOne({ jobId: objectId(selector.jobId), eventId: selector.eventId })
        .session(session);
      if (receipt) {
        if (receipt.requestHash !== hash)
          throw jobError('IDEMPOTENCY_CONFLICT');
        return { status: receipt.status };
      }
      const { job } = await this.current(selector, session, true, identity);
      await this.accountAccess.assertActive(job.userId, session);
      assertMeasuredDuration(
        report.durationSeconds,
        job.admissionSnapshot?.maxDurationSecondsExclusive ?? 600,
      );
      if (!['validating', 'processing'].includes(job.status))
        throw jobError('JOB_STATE_CONFLICT');
      const now = new Date();
      const entering = job.status === 'validating';
      await this.jobs.updateOne(
        { _id: job._id, revision: job.revision },
        {
          $set: {
            status: 'processing',
            processingObservedAt: now,
            measuredDurationSeconds: report.durationSeconds,
            ...(entering
              ? {
                  processingStartedAt: job.processingStartedAt ?? now,
                  processingIntervalStartedAt: now,
                  processingFinishedAt: null,
                }
              : {}),
          },
          $inc: { revision: 1 },
        },
        { session },
      );
      if (entering)
        await this.attempts.updateOne(
          { attemptId: job.attemptId },
          { $set: { processingStartedAt: now } },
          { session },
        );
      await this.receipts.create(
        [
          {
            jobId: job._id,
            eventId: selector.eventId,
            attemptId: selector.attemptId,
            requestHash: hash,
            operation: 'stage',
            status: 'processing',
            createdAt: new Date(),
          },
        ],
        { session },
      );
      return { status: 'processing' as const };
    });
  }

  async assign(
    job: HydratedDocument<Job>,
    control: HydratedDocument<WorkerControl>,
    sessionId: string,
    session: ClientSession,
    identity?: WorkerIdentity,
  ) {
    if (this.config.get<boolean>('AUDIO_PROCESSING_ENABLED') === false)
      throw authError('SERVICE_UNAVAILABLE');
    const authority = await this.authority(identity, session);
    if (
      authority.identity.workerId !== control._id ||
      authority.state !== 'enabled'
    )
      throw jobError('WORKER_RECOVERY_REQUIRED');
    await this.accountAccess.assertActive(job.userId, session);
    const attemptId = randomUUID();
    const generation = control.generation + 1;
    if (!Number.isSafeInteger(generation))
      throw new Error('Worker generation exhausted');
    const leaseExpiresAt = this.deadline();
    const now = new Date();
    await this.workers.updateOne(
      { _id: control._id },
      {
        $set: {
          activeJobId: job._id,
          attemptId,
          sessionId,
          generation,
          leaseExpiresAt,
          lastSeenAt: now,
        },
      },
      { session },
    );
    job.set({
      workerId: control._id,
      status: 'validating',
      validatingAt: now,
      processingIntervalStartedAt: null,
      processingObservedAt: now,
      attemptId,
      sessionId,
      generation,
      leaseExpiresAt,
      outputReservation: null,
      revision: job.revision + 1,
    });
    await job.save({ session });
    await this.attempts.create(
      [
        {
          jobId: job._id,
          workerId: control._id,
          attemptId,
          sessionId,
          generation,
          startedAt: now,
        },
      ],
      { session },
    );
    return job;
  }

  async assignment(job: Job, identity?: WorkerIdentity) {
    if (
      !job.inputObject ||
      !job.attemptId ||
      !job.sessionId ||
      !job.leaseExpiresAt
    )
      throw new Error('Incomplete assignment');
    const download = await processingIo(() =>
      this.storage.createDownloadGrant(job.inputObject!),
    );
    await this.transactions.run(async (session) => {
      await this.current(
        {
          jobId: job._id.toHexString(),
          attemptId: job.attemptId!,
          sessionId: job.sessionId!,
          generation: job.generation,
        },
        session,
        true,
        identity,
      );
    });
    await this.accountAccess.assertActive(job.userId);
    return {
      workerId: this.ownerId(job.workerId),
      jobId: job._id.toHexString(),
      attemptId: job.attemptId,
      sessionId: job.sessionId,
      generation: job.generation,
      status: job.status,
      cancelRequested: job.status === 'cancel_requested',
      leaseExpiresAt: job.leaseExpiresAt.toISOString(),
      input: {
        extension: job.inputReservation.extension,
        contentType: job.inputReservation.contentType,
        bytes: job.inputReservation.bytes,
        sha256: job.inputReservation.sha256,
        durationSeconds: job.inputReservation.durationSeconds,
        download,
      },
    };
  }

  private deadline(): Date {
    return new Date(
      Date.now() +
        this.config.getOrThrow<number>('PROCESSING_LEASE_SECONDS') * 1000,
    );
  }
}
