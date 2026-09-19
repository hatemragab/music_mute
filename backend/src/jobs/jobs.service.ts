import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { Types, type Model } from 'mongoose';
import { ProcessingAdmissionService } from '../admin-settings/processing-admission.service.js';
import { authError } from '../auth/auth.errors.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { processingIo } from '../processing/processing-io.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { jobError } from './job-errors.js';
import { normalizeJobMetadata, type JobMetadata } from './job-metadata.js';
import { isDuplicateKey, objectId, requestHash } from './job-request.js';
import { Job } from './job.schema.js';
import { assertInputDeclaration } from './job-state.js';
import type { InputDeclaration, WorkerRetryEligibility } from './job.types.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  workerRecipeSnapshot,
} from './worker-recipes.js';

const INITIAL_RETRY_ELIGIBILITY: Readonly<WorkerRetryEligibility> =
  Object.freeze({
    eligible: true,
    attemptsRemaining: 3,
    nextAttemptAt: null,
  });

@Injectable()
export class JobsService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly storage: StorageTransfersService,
    private readonly transactions: ProcessingTransactions,
    private readonly access: AccountAccessService,
    private readonly admission: ProcessingAdmissionService,
  ) {}

  async create(
    userId: string,
    input: InputDeclaration,
    requestId: string,
    metadata: JobMetadata = {},
  ) {
    const normalized = normalizeJobMetadata(metadata);
    assertInputDeclaration(input, normalized.policyVersion ?? 1);
    if (!isUUID(requestId, '4')) throw authError('INVALID_INPUT');
    requestId = requestId.toLowerCase();
    const owner = objectId(userId);
    const hash = requestHash({
      operation: 'create',
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
                inputReservation: {
                  ...input,
                  key: `users/${owner.toHexString()}/jobs/${id.toHexString()}/input/${randomUUID()}.${input.extension}`,
                },
                admissionSnapshot,
                recipeSnapshot: workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID),
                retryEligibility: { ...INITIAL_RETRY_ELIGIBILITY },
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
        ? await processingIo(() => {
            this.admission.assertAcceptedReservation(job!);
            return this.storage.createInputGrant(job!);
          })
        : undefined;
    const current = await this.findOwned(userId, job._id.toHexString());
    return {
      id: job._id.toHexString(),
      requestId: job.requestId,
      status: current.status,
      ...(current.status === 'awaiting_upload' && upload ? { upload } : {}),
    };
  }

  async renewUpload(userId: string, jobId: string) {
    const owner = objectId(userId);
    const id = objectId(jobId);
    const job = await this.transactions.run(async (session) => {
      const current = await this.jobs
        .findOne({ _id: id, userId: owner })
        .session(session);
      if (!current || current.deletedAt) throw jobError('JOB_NOT_FOUND');
      if (current.status !== 'awaiting_upload')
        throw jobError('JOB_STATE_CONFLICT');
      await this.access.assertActive(owner, session);
      this.admission.assertAcceptedReservation(current);
      return current.toObject();
    });
    const grant = await processingIo(() => this.storage.createInputGrant(job));
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
    const identity = await processingIo(() => this.storage.verifyInput(job));
    return this.transactions.run(async (session) => {
      await this.access.assertActive(userId, session);
      const current = await this.jobs
        .findOne({ _id: job._id, userId: job.userId })
        .session(session);
      if (!current || current.deletedAt) throw jobError('JOB_NOT_FOUND');
      if (current.inputObject) return { id: jobId, status: current.status };
      if (current.status !== 'awaiting_upload')
        throw jobError('JOB_STATE_CONFLICT');
      this.admission.assertAcceptedReservation(current, identity.bytes);
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
          $set: { inputObject: identity, queuedAt, status: 'queued' },
          $inc: { revision: 1 },
        },
        { session, runValidators: true },
      );
      if (queued.modifiedCount !== 1) throw jobError('JOB_STATE_CONFLICT');
      return { id: jobId, status: 'queued' as const };
    });
  }

  private async findOwned(userId: string, jobId: string) {
    await this.access.assertActive(userId);
    const job = await this.jobs
      .findOne({ _id: objectId(jobId), userId: objectId(userId) })
      .lean();
    if (!job || job.deletedAt) throw jobError('JOB_NOT_FOUND');
    return job;
  }
}
