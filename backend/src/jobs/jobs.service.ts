import type { ImportMeasurements } from './job-stage-timing.js';
import { normalizeExtraData, type JobExtraData } from './job-extra-data.js';
import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { Types, type Model } from 'mongoose';
import { ProcessingAdmissionService } from '../admin-settings/processing-admission.service.js';
import { authError } from '../auth/auth.errors.js';
import type { ProcessingTransactionDiagnostics } from '../processing/processing-diagnostics.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { processingIo } from '../processing/processing-io.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import {
  isStorageEtag,
  validateObjectReservation,
} from '../storage/object-identity.js';
import { isSharedMediaObjectKey } from '../shared-media/shared-media-key.js';
import { NotificationOutbox } from '../notifications/notification-outbox.schema.js';
import { AccountAccessService } from '../users/account-access.service.js';
import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { jobError } from './job-errors.js';
import { normalizeJobMetadata, type JobMetadata } from './job-metadata.js';
import { isDuplicateKey, objectId, requestHash } from './job-request.js';
import { Job } from './job.schema.js';
import { assertInputDeclaration } from './job-state.js';
import type {
  InputDeclaration,
  ObjectIdentity,
  WorkerRecipeSnapshot,
} from './job.types.js';
import { validComparisonRanges } from './comparison-ranges.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  isWorkerRecipeSnapshot,
  workerRecipeSnapshot,
} from './worker-recipes.js';
import { WorkerHintService } from '../worker-hints/worker-hint.service.js';
import { assertJobRequestNotPurged } from './purged-job-request.js';

const UPLOAD_EXPIRY_GRACE_MS = 300_000;
const TRANSFER_SETTLEMENT_MS = 3_600_000;

export interface SharedJobInput {
  input: InputDeclaration;
  inputObject: ObjectIdentity;
  outputObject: ObjectIdentity;
  recipeSnapshot: WorkerRecipeSnapshot;
  metadata: JobMetadata & { extraData?: JobExtraData | null };
  comparisonRanges: number[][] | null;
  sourceKey: string;
  resultKey: string;
}

interface SharedImportMeasurements extends ImportMeasurements {
  acquisitionId?: string;
}

interface SharedJobReservation extends Omit<SharedJobInput, 'outputObject'> {
  requestedTrimEnabled?: boolean;
  outputObject?: ObjectIdentity;
  serverTiming?: SharedImportMeasurements;
  acquisitionId?: string;
  importReservationId?: Types.ObjectId;
}

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

  /** Create an account-owned Library entry referencing permanent shared media. */
  async createFromCache(
    userId: string,
    requestId: string,
    cached: SharedJobInput,
    acquisitionId?: string,
    importReservationId?: Types.ObjectId,
  ): Promise<{ jobId: string }> {
    return this.createSharedJob(userId, requestId, {
      ...cached,
      acquisitionId,
      importReservationId,
    });
  }

  /** Queue an already verified shared URL input without an upload entitlement. */
  async createForSharedInput(
    userId: string,
    input: InputDeclaration,
    requestId: string,
    metadata: JobMetadata,
    trimEnabled: boolean,
    inputObject: ObjectIdentity,
    sourceKey: string,
    resultKey: string,
    serverTiming?: SharedImportMeasurements,
    extraData: JobExtraData | null = null,
    importReservationId?: Types.ObjectId,
    frozenRecipe?: WorkerRecipeSnapshot,
    requestedTrimEnabled?: boolean,
  ): Promise<{ jobId: string }> {
    if (
      typeof trimEnabled !== 'boolean' ||
      (requestedTrimEnabled !== undefined &&
        typeof requestedTrimEnabled !== 'boolean') ||
      (frozenRecipe && frozenRecipe.trimEnabled !== trimEnabled)
    )
      throw authError('INVALID_INPUT');
    return this.createSharedJob(userId, requestId, {
      input,
      inputObject,
      sourceKey,
      resultKey,
      recipeSnapshot:
        frozenRecipe ??
        workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, trimEnabled),
      metadata: { ...metadata, extraData },
      comparisonRanges: null,
      serverTiming,
      acquisitionId: serverTiming?.acquisitionId,
      importReservationId,
      ...(requestedTrimEnabled === undefined ? {} : { requestedTrimEnabled }),
    });
  }

  private async createSharedJob(
    userId: string,
    requestId: string,
    shared: SharedJobReservation,
  ): Promise<{ jobId: string }> {
    const metadata = normalizeJobMetadata(shared.metadata);
    if (
      metadata.sourceKind !== 'url' ||
      !['youtube', 'audio_file'].includes(metadata.source ?? '') ||
      !/^[a-f0-9]{64}$/.test(shared.sourceKey) ||
      !/^[a-f0-9]{64}$/.test(shared.resultKey) ||
      !isUUID(requestId, '4')
    )
      throw authError('INVALID_INPUT');
    assertInputDeclaration(shared.input);
    this.assertSharedObject(shared.inputObject, shared.sourceKey, 'input');
    if (
      shared.inputObject.bytes !== shared.input.bytes ||
      shared.inputObject.sha256 !== shared.input.sha256 ||
      shared.inputObject.contentType !== shared.input.contentType
    )
      throw authError('INVALID_INPUT');
    const recipe = shared.recipeSnapshot;
    if (!isWorkerRecipeSnapshot(recipe)) throw authError('INVALID_INPUT');
    if (shared.outputObject) {
      this.assertSharedObject(shared.outputObject, shared.resultKey, 'output');
      if (
        shared.outputObject.contentType !== 'audio/mpeg' ||
        (shared.comparisonRanges !== null &&
          !validComparisonRanges(shared.comparisonRanges))
      )
        throw authError('INVALID_INPUT');
    }
    requestId = requestId.toLowerCase();
    const owner = objectId(userId);
    const hash = requestHash({
      operation: 'create_shared',
      input: shared.input,
      metadata,
      sourceKey: shared.sourceKey,
      resultKey: shared.resultKey,
      recipeDigest: recipe.recipeDigest,
      ...(shared.requestedTrimEnabled === undefined
        ? {}
        : { requestedTrimEnabled: shared.requestedTrimEnabled }),
    });
    const diagnostics: ProcessingTransactionDiagnostics | undefined =
      shared.acquisitionId
        ? {
            operation: 'url-import-handoff',
            acquisitionId: shared.acquisitionId,
            step: 'idempotency-read',
          }
        : undefined;
    let job = await this.jobs.findOne({ userId: owner, requestId }).lean();
    if (!job) {
      const id = new Types.ObjectId();
      try {
        job = await this.transactions.run(
          async (session) => {
            if (diagnostics) diagnostics.step = 'idempotency-read';
            const repeated = await this.jobs
              .findOne({ userId: owner, requestId })
              .session(session)
              .lean();
            if (repeated) return repeated;
            if (diagnostics) diagnostics.step = 'purged-request-check';
            await assertJobRequestNotPurged(
              this.jobs,
              owner,
              requestId,
              hash,
              session,
            );
            if (diagnostics) diagnostics.step = 'admission';
            const { admissionSnapshot, policy } = shared.outputObject
              ? await this.admission.assertCachedWorkWithPolicy(
                  owner,
                  shared.input,
                  session,
                  metadata,
                  shared.importReservationId,
                )
              : await this.admission.assertNewWorkWithPolicy(
                  owner,
                  shared.input,
                  session,
                  id,
                  metadata,
                  shared.importReservationId,
                );
            const now = new Date();
            const ready = Boolean(shared.outputObject);
            const accountFreshTransfer = Boolean(shared.importReservationId);
            if (diagnostics) diagnostics.step = 'job-create';
            const [created] = await this.jobs.create(
              [
                {
                  _id: id,
                  userId: owner,
                  logicalAudioId: id,
                  requestId,
                  requestHash: hash,
                  sourceTitle: metadata.sourceTitle ?? null,
                  displayName: metadata.sourceTitle ?? null,
                  sourceKind: metadata.sourceKind,
                  sourceUrl: metadata.sourceUrl ?? null,
                  extra_data: normalizeExtraData(shared.metadata.extraData),
                  clientStartedAt: metadata.clientStartedAt
                    ? new Date(metadata.clientStartedAt)
                    : null,
                  sharedSourceKey: shared.sourceKey,
                  sharedResultKey: shared.resultKey,
                  inputReservation: {
                    ...shared.input,
                    key: shared.inputObject.key,
                  },
                  inputObject: accountFreshTransfer ? null : shared.inputObject,
                  outputObject: shared.outputObject ?? null,
                  measuredDurationSeconds: shared.input.durationSeconds,
                  ...(ready && shared.comparisonRanges
                    ? {
                        measuredOutputDurationSeconds:
                          shared.comparisonRanges.reduce(
                            (sum, [start, end]) => sum + end! - start!,
                            0,
                          ) / 44100,
                      }
                    : {}),
                  recipeSnapshot: recipe,
                  requestedTrimEnabled: shared.requestedTrimEnabled ?? null,
                  admissionSnapshot,
                  status: ready ? 'ready' : 'queued',
                  finishedAt: ready ? now : null,
                  comparisonRanges: ready ? shared.comparisonRanges : null,
                  retryEligibility: {
                    eligible: !ready,
                    attemptsRemaining: ready
                      ? 0
                      : admissionSnapshot.maxInfrastructureAttempts,
                    nextAttemptAt: null,
                  },
                  ...(ready
                    ? {}
                    : {
                        queuedAt: now,
                        serverTimingStartedAt:
                          shared.serverTiming?.startedAt ?? now,
                        queueTimingStartedAt: now,
                        importStageTimings: shared.serverTiming?.stages ?? [],
                        queueAccumulatedMs: 0,
                        retryWaitAccumulatedMs: 0,
                        processingAccumulatedMs: 0,
                      }),
                },
              ],
              { session },
            );
            const result = created.toObject();
            if (accountFreshTransfer) {
              // Account the first server acquisition using the established upload
              // receipts. No second PUT/grant is needed for the verified shared key.
              if (diagnostics) diagnostics.step = 'upload-reservation';
              await this.usage.reserveUploadGrant(
                result,
                requestId,
                session,
                now,
                policy,
              );
              if (diagnostics) diagnostics.step = 'upload-confirmation';
              await this.usage.confirmUploadBytes(
                result,
                shared.input.bytes,
                session,
                now,
                policy,
              );
              if (diagnostics) diagnostics.step = 'input-attachment';
              const attached = await this.jobs.updateOne(
                {
                  _id: id,
                  userId: owner,
                  status: ready ? 'ready' : 'queued',
                  inputObject: null,
                },
                {
                  $set: { inputObject: shared.inputObject },
                  $inc: { revision: 1 },
                },
                { session, runValidators: true },
              );
              if (attached.modifiedCount !== 1)
                throw jobError('JOB_STATE_CONFLICT');
            }
            if (ready) {
              if (diagnostics) diagnostics.step = 'retained-media';
              await this.usage.recordRetainedCachedMedia(
                { ...result, inputObject: shared.inputObject },
                session,
                now,
                policy,
              );
              if (diagnostics) diagnostics.step = 'notification-outbox';
              await this.jobs.db
                .model<NotificationOutbox>(NotificationOutbox.name)
                .updateOne(
                  { jobId: id, outcome: 'ready' },
                  {
                    $setOnInsert: {
                      jobId: id,
                      userId: owner,
                      outcome: 'ready',
                      state: 'pending',
                      nextAttemptAt: now,
                      revision: 0,
                    },
                  },
                  { session, upsert: true, setDefaultsOnInsert: true },
                );
            }
            if (diagnostics) diagnostics.step = 'commit';
            return { ...result, inputObject: shared.inputObject };
          },
          diagnostics,
          { serializeHandoff: true },
        );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        job = await this.jobs.findOne({ userId: owner, requestId }).lean();
      }
    }
    if (!job) throw new Error('Shared job reservation unavailable');
    if (job.requestHash !== hash) throw jobError('IDEMPOTENCY_CONFLICT');
    if (job.deletedAt) throw jobError('JOB_NOT_FOUND');
    const current = await this.findOwned(userId, job._id.toHexString());
    if (current.status === 'queued')
      void this.hints?.publish('work_available').catch(() => undefined);
    return { jobId: job._id.toHexString() };
  }

  private assertSharedObject(
    object: ObjectIdentity,
    assetKey: string,
    kind: 'input' | 'output',
  ): void {
    try {
      validateObjectReservation(object);
      if (
        !isStorageEtag(object.etag) ||
        !isSharedMediaObjectKey(object.key, assetKey, kind)
      )
        throw new TypeError('Invalid shared media identity');
    } catch {
      throw authError('INVALID_INPUT');
    }
  }

  async create(
    userId: string,
    input: InputDeclaration,
    requestId: string,
    metadata: JobMetadata = {},
    trimEnabled = true,
    serverTiming?: ImportMeasurements,
    extraData: JobExtraData | null = null,
    importReservationId?: Types.ObjectId,
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
          await assertJobRequestNotPurged(
            this.jobs,
            owner,
            requestId,
            hash,
            session,
          );
          const admissionSnapshot = await this.admission.assertNewWork(
            owner,
            input,
            session,
            id,
            normalized,
            importReservationId,
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
                extra_data: normalizeExtraData(extraData),
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
        await this.transactions.run(async (session) => {
          const pending = await this.jobs
            .findOne({
              _id: job._id,
              userId: job.userId,
              deletedAt: null,
              status: 'awaiting_upload',
              inputObject: null,
            })
            .session(session);
          if (!pending) return;
          await this.cleanup.schedule(
            {
              key: pending.inputReservation.key,
              ownerUserId: pending.userId,
              reason: 'AUDIO_INPUT_INVALID',
              nextAt: due,
              settleUntil: new Date(due.getTime() + TRANSFER_SETTLEMENT_MS),
            },
            session,
          );
          // Competes with successful confirmation before the cleanup task commits.
          const touched = await this.jobs.updateOne(
            {
              _id: pending._id,
              revision: pending.revision,
              status: 'awaiting_upload',
              inputObject: null,
            },
            { $inc: { revision: 1 } },
            { session },
          );
          if (touched.modifiedCount !== 1) throw jobError('JOB_STATE_CONFLICT');
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
    await this.access.assertActiveReadOnly(userId);
    const job = await this.jobs
      .findOne({ _id: objectId(jobId), userId: objectId(userId) })
      .lean();
    if (!job || job.deletedAt) throw jobError('JOB_NOT_FOUND');
    await this.access.assertActiveReadOnly(userId);
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
