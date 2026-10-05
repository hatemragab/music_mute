import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import {
  Types,
  trusted,
  type ClientSession,
  type Connection,
  type Model,
} from 'mongoose';
import { AccountPolicyService } from '../admin-settings/account-policy.service.js';
import { AccountRestrictionsService } from '../abuse-protection/account-restrictions.service.js';
import { authError } from '../auth/auth.errors.js';
import { Job } from '../jobs/job.schema.js';
import { jobError } from '../jobs/job-errors.js';
import {
  normalizeAudioName,
  normalizeYouTubeSourceUrl,
} from '../jobs/job-metadata.js';
import { assertInputDeclaration } from '../jobs/job-state.js';
import { assertJobRequestNotPurged } from '../jobs/purged-job-request.js';
import { objectId, requestHash } from '../jobs/job-request.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  workerRecipeSnapshot,
} from '../jobs/worker-recipes.js';
import type { UploadGrant } from '../jobs/job.types.js';
import { NotificationOutbox } from '../notifications/notification-outbox.schema.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import {
  AccountUsagePeriod,
  AccountDailyUsagePeriod,
} from '../processing-usage/processing-usage.schema.js';
import { processingIo } from '../processing/processing-io.js';
import { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { User } from '../users/user.schema.js';
import {
  CreateLocalMediaSyncDto,
  LOCAL_MEDIA_PROFILE_ID,
  type LocalMediaSyncView,
} from './local-media-sync.dto.js';
import { LocalMediaSync } from './local-media-sync.schema.js';
import { LocalMediaValidationService } from './local-media-validation.service.js';

const RESERVATION_MS = 86_400_000;
const VALIDATION_LEASE_MS = 180_000;
const MAX_PENDING_PAIRS = 3;
@Injectable()
export class LocalMediaSyncsService implements OnModuleInit {
  constructor(
    @InjectModel(LocalMediaSync.name)
    private readonly syncs: Model<LocalMediaSync>,
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly transactions: ProcessingTransactions,
    private readonly access: AccountAccessService,
    private readonly policies: AccountPolicyService,
    private readonly usage: ProcessingUsageService,
    private readonly storage: StorageTransfersService,
    private readonly cleanup: StorageCleanupService,
    private readonly validation: LocalMediaValidationService,
    private readonly restrictions: AccountRestrictionsService,
    @InjectConnection() private readonly connection: Connection,
  ) {}
  async onModuleInit(): Promise<void> {
    // This flow remains enabled while cloud separation is paused. Await all
    // collections/indexes used by its transactions independently of that flag.
    await Promise.all(
      [
        LocalMediaSync.name,
        Job.name,
        NotificationOutbox.name,
        AccountUsagePeriod.name,
        AccountDailyUsagePeriod.name,
      ].map((name) => this.connection.model(name).init()),
    );
  }
  async create(
    userId: string,
    dto: CreateLocalMediaSyncDto,
    authTimeSec: number,
  ): Promise<LocalMediaSyncView> {
    assertInputDeclaration(dto.original);
    assertInputDeclaration(dto.vocals);
    if (
      !isUUID(dto.requestId, '4') ||
      dto.profileId !== LOCAL_MEDIA_PROFILE_ID ||
      dto.vocals.extension !== 'mp3' ||
      dto.vocals.contentType !== 'audio/mpeg' ||
      Math.abs(dto.original.durationSeconds - dto.vocals.durationSeconds) >
        0.25 ||
      !['file', 'url'].includes(dto.sourceKind)
    )
      throw authError('INVALID_INPUT');
    const requestId = dto.requestId.toLowerCase();
    const owner = objectId(userId);
    const title =
      dto.sourceTitle === undefined
        ? null
        : normalizeAudioName(dto.sourceTitle);
    const url =
      dto.sourceKind === 'url'
        ? normalizeYouTubeSourceUrl(dto.sourceUrl)
        : null;
    if (dto.sourceKind === 'file' && dto.sourceUrl !== undefined)
      throw authError('INVALID_INPUT');
    const hash = requestHash({
      operation: 'local_media_sync',
      original: dto.original,
      vocals: dto.vocals,
      profileId: LOCAL_MEDIA_PROFILE_ID,
      sourceKind: dto.sourceKind,
      title,
      url,
    });
    const result = await this.transactions.run(async (session) => {
      await this.assertAccess(owner, authTimeSec, session);
      const repeated = await this.syncs
        .findOne({ userId: owner, requestId })
        .session(session)
        .lean();
      if (repeated) {
        if (repeated.requestHash !== hash)
          throw jobError('IDEMPOTENCY_CONFLICT');
        return repeated;
      }
      await assertJobRequestNotPurged(
        this.jobs,
        owner,
        requestId,
        hash,
        session,
      );
      if (await this.jobs.exists({ userId: owner, requestId }).session(session))
        throw jobError('IDEMPOTENCY_CONFLICT');
      const now = new Date();
      const policy = await this.policies.effective(owner, now, session);
      const limits = policy.values;
      for (const artifact of [dto.original, dto.vocals]) {
        if (artifact.bytes > limits.maxPreparedAudioBytes)
          throw jobError('MEDIA_TOO_LARGE');
        if (artifact.durationSeconds > limits.maxDurationSeconds)
          throw jobError('MEDIA_TOO_LONG');
      }
      const pending = await this.syncs
        .find({
          userId: owner,
          status: 'awaiting_upload',
          expiresAt: trusted({ $gt: now }),
        })
        .session(session)
        .select('original.bytes vocals.bytes')
        .lean();
      if (pending.length >= MAX_PENDING_PAIRS)
        throw jobError('UPLOAD_ATTEMPT_LIMIT_REACHED');
      const pendingBytes = pending.reduce(
        (sum, item) => sum + item.original.bytes + item.vocals.bytes,
        0,
      );
      const bytes = dto.original.bytes + dto.vocals.bytes;
      const available = await this.usage.readUsage(owner, session, now);
      if (bytes + pendingBytes > available.storage.remainingBytes)
        throw jobError('RETAINED_STORAGE_LIMIT_REACHED');
      if (bytes + pendingBytes > available.uploads.monthlyRemainingBytes)
        throw jobError('UPLOAD_BYTE_LIMIT_REACHED');
      const id = new Types.ObjectId();
      const jobId = new Types.ObjectId();
      const expiresAt = new Date(now.getTime() + RESERVATION_MS);
      const grantExpiry = new Date(
        now.getTime() + limits.signedUrlTtlSeconds * 1000,
      );
      await this.usage.reserveLocalMediaGrants(owner, session, now);
      const [created] = await this.syncs.create(
        [
          {
            _id: id,
            userId: owner,
            jobId,
            requestId,
            requestHash: hash,
            original: {
              ...dto.original,
              key: `users/${owner.toHexString()}/jobs/${jobId.toHexString()}/local/original.${dto.original.extension}`,
            },
            vocals: {
              ...dto.vocals,
              key: `users/${owner.toHexString()}/jobs/${jobId.toHexString()}/local/vocals.mp3`,
            },
            sourceKind: dto.sourceKind,
            sourceTitle: title,
            sourceUrl: url,
            recipeSnapshot: workerRecipeSnapshot(
              DEFAULT_WORKER_RECIPE_ID,
              false,
            ),
            expiresAt,
            grants: [{ requestId, expiresAt: grantExpiry }],
            maxGrantPairs: Math.min(20, limits.maxClientInputAttempts),
          },
        ],
        { session },
      );
      const stored = created.toObject();
      for (const artifact of [stored.original, stored.vocals])
        await this.cleanup.schedule(
          {
            key: artifact.key,
            ownerUserId: owner,
            reason:
              artifact === stored.original
                ? 'AUDIO_INPUT_EXPIRED'
                : 'AUDIO_OUTPUT_ORPHANED',
            nextAt: new Date(expiresAt.getTime() + 300_000),
            settleUntil: new Date(expiresAt.getTime() + 3_600_000),
          },
          session,
        );
      return stored;
    });
    return this.withGrants(result, requestId, authTimeSec);
  }
  async get(userId: string, id: string): Promise<LocalMediaSyncView> {
    const stored = await this.owned(objectId(userId), objectId(id));
    return this.present(stored);
  }
  async grants(
    userId: string,
    id: string,
    requestId: string,
    authTimeSec: number,
  ): Promise<LocalMediaSyncView> {
    if (!isUUID(requestId, '4')) throw authError('INVALID_INPUT');
    requestId = requestId.toLowerCase();
    const owner = objectId(userId);
    const syncId = objectId(id);
    const stored = await this.transactions.run(async (session) => {
      await this.assertAccess(owner, authTimeSec, session);
      const sync = await this.owned(owner, syncId, session);
      if (sync.status === 'ready') return sync;
      this.assertPending(sync);
      if (sync.grants.some((grant) => grant.requestId === requestId))
        return sync;
      if (sync.grants.length >= sync.maxGrantPairs)
        throw jobError('UPLOAD_ATTEMPT_LIMIT_REACHED');
      const policy = await this.policies.effective(owner, new Date(), session);
      const expiresAt = new Date(
        Math.min(
          sync.expiresAt.getTime(),
          Date.now() + policy.values.signedUrlTtlSeconds * 1000,
        ),
      );
      await this.usage.reserveLocalMediaGrants(owner, session);
      const updated = await this.syncs
        .findOneAndUpdate(
          {
            _id: syncId,
            userId: owner,
            revision: sync.revision,
            status: 'awaiting_upload',
          },
          {
            $push: { grants: { requestId, expiresAt } },
            $inc: { revision: 1 },
          },
          { session, returnDocument: 'after', runValidators: true },
        )
        .lean();
      if (!updated) throw jobError('JOB_STATE_CONFLICT');
      return updated;
    });
    return this.withGrants(stored, requestId, authTimeSec);
  }
  async complete(
    userId: string,
    id: string,
    authTimeSec: number,
    reauthorize: () => Promise<void>,
  ): Promise<LocalMediaSyncView> {
    const owner = objectId(userId);
    const syncId = objectId(id);
    const token = randomUUID();
    const sync = await this.transactions.run(async (session) => {
      await this.assertAccess(owner, authTimeSec, session);
      const stored = await this.owned(owner, syncId, session);
      if (stored.status === 'ready') return stored;
      this.assertPending(stored);
      const acquired = await this.syncs
        .findOneAndUpdate(
          {
            _id: syncId,
            userId: owner,
            status: 'awaiting_upload',
            $or: [
              { validationLeaseUntil: null },
              { validationLeaseUntil: trusted({ $lte: new Date() }) },
            ],
          },
          {
            $set: {
              validationToken: token,
              validationLeaseUntil: new Date(Date.now() + VALIDATION_LEASE_MS),
            },
          },
          { session, returnDocument: 'after', runValidators: true },
        )
        .lean();
      if (!acquired) throw jobError('JOB_STATE_CONFLICT');
      return acquired;
    });
    if (sync.status === 'ready') return this.present(sync);
    try {
      const original = await processingIo(() =>
        this.storage.findUploadedObject(sync.original),
      );
      const vocals = await processingIo(() =>
        this.storage.findUploadedObject(sync.vocals),
      );
      if (!original || !vocals) throw jobError('UPLOAD_NOT_READY');
      const measured = await processingIo(() =>
        this.validation.validate(sync, { original, vocals }),
      );
      await reauthorize();
      const committed = await this.transactions.run(async (session) => {
        await this.assertAccess(owner, authTimeSec, session);
        const current = await this.owned(owner, syncId, session);
        if (current.status === 'ready') return current;
        this.assertPending(current);
        if (
          current.validationToken !== token ||
          !current.validationLeaseUntil ||
          current.validationLeaseUntil.getTime() <= Date.now()
        )
          throw jobError('JOB_STATE_CONFLICT');
        const policy = await this.policies.effective(
          owner,
          new Date(),
          session,
        );
        if (
          original.bytes > policy.values.maxPreparedAudioBytes ||
          vocals.bytes > policy.values.maxPreparedAudioBytes ||
          measured.originalDuration > policy.values.maxDurationSeconds ||
          measured.vocalsDuration > policy.values.maxDurationSeconds
        )
          throw jobError('MEDIA_TOO_LONG');
        const now = new Date();
        const [created] = await this.jobs.create(
          [
            {
              _id: current.jobId,
              userId: owner,
              logicalAudioId: current.jobId,
              requestId: current.requestId,
              requestHash: current.requestHash,
              sourceTitle: current.sourceTitle,
              displayName: current.sourceTitle,
              sourceKind: current.sourceKind,
              sourceUrl: current.sourceUrl,
              inputReservation: current.original,
              inputObject: original,
              outputObject: vocals,
              measuredDurationSeconds: measured.originalDuration,
              measuredOutputDurationSeconds: measured.vocalsDuration,
              recipeSnapshot: current.recipeSnapshot,
              status: 'ready',
              finishedAt: now,
              comparisonRanges: null,
              retryEligibility: {
                eligible: false,
                attemptsRemaining: 0,
                nextAttemptAt: null,
              },
              processingOrigin: 'local_device',
            },
          ],
          { session },
        );
        const job = created.toObject();
        await this.usage.recordLocalMediaUploads(job, session, now);
        await this.usage.recordRetainedCachedMedia(job, session, now);
        await this.jobs.db
          .model<NotificationOutbox>(NotificationOutbox.name)
          .updateOne(
            { jobId: job._id, outcome: 'ready' },
            {
              $setOnInsert: {
                jobId: job._id,
                userId: owner,
                outcome: 'ready',
                state: 'pending',
                nextAttemptAt: now,
                revision: 0,
              },
            },
            { session, upsert: true, setDefaultsOnInsert: true },
          );
        for (const artifact of [original, vocals])
          await this.cleanup.cancelScheduled(artifact.key, session);
        const updated = await this.syncs
          .findOneAndUpdate(
            {
              _id: syncId,
              userId: owner,
              validationToken: token,
              status: 'awaiting_upload',
            },
            {
              $set: {
                status: 'ready',
                committedAt: now,
                validationLeaseUntil: null,
                validationToken: null,
              },
              $inc: { revision: 1 },
            },
            { session, returnDocument: 'after', runValidators: true },
          )
          .lean();
        if (!updated) throw jobError('JOB_STATE_CONFLICT');
        return updated;
      });
      return this.present(committed);
    } finally {
      await this.syncs.updateOne(
        {
          _id: syncId,
          userId: owner,
          validationToken: token,
          status: 'awaiting_upload',
        },
        { $set: { validationToken: null, validationLeaseUntil: null } },
      );
    }
  }
  private async assertAccess(
    owner: Types.ObjectId,
    authTimeSec: number,
    session: ClientSession,
  ): Promise<void> {
    await this.access.assertActive(owner, session);
    const user = await this.users
      .findById(owner)
      .session(session)
      .select('sessionsRevokedAfterSec')
      .lean();
    if (
      !user ||
      !Number.isSafeInteger(authTimeSec) ||
      authTimeSec <= user.sessionsRevokedAfterSec
    )
      throw authError('UNAUTHENTICATED');
    if (await this.restrictions.current(owner, session))
      throw authError('ACCOUNT_RESTRICTED');
    await this.policies.touchGlobalFence(session);
  }
  private assertPending(sync: LocalMediaSync): void {
    if (sync.expiresAt.getTime() <= Date.now())
      throw jobError('UPLOAD_RESERVATION_EXPIRED');
    if (sync.status !== 'awaiting_upload') throw jobError('JOB_STATE_CONFLICT');
  }
  private async owned(
    owner: Types.ObjectId,
    id: Types.ObjectId,
    session?: ClientSession,
  ): Promise<LocalMediaSync> {
    const sync = await this.syncs
      .findOne({ _id: id, userId: owner })
      .session(session ?? null)
      .lean();
    if (!sync) throw jobError('JOB_NOT_FOUND');
    if (
      sync.status === 'ready' &&
      !(await this.jobs
        .exists({ _id: sync.jobId, userId: owner, deletedAt: null })
        .session(session ?? null))
    )
      throw jobError('JOB_NOT_FOUND');
    return sync;
  }
  private present(
    sync: LocalMediaSync,
    uploadGrants: LocalMediaSyncView['uploadGrants'] = null,
  ): LocalMediaSyncView {
    return {
      syncId: sync._id.toHexString(),
      jobId: sync.jobId.toHexString(),
      requestId: sync.requestId,
      status:
        sync.status === 'ready'
          ? 'ready'
          : sync.expiresAt.getTime() <= Date.now()
            ? 'expired'
            : 'awaiting_upload',
      expiresAt: sync.expiresAt.toISOString(),
      profileId: LOCAL_MEDIA_PROFILE_ID,
      committed: sync.status === 'ready',
      revision: sync.revision,
      uploadGrants,
    };
  }
  private async withGrants(
    sync: LocalMediaSync,
    requestId: string,
    authTimeSec: number,
  ): Promise<LocalMediaSyncView> {
    if (sync.status === 'ready')
      return this.present(await this.owned(sync.userId, sync._id));
    this.assertPending(sync);
    const grant = sync.grants.find((item) => item.requestId === requestId);
    if (!grant || grant.expiresAt.getTime() <= Date.now())
      throw jobError('UPLOAD_RESERVATION_EXPIRED');
    const original: UploadGrant = await processingIo(() =>
      this.storage.createWorkerOutputGrant(sync.original, grant.expiresAt),
    );
    const vocals: UploadGrant = await processingIo(() =>
      this.storage.createWorkerOutputGrant(sync.vocals, grant.expiresAt),
    );
    await this.transactions.run((session) =>
      this.assertAccess(sync.userId, authTimeSec, session),
    );
    return this.present(sync, { original, vocals });
  }
}
