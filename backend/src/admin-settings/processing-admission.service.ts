import { hasProcessingCapacity } from '../jobs/dispatch-eligibility.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type ClientSession, type Model, type Types } from 'mongoose';
import { Job } from '../jobs/job.schema.js';
import {
  PROCESSING_CAPACITY_STATUSES,
  WAITING_CAPACITY_STATUSES,
} from '../jobs/job-lifecycle-policy.js';
import { jobError } from '../jobs/job-errors.js';
import {
  PREPARATION_PROFILE_ID,
  type AdmissionSnapshot,
  type InputDeclaration,
  type JobStatus,
} from '../jobs/job.types.js';
import type { JobMetadata } from '../jobs/job-metadata.js';
import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { User } from '../users/user.schema.js';
import { ProcessingAdmissionFence } from './processing-settings.schema.js';
import {
  AccountPolicyService,
  type EffectiveAccountPolicy,
} from './account-policy.service.js';

@Injectable()
export class ProcessingAdmissionService {
  constructor(
    @InjectModel(ProcessingAdmissionFence.name)
    private readonly fences: Model<ProcessingAdmissionFence>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly policies: AccountPolicyService,
    private readonly usage: ProcessingUsageService,
    private readonly config: ConfigService,
  ) {}

  async assertNewWork(
    userId: string | Types.ObjectId,
    input: Pick<InputDeclaration, 'bytes' | 'durationSeconds'>,
    session: ClientSession,
    newJobId: Types.ObjectId,
    metadata: JobMetadata = {},
    importReservationId?: Types.ObjectId,
  ): Promise<AdmissionSnapshot> {
    const { admissionSnapshot } = await this.assertNewWorkWithPolicy(
      userId,
      input,
      session,
      newJobId,
      metadata,
      importReservationId,
    );
    return admissionSnapshot;
  }

  /** Reuse only within this fenced transaction callback, never across retries. */
  async assertNewWorkWithPolicy(
    userId: string | Types.ObjectId,
    input: Pick<InputDeclaration, 'bytes' | 'durationSeconds'>,
    session: ClientSession,
    newJobId: Types.ObjectId,
    metadata: JobMetadata = {},
    importReservationId?: Types.ObjectId,
  ): Promise<{
    admissionSnapshot: AdmissionSnapshot;
    policy: EffectiveAccountPolicy;
  }> {
    const { accountId, policy } = await this.assertAdmissionPolicy(
      userId,
      input,
      session,
      metadata,
      importReservationId,
    );
    await this.usage.assertRetainedCapacity(
      accountId,
      policy.values.maxRetainedOutputBytes,
      session,
    );

    const waitingJobs = await this.countCapacity(
      userId,
      WAITING_CAPACITY_STATUSES,
      session,
    );
    const processingJobs = await this.countCapacity(
      userId,
      PROCESSING_CAPACITY_STATUSES,
      session,
    );
    const maxWaitingJobs = policy.values.maxWaitingJobs;
    const maxProcessingJobs = policy.values.maxProcessingJobs;
    if (waitingJobs >= maxWaitingJobs)
      throw jobError('PROCESSING_LIMIT_REACHED', {
        nextResetAt: null,
        capacity: {
          waitingJobs,
          maxWaitingJobs,
          processingJobs,
          maxProcessingJobs,
        },
        action: 'wait_for_job_to_finish',
      });

    await this.usage.reserveForJob(
      newJobId,
      accountId,
      input.durationSeconds,
      session,
      new Date(),
      policy,
    );
    return { admissionSnapshot: this.snapshot(policy, metadata), policy };
  }

  /** A completed cache result does not consume queue or processing capacity. */
  async assertCachedWork(
    userId: string | Types.ObjectId,
    input: Pick<InputDeclaration, 'bytes' | 'durationSeconds'>,
    session: ClientSession,
    metadata: JobMetadata,
    importReservationId?: Types.ObjectId,
  ): Promise<AdmissionSnapshot> {
    const { admissionSnapshot } = await this.assertCachedWorkWithPolicy(
      userId,
      input,
      session,
      metadata,
      importReservationId,
    );
    return admissionSnapshot;
  }

  /** Cached delivery still resolves current policy after its admission fences. */
  async assertCachedWorkWithPolicy(
    userId: string | Types.ObjectId,
    input: Pick<InputDeclaration, 'bytes' | 'durationSeconds'>,
    session: ClientSession,
    metadata: JobMetadata,
    importReservationId?: Types.ObjectId,
  ): Promise<{
    admissionSnapshot: AdmissionSnapshot;
    policy: EffectiveAccountPolicy;
  }> {
    const { policy } = await this.assertAdmissionPolicy(
      userId,
      input,
      session,
      metadata,
      importReservationId,
    );
    // The exact retained input and output bytes are claimed and checked by
    // recordRetainedCachedMedia in the same creation transaction.
    return { admissionSnapshot: this.snapshot(policy, metadata), policy };
  }

  private async assertAdmissionPolicy(
    userId: string | Types.ObjectId,
    input: Pick<InputDeclaration, 'bytes' | 'durationSeconds'>,
    session: ClientSession,
    metadata: JobMetadata,
    importReservationId?: Types.ObjectId,
  ): Promise<{ accountId: Types.ObjectId; policy: EffectiveAccountPolicy }> {
    if (!session.inTransaction())
      throw new Error('Processing admission requires a transaction');

    await this.policies.touchGlobalFence(session);
    await this.touchAccountFence(userId, session);

    const user = await this.users.updateOne(
      {
        _id: userId,
        status: 'active',
      },
      { $inc: { accessRevision: 1 } },
      { session },
    );
    if (user.modifiedCount !== 1) throw jobError('PROCESSING_UNAVAILABLE');

    const accountId =
      typeof userId === 'string'
        ? new this.jobs.base.Types.ObjectId(userId)
        : userId;
    // All admissions acquire these fences before mutating account usage. The
    // import hold and measured job reservation are exchanged in one transaction,
    // so the hold cannot consume the allowance used to admit its replacement.
    if (importReservationId)
      await this.usage.releaseImport(
        importReservationId,
        accountId,
        session,
        true,
      );
    const policy = await this.policies.effective(
      accountId,
      new Date(),
      session,
    );
    if (
      this.config.get<boolean>('AUDIO_PROCESSING_ENABLED') !== true ||
      !policy.acceptNewJobs
    )
      throw jobError('PROCESSING_UNAVAILABLE');

    if (
      metadata.policyVersion !== 2 ||
      metadata.preparationProfileId !== PREPARATION_PROFILE_ID ||
      !['audio_file', 'video_file', 'youtube'].includes(metadata.source ?? '')
    )
      throw jobError('PROCESSING_POLICY_INCOMPATIBLE');
    if (
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > policy.values.maxPreparedAudioBytes ||
      !Number.isFinite(input.durationSeconds) ||
      input.durationSeconds <= 0 ||
      input.durationSeconds > policy.values.maxDurationSeconds
    )
      throw jobError('PROCESSING_UNAVAILABLE');

    return { accountId, policy };
  }

  private snapshot(
    policy: EffectiveAccountPolicy,
    metadata: JobMetadata,
  ): AdmissionSnapshot {
    return {
      policyVersion: 2 as const,
      maxDurationSeconds: policy.values.maxDurationSeconds,
      maxInputBytes: policy.values.maxPreparedAudioBytes,
      preparationProfileId: metadata.preparationProfileId!,
      source: metadata.source!,
      settingsRevision: policy.globalRevision,
      maxWaitingJobs: policy.values.maxWaitingJobs,
      maxProcessingJobs: policy.values.maxProcessingJobs,
      maxInfrastructureAttempts: policy.values.maxInfrastructureAttempts,
      maxClientInputAttempts: policy.values.maxClientInputAttempts,
      reservationExpiresAt: new Date(
        Date.now() +
          this.config.getOrThrow<number>('PROCESSING_URL_SECONDS') * 1000,
      ),
    };
  }

  async claimProcessingSlot(
    job: Pick<Job, '_id' | 'userId' | 'admissionSnapshot'>,
    session: ClientSession,
  ): Promise<boolean> {
    if (!session.inTransaction())
      throw new Error('Processing claim admission requires a transaction');
    const userId = job.userId;
    const maxProcessingJobs = job.admissionSnapshot?.maxProcessingJobs;
    if (!hasProcessingCapacity(maxProcessingJobs, 0)) return false;
    await this.touchAccountFence(userId, session);
    const user = await this.users.updateOne(
      {
        _id: userId,
        status: 'active',
      },
      { $inc: { accessRevision: 1 } },
      { session },
    );
    if (user.modifiedCount !== 1) return false;
    const policy = await this.policies.effective(userId, new Date(), session);
    if (
      this.config.get<boolean>('AUDIO_PROCESSING_ENABLED') !== true ||
      !policy.acceptNewJobs ||
      !(await this.usage.hasReservedProcessing(job._id, userId, session))
    )
      return false;
    const processingJobs = await this.countCapacity(
      userId,
      PROCESSING_CAPACITY_STATUSES,
      session,
    );
    return hasProcessingCapacity(maxProcessingJobs, processingJobs);
  }

  private async touchAccountFence(
    userId: string | Types.ObjectId,
    session: ClientSession,
  ): Promise<void> {
    const userFence = await this.fences.updateOne(
      { _id: `user:${userId.toString()}` },
      { $inc: { revision: 1 } },
      { upsert: true, session, setDefaultsOnInsert: true },
    );
    if (!userFence.acknowledged) throw jobError('PROCESSING_UNAVAILABLE');
  }

  private countCapacity(
    userId: string | Types.ObjectId,
    statuses: readonly JobStatus[],
    session: ClientSession,
  ): Promise<number> {
    return this.jobs
      .countDocuments({
        userId,
        deletedAt: null,
        status: trusted({ $in: statuses }),
      })
      .session(session);
  }

  assertAcceptedReservation(
    job: Pick<Job, 'admissionSnapshot' | 'inputReservation'>,
    actualBytes = job.inputReservation.bytes,
  ): AdmissionSnapshot {
    const snapshot = job.admissionSnapshot;
    if (!snapshot) throw jobError('PROCESSING_POLICY_INCOMPATIBLE');
    if (snapshot.reservationExpiresAt.getTime() <= Date.now())
      throw jobError('UPLOAD_RESERVATION_EXPIRED');
    if (
      snapshot.policyVersion !== 2 ||
      actualBytes > snapshot.maxInputBytes ||
      job.inputReservation.durationSeconds > snapshot.maxDurationSeconds
    )
      throw jobError('PROCESSING_UNAVAILABLE');
    return snapshot;
  }
}
