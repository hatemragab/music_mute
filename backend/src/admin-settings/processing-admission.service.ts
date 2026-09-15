import type { JobMetadata } from '../jobs/job-metadata.js';
import { assertPreparedAudioV2 } from './processing-policy-v2.js';
import { qualifiedWorkers } from './queue-policy.service.js';
import { WorkerControl } from '../worker/worker-control.schema.js';
import { estimateCost } from '../processing-queue/queue-cost.js';
import { ProcessingQueuePolicy } from './queue-policy.schema.js';
import { readQueuePolicy } from './queue-policy.service.js';
import { QueueCapacityService } from '../processing-queue/queue-capacity.service.js';
import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { ProcessingUsageLedger } from '../processing-usage/processing-usage.schema.js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type ClientSession, type Model, type Types } from 'mongoose';
import { Job } from '../jobs/job.schema.js';
import { ACTIVE_ADMISSION_STATUSES } from '../jobs/job-state.js';
import { jobError } from '../jobs/job-errors.js';
import type { AdmissionSnapshot, InputDeclaration } from '../jobs/job.types.js';
import { User } from '../users/user.schema.js';
import { ProcessingAdmissionFence } from './processing-settings.schema.js';
import { ProcessingSettingsService } from './processing-settings.service.js';

@Injectable()
export class ProcessingAdmissionService {
  constructor(
    @InjectModel(ProcessingAdmissionFence.name)
    private readonly fences: Model<ProcessingAdmissionFence>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly settings: ProcessingSettingsService,
    private readonly config: ConfigService,
  ) {}

  async assertNewWork(
    userId: string | Types.ObjectId,
    input: Pick<InputDeclaration, 'bytes' | 'durationSeconds'>,
    session: ClientSession,
    excludeCurrentJobId?: string | Types.ObjectId,
    newJobId?: Types.ObjectId,
    metadata: JobMetadata = {},
  ): Promise<AdmissionSnapshot> {
    await this.settings.touchGlobalFence(session);
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
    const settings = await this.settings.effective(session);
    const queuePolicy = await readQueuePolicy(
      this.jobs.db.model<ProcessingQueuePolicy>(ProcessingQueuePolicy.name),
      session,
    );
    if (
      !settings.acceptNewJobs ||
      !queuePolicy.acceptNewJobs ||
      this.config.get<boolean>('AUDIO_PROCESSING_ENABLED') !== true
    )
      throw jobError('PROCESSING_UNAVAILABLE');
    if (metadata.policyVersion === 2) {
      assertPreparedAudioV2(input, { evidenceStatus: 'verified' });
      const workers = await qualifiedWorkers(
        this.jobs.db.model<ProcessingQueuePolicy>(ProcessingQueuePolicy.name),
        queuePolicy.qualification,
        session,
        input.durationSeconds,
        input.bytes,
      );
      if (workers.length === 0 || !queuePolicy.qualification)
        throw jobError('PROCESSING_CAPACITY_UNAVAILABLE');
      if (
        input.durationSeconds > queuePolicy.maxDurationSeconds ||
        (!queuePolicy.acceptLongJobs && input.durationSeconds > 600)
      )
        throw jobError('MEDIA_TOO_LONG');
      if (input.bytes > queuePolicy.maxPreparedAudioBytes)
        throw jobError('MEDIA_TOO_LARGE');
      await this.jobs.db
        .model<WorkerControl>(WorkerControl.name)
        .updateOne(
          { _id: workers[0], mediaPolicyVersion: 2 },
          { $inc: { controlRevision: 1 } },
          { session },
        );
    } else {
      if (
        !Number.isInteger(input.bytes) ||
        input.bytes < 1 ||
        input.bytes >= settings.maxInputBytesExclusive ||
        input.bytes >= queuePolicy.maxPreparedAudioBytes ||
        !Number.isFinite(input.durationSeconds) ||
        input.durationSeconds <= 0 ||
        input.durationSeconds >= settings.maxDurationSecondsExclusive ||
        input.durationSeconds >= queuePolicy.maxDurationSeconds
      )
        throw jobError('PROCESSING_UNAVAILABLE');
    }
    {
      const active = await this.jobs
        .countDocuments({
          userId,
          deletedAt: null,
          status: trusted({ $in: ACTIVE_ADMISSION_STATUSES }),
          ...(excludeCurrentJobId
            ? { _id: trusted({ $ne: excludeCurrentJobId }) }
            : {}),
        })
        .session(session);
      if (active >= 1) throw jobError('PROCESSING_LIMIT_REACHED');
    }
    await new QueueCapacityService(this.jobs).assertCapacity(
      input.durationSeconds,
      session,
      excludeCurrentJobId,
    );
    if (newJobId)
      await this.usage.reserveForJob(
        newJobId,
        typeof userId === 'string'
          ? new this.jobs.base.Types.ObjectId(userId)
          : userId,
        input.durationSeconds,
        session,
      );
    return {
      ...(metadata.policyVersion === 2
        ? {
            policyVersion: 2 as const,
            maxDurationSeconds: queuePolicy.maxDurationSeconds,
            maxInputBytes: queuePolicy.maxPreparedAudioBytes,
            qualification: queuePolicy.qualification,
            preparationProfileId: metadata.preparationProfileId,
            source: metadata.source,
            queueLimits: {
              maxOutstandingJobs: queuePolicy.maxOutstandingJobs,
              maxOutstandingAudioSeconds:
                queuePolicy.maxOutstandingAudioSeconds,
            },
            estimatedWorkerSeconds: estimateCost(input.durationSeconds, {
              revision: queuePolicy.qualification!.costModelRevision,
              evidenceStatus: 'verified',
              measuredAt: queuePolicy.qualification!.measuredAt,
              referenceProcessingSecondsPerAudioSecond:
                queuePolicy.qualification!
                  .referenceProcessingSecondsPerAudioSecond,
              fixedJobOverheadSeconds:
                queuePolicy.qualification!.fixedJobOverheadSeconds,
            }),
          }
        : {}),
      queueLimits: {
        maxOutstandingJobs: queuePolicy.maxOutstandingJobs,
        maxOutstandingAudioSeconds: queuePolicy.maxOutstandingAudioSeconds,
      },
      settingsRevision: settings.revision,
      maxInputBytesExclusive: Math.min(
        settings.maxInputBytesExclusive,
        queuePolicy.maxPreparedAudioBytes,
      ),
      maxDurationSecondsExclusive: Math.min(
        settings.maxDurationSecondsExclusive,
        queuePolicy.maxDurationSeconds,
      ),
      maxActiveJobsPerUser: 1,
      reservationExpiresAt: new Date(
        Date.now() +
          this.config.getOrThrow<number>('PROCESSING_URL_SECONDS') * 1000,
      ),
    };
  }

  private get usage() {
    return new ProcessingUsageService(
      this.jobs.db.model<ProcessingUsageLedger>(ProcessingUsageLedger.name),
      this.jobs,
    );
  }

  acceptedSnapshot(
    job: Pick<Job, 'admissionSnapshot' | 'createdAt'>,
  ): AdmissionSnapshot {
    return (
      job.admissionSnapshot ?? {
        settingsRevision: 0,
        maxInputBytesExclusive: 30_000_000,
        maxDurationSecondsExclusive: 600,
        maxActiveJobsPerUser: null,
        reservationExpiresAt: new Date(
          job.createdAt.getTime() +
            this.config.getOrThrow<number>('PROCESSING_URL_SECONDS') * 1000,
        ),
      }
    );
  }

  assertAcceptedReservation(
    job: Pick<Job, 'admissionSnapshot' | 'createdAt' | 'inputReservation'>,
    actualBytes = job.inputReservation.bytes,
  ): AdmissionSnapshot {
    const snapshot = this.acceptedSnapshot(job);
    if (snapshot.reservationExpiresAt.getTime() <= Date.now())
      throw jobError('UPLOAD_RESERVATION_EXPIRED');
    if (snapshot.policyVersion === 2) {
      if (
        actualBytes > (snapshot.maxInputBytes ?? 0) ||
        job.inputReservation.durationSeconds >
          (snapshot.maxDurationSeconds ?? 0)
      )
        throw jobError('PROCESSING_UNAVAILABLE');
      return snapshot;
    }
    if (
      actualBytes >= snapshot.maxInputBytesExclusive ||
      job.inputReservation.durationSeconds >=
        snapshot.maxDurationSecondsExclusive
    )
      throw jobError('PROCESSING_UNAVAILABLE');
    return snapshot;
  }
}
