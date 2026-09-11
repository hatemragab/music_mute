import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { authError } from '../auth/auth.errors.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { processingIo } from '../processing/processing-io.js';
import { EnqueueService } from './enqueue.service.js';
import { Job } from './job.schema.js';
import { assertInputDeclaration } from './job-state.js';
import { isDuplicateKey, objectId, requestHash } from './job-request.js';
import { jobError } from './job-errors.js';
import type { InputDeclaration } from './job.types.js';
import { normalizeJobMetadata, type JobMetadata } from './job-metadata.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { ProcessingAdmissionService } from '../admin-settings/processing-admission.service.js';

@Injectable()
export class JobsService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly storage: StorageTransfersService,
    private readonly transactions: ProcessingTransactions,
    private readonly enqueue: EnqueueService,
    private readonly access: AccountAccessService,
    private readonly admission: ProcessingAdmissionService,
  ) {}

  async create(
    userId: string,
    input: InputDeclaration,
    requestId: string,
    metadata: JobMetadata = {},
  ) {
    assertInputDeclaration(input);
    if (!isUUID(requestId, '4')) throw authError('INVALID_INPUT');
    requestId = requestId.toLowerCase();
    const owner = objectId(userId);
    const normalized = normalizeJobMetadata(metadata);
    const hash = requestHash({
      operation: 'create',
      input,
      ...(Object.keys(normalized).length ? { metadata: normalized } : {}),
    });
    let job = await this.jobs.findOne({ userId: owner, requestId }).lean();
    if (!job) {
      const id = new Types.ObjectId();
      try {
        const created = await this.transactions.run(async (session) => {
          const repeated = await this.jobs
            .findOne({ userId: owner, requestId })
            .session(session)
            .lean();
          if (repeated) return repeated;
          const admissionSnapshot = await this.admission.assertNewWork(
            owner,
            input,
            session,
          );
          const [result] = await this.jobs.create(
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
              },
            ],
            { session },
          );
          return result.toObject();
        });
        job = created;
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
            const admissionSnapshot =
              this.admission.assertAcceptedReservation(job);
            return this.storage.createInputGrant({
              ...job,
              admissionSnapshot,
            });
          })
        : undefined;
    // A cancelled/deleted reservation must not leak a grant produced by an in-flight signer.
    const current = await this.findOwned(userId, job._id.toHexString());
    return {
      id: job._id.toHexString(),
      requestId: job.requestId,
      status: current.status,
      ...(current.status === 'awaiting_upload' && upload ? { upload } : {}),
    };
  }

  async findOwned(userId: string, jobId: string) {
    await this.access.assertActive(userId);
    const job = await this.jobs
      .findOne({ _id: objectId(jobId), userId: objectId(userId) })
      .lean();
    if (!job || job.deletedAt) throw jobError('JOB_NOT_FOUND');
    return job;
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
      const admissionSnapshot = await this.admission.assertNewWork(
        owner,
        current.inputReservation,
        session,
        current._id,
      );
      current.set({ admissionSnapshot, revision: current.revision + 1 });
      await current.save({ session });
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
    await this.enqueue.prepare();
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
      const queueOrder = await this.enqueue.next(session);
      await this.jobs.updateOne(
        {
          _id: current._id,
          status: 'awaiting_upload',
          revision: current.revision,
        },
        {
          $set: {
            inputObject: identity,
            queueOrder,
            queuedAt: new Date(),
            status: 'queued',
          },
          $inc: { revision: 1 },
        },
        { session, runValidators: true },
      );
      return { id: jobId, status: 'queued' as const };
    });
  }
}
