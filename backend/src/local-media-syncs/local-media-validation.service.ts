import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { StorageClient } from '../infrastructure/storage.module.js';
import { authError } from '../auth/auth.errors.js';
import { jobError } from '../jobs/job-errors.js';
import type { InputReservation, ObjectIdentity } from '../jobs/job.types.js';
import { inspectProbe } from '../url-imports/import-probe.js';
import { MAX_AUDIO_DURATION_SECONDS } from '../jobs/media-limits.js';

const execute = promisify(execFile);
const activeLimit = 2;
const validationTimeoutMs = 150_000;
interface AudioProbe {
  streams: {
    codec_type?: string;
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    duration?: string;
  }[];
  format: { format_name?: string; duration?: string };
}
export function inspectLocalAudio(
  value: unknown,
  reservation: InputReservation,
  vocal: boolean,
): number {
  const data = value as AudioProbe;
  const stream = data?.streams?.[0];
  if (
    !data ||
    !Array.isArray(data.streams) ||
    data.streams.length !== 1 ||
    stream?.codec_type !== 'audio'
  )
    throw jobError('UPLOAD_NOT_READY');
  const formats = data.format?.format_name?.split(',') ?? [];
  let type: string;
  let duration: number;
  if (formats.includes('wav') && stream.codec_name?.startsWith('pcm_')) {
    type = 'audio/wav';
    duration = Number(data.format.duration ?? stream.duration);
  } else if (formats.includes('flac') && stream.codec_name === 'flac') {
    type = 'audio/flac';
    duration = Number(data.format.duration ?? stream.duration);
  } else {
    try {
      const result = inspectProbe(data, MAX_AUDIO_DURATION_SECONDS);
      type = result.contentType;
      duration = result.durationSeconds;
    } catch {
      throw jobError('UPLOAD_NOT_READY');
    }
  }
  if (
    type !== reservation.contentType ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > MAX_AUDIO_DURATION_SECONDS ||
    Math.abs(duration - reservation.durationSeconds) > 0.25
  )
    throw jobError('UPLOAD_NOT_READY');
  if (
    vocal &&
    (type !== 'audio/mpeg' ||
      stream.codec_name !== 'mp3' ||
      stream.sample_rate !== '44100' ||
      stream.channels !== 2)
  )
    throw jobError('UPLOAD_NOT_READY');
  return duration;
}
@Injectable()
export class LocalMediaValidationService {
  private active = 0;
  constructor(
    private readonly storage: StorageClient,
    private readonly config: ConfigService,
  ) {}
  async validate(
    pair: { original: InputReservation; vocals: InputReservation },
    identities: { original: ObjectIdentity; vocals: ObjectIdentity },
  ): Promise<{ originalDuration: number; vocalsDuration: number }> {
    if (this.active >= activeLimit) throw authError('SERVICE_UNAVAILABLE');
    this.active++;
    let directory: string | undefined;
    try {
      const disk = await statfs(tmpdir());
      if (
        Number(disk.bavail) * Number(disk.bsize) <
        pair.original.bytes + pair.vocals.bytes + 128_000_000
      )
        throw authError('SERVICE_UNAVAILABLE');
      directory = await mkdtemp(join(tmpdir(), 'musicmute-local-sync-'));
      const signal = AbortSignal.timeout(validationTimeoutMs);
      const originalDuration = await this.validateObject(
        pair.original,
        identities.original,
        join(directory, 'original'),
        false,
        signal,
      );
      const vocalsDuration = await this.validateObject(
        pair.vocals,
        identities.vocals,
        join(directory, 'vocals'),
        true,
        signal,
      );
      if (Math.abs(originalDuration - vocalsDuration) > 0.25)
        throw jobError('UPLOAD_NOT_READY');
      return { originalDuration, vocalsDuration };
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        this.active--;
      }
    }
  }
  private async validateObject(
    reservation: InputReservation,
    identity: ObjectIdentity,
    path: string,
    vocal: boolean,
    signal: AbortSignal,
  ): Promise<number> {
    const response = await this.storage.send(
      new GetObjectCommand({
        Bucket: this.config.getOrThrow<string>('STORAGE_BUCKET'),
        Key: reservation.key,
        IfMatch: identity.etag,
      }),
      { abortSignal: signal },
    );
    if (!(response.Body instanceof Readable))
      throw jobError('UPLOAD_NOT_READY');
    let bytes = 0;
    const hash = createHash('sha256');
    const bounds = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > reservation.bytes)
          return callback(jobError('UPLOAD_NOT_READY'));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      response.Body,
      bounds,
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (
      bytes !== reservation.bytes ||
      hash.digest('base64') !== reservation.sha256
    )
      throw jobError('UPLOAD_NOT_READY');
    const ffprobe = this.config.get<string>(
      'URL_IMPORT_FFPROBE_PATH',
      '/usr/bin/ffprobe',
    );
    let stdout: string;
    try {
      ({ stdout } = await execute(
        ffprobe,
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'file',
          '-format_whitelist',
          'mov,mp3,matroska,ogg,aac,wav,flac',
          '-show_entries',
          'format=duration,format_name:stream=codec_type,codec_name,duration,sample_rate,channels',
          '-of',
          'json',
          path,
        ],
        { signal, timeout: 30_000, maxBuffer: 65_536, killSignal: 'SIGKILL' },
      ));
      const duration = inspectLocalAudio(
        JSON.parse(stdout),
        reservation,
        vocal,
      );
      await execute(
        join(dirname(ffprobe), 'ffmpeg'),
        [
          '-v',
          'error',
          '-xerror',
          '-nostdin',
          '-protocol_whitelist',
          'file',
          '-format_whitelist',
          'mov,mp3,matroska,ogg,aac,wav,flac',
          '-i',
          path,
          '-map',
          '0:a:0',
          '-vn',
          '-sn',
          '-dn',
          '-f',
          'null',
          '-',
        ],
        { signal, timeout: 45_000, maxBuffer: 65_536, killSignal: 'SIGKILL' },
      );
      return duration;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        ['ENOENT', 'EACCES'].includes(String(error.code))
      )
        throw authError('SERVICE_UNAVAILABLE');
      throw jobError('UPLOAD_NOT_READY');
    }
  }
}
