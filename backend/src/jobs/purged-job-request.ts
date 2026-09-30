import type { ClientSession, Model, Types } from 'mongoose';
import { Job } from './job.schema.js';
import { jobError } from './job-errors.js';
import { PurgedJobRequest } from './purged-job-request.schema.js';

export async function assertJobRequestNotPurged(
  jobs: Model<Job>,
  accountId: Types.ObjectId,
  requestId: string,
  requestHash: string,
  session: ClientSession,
): Promise<void> {
  const receipt = await jobs.db
    .model<PurgedJobRequest>(PurgedJobRequest.name)
    .findOne({ accountId, requestId })
    .session(session)
    .lean();
  if (!receipt) return;
  if (receipt.requestHash !== requestHash)
    throw jobError('IDEMPOTENCY_CONFLICT');
  throw jobError('JOB_NOT_FOUND');
}
