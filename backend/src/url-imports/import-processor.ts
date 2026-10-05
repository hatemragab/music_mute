import { elapsedMs, type StageMeasurement } from '../jobs/job-stage-timing.js';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { SharedMediaService } from '../shared-media/shared-media.service.js';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job as QueueJob } from 'bullmq';
import { trusted, type Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { JobsService } from '../jobs/jobs.service.js';
import { JobActionsService } from '../jobs/job-actions.service.js';
import { Job } from '../jobs/job.schema.js';
import { PREPARATION_PROFILE_ID } from '../jobs/job.types.js';
import { IMPORT_QUEUE, ImportsService } from './imports.service.js';
import { MediaImport, type ImportState } from './media-import.schema.js';
import { AudioAcquisitionClient } from './audio-acquisition-client.js';
import { ImportFiles } from './import-files.js';
import { probeImport } from './import-probe.js';
import { importError, safeImportError } from './import-errors.js';
import { safeProcessingFailure } from '../processing/processing-diagnostics.js';
import {
  handoffAttemptFilter,
  MAX_ACQUISITION_ATTEMPTS,
} from './import-retry.js';

type SharedSubmissionStep =
  | 'account-check'
  | 'job-creation'
  | 'import-metadata'
  | 'job-association'
  | 'import-finish';

@Injectable()
@Processor(IMPORT_QUEUE, { autorun: false, concurrency: 1, maxStalledCount: 0 })
export class ImportProcessor extends WorkerHost {
  private readonly logger = new Logger(ImportProcessor.name);
  readonly files: ImportFiles;
  readonly shutdown = new AbortController();

  constructor(
    private readonly imports: ImportsService,
    private readonly downloader: AudioAcquisitionClient,
    private readonly jobs: JobsService,
    private readonly actions: JobActionsService,
    private readonly config: ConfigService,
    @InjectModel(Job.name) private readonly jobRecords: Model<Job>,
    @Optional() private readonly shared?: SharedMediaService,
  ) {
    super();
    this.files = new ImportFiles(
      config.getOrThrow<string>('URL_IMPORT_TEMP_ROOT'),
      config.getOrThrow<number>('URL_IMPORT_MIN_FREE_BYTES'),
    );
  }

  async process(
    job: QueueJob<{
      importId: string;
      attempt?: number;
      handoffAttempt?: number;
    }>,
  ): Promise<void> {
    const expectedAttempt = job.data.attempt ?? 1;
    const handoffAttempt = job.data.handoffAttempt;
    const handoff = handoffAttempt !== undefined;
    if (
      handoff
        ? !Number.isSafeInteger(handoffAttempt) ||
          handoffAttempt < 1 ||
          job.data.attempt !== undefined
        : !Number.isSafeInteger(expectedAttempt) ||
          expectedAttempt < 1 ||
          expectedAttempt > MAX_ACQUISITION_ATTEMPTS
    )
      return;
    const executionId = randomUUID();
    const claimedAt = new Date();
    const record = await this.imports.records
      .findOneAndUpdate(
        handoff
          ? {
              _id: job.data.importId,
              status: 'queued',
              handoffPending: true,
              handoffAttempt,
              $or: [
                { nextAttemptAt: null },
                { nextAttemptAt: trusted({ $lte: claimedAt }) },
              ],
            }
          : {
              _id: job.data.importId,
              status: 'queued',
              handoffPending: trusted({ $ne: true }),
              $and: [
                {
                  $or: [
                    { acquisitionAttempt: expectedAttempt - 1 },
                    ...(expectedAttempt === 1
                      ? [{ acquisitionAttempt: trusted({ $exists: false }) }]
                      : []),
                  ],
                },
                {
                  $or: [
                    { nextAttemptAt: null },
                    { nextAttemptAt: trusted({ $lte: new Date() }) },
                  ],
                },
              ],
              $expr: trusted({
                $lt: [
                  { $ifNull: ['$acquisitionAttempt', 0] },
                  { $ifNull: ['$maxAcquisitionAttempts', 1] },
                ],
              }),
            },
        [
          {
            $set: {
              status: handoff ? 'uploading' : 'downloading',
              executionId,
              nextAttemptAt: null,
              error: null,
              deadlineAt: new Date(claimedAt.getTime() + 15 * 60_000),
              // The first active claim excludes initial queue time. Retries
              // retain it so adapters can enforce one import-wide budget.
              ...(handoff
                ? {}
                : {
                    acquisitionStartedAt: {
                      $ifNull: ['$acquisitionStartedAt', claimedAt],
                    },
                    acquisitionAttempt: expectedAttempt,
                  }),
            },
          },
        ],
        { returnDocument: 'after', updatePipeline: true },
      )
      .lean();
    if (!record) return;
    // Preparation must consume the persisted execution budget, rather than
    // starting a new full transfer lifetime after slow dependency reads.
    const remainingMs = record.deadlineAt!.getTime() - Date.now();
    const executionSignal = AbortSignal.any([
      this.shutdown.signal,
      remainingMs > 0 ? AbortSignal.timeout(remainingMs) : AbortSignal.abort(),
    ]);
    const queueMs = elapsedMs(record.queuedAt ?? record.createdAt, new Date());
    const stages: StageMeasurement[] = (record.stageTimings ?? []).map(
      (stage) => ({ ...stage }),
    );
    if (queueMs !== null) {
      const queued = stages.find((stage) => stage.stage === 'import-queue');
      if (queued) queued.durationMs += queueMs;
      else
        stages.push({
          stage: 'import-queue',
          durationMs: queueMs,
          complete: true,
        });
    }
    let activeStage = 'shared-inspection';
    let timingJobId: string | null = null;
    const saveTimings = () =>
      this.observeTimings(record, async () => {
        await this.imports.records.updateOne(
          { _id: record._id, executionId, ...handoffAttemptFilter(record) },
          { $set: { stageTimings: stages } },
          { runValidators: true },
        );
        if (timingJobId)
          await this.jobRecords.updateOne(
            { _id: timingJobId, userId: record.userId },
            { $set: { importStageTimings: stages } },
            { runValidators: true },
          );
      });
    const measure = async <T>(
      stage: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      activeStage = stage;
      let entry = stages.find((candidate) => candidate.stage === stage);
      if (!entry) {
        entry = { stage, durationMs: 0, complete: false };
        stages.push(entry);
      }
      entry.complete = false;
      this.logger.log({
        event: 'import-stage',
        acquisition_id: executionId,
        stage,
        state: 'started',
      });
      await saveTimings();
      const start = performance.now();
      try {
        const result = await operation();
        entry.complete = true;
        return result;
      } finally {
        const durationMs = Math.round(performance.now() - start);
        entry.durationMs += durationMs;
        this.logger.log({
          event: 'import-stage',
          acquisition_id: executionId,
          stage,
          state: entry.complete ? 'completed' : 'failed',
          duration_ms: durationMs,
        });
        await saveTimings();
      }
    };
    try {
      executionSignal.throwIfAborted();
      if (record.handoffPending) {
        // Creation may have committed before its receipt or import metadata was saved.
        // Resolve that original UUID before inspecting or submitting any new work.
        const accepted = await this.jobRecords
          .findOne({ userId: record.userId, requestId: record.jobRequestId })
          .lean();
        executionSignal.throwIfAborted();
        if (accepted?.inputObject) {
          timingJobId = accepted._id.toHexString();
          await this.finish(record, 'submitted', timingJobId);
          await saveTimings();
          return;
        }
      }
      const cached = await this.shared?.inspect(record);
      executionSignal.throwIfAborted();
      if (record.handoffPending && !this.confirmedHandoff(record, cached))
        throw importError(
          cached?.action === 'wait'
            ? 'IMPORT_DEPENDENCY_FAILED'
            : 'IMPORT_SOURCE_UNAVAILABLE',
        );
      if (cached && (cached.action === 'failed' || cached.action === 'wait'))
        throw importError('IMPORT_DEPENDENCY_FAILED');
      if (
        cached &&
        (cached.action === 'source' || cached.action === 'result')
      ) {
        activeStage = 'job-submission';
        timingJobId = await this.submitShared(
          record,
          cached,
          stages,
          Boolean(record.acquisitionReservedAt),
        );
        await saveTimings();
        return;
      }
      activeStage = 'acquisition-reservation';
      const limits = await this.imports.reserveAcquisition(record);
      executionSignal.throwIfAborted();
      await this.files.withFile(async (path, signal) => {
        const downloaded = await measure('source-download', () =>
          this.downloader.download(
            record.sourceUrl,
            this.files,
            path,
            limits,
            signal,
            executionId,
            {
              attempt: record.acquisitionAttempt,
              maxAttempts: record.maxAcquisitionAttempts ?? 1,
              startedAt: record.acquisitionStartedAt!,
            },
          ),
        );
        await this.stage(record, 'validating', signal);
        const measured = await measure('source-validation', () =>
          probeImport(
            path,
            limits.maxDuration,
            signal,
            this.config.getOrThrow<string>('URL_IMPORT_FFPROBE_PATH'),
          ),
        );
        const {
          sourceTitle: downloadedTitle,
          extraData,
          ...audio
        } = downloaded;
        const sourceTitle = record.sourceTitle ?? downloadedTitle ?? null;
        if (sourceTitle) {
          const savedTitle = await this.imports.records.updateOne(
            {
              _id: record._id,
              executionId,
              ...handoffAttemptFilter(record),
              status: 'validating',
            },
            { $set: { sourceTitle } },
          );
          if (savedTitle.matchedCount !== 1)
            throw importError('IMPORT_DEPENDENCY_FAILED');
        }
        const input = { ...audio, ...measured };
        await this.imports.assertAccountAllowed(record.userId);
        await this.stage(record, 'uploading', signal);
        if (record.sharedSourceKey && this.shared) {
          const included = extraData
            ? {
                ...extraData,
                duration_seconds: measured.durationSeconds,
                file_bytes: audio.bytes,
              }
            : null;
          const sourceReservation = await this.shared.reserveSource(
            record,
            input,
            sourceTitle,
            included,
          );
          const upload = await this.shared.sourceGrant(sourceReservation);
          await measure('source-upload', async () => {
            const body = createReadStream(path);
            try {
              const response = await fetch(upload.url, {
                method: 'PUT',
                headers: {
                  ...upload.headers,
                  'Content-Length': String(input.bytes),
                },
                redirect: 'error',
                signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
                body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
                duplex: 'half',
              } as RequestInit & { duplex: 'half' });
              await response.body?.cancel();
              if (!response.ok && response.status !== 412)
                throw importError('IMPORT_DEPENDENCY_FAILED');
            } finally {
              body.destroy();
            }
          });
          const identity = await measure('upload-confirmation', () =>
            this.shared!.verifySource(sourceReservation),
          );
          await measure('shared-source-confirmation', () =>
            this.shared!.confirmSource(record, identity, sourceTitle, included),
          );
          const confirmed = await this.shared.inspect(record);
          if (confirmed?.action !== 'source')
            throw importError('IMPORT_DEPENDENCY_FAILED');
          activeStage = 'job-submission';
          timingJobId = await this.submitShared(
            record,
            confirmed,
            stages,
            true,
          );
          return;
        }
        const reserved = await this.jobs.create(
          record.userId.toHexString(),
          input,
          record.jobRequestId,
          {
            policyVersion: 2,
            preparationProfileId: PREPARATION_PROFILE_ID,
            source: record.provider === 'youtube' ? 'youtube' : 'audio_file',
            sourceKind: 'url',
            ...(sourceTitle ? { sourceTitle } : {}),
            ...(record.provider === 'youtube'
              ? { sourceUrl: record.sourceUrl }
              : {}),
          },
          record.trimEnabled ?? true,
          { startedAt: record.createdAt, stages },
          extraData
            ? {
                ...extraData,
                duration_seconds: measured.durationSeconds,
                file_bytes: audio.bytes,
              }
            : null,
          record._id,
        );
        timingJobId = reserved.id;
        const saved = await this.imports.records.updateOne(
          {
            _id: record._id,
            executionId,
            ...handoffAttemptFilter(record),
            status: 'uploading',
          },
          { $set: { jobId: reserved.id, input } },
        );
        if (saved.modifiedCount !== 1)
          throw importError('IMPORT_DEPENDENCY_FAILED');
        signal.throwIfAborted();
        if (reserved.upload) {
          const upload = reserved.upload;
          await measure('source-upload', async () => {
            // Use the existing signed immutable PUT contract, including checksum and length.
            const body = createReadStream(path);
            const uploadSignal = AbortSignal.any([
              signal,
              AbortSignal.timeout(120_000),
            ]);
            try {
              const response = await fetch(upload.url, {
                method: 'PUT',
                headers: {
                  ...upload.headers,
                  // A stream has no inferred length; the storage signer binds the measured byte count.
                  'Content-Length': String(downloaded.bytes),
                },
                redirect: 'error',
                signal: uploadSignal,
                body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
                duplex: 'half',
              } as RequestInit & { duplex: 'half' });
              await response.body?.cancel();
              // A lost successful response/immutable replay is resolved by confirmUpload's HEAD checks.
              if (!response.ok && response.status !== 412)
                throw importError('IMPORT_DEPENDENCY_FAILED');
            } finally {
              body.destroy();
            }
          });
        }
        signal.throwIfAborted();
        await this.imports.assertAccountAllowed(record.userId);
        await measure('upload-confirmation', () =>
          this.jobs.confirmUpload(record.userId.toHexString(), reserved.id),
        );
        await this.finish(record, 'submitted', reserved.id);
      }, executionSignal);
    } catch (error) {
      this.logger.error({
        event: 'import-failure',
        acquisition_id: executionId,
        code: safeImportError(error).code,
        stage: activeStage,
        attempt: record.acquisitionAttempt,
        handoff_attempt: record.handoffAttempt ?? 0,
        failure: safeProcessingFailure(error),
      });
      try {
        await this.reconcileFailure(record, error);
      } catch (recoveryError) {
        this.logger.error({
          event: 'import-reconciliation',
          acquisition_id: executionId,
          attempt: record.acquisitionAttempt,
          handoff_attempt: record.handoffAttempt ?? 0,
          result: 'PENDING',
          failure: safeProcessingFailure(recoveryError),
          original_failure: safeProcessingFailure(error),
        });
        throw recoveryError;
      }
    }
  }

  private async stage(
    record: MediaImport,
    status: ImportState,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const changed = await this.imports.records.updateOne(
      {
        _id: record._id,
        executionId: record.executionId,
        ...handoffAttemptFilter(record),
        status: trusted({
          $in: ['downloading', 'validating', 'uploading'] as const,
        }),
      },
      { $set: { status } },
    );
    if (changed.matchedCount !== 1)
      throw importError('IMPORT_DEPENDENCY_FAILED');
  }

  private confirmedHandoff(
    record: MediaImport,
    cached: Awaited<ReturnType<SharedMediaService['inspect']>> | undefined,
  ): boolean {
    return Boolean(
      cached &&
      (cached.action === 'source' || cached.action === 'result') &&
      record.sharedSourceKey &&
      record.sharedResultKey &&
      cached.source?._id === record.sharedSourceKey &&
      (cached.result?._id === record.sharedResultKey ||
        cached.result?.derivedFromResultKey === record.sharedResultKey) &&
      cached.source.input &&
      cached.source.inputObject &&
      (cached.action !== 'result' || cached.result.outputObject),
    );
  }

  private async submitShared(
    record: MediaImport,
    cached: NonNullable<Awaited<ReturnType<SharedMediaService['inspect']>>>,
    stages: StageMeasurement[],
    acquired = false,
  ): Promise<string> {
    let entry = stages.find((stage) => stage.stage === 'job-submission');
    if (!entry) {
      entry = { stage: 'job-submission', durationMs: 0, complete: false };
      stages.push(entry);
    }
    entry.complete = false;
    const saveTimings = () =>
      this.observeTimings(record, async () => {
        await this.imports.records.updateOne(
          {
            _id: record._id,
            executionId: record.executionId,
            ...handoffAttemptFilter(record),
          },
          { $set: { stageTimings: stages } },
          { runValidators: true },
        );
      });
    await saveTimings();
    const started = performance.now();
    let jobId: string | null = null;
    let step: SharedSubmissionStep = 'account-check';
    const context = {
      event: 'import-stage',
      acquisition_id: record.executionId,
      attempt: record.acquisitionAttempt,
      handoff_attempt: record.handoffAttempt ?? 0,
      stage: 'job-submission',
      source_confirmed: Boolean(cached.source?.inputObject),
      cache_action: cached.action,
    };
    this.logger.log({ ...context, state: 'started' });
    try {
      jobId = await this.submitSharedJob(
        record,
        cached,
        stages,
        acquired,
        (value) => {
          step = value;
        },
      );
      entry.complete = true;
      return jobId;
    } catch (error) {
      this.logger.error({
        ...context,
        state: 'failed',
        step,
        duration_ms: Math.round(performance.now() - started),
        failure: safeProcessingFailure(error),
      });
      throw error;
    } finally {
      const durationMs = Math.round(performance.now() - started);
      entry.durationMs += durationMs;
      if (entry.complete)
        this.logger.log({
          ...context,
          state: 'completed',
          step,
          duration_ms: durationMs,
        });
      await saveTimings();
      if (jobId)
        await this.observeTimings(record, async () => {
          await this.jobRecords.updateOne(
            { _id: jobId, userId: record.userId },
            { $set: { importStageTimings: stages } },
            { runValidators: true },
          );
        });
    }
  }

  /** Observability writes cannot erase a command failure or fail an accepted job. */
  private async observeTimings(
    record: MediaImport,
    operation: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.logger.error({
        event: 'import-observation-failure',
        acquisition_id: record.executionId,
        attempt: record.acquisitionAttempt,
        operation: 'stage-timings',
        failure: safeProcessingFailure(error),
      });
    }
  }

  private async submitSharedJob(
    record: MediaImport,
    cached: NonNullable<Awaited<ReturnType<SharedMediaService['inspect']>>>,
    stages: StageMeasurement[],
    acquired: boolean,
    onStep: (step: SharedSubmissionStep) => void,
  ): Promise<string> {
    const source = cached.source!;
    const result = cached.result!;
    const metadata = {
      policyVersion: 2 as const,
      preparationProfileId: PREPARATION_PROFILE_ID,
      source:
        record.provider === 'youtube'
          ? ('youtube' as const)
          : ('audio_file' as const),
      sourceKind: 'url' as const,
      ...(source.sourceTitle ? { sourceTitle: source.sourceTitle } : {}),
      ...(record.provider === 'youtube' ? { sourceUrl: record.sourceUrl } : {}),
    };
    onStep('account-check');
    await this.imports.assertAccountAllowed(record.userId);
    onStep('job-creation');
    const reserved =
      cached.action === 'result'
        ? await this.jobs.createFromCache(
            record.userId.toHexString(),
            record.jobRequestId,
            {
              input: source.input!,
              inputObject: source.inputObject!,
              outputObject: result.outputObject!,
              recipeSnapshot: result.recipeSnapshot,
              metadata: { ...metadata, extraData: source.extraData },
              comparisonRanges: result.comparisonRanges,
              sourceKey: source._id,
              resultKey: result._id,
            },
            record.executionId ?? undefined,
            acquired ? record._id : undefined,
          )
        : await this.jobs.createForSharedInput(
            record.userId.toHexString(),
            source.input!,
            record.jobRequestId,
            metadata,
            result.recipeSnapshot.trimEnabled,
            source.inputObject!,
            source._id,
            result._id,
            {
              startedAt: record.createdAt,
              stages,
              acquisitionId: record.executionId ?? undefined,
            },
            source.extraData,
            acquired ? record._id : undefined,
            result.recipeSnapshot,
            (record.trimEnabled ?? true) !== result.recipeSnapshot.trimEnabled
              ? (record.trimEnabled ?? true)
              : undefined,
          );
    onStep('import-metadata');
    await this.imports.records.updateOne(
      {
        _id: record._id,
        executionId: record.executionId,
        ...handoffAttemptFilter(record),
      },
      { $set: { sourceTitle: source.sourceTitle, input: source.input } },
    );
    if (cached.action === 'source') {
      onStep('job-association');
      await this.shared!.associateJob(
        record,
        new this.jobRecords.base.Types.ObjectId(reserved.jobId),
      );
    }
    onStep('import-finish');
    await this.finish(record, 'submitted', reserved.jobId);
    return reserved.jobId;
  }

  async reconcileFailure(record: MediaImport, error: unknown): Promise<void> {
    const recoveryContext = {
      event: 'import-reconciliation',
      acquisition_id: record.executionId,
      attempt: record.acquisitionAttempt,
      handoff_attempt: record.handoffAttempt ?? 0,
    };
    this.logger.log({
      ...recoveryContext,
      result: 'STARTED',
      failure: safeProcessingFailure(error),
    });
    const fresh = await this.imports.records.findById(record._id).lean();
    if (
      !fresh ||
      fresh.executionId !== record.executionId ||
      (fresh.handoffAttempt ?? 0) !== (record.handoffAttempt ?? 0) ||
      (fresh.acquisitionAttempt ?? 0) !== (record.acquisitionAttempt ?? 0) ||
      !['queued', 'downloading', 'validating', 'uploading'].includes(
        fresh.status,
      )
    ) {
      this.logger.log({ ...recoveryContext, result: 'SUPERSEDED' });
      return;
    }
    record = fresh;
    // If confirmation committed just before a crash/network error, preserve its accepted job.
    const current = await this.jobRecords
      .findOne({ userId: record.userId, requestId: record.jobRequestId })
      .lean();
    if (current?.inputObject) {
      await this.finish(record, 'submitted', current._id.toHexString());
      this.logger.log({ ...recoveryContext, result: 'ACCEPTED_JOB_RECOVERED' });
      return;
    }
    let safeToAcquire = !record.sharedSourceKey;
    if (record.sharedSourceKey && this.shared) {
      // A lost PUT/confirmation response can still leave a verified immutable source.
      // A storage outage leaves recovery pending; it never repeats paid acquisition.
      await this.shared.recoverSource(record);
      const cached = await this.shared.inspect(record);
      safeToAcquire = cached?.action === 'acquire' && !cached.source?.inputKey;
      if (
        record.handoffPending &&
        cached?.action !== 'wait' &&
        !this.confirmedHandoff(record, cached)
      ) {
        // An explicit absent or incompatible immutable catalogue is permanent.
        // Dependency exceptions above remain active for runtime reconciliation.
        error = importError('IMPORT_SOURCE_UNAVAILABLE');
      } else if (cached?.action === 'source' || cached?.action === 'result') {
        const fresh = await this.imports.records.findById(record._id).lean();
        if (
          fresh &&
          fresh.executionId === record.executionId &&
          (fresh.handoffAttempt ?? 0) === (record.handoffAttempt ?? 0) &&
          (fresh.acquisitionAttempt ?? 0) ===
            (record.acquisitionAttempt ?? 0) &&
          ['downloading', 'validating', 'uploading'].includes(fresh.status)
        ) {
          try {
            await this.submitShared(
              fresh,
              cached,
              fresh.stageTimings,
              Boolean(fresh.acquisitionReservedAt),
            );
            this.logger.log({
              ...recoveryContext,
              result: 'CONFIRMED_SOURCE_SUBMITTED',
            });
            return;
          } catch (recoveryError) {
            this.logger.error({
              ...recoveryContext,
              result: 'SUBMISSION_RECOVERY_FAILED',
              failure: safeProcessingFailure(recoveryError),
            });
            error = recoveryError;
            const safe = safeImportError(recoveryError);
            if (safe.code === 'IMPORT_DEPENDENCY_FAILED') {
              try {
                if (await this.imports.retryHandoff(fresh, safe)) {
                  this.logger.error({
                    ...recoveryContext,
                    result: 'HANDOFF_RETRY_QUEUED',
                    handoff_attempt: (fresh.handoffAttempt ?? 0) + 1,
                    failure: safeProcessingFailure(recoveryError),
                  });
                  return;
                }
                // A lost dependency read or superseded CAS never authorizes another download.
                throw recoveryError;
              } catch (retryError) {
                if (
                  safeImportError(retryError).code ===
                  'IMPORT_DEPENDENCY_FAILED'
                )
                  throw retryError;
                error = retryError;
              }
            }
          }
        }
      }
    }
    // A durable handoff can wait for its confirmed catalogue to recover, but can
    // never fall through to a paid acquisition if inspection temporarily changes.
    if (
      record.handoffPending &&
      safeImportError(error).code === 'IMPORT_DEPENDENCY_FAILED'
    )
      throw error;
    if (!current && safeToAcquire) {
      try {
        if (
          await this.imports.retryAcquisition(record, safeImportError(error))
        ) {
          this.logger.log({
            ...recoveryContext,
            result: 'ACQUISITION_RETRY_QUEUED',
            next_attempt: (record.acquisitionAttempt ?? 0) + 1,
          });
          return;
        }
      } catch (retryError) {
        // Access/policy changes end the series. Dependency outages leave Mongo
        // recovery pending instead of manufacturing another paid execution.
        const safe = safeImportError(retryError);
        if (safe.code === 'IMPORT_DEPENDENCY_FAILED') throw retryError;
        error = retryError;
      }
    }
    const stillCurrent = await this.imports.records.findById(record._id).lean();
    if (
      !stillCurrent ||
      stillCurrent.executionId !== record.executionId ||
      (stillCurrent.handoffAttempt ?? 0) !== (record.handoffAttempt ?? 0) ||
      (stillCurrent.acquisitionAttempt ?? 0) !==
        (record.acquisitionAttempt ?? 0) ||
      stillCurrent.status !== record.status
    )
      return;
    await this.actions.cancelPendingUpload(
      record.userId.toHexString(),
      record.jobRequestId,
    );
    // Existing cancelled-job storage maintenance reclaims only this reservation's object key.
    await this.imports.failAcquisition(record, safeImportError(error));
    this.logger.error({
      ...recoveryContext,
      result: 'TERMINAL_FAILURE',
      code: safeImportError(error).code,
      safe_to_acquire: safeToAcquire,
      failure: safeProcessingFailure(error),
    });
  }

  private async finish(
    record: MediaImport,
    status: 'submitted',
    jobId: string,
  ) {
    await this.imports.records.updateOne(
      {
        _id: record._id,
        executionId: record.executionId,
        ...handoffAttemptFilter(record),
        status: trusted({
          $in: ['downloading', 'validating', 'uploading'] as const,
        }),
      },
      {
        $set: {
          status,
          finishedAt: new Date(),
          jobId,
          error: null,
          nextAttemptAt: null,
          handoffPending: false,
          expiresAt: new Date(Date.now() + 7 * 86400_000),
        },
      },
    );
  }
}
