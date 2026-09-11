import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AuthRateLimitException } from '../auth/rate-limit.exception.js';
import { Job } from '../jobs/job.schema.js';
import { jobError } from '../jobs/job-errors.js';
import { isDuplicateKey, objectId, requestHash } from '../jobs/job-request.js';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import type { ClientErrorDto } from './client-error.dto.js';
import { ClientError } from './client-error.schema.js';
import { AccountAccessService } from '../users/account-access.service.js';

const REPORT_LIMIT = 30;
const REPORT_WINDOW_MS = 60_000;

@Injectable()
export class ClientErrorsService {
  constructor(
    @InjectModel(ClientError.name)
    private readonly errors: Model<ClientError>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    private readonly rateBudget: RateBudgetService,
    private readonly rateKeys: RateLimitKeys,
    private readonly access: AccountAccessService,
  ) {}

  async report(userId: string, dto: ClientErrorDto) {
    const owner = objectId(userId);
    const decision = await this.rateBudget.reserve([
      {
        key: this.rateKeys.bucket('client-errors', owner.toHexString()),
        limit: REPORT_LIMIT,
        windowMs: REPORT_WINDOW_MS,
      },
    ]);
    if (!decision.allowed)
      throw new AuthRateLimitException(decision.retryAfterSeconds);

    const payloadHash = requestHash({
      eventId: dto.eventId,
      operationId: dto.operationId,
      ...(dto.jobId ? { jobId: dto.jobId.toLowerCase() } : {}),
      stage: dto.stage,
      code: dto.code,
      retryable: dto.retryable,
      platform: dto.platform,
      appVersion: dto.appVersion,
      osVersion: dto.osVersion,
      occurredAt: dto.occurredAt,
      ...(dto.httpStatus === undefined ? {} : { httpStatus: dto.httpStatus }),
    });

    let existing = await this.errors
      .findOne({
        userId: owner,
        eventId: dto.eventId,
      })
      .lean();
    if (existing)
      return this.replay(existing.payloadHash, payloadHash, dto.eventId);

    const jobSelector = dto.jobId
      ? {
          _id: objectId(dto.jobId),
          userId: owner,
          requestId: dto.operationId,
        }
      : { userId: owner, requestId: dto.operationId };
    const job = await this.jobs.findOne(jobSelector).lean();
    if (dto.jobId && !job) throw jobError('JOB_NOT_FOUND');

    try {
      await this.access.runActive(userId, (session) =>
        this.errors.create(
          [
            {
              userId: owner,
              eventId: dto.eventId,
              operationId: dto.operationId,
              jobId: job?._id ?? null,
              stage: dto.stage,
              code: dto.code,
              retryable: dto.retryable,
              platform: dto.platform,
              appVersion: dto.appVersion,
              osVersion: dto.osVersion,
              occurredAt: new Date(dto.occurredAt),
              httpStatus: dto.httpStatus ?? null,
              receivedAt: new Date(),
              payloadHash,
            },
          ],
          { session },
        ),
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      existing = await this.errors
        .findOne({
          userId: owner,
          eventId: dto.eventId,
        })
        .lean();
      if (!existing) throw error;
      return this.replay(existing.payloadHash, payloadHash, dto.eventId);
    }
    return { eventId: dto.eventId };
  }

  private replay(existingHash: string, payloadHash: string, eventId: string) {
    if (existingHash !== payloadHash) throw jobError('IDEMPOTENCY_CONFLICT');
    return { eventId };
  }
}
