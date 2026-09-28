import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImportFiles } from './import-files.js';
import { randomUUID } from 'node:crypto';

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
  ): ReturnType<ImportFiles['download']> {
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
