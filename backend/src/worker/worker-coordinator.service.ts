import { WorkerReadinessService } from './worker-readiness.service.js';
import { FairQueueService } from '../processing-queue/fair-queue.service.js';
import { QueueExecutionUsage } from '../processing-queue/queue-scheduling.schema.js';
import {
  assertExecutionEvidence,
  type AttemptExecutionEvidence,
} from './execution-evidence.js';
import { QueueCapacityService } from '../processing-queue/queue-capacity.service.js';
import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { ProcessingUsageLedger } from '../processing-usage/processing-usage.schema.js';
import { HttpException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { ClientSession, HydratedDocument, Model } from 'mongoose';
import { isUUID } from 'class-validator';
import { authError } from '../auth/auth.errors.js';
import { Job } from '../jobs/job.schema.js';
import {
  JobAttempt,
  type ClaimAdmissionEvidence,
} from '../jobs/job-attempt.schema.js';
import { JobReceipt } from '../jobs/job-receipt.schema.js';
import { jobError } from '../jobs/job-errors.js';
import { assertMeasuredDuration } from '../jobs/job-state.js';
import { objectId, requestHash } from '../jobs/job-request.js';
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

  async claim(
    sessionId: string,
    identity?: WorkerIdentity,
    mediaPolicyVersion?: 2,
    recoveryOnly = false,
  ) {
    if (!isUUID(sessionId, '4')) throw authError('INVALID_INPUT');
    sessionId = sessionId.toLowerCase();
    if (mediaPolicyVersion !== 2)
      await this.transactions.run(async (session) => {
        const { control } = await this.authority(identity, session);
        await this.workers.updateOne(
          { _id: control._id },
          { $set: { mediaPolicyVersion: null, mediaCapabilitySeenAt: null } },
          { session },
        );
      });
    const job = await this.transactions.run(async (session) => {
      const {
        control,
        state,
        identity: owner,
      } = await this.authority(identity, session);
      if (mediaPolicyVersion === 2) {
        control.mediaPolicyVersion = 2;
        control.mediaCapabilitySeenAt = new Date();
        await this.workers.updateOne(
          { _id: control._id },
          {
            $set: {
              mediaPolicyVersion: 2,
              mediaCapabilitySeenAt: control.mediaCapabilitySeenAt,
            },
          },
          { session },
        );
      }
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
        if (
          current.admissionSnapshot?.policyVersion === 2 &&
          mediaPolicyVersion !== 2
        )
          throw jobError('WORKER_RECOVERY_REQUIRED');
        return current;
      }
      // Discovery after a lost claim response must never reserve fresh work.
      if (recoveryOnly) return null;
      const readiness = await new WorkerReadinessService(
        this.jobs.db,
      ).evaluateNewClaim(owner.workerId, session);
      if (!readiness.allowed)
        throw new HttpException(
          {
            code: readiness.reasonCodes[0],
            reasonCodes: readiness.reasonCodes,
            message: 'Worker is not eligible for a new assignment',
          },
          409,
        );
      const next =
        state === 'draining'
          ? null
          : await new FairQueueService(this.jobs).selectNextEligible(
              new Date(),
              session,
              mediaPolicyVersion,
              readiness,
            );
      if (!next) {
        await this.workers.updateOne(
          { _id: control._id },
          { $set: { lastSeenAt: new Date() } },
          { session },
        );
        return null;
      }
      return this.assign(
        next,
        control,
        sessionId,
        session,
        identity,
        readiness,
      );
    });
    return job ? this.assignment(job, identity, mediaPolicyVersion) : null;
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
      executionEvidence?: AttemptExecutionEvidence;
    },
    identity?: WorkerIdentity,
  ) {
    if (
      report.stage !== 'processing' ||
      report.decodable !== true ||
      report.hasAudio !== true ||
      !Number.isFinite(report.durationSeconds) ||
      report.durationSeconds <= 0 ||
      report.durationSeconds > 1800
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
      const admittedAttempt = await this.attempts
        .findOne({ attemptId: job.attemptId })
        .session(session)
        .lean();
      if (
        admittedAttempt?.admissionEvidence &&
        report.durationSeconds >
          admittedAttempt.admissionEvidence.maxDurationSeconds
      )
        throw jobError('MEDIA_TOO_LONG');
      await this.accountAccess.assertActive(job.userId, session);
      if (job.admissionSnapshot?.policyVersion === 2) {
        if (
          report.durationSeconds >
          (job.admissionSnapshot.maxDurationSeconds ?? 0)
        )
          throw jobError('MEDIA_TOO_LONG');
      } else
        assertMeasuredDuration(
          report.durationSeconds,
          job.admissionSnapshot?.maxDurationSecondsExclusive ?? 600,
        );
      await new QueueCapacityService(this.jobs).assertCapacity(
        report.durationSeconds,
        session,
        job._id,
        job.admissionSnapshot ?? undefined,
      );
      await new ProcessingUsageService(
        this.jobs.db.model<ProcessingUsageLedger>(ProcessingUsageLedger.name),
        this.jobs,
      ).reconcileMeasured(job, report.durationSeconds, session);
      if (!['validating', 'processing'].includes(job.status))
        throw jobError('JOB_STATE_CONFLICT');
      if (
        report.executionEvidence &&
        report.executionEvidence.measuredAudioSeconds !== report.durationSeconds
      )
        throw jobError('JOB_STATE_CONFLICT');
      if (report.executionEvidence)
        await this.recordExecution(
          job,
          selector.eventId,
          report.executionEvidence,
          session,
        );
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
    admissionEvidence?: ClaimAdmissionEvidence,
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
    if (
      await new FairQueueService(this.jobs).ownerIsRunning(
        job.userId,
        session,
        job._id,
      )
    )
      throw jobError('PROCESSING_LIMIT_REACHED');
    if (
      job.admissionSnapshot?.policyVersion === 2 &&
      control.mediaPolicyVersion !== 2
    )
      throw jobError('PROCESSING_CAPACITY_UNAVAILABLE');
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
          admissionEvidence,
        },
      ],
      { session },
    );
    await this.jobs.db
      .model<QueueExecutionUsage>(QueueExecutionUsage.name)
      .create(
        [
          {
            _id: attemptId,
            userId: job.userId,
            executionSeconds: null,
            expiresAt: new Date(now.getTime() + 86400_000),
          },
        ],
        { session },
      );
    return job;
  }

  async assignment(
    job: Job,
    identity?: WorkerIdentity,
    mediaPolicyVersion?: 2,
  ) {
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
      ...(mediaPolicyVersion === 2 || job.admissionSnapshot?.policyVersion === 2
        ? {
            processingLimits: {
              policyVersion: job.admissionSnapshot?.policyVersion ?? 1,
              maxDurationSeconds:
                job.admissionSnapshot?.policyVersion === 2
                  ? job.admissionSnapshot.maxDurationSeconds
                  : (job.admissionSnapshot?.maxDurationSecondsExclusive ?? 600),
              durationInclusive: job.admissionSnapshot?.policyVersion === 2,
              maxInputBytes:
                job.admissionSnapshot?.policyVersion === 2
                  ? job.admissionSnapshot.maxInputBytes
                  : (job.admissionSnapshot?.maxInputBytesExclusive ??
                    30_000_000),
              inputBytesInclusive: job.admissionSnapshot?.policyVersion === 2,
              maxOutputBytes:
                job.admissionSnapshot?.qualification?.maxOutputBytes ??
                this.config.get<number>(
                  'PROCESSING_OUTPUT_MAX_BYTES',
                  100_000_000,
                ),
              outputBytesInclusive: job.admissionSnapshot?.policyVersion === 2,
              probeTimeoutSeconds:
                job.admissionSnapshot?.qualification?.probeTimeoutSeconds ??
                300,
              processingTimeoutSeconds:
                job.admissionSnapshot?.qualification
                  ?.processingTimeoutSeconds ?? 7200,
              costModelRevision:
                job.admissionSnapshot?.qualification?.costModelRevision ?? null,
            },
          }
        : {}),
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

  async recordExecution(
    job: Job,
    eventId: string,
    evidence: AttemptExecutionEvidence,
    session: ClientSession,
  ) {
    const attempt = await this.attempts
      .findOne({ attemptId: job.attemptId })
      .session(session);
    if (!attempt) throw jobError('STALE_ATTEMPT');
    const hash = requestHash(evidence);
    if (attempt.executionEvidenceEventId === eventId) {
      if (attempt.executionEvidenceHash !== hash)
        throw jobError('IDEMPOTENCY_CONFLICT');
      return;
    }
    if (
      attempt.separatorStoppedConfirmed &&
      (!evidence.stoppedConfirmed ||
        evidence.separatorExecutionSeconds !==
          attempt.separatorExecutionSeconds)
    )
      throw jobError('JOB_STATE_CONFLICT');
    assertExecutionEvidence(
      evidence,
      eventId,
      attempt.separatorExecutionSeconds,
      attempt.startedAt,
      new Date(),
    );
    if (
      job.measuredDurationSeconds !== null &&
      evidence.measuredAudioSeconds !== job.measuredDurationSeconds
    )
      throw jobError('JOB_STATE_CONFLICT');
    if (
      attempt.separationCompleted === true &&
      evidence.separationCompleted === false
    )
      throw jobError('JOB_STATE_CONFLICT');
    if (evidence.separationCompleted !== undefined)
      attempt.separationCompleted = evidence.separationCompleted;
    attempt.executionEvidenceEventId = eventId;
    attempt.executionEvidenceHash = hash;
    attempt.separatorExecutionSeconds = evidence.separatorExecutionSeconds;
    attempt.separatorStoppedConfirmed = evidence.stoppedConfirmed;
    await attempt.save({ session });
    await this.jobs.db
      .model<QueueExecutionUsage>(QueueExecutionUsage.name)
      .updateOne(
        { _id: attempt.attemptId },
        {
          $set: {
            executionSeconds: evidence.separatorExecutionSeconds,
            expiresAt: new Date(
              (attempt.processingStartedAt ?? attempt.startedAt).getTime() +
                86400_000,
            ),
          },
        },
        { session },
      );
  }

  private deadline(): Date {
    return new Date(
      Date.now() +
        this.config.getOrThrow<number>('PROCESSING_LEASE_SECONDS') * 1000,
    );
  }
}
