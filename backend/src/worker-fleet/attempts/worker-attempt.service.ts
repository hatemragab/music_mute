import { measureTransferOperation } from './transfer-timing.js';
import { withAttemptMeasurements } from '../../jobs/job-stage-timing.js';
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
import { resolveJobFailure } from '../../jobs/job-lifecycle-policy.js';
import type { ObjectIdentity } from '../../jobs/job.types.js';
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
import { sanitizeWorkerDiagnosticLine } from '../telemetry/worker-diagnostic-sanitizer.js';
import { workerError } from '../worker-errors.js';
import type {
  CompleteWorkerAttemptDto,
  FailWorkerAttemptDto,
  WorkerAttemptOwnershipDto,
  WorkerOutputGrantDto,
  UpdateWorkerAttemptProgressDto,
} from './worker-attempt.dto.js';

const ACTIVE_ATTEMPTS = ['claimed', 'running', 'uploading'] as const;
const ACTIVE_JOB_STATUSES = ['processing', 'uploading_result'] as const;
@Injectable()
export class WorkerAttemptService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(WorkerAttempt.name)
    private readonly attempts: Model<WorkerAttempt>,
    @InjectModel(WorkerSlot.name)
    private readonly slots: Model<WorkerSlot>,
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
    if (!(await this.storage.isPinnedObjectAvailable(first.job.inputObject)))
      throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    const session = await this.connection.startSession();
    let entitlement: { expiresAt: Date };
    try {
      const reserved = await session.withTransaction(async () => {
        const current = await this.loadCurrent(
          principal,
          attemptId,
          dto,
          session,
        );
        if (
          !current.job.inputObject ||
          !sameObject(first.job.inputObject!, current.job.inputObject)
        )
          throw workerError('WORKER_CONFLICT');
        await this.accountAccess.assertActive(current.job.userId, session);
        return this.usage.reserveDownloadGrant(
          {
            accountId: current.job.userId,
            jobId: current.job._id,
            scope: 'worker_input',
            requestId: dto.requestId,
            attemptId,
            object: current.job.inputObject,
          },
          session,
        );
      });
      if (!reserved) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
      entitlement = reserved;
    } finally {
      await session.endSession();
    }
    const grant = await this.storage.createDownloadGrant(
      first.job.inputObject,
      entitlement.expiresAt,
    );
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

  async progress(
    principal: WorkerPrincipal,
    attemptId: string,
    dto: UpdateWorkerAttemptProgressDto,
  ) {
    if (dto.phase !== 'separating' && dto.phasePercent !== null)
      throw workerError('WORKER_INVALID_REQUEST');
    const current = await this.loadCurrent(principal, attemptId, dto);
    if (!ACTIVE_JOB_STATUSES.some((status) => status === current.job.status))
      throw workerError('WORKER_CONFLICT');
    const existing = current.job.workerProgress;
    if (existing?.attemptId === attemptId && existing.sequence >= dto.sequence)
      return {
        requestId: dto.requestId,
        attemptId,
        accepted: false,
        sequence: existing.sequence,
      };
    const now = new Date();
    const result = await this.jobs.updateOne(
      {
        ...this.jobOwnershipFilter(current.job, current.attempt, now, false),
        $or: [
          { workerProgress: null },
          {
            'workerProgress.attemptId': attemptId,
            'workerProgress.sequence': trusted({ $lt: dto.sequence }),
          },
        ],
      },
      {
        $set: {
          stageTimingAttempts: withAttemptMeasurements(
            current.job,
            attemptId,
            current.attempt.attemptNumber,
            dto.executionTimings,
          ),
          workerProgress: {
            attemptId,
            sequence: dto.sequence,
            phase: dto.phase,
            phasePercent: dto.phasePercent,
            observedAt: now,
          },
        },
      },
      { runValidators: true },
    );
    if (result.modifiedCount !== 1) {
      const latest = await this.loadCurrent(principal, attemptId, dto);
      if (
        latest.job.workerProgress?.attemptId !== attemptId ||
        latest.job.workerProgress.sequence < dto.sequence
      )
        throw workerError('WORKER_CONFLICT');
      return {
        requestId: dto.requestId,
        attemptId,
        accepted: false,
        sequence: latest.job.workerProgress.sequence,
      };
    }
    return {
      requestId: dto.requestId,
      attemptId,
      accepted: true,
      sequence: dto.sequence,
    };
  }

  async outputGrant(
    principal: WorkerPrincipal,
    attemptId: string,
    dto: WorkerOutputGrantDto,
  ) {
    return measureTransferOperation('output_grant', attemptId, () =>
      this.issueOutputGrant(principal, attemptId, dto),
    );
  }

  private async issueOutputGrant(
    principal: WorkerPrincipal,
    attemptId: string,
    dto: WorkerOutputGrantDto,
  ) {
    const first = await this.loadCurrent(principal, attemptId, dto);
    const reservation = this.outputReservation(first.job, first.attempt, dto);
    this.assertReservation(first.attempt.outputReservation, reservation);
    if (first.attempt.outputReservation) {
      const object = await this.storage.findUploadedVersion(reservation);
      if (object) {
        await this.accountAccess.assertActive(first.job.userId);
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
          grant: null,
          object,
        };
      }
    }
    const grant = await measureTransferOperation(
      'output_grant_signing',
      attemptId,
      () =>
        this.storage.createWorkerOutputGrant(
          reservation,
          first.attempt.deadlineAt,
        ),
    );
    const grantExpiresAt = new Date(grant.expiresAt);
    const session = await this.connection.startSession();
    try {
      await measureTransferOperation(
        'output_grant_transaction',
        attemptId,
        () =>
          session.withTransaction(async () => {
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
            if (jobFence.modifiedCount !== 1)
              throw workerError('WORKER_CONFLICT');
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
          }),
      );
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
      object: null,
    };
  }

  async complete(
    principal: WorkerPrincipal,
    attemptId: string,
    dto: CompleteWorkerAttemptDto,
  ) {
    return measureTransferOperation('completion', attemptId, () =>
      this.completeMeasured(principal, attemptId, dto),
    );
  }

  private async completeMeasured(
    principal: WorkerPrincipal,
    attemptId: string,
    dto: CompleteWorkerAttemptDto,
  ) {
    const completionStarted = performance.now();
    const first = await this.loadAttemptAndJob(principal, attemptId, dto);
    this.assertRecipe(first.job, dto);
    if (first.attempt.state === 'succeeded')
      return this.presentCompletion(first.attempt, dto, true);
    this.assertCurrent(first.attempt, first.job, new Date());
    const reservation = first.attempt.outputReservation;
    if (!reservation) throw workerError('WORKER_CONFLICT');
    const object = await measureTransferOperation(
      'completion_storage_verification',
      attemptId,
      () => this.storage.verifyUploadedVersion(reservation, dto.versionId),
    );
    const session = await this.connection.startSession();
    try {
      const result = await measureTransferOperation(
        'completion_transaction',
        attemptId,
        () =>
          session.withTransaction(async () => {
            const current = await this.loadAttemptAndJob(
              principal,
              attemptId,
              dto,
              session,
            );
            this.assertRecipe(current.job, dto);
            if (current.attempt.state === 'succeeded')
              return this.presentCompletion(current.attempt, dto, true);
            const now = new Date();
            this.assertCurrent(current.attempt, current.job, now);
            this.assertReservation(
              current.attempt.outputReservation,
              reservation,
            );
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
                  failureClass: null,
                  terminalSummary: null,
                  finishedAt: now,
                  leaseExpiresAt: now,
                  processingStageTimings: dto.stageTimings,
                },
                $inc: { revision: 1 },
              },
              { session, runValidators: true },
            );
            if (attemptFence.modifiedCount !== 1)
              throw workerError('WORKER_CONFLICT');
            await this.usage.recordRetainedOutput(
              current.job,
              object.bytes,
              session,
            );
            const readyAt = new Date();
            const finalizationMs = Math.round(
              performance.now() - completionStarted,
            );
            const job = await this.jobs
              .findOneAndUpdate(
                this.jobOwnershipFilter(current.job, current.attempt, readyAt),
                {
                  $set: {
                    status: 'ready',
                    outputObject: object,
                    retainedOutputAccountedAt: readyAt,
                    retainedOutputReleasedAt: null,
                    currentExecution: null,
                    workerProgress: null,
                    finishedAt: readyAt,
                    workerStageTimings: dto.stageTimings,
                    stageTimingAttempts: withAttemptMeasurements(
                      current.job,
                      attemptId,
                      current.attempt.attemptNumber,
                      dto.executionTimings?.map((timing) =>
                        timing.stage === 'completion'
                          ? {
                              stage: 'completion',
                              durationMs: finalizationMs,
                              complete: true,
                            }
                          : timing,
                      ),
                    ),
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
          }),
      );
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
        const maxAttempts =
          current.job.admissionSnapshot?.maxInfrastructureAttempts;
        if (!maxAttempts) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
        const failure = resolveJobFailure(dto.code, {
          retryEligible: current.job.retryEligibility?.eligible === true,
          attemptsRemaining:
            current.job.retryEligibility?.attemptsRemaining ?? 0,
          attemptNumber: current.attempt.attemptNumber,
          maxAttempts,
        });
        const retry = failure.automaticRetry;
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
              failureClass: failure.classification,
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
                stageTimingAttempts: withAttemptMeasurements(
                  current.job,
                  attemptId,
                  current.attempt.attemptNumber,
                  dto.executionTimings,
                ),
                status: retry ? 'queued' : 'failed',
                currentExecution: null,
                workerProgress: null,
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
                  message: failure.publicMessage!,
                  at: now,
                },
                ...(retry
                  ? {
                      queuedAt: now,
                      queueTimingStartedAt: current.job.serverTimingStartedAt
                        ? now
                        : null,
                      finishedAt: null,
                    }
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
      recipe.recipeDigest !== dto.recipeDigest ||
      recipe.modelDigest !== dto.modelDigest ||
      recipe.trimEnabled !== dto.trimEnabled ||
      recipe.denoiseEnabled !== dto.denoiseEnabled ||
      recipe.outputFormat !== dto.outputFormat ||
      dto.outputBitrateKbps > recipe.outputBitrateKbps
    )
      throw workerError('WORKER_CONFLICT');
  }

  private jobOwnershipFilter(
    job: Job,
    attempt: WorkerAttempt,
    now: Date,
    withRevision = true,
  ) {
    return {
      _id: job._id,
      ...(withRevision ? { revision: job.revision } : {}),
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
    dto: CompleteWorkerAttemptDto,
    replayed: boolean,
  ) {
    if (
      !attempt.outputObject ||
      attempt.outputObject.versionId !== dto.versionId ||
      JSON.stringify(attempt.processingStageTimings) !==
        JSON.stringify(dto.stageTimings)
    )
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
