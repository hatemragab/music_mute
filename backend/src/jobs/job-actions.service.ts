import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { ProcessingUsageLedger } from '../processing-usage/processing-usage.schema.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isUUID } from 'class-validator';
import { Types, trusted, type ClientSession, type Model } from 'mongoose';
import { ProcessingAdmissionService } from '../admin-settings/processing-admission.service.js';
import { authError } from '../auth/auth.errors.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { Job } from './job.schema.js';
import { nextCancellationState } from './job-state.js';
import { jobError } from './job-errors.js';
import { isDuplicateKey, objectId, requestHash } from './job-request.js';
import type { JobFailureCode } from './job.types.js';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';

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
    private readonly accountAccess: AccountAccessService,
    private readonly admission: ProcessingAdmissionService,
  ) {}

  private get usage() {
    return new ProcessingUsageService(
      this.jobs.db.model<ProcessingUsageLedger>(ProcessingUsageLedger.name),
      this.jobs,
    );
  }

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
      await this.usage.settleJob(updated, session);
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
    await this.usage.settleJob(updated, session);
    return updated;
  }

  async retry(userId: string, jobId: string, requestId: string) {
    if (!isUUID(requestId, '4')) throw authError('INVALID_INPUT');
    requestId = requestId.toLowerCase();
    const owner = objectId(userId);
    const originalId = objectId(jobId);
    const hash = requestHash({
      operation: 'retry',
      originalJobId: originalId.toHexString(),
    });
    const existing = await this.jobs
      .findOne({ userId: owner, requestId })
      .lean();
    if (existing) return this.presentRetry(existing, hash);

    try {
      return await this.transactions.run(async (session) => {
        await this.accountAccess.assertActive(owner, session);
        const repeated = await this.jobs
          .findOne({ userId: owner, requestId })
          .session(session)
          .lean();
        if (repeated) return this.presentRetry(repeated, hash);
        const original = await this.jobs
          .findOne({ _id: originalId, userId: owner })
          .session(session)
          .lean();
        this.assertRetryable(original);

        const newJobId = new Types.ObjectId();
        const admissionSnapshot = await this.admission.assertNewWork(
          owner,
          original.inputReservation,
          session,
          newJobId,
          original.admissionSnapshot?.policyVersion === 2
            ? {
                policyVersion: 2,
                preparationProfileId:
                  original.admissionSnapshot.preparationProfileId,
                source: original.admissionSnapshot.source,
              }
            : {},
        );
        const touched = await this.jobs.updateOne(
          {
            _id: original._id,
            userId: owner,
            deletedAt: null,
            revision: original.revision,
          },
          { $inc: { revision: 1 } },
          { session },
        );
        if (touched.modifiedCount !== 1) throw jobError('JOB_STATE_CONFLICT');

        const queuedAt = new Date();
        const [created] = await this.jobs.create(
          [
            {
              _id: newJobId,
              userId: owner,
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
              recipeSnapshot: { ...original.recipeSnapshot },
              retryEligibility: {
                eligible: true,
                attemptsRemaining: 3,
                nextAttemptAt: null,
              },
              queuedAt,
            },
          ],
          { session },
        );
        return this.presentRetry(created.toObject(), hash);
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
      !input.versionId ||
      input.versionId === 'null' ||
      input.key !== job.inputReservation.key ||
      input.bytes !== job.inputReservation.bytes ||
      input.sha256 !== job.inputReservation.sha256 ||
      input.contentType !== job.inputReservation.contentType ||
      !job.recipeSnapshot ||
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
