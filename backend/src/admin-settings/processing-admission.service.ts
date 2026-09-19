import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type ClientSession, type Model, type Types } from 'mongoose';
import { Job } from '../jobs/job.schema.js';
import { ACTIVE_ADMISSION_STATUSES } from '../jobs/job-state.js';
import { jobError } from '../jobs/job-errors.js';
import type { AdmissionSnapshot, InputDeclaration } from '../jobs/job.types.js';
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
    const userFence = await this.fences.updateOne(
      { _id: `user:${userId.toString()}` },
      { $inc: { revision: 1 } },
      { upsert: true, session, setDefaultsOnInsert: true },
    );
    if (!userFence.acknowledged) throw jobError('PROCESSING_UNAVAILABLE');

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

    const v2 = metadata.policyVersion === 2;
    if (
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      (v2
        ? input.bytes > policy.values.maxPreparedAudioBytes
        : input.bytes > policy.values.maxPreparedAudioBytes) ||
      !Number.isFinite(input.durationSeconds) ||
      input.durationSeconds <= 0 ||
      (v2
        ? input.durationSeconds > policy.values.maxDurationSeconds
        : input.durationSeconds > policy.values.maxDurationSeconds)
    )
      throw jobError('PROCESSING_UNAVAILABLE');

    const maximumActive = policy.values.maxProcessingJobs;
    const active = await this.jobs
      .countDocuments({
        userId,
        deletedAt: null,
        status: trusted({ $in: ACTIVE_ADMISSION_STATUSES }),
      })
      .session(session);
    if (active >= maximumActive) throw jobError('PROCESSING_LIMIT_REACHED');

    await this.usage.reserveForJob(
      newJobId,
      accountId,
      input.durationSeconds,
      session,
    );

    return {
      ...(v2
        ? {
            policyVersion: 2 as const,
            maxDurationSeconds: policy.values.maxDurationSeconds,
            maxInputBytes: policy.values.maxPreparedAudioBytes,
            preparationProfileId: metadata.preparationProfileId,
            source: metadata.source,
          }
        : { policyVersion: 1 as const }),
      settingsRevision: policy.globalRevision,
      maxInputBytesExclusive: policy.values.maxPreparedAudioBytes + 1,
      maxDurationSecondsExclusive: policy.values.maxDurationSeconds + 1,
      maxActiveJobsPerUser: maximumActive,
      reservationExpiresAt: new Date(
        Date.now() +
          this.config.getOrThrow<number>('PROCESSING_URL_SECONDS') * 1000,
      ),
    };
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
      snapshot.policyVersion === 2
        ? actualBytes > (snapshot.maxInputBytes ?? 0) ||
          job.inputReservation.durationSeconds >
            (snapshot.maxDurationSeconds ?? 0)
        : actualBytes >= snapshot.maxInputBytesExclusive ||
          job.inputReservation.durationSeconds >=
            snapshot.maxDurationSecondsExclusive
    )
      throw jobError('PROCESSING_UNAVAILABLE');
    return snapshot;
  }
}
