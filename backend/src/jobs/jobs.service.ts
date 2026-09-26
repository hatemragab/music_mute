import type { ImportMeasurements } from './job-stage-timing.js';
import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { Types, type Model } from 'mongoose';
import { ProcessingAdmissionService } from '../admin-settings/processing-admission.service.js';
import { authError } from '../auth/auth.errors.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { processingIo } from '../processing/processing-io.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { jobError } from './job-errors.js';
import { normalizeJobMetadata, type JobMetadata } from './job-metadata.js';
import { isDuplicateKey, objectId, requestHash } from './job-request.js';
import { Job } from './job.schema.js';
import { assertInputDeclaration } from './job-state.js';
import type { InputDeclaration, ObjectIdentity } from './job.types.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  workerRecipeSnapshot,
} from './worker-recipes.js';
import { WorkerHintService } from '../worker-hints/worker-hint.service.js';

const UPLOAD_EXPIRY_GRACE_MS = 300_000;
const VERSION_SETTLEMENT_MS = 3_600_000;

@Injectable()
export class JobsService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly storage: StorageTransfersService,
    private readonly transactions: ProcessingTransactions,
    private readonly access: AccountAccessService,
    private readonly admission: ProcessingAdmissionService,
    private readonly usage: ProcessingUsageService,
    private readonly cleanup: StorageCleanupService,
    @Optional() private readonly hints?: WorkerHintService,
  ) {}

  async create(
    userId: string,
    input: InputDeclaration,
    requestId: string,
    metadata: JobMetadata = {},
    trimEnabled = true,
    serverTiming?: ImportMeasurements,
  ) {
    if (typeof trimEnabled !== 'boolean') throw authError('INVALID_INPUT');
    const normalized = normalizeJobMetadata(metadata);
    assertInputDeclaration(input);
    if (!isUUID(requestId, '4')) throw authError('INVALID_INPUT');
    requestId = requestId.toLowerCase();
    const owner = objectId(userId);
    const hash = requestHash({
      operation: 'create',
      ...(trimEnabled ? {} : { trimEnabled: false }),
      input,
      ...(Object.keys(normalized).length ? { metadata: normalized } : {}),
    });
    let job = await this.jobs.findOne({ userId: owner, requestId }).lean();
    if (!job) {
      const id = new Types.ObjectId();
      try {
        job = await this.transactions.run(async (session) => {
          const repeated = await this.jobs
            .findOne({ userId: owner, requestId })
            .session(session)
            .lean();
          if (repeated) return repeated;
          const admissionSnapshot = await this.admission.assertNewWork(
            owner,
            input,
            session,
            id,
            normalized,
          );
          const [created] = await this.jobs.create(
            [
              {
                _id: id,
                userId: owner,
                logicalAudioId: id,
                requestId,
                requestHash: hash,
                sourceTitle: normalized.sourceTitle ?? null,
                displayName: normalized.sourceTitle ?? null,
                sourceKind: normalized.sourceKind ?? null,
                sourceUrl: normalized.sourceUrl ?? null,
                clientStartedAt: normalized.clientStartedAt
                  ? new Date(normalized.clientStartedAt)
                  : null,
                processingAccumulatedMs: 0,
                serverTimingStartedAt: serverTiming?.startedAt ?? new Date(),
                importStageTimings: serverTiming?.stages ?? [],
                queueAccumulatedMs: 0,
                retryWaitAccumulatedMs: 0,
                inputReservation: {
                  ...input,
                  key: `users/${owner.toHexString()}/jobs/${id.toHexString()}/input/${randomUUID()}.${input.extension}`,
                },
                admissionSnapshot,
                recipeSnapshot: workerRecipeSnapshot(
                  DEFAULT_WORKER_RECIPE_ID,
                  trimEnabled,
                ),
                retryEligibility: {
                  eligible: true,
                  attemptsRemaining:
                    admissionSnapshot.maxInfrastructureAttempts,
                  nextAttemptAt: null,
                },
              },
            ],
            { session },
          );
          return created.toObject();
        });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        job = await this.jobs.findOne({ userId: owner, requestId }).lean();
      }
    }
    if (!job) throw new Error('Job reservation unavailable');
    if (job.requestHash !== hash) throw jobError('IDEMPOTENCY_CONFLICT');
    if (job.deletedAt) throw jobError('JOB_NOT_FOUND');

    const upload =
      job.status === 'awaiting_upload'
        ? await this.createAccountedInputGrant(owner, job._id, requestId)
        : undefined;
    const current = await this.findOwned(userId, job._id.toHexString());
    return {
      id: job._id.toHexString(),
      requestId: job.requestId,
      status: current.status,
      ...(current.status === 'awaiting_upload' && upload ? { upload } : {}),
    };
  }

  async renewUpload(userId: string, jobId: string, requestId: string) {
    const owner = objectId(userId);
    const id = objectId(jobId);
    const grant = await this.createAccountedInputGrant(owner, id, requestId);
    const current = await this.findOwned(userId, jobId);
    if (current.status !== 'awaiting_upload')
      throw jobError('JOB_STATE_CONFLICT');
    return grant;
  }

  async confirmUpload(userId: string, jobId: string) {
    const job = await this.findOwned(userId, jobId);
    if (job.inputObject) return { id: jobId, status: job.status };
    if (job.status !== 'awaiting_upload') throw jobError('JOB_STATE_CONFLICT');
    this.admission.assertAcceptedReservation(job);
    let identity: ObjectIdentity;
    try {
      identity = await processingIo(() => this.storage.verifyInput(job));
    } catch (error) {
      if (this.isUploadNotReady(error)) {
        const now = new Date();
        const due = new Date(
          Math.max(
            now.getTime(),
            (job.admissionSnapshot?.reservationExpiresAt.getTime() ??
              now.getTime()) + UPLOAD_EXPIRY_GRACE_MS,
          ),
        );
        await this.cleanup.schedule({
          key: job.inputReservation.key,
          versionId: null,
          ownerUserId: job.userId,
          reason: 'AUDIO_INPUT_INVALID',
          nextAt: due,
          settleUntil: new Date(due.getTime() + VERSION_SETTLEMENT_MS),
        });
      }
      throw error;
    }
    const result = await this.transactions.run(async (session) => {
      await this.access.assertActive(userId, session);
      const current = await this.jobs
        .findOne({ _id: job._id, userId: job.userId })
        .session(session);
      if (!current || current.deletedAt) throw jobError('JOB_NOT_FOUND');
      if (current.inputObject) return { id: jobId, status: current.status };
      if (current.status !== 'awaiting_upload')
        throw jobError('JOB_STATE_CONFLICT');
      this.admission.assertAcceptedReservation(current, identity.bytes);
      await this.usage.confirmUploadBytes(current, identity.bytes, session);
      await this.cleanup.cancelScheduled(current.inputReservation.key, session);
      const queuedAt = new Date();
      const queued = await this.jobs.updateOne(
        {
          _id: current._id,
          status: 'awaiting_upload',
          revision: current.revision,
          inputObject: null,
          recipeSnapshot: { $ne: null },
        },
        {
          $set: {
            inputObject: identity,
            queuedAt,
            queueTimingStartedAt: current.serverTimingStartedAt
              ? queuedAt
              : null,
            status: 'queued',
          },
          $inc: { revision: 1 },
        },
        { session, runValidators: true },
      );
      if (queued.modifiedCount !== 1) throw jobError('JOB_STATE_CONFLICT');
      return { id: jobId, status: 'queued' as const };
    });
    void this.hints?.publish('work_available').catch(() => undefined);
    return result;
  }

  private async findOwned(userId: string, jobId: string) {
    await this.access.assertActive(userId);
    const job = await this.jobs
      .findOne({ _id: objectId(jobId), userId: objectId(userId) })
      .lean();
    if (!job || job.deletedAt) throw jobError('JOB_NOT_FOUND');
    return job;
  }

  private async createAccountedInputGrant(
    owner: Types.ObjectId,
    jobId: Types.ObjectId,
    requestId: string,
  ) {
    const entitlement = await this.transactions.run(async (session) => {
      const current = await this.jobs
        .findOne({ _id: jobId, userId: owner })
        .session(session);
      if (!current || current.deletedAt) throw jobError('JOB_NOT_FOUND');
      if (current.status !== 'awaiting_upload')
        throw jobError('JOB_STATE_CONFLICT');
      await this.access.assertActive(owner, session);
      this.admission.assertAcceptedReservation(current);
      const receipt = await this.usage.reserveUploadGrant(
        current,
        requestId,
        session,
      );
      return { job: current.toObject(), expiresAt: receipt.expiresAt };
    });
    return processingIo(() =>
      this.storage.createInputGrant(entitlement.job, entitlement.expiresAt),
    );
  }

  private isUploadNotReady(error: unknown): boolean {
    const response = (
      error as { getResponse?: () => unknown }
    )?.getResponse?.() as { code?: unknown } | undefined;
    return response?.code === 'UPLOAD_NOT_READY';
  }
}
