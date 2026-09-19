import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { isUUID } from 'class-validator';
import {
  trusted,
  type ClientSession,
  type Connection,
  type Model,
} from 'mongoose';
import { Job } from '../../jobs/job.schema.js';
import type { JobFailureCode, ObjectIdentity } from '../../jobs/job.types.js';
import { NotificationOutbox } from '../../notifications/notification-outbox.schema.js';
import { ProcessingUsageService } from '../../processing-usage/processing-usage.service.js';
import { StorageCleanupService } from '../../storage/storage-cleanup.service.js';
import { StorageTransfersService } from '../../storage/storage-transfers.service.js';
import { AccountAccessService } from '../../users/account-access.service.js';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import {
  WorkerAttempt,
  type WorkerOutputReservation,
} from '../jobs/worker-attempt.schema.js';
import { WorkerSlot } from '../machines/worker-slot.schema.js';
import { WorkerFleetPolicy } from '../policy/worker-fleet-policy.schema.js';
import { sanitizeWorkerDiagnosticLine } from '../telemetry/worker-diagnostic-sanitizer.js';
import { workerError } from '../worker-errors.js';
import type {
  CompleteWorkerAttemptDto,
  FailWorkerAttemptDto,
  WorkerAttemptOwnershipDto,
  WorkerOutputGrantDto,
} from './worker-attempt.dto.js';

const ACTIVE_ATTEMPTS = ['claimed', 'running', 'uploading'] as const;
const ACTIVE_JOB_STATUSES = ['processing', 'uploading_result'] as const;
const RETRYABLE_FAILURES = new Set<JobFailureCode>([
  'SEPARATOR_FAILED',
  'DOWNLOAD_FAILED',
  'OUTPUT_UPLOAD_FAILED',
]);
const SAFE_FAILURE_MESSAGES: Record<JobFailureCode, string> = {
  UPLOAD_EXPIRED: 'The upload expired',
  INVALID_AUDIO: 'The uploaded audio is invalid',
  INPUT_TOO_LONG: 'The audio exceeds processing limits',
  INPUT_CHECKSUM_MISMATCH: 'The uploaded audio could not be verified',
  SEPARATOR_FAILED: 'Audio separation failed',
  OUTPUT_INVALID: 'The processed audio is invalid',
  DOWNLOAD_FAILED: 'The processing input could not be downloaded',
  OUTPUT_UPLOAD_FAILED: 'The processed audio could not be uploaded',
};

@Injectable()
export class WorkerAttemptService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(WorkerAttempt.name)
    private readonly attempts: Model<WorkerAttempt>,
    @InjectModel(WorkerSlot.name)
    private readonly slots: Model<WorkerSlot>,
    @InjectModel(WorkerFleetPolicy.name)
    private readonly policies: Model<WorkerFleetPolicy>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly storage: StorageTransfersService,
    private readonly cleanup: StorageCleanupService,
    private readonly accountAccess: AccountAccessService,
    private readonly usage: ProcessingUsageService,
  ) {}

  private get outbox() {
    return this.jobs.db.model<NotificationOutbox>(NotificationOutbox.name);
  }

  async inputGrant(
    principal: WorkerPrincipal,
    attemptId: string,
    dto: WorkerAttemptOwnershipDto,
  ) {
    const first = await this.loadCurrent(principal, attemptId, dto);
    if (!first.job.inputObject)
      throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    const grant = await this.storage.createDownloadGrant(first.job.inputObject);
    const current = await this.loadCurrent(principal, attemptId, dto);
    if (
      !current.job.inputObject ||
      !sameObject(first.job.inputObject, current.job.inputObject)
    )
      throw workerError('WORKER_CONFLICT');
    await this.accountAccess.assertActive(current.job.userId);
    return {
      requestId: dto.requestId,
      attemptId,
      object: current.job.inputObject,
      grant,
    };
  }

  async outputGrant(
    principal: WorkerPrincipal,
    attemptId: string,
    dto: WorkerOutputGrantDto,
  ) {
    const first = await this.loadCurrent(principal, attemptId, dto);
    const reservation = this.outputReservation(first.job, first.attempt, dto);
    this.assertReservation(first.attempt.outputReservation, reservation);
    const grant = await this.storage.createWorkerOutputGrant(
      reservation,
      first.attempt.deadlineAt,
    );
    const grantExpiresAt = new Date(grant.expiresAt);
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const { attempt, job } = await this.loadCurrent(
          principal,
          attemptId,
          dto,
          session,
        );
        this.assertReservation(attempt.outputReservation, reservation);
        await this.accountAccess.assertActive(job.userId, session);
        await this.usage.reconcileMeasured(
          job,
          dto.measuredDurationSeconds,
          session,
        );
        const attemptFence = await this.attempts.updateOne(
          { _id: attempt._id, revision: attempt.revision },
          {
            $set: {
              state: 'uploading',
              stage: 'uploading',
              outputReservation: { ...reservation, grantExpiresAt },
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (attemptFence.modifiedCount !== 1)
          throw workerError('WORKER_CONFLICT');
        const now = new Date();
        const jobFence = await this.jobs.updateOne(
          this.jobOwnershipFilter(job, attempt, now),
          {
            $set: {
              status: 'uploading_result',
              measuredDurationSeconds: dto.measuredDurationSeconds,
              processingFinishedAt: job.processingFinishedAt ?? now,
              uploadingResultAt: job.uploadingResultAt ?? now,
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (jobFence.modifiedCount !== 1) throw workerError('WORKER_CONFLICT');
        await this.cleanup.schedule(
          {
            key: reservation.key,
            ownerUserId: job.userId,
            reason: 'AUDIO_OUTPUT_ORPHANED',
            nextAt: attempt.deadlineAt,
            settleUntil: new Date(attempt.deadlineAt.getTime() + 300_000),
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return {
      requestId: dto.requestId,
      attemptId,
      reservation: {
        key: reservation.key,
        bytes: reservation.bytes,
        sha256: reservation.sha256,
        contentType: reservation.contentType,
        measuredDurationSeconds: reservation.measuredDurationSeconds,
      },
      grant,
    };
  }

  async complete(
    principal: WorkerPrincipal,
    attemptId: string,
    dto: CompleteWorkerAttemptDto,
  ) {
    const first = await this.loadAttemptAndJob(principal, attemptId, dto);
    this.assertRecipe(first.job, dto);
    if (first.attempt.state === 'succeeded')
      return this.presentCompletion(first.attempt, dto.versionId, true);
    this.assertCurrent(first.attempt, first.job, new Date());
    const reservation = first.attempt.outputReservation;
    if (!reservation) throw workerError('WORKER_CONFLICT');
    const object = await this.storage.verifyUploadedVersion(
      reservation,
      dto.versionId,
    );
    const session = await this.connection.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const current = await this.loadAttemptAndJob(
          principal,
          attemptId,
          dto,
          session,
        );
        this.assertRecipe(current.job, dto);
        if (current.attempt.state === 'succeeded')
          return this.presentCompletion(current.attempt, dto.versionId, true);
        const now = new Date();
        this.assertCurrent(current.attempt, current.job, now);
        this.assertReservation(current.attempt.outputReservation, reservation);
        if (!sameReservationObject(reservation, object))
          throw workerError('WORKER_CONFLICT');
        await this.accountAccess.assertActive(current.job.userId, session);
        const attemptFence = await this.attempts.updateOne(
          {
            _id: current.attempt._id,
            revision: current.attempt.revision,
            state: trusted({ $in: ACTIVE_ATTEMPTS }),
          },
          {
            $set: {
              state: 'succeeded',
              stage: 'finalizing',
              outputObject: object,
              terminalCode: null,
              terminalSummary: null,
              finishedAt: now,
              leaseExpiresAt: now,
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (attemptFence.modifiedCount !== 1)
          throw workerError('WORKER_CONFLICT');
        const job = await this.jobs
          .findOneAndUpdate(
            this.jobOwnershipFilter(current.job, current.attempt, now),
            {
              $set: {
                status: 'ready',
                outputObject: object,
                currentExecution: null,
                finishedAt: now,
                retryEligibility: {
                  eligible: false,
                  attemptsRemaining: 0,
                  nextAttemptAt: null,
                },
              },
              $inc: { revision: 1 },
            },
            { session, runValidators: true, returnDocument: 'after' },
          )
          .lean();
        if (!job) throw workerError('WORKER_CONFLICT');
        await this.releaseSlot(current.attempt, now, session);
        await this.usage.settleJob(job, session);
        await this.enqueueNotification(job, 'ready', now, session);
        await this.cleanup.cancelScheduled(reservation.key, session);
        return {
          attemptId,
          jobId: job._id.toHexString(),
          status: 'ready',
          replayed: false,
        };
      });
      if (!result) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
      return result;
    } finally {
      await session.endSession();
    }
  }

  async fail(
    principal: WorkerPrincipal,
    attemptId: string,
    dto: FailWorkerAttemptDto,
  ) {
    const terminalSummary = sanitizeWorkerDiagnosticLine(dto.summary);
    const session = await this.connection.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const current = await this.loadAttemptAndJob(
          principal,
          attemptId,
          dto,
          session,
        );
        if (current.attempt.state === 'failed') {
          if (
            current.attempt.terminalCode !== dto.code ||
            current.attempt.terminalSummary !== terminalSummary
          )
            throw workerError('WORKER_CONFLICT');
          return {
            attemptId,
            jobId: current.job._id.toHexString(),
            status: current.job.status,
            replayed: true,
          };
        }
        const now = new Date();
        this.assertCurrent(current.attempt, current.job, now);
        await this.accountAccess.assertActive(current.job.userId, session);
        const policy = await this.policies
          .findById('worker-fleet')
          .session(session)
          .lean();
        if (!policy) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
        const retry =
          RETRYABLE_FAILURES.has(dto.code) &&
          current.job.retryEligibility?.eligible === true &&
          current.job.retryEligibility.attemptsRemaining > 1 &&
          current.attempt.attemptNumber < policy.maxAttempts;
        const attemptFence = await this.attempts.updateOne(
          {
            _id: current.attempt._id,
            revision: current.attempt.revision,
            state: trusted({ $in: ACTIVE_ATTEMPTS }),
          },
          {
            $set: {
              state: 'failed',
              terminalCode: dto.code,
              terminalSummary,
              finishedAt: now,
              leaseExpiresAt: now,
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true },
        );
        if (attemptFence.modifiedCount !== 1)
          throw workerError('WORKER_CONFLICT');
        const nextAttemptAt = retry
          ? new Date(
              now.getTime() +
                Math.min(
                  60_000,
                  5_000 * 2 ** (current.attempt.attemptNumber - 1),
                ),
            )
          : null;
        const job = await this.jobs
          .findOneAndUpdate(
            this.jobOwnershipFilter(current.job, current.attempt, now),
            {
              $set: {
                status: retry ? 'queued' : 'failed',
                currentExecution: null,
                retryEligibility: {
                  eligible: retry,
                  attemptsRemaining: Math.max(
                    0,
                    (current.job.retryEligibility?.attemptsRemaining ?? 1) - 1,
                  ),
                  nextAttemptAt,
                },
                lastError: {
                  code: dto.code,
                  message: SAFE_FAILURE_MESSAGES[dto.code],
                  at: now,
                },
                ...(retry
                  ? { queuedAt: now, finishedAt: null }
                  : { finishedAt: now }),
              },
              $inc: { revision: 1 },
            },
            { session, runValidators: true, returnDocument: 'after' },
          )
          .lean();
        if (!job) throw workerError('WORKER_CONFLICT');
        await this.releaseSlot(current.attempt, now, session);
        if (!retry) {
          await this.usage.settleJob(job, session);
          await this.enqueueNotification(job, 'failed', now, session);
        }
        return {
          attemptId,
          jobId: job._id.toHexString(),
          status: job.status,
          replayed: false,
        };
      });
      if (!result) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
      return result;
    } finally {
      await session.endSession();
    }
  }

  private async loadCurrent(
    principal: WorkerPrincipal,
    attemptId: string,
    dto: WorkerAttemptOwnershipDto,
    session?: ClientSession,
  ) {
    const current = await this.loadAttemptAndJob(
      principal,
      attemptId,
      dto,
      session,
    );
    this.assertCurrent(current.attempt, current.job, new Date());
    return current;
  }

  private async loadAttemptAndJob(
    principal: WorkerPrincipal,
    attemptId: string,
    dto: WorkerAttemptOwnershipDto,
    session?: ClientSession,
  ) {
    if (principal.kind !== 'machine' || !isUUID(attemptId, '4'))
      throw workerError('WORKER_UNAUTHENTICATED');
    const attemptQuery = this.attempts.findById(attemptId);
    if (session) attemptQuery.session(session);
    const attempt = await attemptQuery.lean();
    if (
      !attempt ||
      attempt.machineId !== principal.subjectId ||
      attempt.workerId !== dto.workerId ||
      attempt.sessionId !== dto.sessionId ||
      attempt.incarnation !== dto.incarnation
    )
      throw workerError('WORKER_CONFLICT');
    const jobQuery = this.jobs.findById(attempt.jobId);
    if (session) jobQuery.session(session);
    const job = await jobQuery.lean();
    if (!job) throw workerError('WORKER_CONFLICT');
    return { attempt, job };
  }

  private assertCurrent(attempt: WorkerAttempt, job: Job, now: Date): void {
    if (
      !ACTIVE_ATTEMPTS.some((state) => state === attempt.state) ||
      attempt.leaseExpiresAt <= now ||
      attempt.deadlineAt <= now ||
      job.deletedAt ||
      ['cancel_requested', 'cancelled'].includes(job.status) ||
      job.currentExecution?.attemptId !== attempt._id ||
      job.currentExecution.machineId !== attempt.machineId ||
      job.currentExecution.workerId !== attempt.workerId ||
      job.currentExecution.sessionId !== attempt.sessionId ||
      job.currentExecution.incarnation !== attempt.incarnation ||
      job.currentExecution.leaseExpiresAt <= now ||
      job.currentExecution.deadlineAt <= now
    )
      throw workerError('WORKER_CONFLICT');
  }

  private outputReservation(
    job: Job,
    attempt: WorkerAttempt,
    dto: WorkerOutputGrantDto,
  ): WorkerOutputReservation {
    return {
      key: `users/${job.userId.toHexString()}/jobs/${job._id.toHexString()}/attempts/${attempt._id}/vocals.mp3`,
      bytes: dto.bytes,
      sha256: dto.sha256,
      contentType: dto.contentType,
      measuredDurationSeconds: dto.measuredDurationSeconds,
      grantExpiresAt: attempt.deadlineAt,
    };
  }

  private assertReservation(
    existing: WorkerOutputReservation | null,
    expected: WorkerOutputReservation,
  ): void {
    if (
      existing &&
      (existing.key !== expected.key ||
        existing.bytes !== expected.bytes ||
        existing.sha256 !== expected.sha256 ||
        existing.contentType !== expected.contentType ||
        existing.measuredDurationSeconds !== expected.measuredDurationSeconds)
    )
      throw workerError('WORKER_CONFLICT');
  }

  private assertRecipe(job: Job, dto: CompleteWorkerAttemptDto): void {
    const recipe = job.recipeSnapshot;
    if (
      !recipe ||
      recipe.recipeId !== dto.recipeId ||
      recipe.recipeRevision !== dto.recipeRevision ||
      recipe.modelDigest !== dto.modelDigest ||
      recipe.trimEnabled !== dto.trimEnabled ||
      recipe.denoiseEnabled !== dto.denoiseEnabled ||
      recipe.outputFormat !== dto.outputFormat ||
      recipe.outputBitrateKbps !== dto.outputBitrateKbps
    )
      throw workerError('WORKER_CONFLICT');
  }

  private jobOwnershipFilter(job: Job, attempt: WorkerAttempt, now: Date) {
    return {
      _id: job._id,
      revision: job.revision,
      status: trusted({ $in: ACTIVE_JOB_STATUSES }),
      deletedAt: null,
      'currentExecution.attemptId': attempt._id,
      'currentExecution.machineId': attempt.machineId,
      'currentExecution.workerId': attempt.workerId,
      'currentExecution.sessionId': attempt.sessionId,
      'currentExecution.incarnation': attempt.incarnation,
      'currentExecution.leaseExpiresAt': trusted({ $gt: now }),
      'currentExecution.deadlineAt': trusted({ $gt: now }),
    };
  }

  private async releaseSlot(
    attempt: WorkerAttempt,
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    const released = await this.slots.updateOne(
      {
        _id: attempt.workerId,
        machineId: attempt.machineId,
        sessionId: attempt.sessionId,
        incarnation: attempt.incarnation,
        currentAttemptId: attempt._id,
      },
      {
        $set: { state: 'idle', currentAttemptId: null, lastSeenAt: now },
        $inc: { revision: 1 },
      },
      { session, runValidators: true },
    );
    if (released.modifiedCount !== 1) throw workerError('WORKER_CONFLICT');
  }

  private async enqueueNotification(
    job: Job,
    outcome: 'ready' | 'failed',
    now: Date,
    session: ClientSession,
  ): Promise<void> {
    await this.outbox.updateOne(
      { jobId: job._id, outcome },
      {
        $setOnInsert: {
          jobId: job._id,
          userId: job.userId,
          outcome,
          state: 'pending',
          nextAttemptAt: now,
          leaseId: null,
          leaseExpiresAt: null,
          targetSnapshotAt: null,
          targetThroughId: null,
          targetCursor: null,
          targetsFrozenAt: null,
          completedAt: null,
          revision: 0,
        },
      },
      { session, upsert: true, setDefaultsOnInsert: false },
    );
  }

  private presentCompletion(
    attempt: WorkerAttempt,
    versionId: string,
    replayed: boolean,
  ) {
    if (!attempt.outputObject || attempt.outputObject.versionId !== versionId)
      throw workerError('WORKER_CONFLICT');
    return {
      attemptId: attempt._id,
      jobId: attempt.jobId.toHexString(),
      status: 'ready',
      replayed,
    };
  }
}

function sameObject(left: ObjectIdentity, right: ObjectIdentity): boolean {
  return (
    left.key === right.key &&
    left.versionId === right.versionId &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.contentType === right.contentType
  );
}

function sameReservationObject(
  reservation: WorkerOutputReservation,
  object: ObjectIdentity,
): boolean {
  return (
    reservation.key === object.key &&
    reservation.bytes === object.bytes &&
    reservation.sha256 === object.sha256 &&
    reservation.contentType === object.contentType
  );
}
