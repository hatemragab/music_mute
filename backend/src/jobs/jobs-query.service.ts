import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { QueryFilter, Model } from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { processingIo } from '../processing/processing-io.js';
import { Job } from './job.schema.js';
import { objectId } from './job-request.js';
import { jobError } from './job-errors.js';
import { JOB_STATUSES, type JobStatus } from './job.types.js';
import { presentJob } from './jobs.presenter.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import type { ObjectIdentity } from './job.types.js';

interface HistoryPosition {
  createdAt: Date;
  id: string;
}
export function encodeHistoryCursor(position: HistoryPosition): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: position.createdAt.toISOString(),
      id: position.id,
    }),
  ).toString('base64url');
}
export function decodeHistoryCursor(cursor: string): HistoryPosition {
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString(),
    ) as Record<string, unknown>;
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'createdAt,id' ||
      typeof value.createdAt !== 'string' ||
      typeof value.id !== 'string'
    )
      throw new Error();
    const createdAt = new Date(value.createdAt);
    if (createdAt.toISOString() !== value.createdAt) throw new Error();
    objectId(value.id);
    return { createdAt, id: value.id };
  } catch {
    throw authError('INVALID_INPUT');
  }
}

@Injectable()
export class JobsQueryService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly access: AccountAccessService,
    private readonly storage: StorageTransfersService,
    private readonly transactions: ProcessingTransactions,
    private readonly usage: ProcessingUsageService,
  ) {}

  async list(
    userId: string,
    query: { limit?: string; cursor?: string; status?: string },
  ) {
    if (
      Object.keys(query).some(
        (key) => !['limit', 'cursor', 'status'].includes(key),
      )
    )
      throw authError('INVALID_INPUT');
    const limit = query.limit === undefined ? 20 : Number(query.limit);
    if (
      (query.limit !== undefined &&
        (typeof query.limit !== 'string' || !/^\d{1,3}$/.test(query.limit))) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw authError('INVALID_INPUT');
    const filter: QueryFilter<Job> = {
      userId: objectId(userId),
      deletedAt: null,
    };
    if (query.status !== undefined) {
      if (!JOB_STATUSES.includes(query.status as JobStatus))
        throw authError('INVALID_INPUT');
      filter.status = query.status as JobStatus;
    }
    if (query.cursor !== undefined) {
      if (typeof query.cursor !== 'string') throw authError('INVALID_INPUT');
      const cursor = decodeHistoryCursor(query.cursor);
      filter.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, _id: { $lt: objectId(cursor.id) } },
      ];
    }
    const results = await this.jobs
      .find(filter)
      .setOptions({ sanitizeFilter: false })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .lean();
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((job) => presentJob(job)),
      nextCursor:
        results.length > limit && last
          ? encodeHistoryCursor({
              createdAt: last.createdAt,
              id: last._id.toHexString(),
            })
          : null,
    };
  }

  async detail(userId: string, jobId: string) {
    return presentJob(await this.findOwned(userId, jobId));
  }

  async download(
    userId: string,
    jobId: string,
    artifact: 'input' | 'output',
    requestId: string,
  ) {
    const job = await this.findOwned(userId, jobId);
    const object = this.downloadObject(job, artifact);
    if (!object) throw jobError('JOB_STATE_CONFLICT');
    if (
      !(await processingIo(() => this.storage.isPinnedObjectAvailable(object)))
    )
      throw jobError('JOB_STATE_CONFLICT');
    const entitlement = await this.transactions.run(async (session) => {
      await this.access.assertActive(userId, session);
      const current = await this.jobs
        .findOne({ _id: job._id, userId: job.userId, deletedAt: null })
        .session(session)
        .lean();
      const currentObject = current
        ? this.downloadObject(current, artifact)
        : null;
      if (!current || !currentObject || !sameObject(currentObject, object))
        throw jobError('JOB_STATE_CONFLICT');
      return this.usage.reserveDownloadGrant(
        {
          accountId: current.userId,
          jobId: current._id,
          scope: artifact === 'output' ? 'user_result' : 'user_input',
          requestId,
          object: currentObject,
        },
        session,
      );
    });
    const grant = await processingIo(() =>
      this.storage.createDownloadGrant(object, entitlement.expiresAt),
    );
    await this.findOwned(userId, jobId);
    return grant;
  }

  private downloadObject(
    job: Job,
    artifact: 'input' | 'output',
  ): ObjectIdentity | null {
    return artifact === 'input'
      ? job.inputObject
      : job.status === 'ready'
        ? job.outputObject
        : null;
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

function sameObject(left: ObjectIdentity, right: ObjectIdentity): boolean {
  return (
    left.key === right.key &&
    left.versionId === right.versionId &&
    left.bytes === right.bytes &&
    left.sha256 === right.sha256 &&
    left.contentType === right.contentType
  );
}
