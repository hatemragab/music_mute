import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImportFiles } from './import-files.js';
import { randomUUID } from 'node:crypto';
import { MAX_ACQUISITION_ATTEMPTS } from './import-retry.js';
import { importError } from './import-errors.js';

export type AcquisitionAttemptContext = {
  attempt: number;
  maxAttempts: number;
  startedAt: Date;
};

@Injectable()
export class AudioAcquisitionClient {
  constructor(private readonly config: ConfigService) {}

  async download(
    url: string,
    files: ImportFiles,
    path: string,
    limits: { maxBytes: number; maxDuration: number },
    signal: AbortSignal,
    acquisitionId: string = randomUUID(),
    context?: AcquisitionAttemptContext,
  ): ReturnType<ImportFiles['download']> {
    if (
      context &&
      (!Number.isSafeInteger(context.attempt) ||
        !Number.isSafeInteger(context.maxAttempts) ||
        context.attempt < 1 ||
        context.attempt > context.maxAttempts ||
        context.maxAttempts > MAX_ACQUISITION_ATTEMPTS ||
        !(context.startedAt instanceof Date) ||
        !Number.isFinite(context.startedAt.getTime()))
    )
      throw importError('IMPORT_DEPENDENCY_FAILED');
    const origin = this.config.getOrThrow<string>('AUDIO_ACQUISITION_API_URL');
    const key = this.config.getOrThrow<string>('AUDIO_ACQUISITION_API_KEY');
    return files.download(
      new URL('/audio-imports', origin).toString(),
      path,
      limits.maxBytes,
      signal,
      {
        method: 'POST',
        headers: {
          Accept: 'application/octet-stream, application/problem+json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'X-Import-Request-ID': acquisitionId,
          ...(context
            ? {
                'X-Import-Attempt': String(context.attempt),
                'X-Import-Max-Attempts': String(context.maxAttempts),
                'X-Import-Acquisition-Started-At':
                  context.startedAt.toISOString(),
              }
            : {}),
        },
        body: JSON.stringify({
          url,
          max_bytes: limits.maxBytes,
          max_duration_seconds: limits.maxDuration,
        }),
      },
    );
  }
}
