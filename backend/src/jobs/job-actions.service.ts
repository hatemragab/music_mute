import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { ProcessingUsageLedger } from '../processing-usage/processing-usage.schema.js';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, trusted, type ClientSession, type Model } from 'mongoose';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { Job } from './job.schema.js';
import { nextCancellationState } from './job-state.js';
import { jobError } from './job-errors.js';
import { objectId } from './job-request.js';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';

type JobActionPrincipal =
  | { kind: 'owner'; userId: Types.ObjectId }
  | { kind: 'admin'; actor: AdminActor; expectedRevision: number };

@Injectable()
export class JobActionsService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly transactions: ProcessingTransactions,
    private readonly accountAccess: AccountAccessService,
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
}
