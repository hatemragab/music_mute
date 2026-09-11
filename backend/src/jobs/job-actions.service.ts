import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isUUID } from 'class-validator';
import { Types, trusted, type ClientSession, type Model } from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { EnqueueService } from './enqueue.service.js';
import { Job } from './job.schema.js';
import { nextCancellationState } from './job-state.js';
import type { JobFailureCode } from './job.types.js';
import { jobError } from './job-errors.js';
import { isDuplicateKey, objectId, requestHash } from './job-request.js';
import { ProcessingAdmissionService } from '../admin-settings/processing-admission.service.js';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import { WorkerControl } from '../worker/worker-control.schema.js';

type JobActionPrincipal =
  | { kind: 'owner'; userId: Types.ObjectId }
  | { kind: 'admin'; actor: AdminActor; expectedRevision: number };

const invalidInputFailures = new Set<JobFailureCode>([
  'INVALID_AUDIO',
  'INPUT_TOO_LONG',
  'INPUT_CHECKSUM_MISMATCH',
]);

export function requiresNewInputForRetry(
  code: JobFailureCode | undefined,
): boolean {
  return code !== undefined && invalidInputFailures.has(code);
}

@Injectable()
export class JobActionsService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly transactions: ProcessingTransactions,
    private readonly enqueue: EnqueueService,
    private readonly accountAccess: AccountAccessService,
    private readonly admission: ProcessingAdmissionService,
    @Optional()
    @InjectModel(WorkerControl.name)
    private readonly workerControls?: Model<WorkerControl>,
  ) {}

  async cancel(userId: string, jobId: string) {
    const principal: JobActionPrincipal = {
      kind: 'owner',
      userId: objectId(userId),
    };
    const job = await this.transactions.run((session) =>
      this.cancelInTransaction(principal, objectId(jobId), session),
    );
    return { id: job._id.toHexString(), status: job.status };
  }

  /** Internal cleanup path. The account is already durably fenced, so owner access must not be re-asserted. */
  async cancelForAccountDeletion(userId: string, jobId: string) {
    const principal: JobActionPrincipal = {
      kind: 'owner',
      userId: objectId(userId),
    };
    const job = await this.transactions.run(async (session) => {
      const current = await this.findForAction(
        principal,
        objectId(jobId),
        session,
      );
      const status = nextCancellationState(current.status);
      if (status === current.status) return current;
      const updated = await this.jobs
        .findOneAndUpdate(
          this.writeAuthority(current, principal),
          {
            $set: {
              status,
              ...(status === 'cancelled' ? { finishedAt: new Date() } : {}),
            },
            $inc: { revision: 1 },
          },
          { session, runValidators: true, returnDocument: 'after' },
        )
        .lean();
      if (!updated) throw jobError('JOB_STATE_CONFLICT');
      return updated;
    });
    return { id: job._id.toHexString(), status: job.status };
  }

  /** Internal admin entrypoint: the caller supplies its already-fenced audit transaction. */
  async cancelAsAdmin(
    actor: AdminActor,
    jobId: string,
    expectedRevision: number,
    session: ClientSession,
  ) {
    const principal = this.adminPrincipal(actor, expectedRevision, session);
    const job = await this.cancelInTransaction(
      principal,
      objectId(jobId),
      session,
    );
    return this.presentAdministrativeState(job);
  }

  private async cancelInTransaction(
    principal: JobActionPrincipal,
    id: Types.ObjectId,
    session: ClientSession,
  ) {
    const job = await this.findForAction(principal, id, session);
    const status = nextCancellationState(job.status);
    await this.accountAccess.assertActive(job.userId, session);
    if (status === job.status && principal.kind === 'owner') return job;
    const updated = await this.jobs
      .findOneAndUpdate(
        this.writeAuthority(job, principal),
        {
          $set: {
            status,
            ...(status === 'cancelled' && status !== job.status
              ? { finishedAt: new Date() }
              : {}),
          },
          $inc: { revision: 1 },
        },
        { session, runValidators: true, returnDocument: 'after' },
      )
      .lean();
    if (!updated) this.changed(principal);
    return updated;
  }

  async retry(userId: string, jobId: string, requestId: string) {
    if (!isUUID(requestId, '4')) throw authError('INVALID_INPUT');
    requestId = requestId.toLowerCase();
    const owner = objectId(userId);
    const principal: JobActionPrincipal = { kind: 'owner', userId: owner };
    const originalId = objectId(jobId);
    const hash = requestHash({
      operation: 'retry',
      originalJobId: originalId.toHexString(),
    });
    const existing = await this.jobs
      .findOne({ userId: owner, requestId })
      .lean();
    if (existing) return this.presentRetry(existing, hash);
    const source = await this.jobs
      .findOne({ _id: originalId, userId: owner })
      .lean();
    this.assertRetryable(source);
    await this.prepareRetry();

    try {
      return await this.transactions.run(async (session) => {
        await this.accountAccess.assertActive(owner, session);
        const repeated = await this.jobs
          .findOne({ userId: owner, requestId })
          .session(session)
          .lean();
        if (repeated) return this.presentRetry(repeated, hash);
        const { job: created } = await this.retryInTransaction(
          principal,
          originalId,
          requestId,
          hash,
          session,
        );
        return this.presentRetry(created, hash);
      });
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const repeated = await this.jobs
        .findOne({ userId: owner, requestId })
        .lean();
      if (!repeated) throw error;
      return this.presentRetry(repeated, hash);
    }
  }

  /** Initialize only the shared FIFO counter; allocation remains inside the supplied transaction. */
  prepareRetry(): Promise<void> {
    return this.enqueue.prepare();
  }

  async retryAsAdmin(
    actor: AdminActor,
    jobId: string,
    expectedRevision: number,
    requestId: string,
    session: ClientSession,
  ) {
    const principal = this.adminPrincipal(actor, expectedRevision, session);
    if (!isUUID(requestId, '4')) throw adminError('INVALID_REQUEST');
    const originalId = objectId(jobId);
    const hash = requestHash({
      operation: 'admin-retry',
      originalJobId: originalId.toHexString(),
      actorUid: actor.uid,
      requestId,
    });
    const { job, sourceRevision } = await this.retryInTransaction(
      principal,
      originalId,
      requestId.toLowerCase(),
      hash,
      session,
    );
    return {
      sourceJobId: originalId.toHexString(),
      newJobId: job._id.toHexString(),
      status: 'queued' as const,
      sourceRevision,
      revision: job.adminRevision ?? 0,
    };
  }

  private async retryInTransaction(
    principal: JobActionPrincipal,
    originalId: Types.ObjectId,
    requestId: string,
    hash: string,
    session: ClientSession,
  ) {
    const original = await this.findForAction(principal, originalId, session);
    if (principal.kind === 'admin' && original.status === 'interrupted')
      throw jobError('WORKER_RECOVERY_REQUIRED');
    this.assertRetryable(original);
    const controls =
      this.workerControls ??
      this.jobs.db.model<WorkerControl>(WorkerControl.name);
    if (await controls.exists({ activeJobId: original._id }).session(session))
      throw jobError('WORKER_RECOVERY_REQUIRED');
    await this.accountAccess.assertActive(original.userId, session);
    const admissionSnapshot = await this.admission.assertNewWork(
      original.userId,
      original.inputReservation,
      session,
    );
    // Retry and source deletion/rename write the same source revision. The new
    // reference commits with this fence, before cleanup may remove pinned input.
    const touched = await this.jobs.updateOne(
      this.writeAuthority(original, principal),
      { $inc: { revision: 1 } },
      { session },
    );
    if (touched.modifiedCount !== 1) this.changed(principal);
    const queuedAt = new Date();
    const queueOrder = await this.enqueue.next(session);
    const [created] = await this.jobs.create(
      [
        {
          _id: new Types.ObjectId(),
          userId: original.userId,
          requestId,
          requestHash: hash,
          retryOfJobId: original._id,
          sourceTitle: original.sourceTitle ?? null,
          displayName: original.displayName ?? original.sourceTitle ?? null,
          sourceKind: original.sourceKind ?? null,
          sourceUrl: original.sourceUrl ?? null,
          clientStartedAt: queuedAt,
          processingAccumulatedMs: 0,
          status: 'queued',
          inputReservation: { ...original.inputReservation },
          admissionSnapshot,
          inputObject: { ...original.inputObject },
          queueOrder,
          queuedAt,
        },
      ],
      { session },
    );
    return { job: created, sourceRevision: (original.adminRevision ?? 0) + 1 };
  }

  private async findForAction(
    principal: JobActionPrincipal,
    id: Types.ObjectId,
    session: ClientSession,
  ) {
    const job = await this.jobs
      .findOne({
        _id: id,
        ...(principal.kind === 'owner' ? { userId: principal.userId } : {}),
      })
      .session(session)
      .lean();
    if (!job || job.deletedAt) throw jobError('JOB_NOT_FOUND');
    if (
      principal.kind === 'admin' &&
      (job.adminRevision ?? 0) !== principal.expectedRevision
    )
      throw adminError('REVISION_CONFLICT');
    return job;
  }

  private writeAuthority(job: Job, principal: JobActionPrincipal) {
    return {
      _id: job._id,
      userId: job.userId,
      deletedAt: null,
      revision: job.revision,
      ...(principal.kind === 'admin'
        ? principal.expectedRevision === 0
          ? {
              $or: [
                { adminRevision: 0 },
                { adminRevision: trusted({ $exists: false }) },
              ],
            }
          : { adminRevision: principal.expectedRevision }
        : {}),
    };
  }

  private adminPrincipal(
    actor: AdminActor,
    expectedRevision: number,
    session: ClientSession,
  ): JobActionPrincipal {
    if (!actor.permissions.includes('jobs.manage'))
      throw adminError('PERMISSION_DENIED');
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER
    )
      throw adminError('INVALID_REQUEST');
    if (!session.inTransaction())
      throw new Error(
        'Administrative job actions require the audit transaction',
      );
    return { kind: 'admin', actor, expectedRevision };
  }

  private changed(principal: JobActionPrincipal): never {
    throw principal.kind === 'admin'
      ? adminError('REVISION_CONFLICT')
      : jobError('JOB_STATE_CONFLICT');
  }

  async administrativeState(actor: AdminActor, id: string) {
    if (!actor.permissions.includes('jobs.manage'))
      throw adminError('PERMISSION_DENIED');
    const job = await this.jobs
      .findOne({ _id: objectId(id), deletedAt: null })
      .maxTimeMS(5000)
      .lean();
    if (!job) throw jobError('JOB_NOT_FOUND');
    return this.presentAdministrativeState(job);
  }

  private presentAdministrativeState(job: Job) {
    return {
      jobId: job._id.toHexString(),
      status: job.status,
      revision: job.adminRevision ?? 0,
    };
  }

  private assertRetryable(job: Job | null): asserts job is Job {
    if (!job || job.deletedAt) throw jobError('JOB_NOT_FOUND');
    if (job.status !== 'failed') throw jobError('JOB_STATE_CONFLICT');
    const input = job.inputObject;
    if (
      !input ||
      typeof input.versionId !== 'string' ||
      !input.versionId.trim() ||
      input.versionId === 'null' ||
      input.key !== job.inputReservation.key ||
      input.bytes !== job.inputReservation.bytes ||
      input.sha256 !== job.inputReservation.sha256 ||
      input.contentType !== job.inputReservation.contentType ||
      requiresNewInputForRetry(job.lastError?.code)
    )
      throw jobError('NEW_INPUT_REQUIRED');
  }

  private presentRetry(job: Job, hash: string) {
    if (job.requestHash !== hash) throw jobError('IDEMPOTENCY_CONFLICT');
    if (job.deletedAt) throw jobError('JOB_NOT_FOUND');
    return {
      id: job._id.toHexString(),
      status: job.status,
      retryOfJobId: job.retryOfJobId?.toHexString() ?? null,
    };
  }
}
