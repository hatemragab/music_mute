import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import { JobAttempt } from '../jobs/job-attempt.schema.js';
import { JobReceipt } from '../jobs/job-receipt.schema.js';
import { jobError } from '../jobs/job-errors.js';
import { requestHash } from '../jobs/job-request.js';
import { isSha256 } from '../jobs/job-state.js';
import { closeProcessingInterval } from '../jobs/job-timing.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { processingIo } from '../processing/processing-io.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { WorkerCoordinatorService } from './worker-coordinator.service.js';
import type { WorkerOutputDto } from './dto/worker-output.dto.js';
import type { WorkerIdentity } from './worker-routes.js';

@Injectable()
export class WorkerOutputService {
  constructor(
    private readonly coordinator: WorkerCoordinatorService,
    private readonly transactions: ProcessingTransactions,
    private readonly storage: StorageTransfersService,
    private readonly config: ConfigService,
    @InjectModel(JobAttempt.name) private readonly attempts: Model<JobAttempt>,
    @InjectModel(JobReceipt.name) private readonly receipts: Model<JobReceipt>,
    private readonly accountAccess: AccountAccessService,
  ) {}

  async reserve(dto: WorkerOutputDto, identity?: WorkerIdentity) {
    if (
      !Number.isInteger(dto.bytes) ||
      dto.bytes < 1 ||
      dto.bytes >=
        this.config.getOrThrow<number>('PROCESSING_OUTPUT_MAX_BYTES') ||
      dto.contentType !== 'audio/mpeg' ||
      dto.playable !== true ||
      dto.voiceOnly !== true ||
      !isSha256(dto.sha256) ||
      !Number.isFinite(dto.durationSeconds) ||
      dto.durationSeconds <= 0 ||
      dto.durationSeconds >= 600
    )
      throw authError('INVALID_INPUT');
    const hash = requestHash({ operation: 'output', ...dto });
    const job = await this.transactions.run(async (session) => {
      const { job } = await this.coordinator.current(
        dto,
        session,
        true,
        identity,
      );
      await this.accountAccess.assertActive(job.userId, session);
      const receipt = await this.receipts
        .findOne({ jobId: job._id, eventId: dto.eventId })
        .session(session);
      if (receipt && receipt.requestHash !== hash)
        throw jobError('IDEMPOTENCY_CONFLICT');
      if (!['processing', 'uploading_result'].includes(job.status))
        throw jobError('JOB_STATE_CONFLICT');
      const reservation = {
        key: `users/${job.userId.toHexString()}/jobs/${job._id.toHexString()}/output/${dto.attemptId}/vocals.mp3`,
        attemptId: dto.attemptId,
        bytes: dto.bytes,
        sha256: dto.sha256,
        contentType: dto.contentType,
        durationSeconds: dto.durationSeconds,
      };
      if (job.outputReservation) {
        if (
          requestHash(job.toObject().outputReservation) !==
          requestHash(reservation)
        )
          throw jobError('IDEMPOTENCY_CONFLICT');
      } else {
        if (job.status !== 'processing') throw jobError('JOB_STATE_CONFLICT');
        const now = new Date();
        const timing = closeProcessingInterval(job, now);
        job.set({
          ...timing,
          outputReservation: reservation,
          status: 'uploading_result',
          uploadingResultAt: now,
          revision: job.revision + 1,
        });
        await job.save({ session });
        await this.attempts.updateOne(
          { attemptId: dto.attemptId },
          {
            $set: {
              outputReservation: reservation,
              ...(timing.processingFinishedAt
                ? { processingEndedAt: timing.processingFinishedAt }
                : {}),
            },
          },
          { session },
        );
      }
      if (!receipt)
        await this.receipts.create(
          [
            {
              jobId: job._id,
              eventId: dto.eventId,
              attemptId: dto.attemptId,
              requestHash: hash,
              operation: 'output',
              status: 'uploading_result',
              createdAt: new Date(),
            },
          ],
          { session },
        );
      return job;
    });
    const upload = await processingIo(() =>
      this.storage.createOutputGrant(job),
    );
    await this.transactions.run(async (session) => {
      await this.coordinator.current(dto, session, true, identity);
    });
    await this.accountAccess.assertActive(job.userId);
    return {
      status: job.status,
      upload,
    };
  }
}
