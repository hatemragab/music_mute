import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { StorageClient } from '../infrastructure/storage.module.js';
import type { ObjectIdentity } from '../jobs/job.types.js';
import {
  MAX_AUDIO_DURATION_SECONDS,
  MAX_PREPARED_AUDIO_BYTES,
} from '../jobs/media-limits.js';
import { importError } from '../url-imports/import-errors.js';
import { probeImport } from '../url-imports/import-probe.js';
import {
  isQuietPcmWindow,
  retainedRangesFromWindows,
  TRIM_SAMPLE_RATE,
} from './shared-media-trim.js';

const execute = promisify(execFile);
const TIMEOUT_MS = 150_000;
export interface DerivedMediaFile {
  path: string;
  bytes: number;
  sha256: string;
  comparisonRanges: number[][];
}

/** Bounded file-based postprocessing; never downloads source URLs or loads a model. */
@Injectable()
export class SharedMediaDerivationService {
  private active = false;
  constructor(
    private readonly storage: StorageClient,
    private readonly config: ConfigService,
  ) {}

  async derive<T>(
    full: ObjectIdentity,
    duration: number,
    publish: (file: DerivedMediaFile) => Promise<T>,
  ): Promise<T> {
    if (this.active) throw importError('IMPORT_DEPENDENCY_FAILED');
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      duration > MAX_AUDIO_DURATION_SECONDS ||
      full.contentType !== 'audio/mpeg' ||
      full.bytes > MAX_PREPARED_AUDIO_BYTES
    )
      throw importError('IMPORT_INVALID_AUDIO');
    this.active = true;
    let directory: string | undefined;
    try {
      const disk = await statfs(tmpdir());
      const maxPcmBytes = Math.ceil((duration + 0.25) * TRIM_SAMPLE_RATE) * 4;
      if (
        Number(disk.bavail) * Number(disk.bsize) <
        2 * maxPcmBytes + 2 * full.bytes + 128_000_000
      )
        throw importError('IMPORT_DISK_FULL');
      directory = await mkdtemp(join(tmpdir(), 'musicmute-shared-trim-'));
      const signal = AbortSignal.timeout(TIMEOUT_MS);
      const source = join(directory, 'full.mp3');
      const pcmPath = join(directory, 'full.pcm');
      const trimmed = join(directory, 'trimmed.pcm');
      const output = join(directory, 'trimmed.mp3');
      await this.download(full, source, signal);
      const ffprobe = this.config.get<string>(
        'URL_IMPORT_FFPROBE_PATH',
        '/usr/bin/ffprobe',
      );
      const ffmpeg = join(dirname(ffprobe), 'ffmpeg');
      const probe = await probeImport(
        source,
        MAX_AUDIO_DURATION_SECONDS,
        signal,
        ffprobe,
      );
      if (Math.abs(probe.durationSeconds - duration) > 0.25)
        throw importError('IMPORT_INVALID_AUDIO');
      await execute(
        ffmpeg,
        [
          '-v',
          'error',
          '-xerror',
          '-nostdin',
          '-protocol_whitelist',
          'file',
          '-format_whitelist',
          'mp3',
          '-i',
          source,
          '-map',
          '0:a:0',
          '-vn',
          '-sn',
          '-dn',
          '-ac',
          '2',
          '-ar',
          '44100',
          '-t',
          String(duration + 0.25),
          '-f',
          's16le',
          pcmPath,
        ],
        { signal, timeout: 45_000, maxBuffer: 65_536, killSignal: 'SIGKILL' },
      );
      const bytes = (await stat(pcmPath)).size;
      if (!bytes || bytes % 4 || bytes > maxPcmBytes)
        throw importError('IMPORT_INVALID_AUDIO');
      const ranges = await trimPcmFile(pcmPath, trimmed, bytes / 4);
      await execute(
        ffmpeg,
        [
          '-v',
          'error',
          '-xerror',
          '-nostdin',
          '-protocol_whitelist',
          'file',
          '-f',
          's16le',
          '-ac',
          '2',
          '-ar',
          '44100',
          '-i',
          trimmed,
          '-map_metadata',
          '-1',
          '-c:a',
          'libmp3lame',
          '-compression_level',
          '7',
          '-b:a',
          '160k',
          output,
        ],
        { signal, timeout: 45_000, maxBuffer: 65_536, killSignal: 'SIGKILL' },
      );
      await probeImport(output, MAX_AUDIO_DURATION_SECONDS, signal, ffprobe);
      await execute(
        ffmpeg,
        [
          '-v',
          'error',
          '-xerror',
          '-nostdin',
          '-protocol_whitelist',
          'file',
          '-format_whitelist',
          'mp3',
          '-i',
          output,
          '-f',
          'null',
          '-',
        ],
        { signal, timeout: 30_000, maxBuffer: 65_536, killSignal: 'SIGKILL' },
      );
      const outputBytes = (await stat(output)).size;
      if (!outputBytes || outputBytes > MAX_PREPARED_AUDIO_BYTES)
        throw importError('IMPORT_TOO_LARGE');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(output))
        hash.update(chunk as Buffer);
      return await publish({
        path: output,
        bytes: outputBytes,
        sha256: hash.digest('base64'),
        comparisonRanges: ranges,
      });
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true });
      } finally {
        this.active = false;
      }
    }
  }

  /** Caller persists the exact reservation in the permanent ledger before PUT. */
  async upload(file: DerivedMediaFile, key: string) {
    await this.storage.send(
      new PutObjectCommand({
        Bucket: this.config.getOrThrow<string>('STORAGE_BUCKET'),
        Key: key,
        Body: createReadStream(file.path),
        ContentLength: file.bytes,
        ContentType: 'audio/mpeg',
        ChecksumSHA256: file.sha256,
        Metadata: { sha256: file.sha256 },
        IfNoneMatch: '*',
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  }

  private async download(
    identity: ObjectIdentity,
    path: string,
    signal: AbortSignal,
  ) {
    const response = await this.storage.send(
      new GetObjectCommand({
        Bucket: this.config.getOrThrow<string>('STORAGE_BUCKET'),
        Key: identity.key,
        IfMatch: identity.etag,
      }),
      { abortSignal: signal },
    );
    if (!(response.Body instanceof Readable))
      throw importError('IMPORT_INVALID_AUDIO');
    let bytes = 0;
    const hash = createHash('sha256');
    await pipeline(
      response.Body,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > identity.bytes)
            return callback(importError('IMPORT_TOO_LARGE'));
          hash.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (bytes !== identity.bytes || hash.digest('base64') !== identity.sha256)
      throw importError('IMPORT_INVALID_AUDIO');
  }
}

/** Scan/write bounded blocks so even the longest allowed song stays off the heap. */
export async function trimPcmFile(
  source: string,
  destination: string,
  samples: number,
): Promise<[number, number][]> {
  const input = await open(source, 'r');
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const silent: boolean[] = [];
    const window = Buffer.alloc(441 * 4);
    for (let position = 0; position < samples; position += 441) {
      const length = Math.min(441, samples - position) * 4;
      const read = await input.read(window, 0, length, position * 4);
      if (read.bytesRead !== length) throw importError('IMPORT_INVALID_AUDIO');
      silent.push(isQuietPcmWindow(window.subarray(0, length)));
    }
    const ranges = retainedRangesFromWindows(silent, samples);
    output = await open(destination, 'wx', 0o600);
    const block = Buffer.alloc(65_536 * 4);
    for (const [start, end] of ranges) {
      const fade = Math.min(220, Math.floor((end - start) / 2));
      for (let position = start; position < end; position += 65_536) {
        const count = Math.min(65_536, end - position);
        const read = await input.read(block, 0, count * 4, position * 4);
        if (read.bytesRead !== count * 4)
          throw importError('IMPORT_INVALID_AUDIO');
        for (let offset = 0; offset < count; offset++) {
          const sample = position + offset;
          let gain = 1;
          if (fade && start > 0 && sample < start + fade)
            gain *= fade === 1 ? 0 : (sample - start) / (fade - 1);
          if (fade && end < samples && sample >= end - fade)
            gain *= fade === 1 ? 0 : (end - 1 - sample) / (fade - 1);
          if (gain !== 1)
            for (let channel = 0; channel < 2; channel++) {
              const index = offset * 4 + channel * 2;
              block.writeInt16LE(
                Math.round(block.readInt16LE(index) * gain),
                index,
              );
            }
        }
        const written = await output.write(block.subarray(0, count * 4));
        if (written.bytesWritten !== count * 4)
          throw importError('IMPORT_DEPENDENCY_FAILED');
      }
    }
    return ranges;
  } finally {
    await output?.close();
    await input.close();
  }
}
