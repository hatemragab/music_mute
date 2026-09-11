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
        processingSuspended: trusted({ $ne: true }),
      },
      { $inc: { accessRevision: 1 } },
      { session },
    );
    if (user.modifiedCount !== 1) throw jobError('PROCESSING_UNAVAILABLE');
    const settings = await this.settings.effective(session);
    if (
      !settings.acceptNewJobs ||
      this.config.get<boolean>('AUDIO_PROCESSING_ENABLED') !== true
    )
      throw jobError('PROCESSING_UNAVAILABLE');
    if (
      !Number.isInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes >= settings.maxInputBytesExclusive ||
      !Number.isFinite(input.durationSeconds) ||
      input.durationSeconds <= 0 ||
      input.durationSeconds >= settings.maxDurationSecondsExclusive
    )
      throw jobError('PROCESSING_UNAVAILABLE');
    if (settings.maxActiveJobsPerUser !== null) {
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
      if (active >= settings.maxActiveJobsPerUser)
        throw jobError('PROCESSING_LIMIT_REACHED');
    }
    return {
      settingsRevision: settings.revision,
      maxInputBytesExclusive: settings.maxInputBytesExclusive,
      maxDurationSecondsExclusive: settings.maxDurationSecondsExclusive,
      maxActiveJobsPerUser: settings.maxActiveJobsPerUser,
      reservationExpiresAt: new Date(
        Date.now() +
          this.config.getOrThrow<number>('PROCESSING_URL_SECONDS') * 1000,
      ),
    };
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
    if (
      actualBytes >= snapshot.maxInputBytesExclusive ||
      job.inputReservation.durationSeconds >=
        snapshot.maxDurationSecondsExclusive
    )
      throw jobError('PROCESSING_UNAVAILABLE');
    return snapshot;
  }
}
