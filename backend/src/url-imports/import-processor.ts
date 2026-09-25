import { Injectable } from '@nestjs/common';
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
import { YtdlpClient } from './ytdlp-client.js';
import { ImportFiles } from './import-files.js';
import { probeImport } from './import-probe.js';
import { importError, safeImportError } from './import-errors.js';

@Injectable()
@Processor(IMPORT_QUEUE, { autorun: false, concurrency: 1, maxStalledCount: 0 })
export class ImportProcessor extends WorkerHost {
  readonly files: ImportFiles;
  readonly shutdown = new AbortController();

  constructor(
    private readonly imports: ImportsService,
    private readonly downloader: YtdlpClient,
    private readonly jobs: JobsService,
    private readonly actions: JobActionsService,
    private readonly config: ConfigService,
    @InjectModel(Job.name) private readonly jobRecords: Model<Job>,
  ) {
    super();
    this.files = new ImportFiles(
      config.getOrThrow<string>('URL_IMPORT_TEMP_ROOT'),
      config.getOrThrow<number>('URL_IMPORT_MIN_FREE_BYTES'),
    );
  }

  async process(job: QueueJob<{ importId: string }>): Promise<void> {
    const executionId = randomUUID();
    const record = await this.imports.records
      .findOneAndUpdate(
        { _id: job.data.importId, status: 'queued' },
        {
          $set: {
            status: 'downloading',
            executionId,
            deadlineAt: new Date(Date.now() + 15 * 60_000),
          },
        },
        { returnDocument: 'after' },
      )
      .lean();
    if (!record) return;
    try {
      const limits = await this.imports.assertEligible(record.userId);
      await this.files.withFile(async (path, signal) => {
        const downloaded = await this.downloader.download(
          record.sourceUrl,
          this.files,
          path,
          limits,
          signal,
        );
        await this.stage(record, 'validating', signal);
        const measured = await probeImport(
          path,
          limits.maxDuration,
          signal,
          this.config.getOrThrow<string>('URL_IMPORT_FFPROBE_PATH'),
        );
        const { sourceTitle: downloadedTitle, ...audio } = downloaded;
        const sourceTitle = record.sourceTitle ?? downloadedTitle;
        if (sourceTitle) {
          const savedTitle = await this.imports.records.updateOne(
            { _id: record._id, executionId, status: 'validating' },
            { $set: { sourceTitle } },
          );
          if (savedTitle.matchedCount !== 1)
            throw importError('IMPORT_DEPENDENCY_FAILED');
        }
        const input = { ...audio, ...measured };
        await this.imports.assertAccountAllowed(record.userId);
        await this.stage(record, 'uploading', signal);
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
        );
        const saved = await this.imports.records.updateOne(
          { _id: record._id, executionId, status: 'uploading' },
          { $set: { jobId: reserved.id, input } },
        );
        if (saved.modifiedCount !== 1)
          throw importError('IMPORT_DEPENDENCY_FAILED');
        signal.throwIfAborted();
        if (reserved.upload) {
          // Use the existing signed immutable PUT contract, including checksum and length.
          const body = createReadStream(path);
          const uploadSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(120_000),
          ]);
          try {
            const response = await fetch(reserved.upload.url, {
              method: 'PUT',
              headers: {
                ...reserved.upload.headers,
                // A stream has no inferred length; S3 signs the measured byte count.
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
        }
        signal.throwIfAborted();
        await this.imports.assertAccountAllowed(record.userId);
        await this.jobs.confirmUpload(record.userId.toHexString(), reserved.id);
        await this.finish(record, 'submitted', reserved.id);
      }, this.shutdown.signal);
    } catch (error) {
      await this.reconcileFailure(record, error);
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
        status: trusted({
          $in: ['downloading', 'validating', 'uploading'] as const,
        }),
      },
      { $set: { status } },
    );
    if (changed.matchedCount !== 1)
      throw importError('IMPORT_DEPENDENCY_FAILED');
  }

  async reconcileFailure(record: MediaImport, error: unknown): Promise<void> {
    // If confirmation committed just before a crash/network error, preserve its accepted job.
    const current = await this.jobRecords
      .findOne({ userId: record.userId, requestId: record.jobRequestId })
      .lean();
    if (current?.inputObject) {
      await this.finish(record, 'submitted', current._id.toHexString());
      return;
    }
    await this.actions.cancelPendingUpload(
      record.userId.toHexString(),
      record.jobRequestId,
    );
    // Existing cancelled-job storage maintenance reclaims only this reservation's S3 key.
    await this.imports.records.updateOne(
      {
        _id: record._id,
        status: trusted({
          $in: ['queued', 'downloading', 'validating', 'uploading'] as const,
        }),
      },
      {
        $set: {
          status: 'failed',
          error: safeImportError(error),
          expiresAt: new Date(Date.now() + 7 * 86400_000),
        },
      },
    );
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
        status: trusted({
          $in: ['downloading', 'validating', 'uploading'] as const,
        }),
      },
      {
        $set: {
          status,
          jobId,
          error: null,
          expiresAt: new Date(Date.now() + 7 * 86400_000),
        },
      },
    );
  }
}
