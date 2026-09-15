import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { ProcessingUsageLedger } from '../processing-usage/processing-usage.schema.js';
import type { AttemptExecutionEvidence } from './execution-evidence.js';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, trusted, type ClientSession, type Model } from 'mongoose';
import { adminError } from '../admin/admin-errors.js';
import { validateStopEvidence } from './worker-stop-evidence.js';
import { Job } from '../jobs/job.schema.js';
import { JobAttempt } from '../jobs/job-attempt.schema.js';
import { JobError } from '../job-errors/job-error.schema.js';
import { jobError } from '../jobs/job-errors.js';
import { closeProcessingInterval } from '../jobs/job-timing.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { processingIo } from '../processing/processing-io.js';
import { WorkerControl } from './worker-control.schema.js';
import { WorkerCoordinatorService } from './worker-coordinator.service.js';
import { WorkerTerminalService } from './worker-terminal.service.js';
import type { WorkerIdentity } from './worker-routes.js';

@Injectable()
export class WorkerRecoveryService {
  private readonly logger = new Logger(WorkerRecoveryService.name);
  private expiryCursor: string | null = null;
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    @InjectModel(JobAttempt.name) private readonly attempts: Model<JobAttempt>,
    @InjectModel(JobError.name) private readonly errors: Model<JobError>,
    @InjectModel(WorkerControl.name)
    private readonly workers: Model<WorkerControl>,
    private readonly transactions: ProcessingTransactions,
    private readonly coordinator: WorkerCoordinatorService,
    private readonly terminal: WorkerTerminalService,
    private readonly storage: StorageTransfersService,
  ) {}

  /** Trusted administrative recovery; caller supplies the audited transaction. */
  async releaseStopped(
    workerId: string,
    proof: {
      jobId: string;
      attemptId: string;
      sessionId: string;
      generation: number;
      expectedRevision: number;
      stoppedAt: string;
      stopEvidence: string;
    },
    session: ClientSession,
  ): Promise<void> {
    if (!session.inTransaction())
      throw new Error('Recovery requires a transaction');
    const stoppedAt = validateStopEvidence(proof.stopEvidence, proof.stoppedAt);
    if (!/^[a-f0-9]{24}$/.test(proof.jobId))
      throw adminError('INVALID_REQUEST');
    const control = await this.workers.findById(workerId).session(session);
    if (!control || control.controlRevision !== proof.expectedRevision)
      throw adminError('REVISION_CONFLICT');
    if (
      control.activeJobId?.toString() !== proof.jobId ||
      control.attemptId !== proof.attemptId ||
      control.sessionId !== proof.sessionId ||
      control.generation !== proof.generation
    )
      throw adminError('RECOVERY_PROOF_REQUIRED');
    const job = await this.jobs
      .findById(new Types.ObjectId(proof.jobId))
      .session(session);
    const attempt = await this.attempts
      .findOne({ attemptId: proof.attemptId })
      .session(session);
    if (
      !job ||
      !attempt ||
      job.workerId !== workerId ||
      attempt.workerId !== workerId ||
      attempt.jobId.toString() !== proof.jobId ||
      job.attemptId !== proof.attemptId ||
      job.sessionId !== proof.sessionId ||
      job.generation !== proof.generation ||
      attempt.sessionId !== proof.sessionId ||
      attempt.generation !== proof.generation ||
      attempt.endedAt ||
      attempt.releasedAt ||
      ![
        'validating',
        'processing',
        'uploading_result',
        'interrupted',
        'cancel_requested',
      ].includes(job.status) ||
      stoppedAt < attempt.startedAt ||
      (control.lastSeenAt && stoppedAt < control.lastSeenAt)
    )
      throw adminError('RECOVERY_PROOF_REQUIRED');
    await this.coordinator.touchControl(control, session);
    if (job.status === 'cancel_requested') {
      await this.terminal.finalize(job, 'cancelled', session);
      // Administrative evidence is not a worker heartbeat.
      await this.workers.updateOne(
        { _id: workerId },
        { $set: { lastSeenAt: control.lastSeenAt } },
        { session },
      );
      await this.attempts.updateOne(
        { _id: attempt._id },
        { $set: { releasedAt: new Date() } },
        { session },
      );
      return;
    }
    const now = new Date();
    const timing = closeProcessingInterval(job, stoppedAt);
    await this.attempts.updateOne(
      { _id: attempt._id },
      {
        $set: {
          endedAt: now,
          releasedAt: now,
          interruptedAt: attempt.interruptedAt ?? stoppedAt,
          outcome: 'interrupted',
          ...(timing.processingFinishedAt
            ? { processingEndedAt: timing.processingFinishedAt }
            : {}),
        },
      },
      { session },
    );
    const released = await this.workers.updateOne(
      {
        _id: workerId,
        activeJobId: job._id,
        attemptId: proof.attemptId,
        sessionId: proof.sessionId,
        generation: proof.generation,
      },
      {
        $set: {
          activeJobId: null,
          attemptId: null,
          sessionId: null,
          leaseExpiresAt: null,
        },
      },
      { session },
    );
    if (released.matchedCount !== 1) throw adminError('REVISION_CONFLICT');
    job.set({
      ...timing,
      status: 'queued',
      workerId: null,
      attemptId: null,
      sessionId: null,
      generation: 0,
      leaseExpiresAt: null,
      outputReservation: null,
      revision: job.revision + 1,
    });
    await job.save({ session });
  }

  async markExpiredAssignments(): Promise<void> {
    const controls = await this.workers
      .find({
        activeJobId: trusted({ $ne: null }),
        leaseExpiresAt: trusted({ $lte: new Date() }),
        ...(this.expiryCursor
          ? { _id: trusted({ $gt: this.expiryCursor }) }
          : {}),
      })
      .sort({ _id: 1 })
      .limit(100)
      .lean();
    this.expiryCursor = controls.length === 100 ? controls.at(-1)!._id : null;
    for (const candidate of controls) {
      try {
        await this.markExpired(candidate._id);
      } catch {
        this.logger.error('Worker assignment expiry check failed');
      }
    }
  }

  private async markExpired(workerId: string): Promise<void> {
    await this.transactions.run(async (session) => {
      const control = await this.workers.findById(workerId).session(session);
      if (
        !control?.activeJobId ||
        !control.leaseExpiresAt ||
        control.leaseExpiresAt.getTime() > Date.now()
      )
        return;
      const job = await this.jobs
        .findById(control.activeJobId)
        .session(session);
      if (
        !job ||
        job.attemptId !== control.attemptId ||
        job.sessionId !== control.sessionId ||
        job.generation !== control.generation ||
        this.coordinator.ownerId(job.workerId) !== workerId
      )
        throw new Error('Inconsistent worker assignment');
      const attempt = await this.attempts
        .findOne({ attemptId: job.attemptId })
        .session(session);
      if (!attempt || attempt.interruptedAt) return;
      if (this.coordinator.ownerId(attempt.workerId) !== workerId)
        throw new Error('Inconsistent worker attempt');
      await this.coordinator.touchControl(control, session);
      const now = new Date();
      const timing = closeProcessingInterval(job, now, true);
      job.set(timing);
      if (job.status !== 'cancel_requested') job.status = 'interrupted';
      job.revision++;
      await job.save({ session });
      await this.attempts.updateOne(
        { _id: attempt._id },
        {
          $set: {
            interruptedAt: now,
            outcome: 'interrupted',
            ...(timing.processingFinishedAt
              ? {
                  processingEndedAt: timing.processingFinishedAt,
                  processingElapsedApproximate: true,
                }
              : {}),
          },
        },
        { session },
      );
      await this.errors.create(
        [
          {
            jobId: job._id,
            attemptId: job.attemptId,
            generation: job.generation,
            eventId: `interrupted:${job.attemptId}`,
            classification: 'interruption',
            code: 'WORKER_INTERRUPTED',
            message:
              'The worker disconnected. Processing will resume after recovery.',
            stage: 'interrupted',
            createdAt: now,
          },
        ],
        { session },
      );
    });
  }

  async reconcile(
    sessionId: string,
    previousAttemptId: string,
    stopped: boolean,
    identity?: WorkerIdentity,
    evidence?: {
      eventId?: string;
      executionEvidence?: AttemptExecutionEvidence;
    },
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.reconcileCurrent(
          sessionId,
          previousAttemptId,
          stopped,
          identity,
          evidence,
        );
      } catch (error) {
        if (
          !(error instanceof HttpException) ||
          (error.getResponse() as { code?: string }).code !== 'STALE_ATTEMPT' ||
          attempt === 2
        )
          throw error;
      }
    }
    throw jobError('STALE_ATTEMPT');
  }

  private async reconcileCurrent(
    sessionId: string,
    previousAttemptId: string,
    stopped: boolean,
    identity?: WorkerIdentity,
    evidence?: {
      eventId?: string;
      executionEvidence?: AttemptExecutionEvidence;
    },
  ) {
    if (stopped !== true) throw jobError('WORKER_RECOVERY_REQUIRED');
    const { previous, snapshot, control } = await this.transactions.run(
      async (session) => {
        const authority = await this.coordinator.authority(identity, session);
        const previous = await this.attempts
          .findOne({ attemptId: previousAttemptId })
          .session(session)
          .lean();
        if (
          !previous ||
          this.coordinator.ownerId(previous.workerId) !==
            authority.identity.workerId
        )
          throw jobError('STALE_ATTEMPT');
        const snapshot = await this.jobs
          .findById(previous.jobId)
          .session(session)
          .lean();
        if (
          !snapshot ||
          (!previous.releasedAt &&
            this.coordinator.ownerId(snapshot.workerId) !==
              authority.identity.workerId)
        )
          throw jobError('STALE_ATTEMPT');
        if (evidence?.executionEvidence) {
          if (!evidence.eventId || !evidence.executionEvidence.stoppedConfirmed)
            throw jobError('JOB_STATE_CONFLICT');
          await this.coordinator.recordExecution(
            { ...snapshot, attemptId: previousAttemptId },
            evidence.eventId,
            evidence.executionEvidence,
            session,
          );
        }
        if (
          evidence?.executionEvidence &&
          ['ready', 'failed', 'cancelled'].includes(snapshot.status)
        )
          await new ProcessingUsageService(
            this.jobs.db.model<ProcessingUsageLedger>(
              ProcessingUsageLedger.name,
            ),
            this.jobs,
          ).settleJob(snapshot, session);
        return { previous, snapshot, control: authority.control };
      },
    );
    if (previous.releasedAt)
      return { status: 'released' as const, previousAttemptId };
    if (
      ['ready', 'failed', 'cancelled'].includes(snapshot.status) &&
      (snapshot.attemptId === previousAttemptId ||
        (snapshot.attemptId === previous.replacementAttemptId &&
          snapshot.sessionId === sessionId))
    )
      return { jobId: snapshot._id.toHexString(), status: snapshot.status };
    if (
      previous.replacementAttemptId &&
      control?.attemptId === previous.replacementAttemptId &&
      control.sessionId === sessionId &&
      snapshot.attemptId === control.attemptId
    ) {
      if (
        !snapshot.leaseExpiresAt ||
        !control.leaseExpiresAt ||
        snapshot.leaseExpiresAt.getTime() <= Date.now() ||
        control.leaseExpiresAt.getTime() <= Date.now() ||
        snapshot.status === 'interrupted'
      ) {
        throw new HttpException(
          {
            statusCode: 409,
            code: 'WORKER_RECOVERY_REQUIRED',
            message: 'The replacement assignment requires recovery',
            previousAttemptId: control.attemptId,
          },
          409,
        );
      }
      const current = await this.transactions.run(async (session) =>
        this.coordinator.current(
          {
            jobId: snapshot._id.toHexString(),
            attemptId: control.attemptId!,
            sessionId,
            generation: control.generation,
          },
          session,
          true,
          identity,
        ),
      );
      return this.coordinator.assignment(current.job, identity);
    }
    if (
      control?.attemptId !== previousAttemptId ||
      snapshot.attemptId !== previousAttemptId
    )
      throw jobError('STALE_ATTEMPT');
    // Fence the old assignment before storage I/O, even if a reboot occurs before lease expiry.
    await this.transactions.run(async (session) => {
      const { job } = await this.coordinator.current(
        {
          jobId: snapshot._id.toHexString(),
          attemptId: previousAttemptId,
          sessionId: snapshot.sessionId!,
          generation: snapshot.generation,
        },
        session,
        false,
        identity,
      );
      job.set({
        status:
          job.status === 'cancel_requested'
            ? 'cancel_requested'
            : 'interrupted',
        leaseExpiresAt: new Date(0),
        revision: job.revision + 1,
      });
      await job.save({ session });
      await this.workers.updateOne(
        { _id: control._id },
        { $set: { leaseExpiresAt: new Date(0) } },
        { session },
      );
    });
    await this.markExpired(control._id);
    const object =
      snapshot.status !== 'cancel_requested' && snapshot.outputReservation
        ? await processingIo(async () => {
            try {
              return await this.storage.findOutput(snapshot);
            } catch (error) {
              if (
                error instanceof HttpException &&
                (error.getResponse() as { code?: string }).code ===
                  'UPLOAD_NOT_READY'
              )
                return null;
              throw error;
            }
          })
        : null;
    const result = await this.transactions.run(async (session) => {
      const { job, control, state } = await this.coordinator.current(
        {
          jobId: snapshot._id.toHexString(),
          attemptId: previousAttemptId,
          sessionId: snapshot.sessionId!,
          generation: snapshot.generation,
        },
        session,
        false,
        identity,
      );
      if (job.status === 'cancel_requested') {
        await this.terminal.finalize(job, 'cancelled', session);
        return { jobId: job._id.toHexString(), status: 'cancelled' as const };
      }
      if (object) {
        await this.terminal.finalize(job, 'ready', session, object);
        return { jobId: job._id.toHexString(), status: 'ready' as const };
      }
      if (state === 'draining') {
        const now = new Date();
        await this.attempts.updateOne(
          { attemptId: previousAttemptId },
          {
            $set: { endedAt: now, releasedAt: now, outcome: 'interrupted' },
          },
          { session },
        );
        const released = await this.workers.updateOne(
          {
            _id: control._id,
            activeJobId: job._id,
            attemptId: previousAttemptId,
            generation: job.generation,
            sessionId: job.sessionId,
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
        job.set({
          status: 'queued',
          workerId: null,
          attemptId: null,
          sessionId: null,
          generation: 0,
          leaseExpiresAt: null,
          outputReservation: null,
          revision: job.revision + 1,
        });
        await job.save({ session });
        return { status: 'released' as const, previousAttemptId };
      }
      const next = await this.coordinator.assign(
        job,
        control,
        sessionId,
        session,
        identity,
        previous.admissionEvidence ?? undefined,
      );
      await this.attempts.updateOne(
        { attemptId: previousAttemptId },
        {
          $set: {
            endedAt: new Date(),
            outcome: 'interrupted',
            replacementAttemptId: next.attemptId,
          },
        },
        { session },
      );
      return next;
    });
    return 'jobId' in result || 'previousAttemptId' in result
      ? result
      : this.coordinator.assignment(result, identity);
  }
}
