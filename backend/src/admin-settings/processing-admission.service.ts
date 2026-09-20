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
import { AccountPolicyService } from './account-policy.service.js';

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
  ): Promise<AdmissionSnapshot> {
    if (!session.inTransaction())
      throw new Error('Processing admission requires a transaction');

    await this.policies.touchGlobalFence(session);
    await this.touchAccountFence(userId, session);

    const user = await this.users.updateOne(
      {
        _id: userId,
        status: 'active',
        $or: [
          { processingSuspended: trusted({ $ne: true }) },
          {
            processingSuspensionExpiresAt: trusted({
              $lte: new Date(),
              $ne: null,
            }),
          },
        ],
      },
      { $inc: { accessRevision: 1 } },
      { session },
    );
    if (user.modifiedCount !== 1) throw jobError('PROCESSING_UNAVAILABLE');

    const accountId =
      typeof userId === 'string'
        ? new this.jobs.base.Types.ObjectId(userId)
        : userId;
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

    await this.usage.assertRetainedCapacity(
      accountId,
      policy.values.maxRetainedOutputBytes,
      session,
    );

    const [waitingJobs, processingJobs] = await Promise.all([
      this.countCapacity(userId, WAITING_CAPACITY_STATUSES, session),
      this.countCapacity(userId, PROCESSING_CAPACITY_STATUSES, session),
    ]);
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
    );

    return {
      policyVersion: 2 as const,
      maxDurationSeconds: policy.values.maxDurationSeconds,
      maxInputBytes: policy.values.maxPreparedAudioBytes,
      preparationProfileId: metadata.preparationProfileId,
      source: metadata.source!,
      settingsRevision: policy.globalRevision,
      maxWaitingJobs,
      maxProcessingJobs,
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
    if (
      typeof maxProcessingJobs !== 'number' ||
      !Number.isSafeInteger(maxProcessingJobs) ||
      maxProcessingJobs < 1
    )
      return false;
    await this.touchAccountFence(userId, session);
    const user = await this.users.updateOne(
      {
        _id: userId,
        status: 'active',
        $or: [
          { processingSuspended: trusted({ $ne: true }) },
          {
            processingSuspensionExpiresAt: trusted({
              $lte: new Date(),
              $ne: null,
            }),
          },
        ],
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
    return processingJobs < maxProcessingJobs;
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
