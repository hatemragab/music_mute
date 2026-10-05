import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { StorageClient } from '../infrastructure/storage.module.js';
import { validComparisonRanges } from '../jobs/comparison-ranges.js';
import type { ObjectIdentity } from '../jobs/job.types.js';
import { SharedMediaDerivationService } from './shared-media-derivation.service.js';

const execute = promisify(execFile);
const ffprobe = ['/usr/bin/ffprobe', '/opt/homebrew/bin/ffprobe'].find(
  (path) => existsSync(path) && existsSync(join(dirname(path), 'ffmpeg')),
);

describe('shared full-MP3 derivation', () => {
  it.skipIf(!ffprobe)(
    'decodes, trims and encodes real MP3 with conditional private I/O and removes scratch',
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), 'musicmute-derivation-fixture-'),
      );
      try {
        const pcm = Buffer.alloc(44_100 * 3 * 4);
        for (let i = 0; i < 44_100 * 3; i++)
          if (i < 44_100 * 0.5 || i >= 44_100 * 2.5) {
            const amplitude = Math.round(
              Math.sin((i / 44_100) * 2 * Math.PI * 440) * 12_000,
            );
            pcm.writeInt16LE(amplitude, i * 4);
            pcm.writeInt16LE(amplitude, i * 4 + 2);
          }
        const input = join(directory, 'fixture.pcm');
        const mp3 = join(directory, 'full.mp3');
        await writeFile(input, pcm);
        await execute(join(dirname(ffprobe!), 'ffmpeg'), [
          '-v',
          'error',
          '-nostdin',
          '-f',
          's16le',
          '-ac',
          '2',
          '-ar',
          '44100',
          '-i',
          input,
          '-c:a',
          'libmp3lame',
          '-b:a',
          '160k',
          mp3,
        ]);
        const body = await readFile(mp3);
        const identity: ObjectIdentity = {
          key: 'shared/url/fixture/full.mp3',
          etag: '"immutable-full"',
          bytes: body.length,
          sha256: createHash('sha256').update(body).digest('base64'),
          contentType: 'audio/mpeg',
        };
        const send = vi.fn(
          async (command: GetObjectCommand | PutObjectCommand) => {
            if (command instanceof GetObjectCommand)
              return { Body: Readable.from(body) };
            const upload = command as PutObjectCommand;
            const chunks: Buffer[] = [];
            for await (const chunk of upload.input.Body as Readable)
              chunks.push(chunk as Buffer);
            expect(upload.input).toMatchObject({
              Key: 'shared/derived.mp3',
              IfNoneMatch: '*',
              ContentType: 'audio/mpeg',
              Metadata: { sha256: upload.input.ChecksumSHA256 },
            });
            expect(
              createHash('sha256')
                .update(Buffer.concat(chunks))
                .digest('base64'),
            ).toBe(upload.input.ChecksumSHA256);
            return {};
          },
        );
        const config = {
          getOrThrow: () => 'private-fixture-bucket',
          get: () => ffprobe,
        };
        const service = new SharedMediaDerivationService(
          { send } as unknown as StorageClient,
          config as unknown as ConfigService,
        );
        let scratch = '';
        const result = await service.derive(identity, 3, async (file) => {
          scratch = file.path;
          expect(existsSync(file.path)).toBe(true);
          expect(validComparisonRanges(file.comparisonRanges)).toBe(true);
          expect(file.comparisonRanges).toHaveLength(2);
          const retained = file.comparisonRanges.reduce(
            (n, [start, end]) => n + end! - start!,
            0,
          );
          expect(retained).toBeLessThan(44_100 * 1.6);
          expect(file.bytes).toBeLessThan(body.length);
          await service.upload(file, 'shared/derived.mp3');
          return 'published';
        });
        expect(result).toBe('published');
        expect(send.mock.calls[0]![0].input).toMatchObject({
          Key: identity.key,
          IfMatch: identity.etag,
        });
        expect(existsSync(scratch)).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('rejects substituted downloaded bytes before invoking publication', async () => {
    const body = Buffer.from('different audio');
    const identity = {
      key: 'shared/full.mp3',
      etag: '"full"',
      bytes: body.length,
      sha256: Buffer.alloc(32, 1).toString('base64'),
      contentType: 'audio/mpeg',
    };
    const send = vi.fn(async () => ({ Body: Readable.from(body) }));
    const service = new SharedMediaDerivationService(
      { send } as unknown as StorageClient,
      { getOrThrow: () => 'bucket' } as unknown as ConfigService,
    );
    const publish = vi.fn();
    await expect(service.derive(identity, 1, publish)).rejects.toMatchObject({
      status: 422,
    });
    expect(publish).not.toHaveBeenCalled();
    // A failed read releases the local capacity slot.
    await expect(service.derive(identity, 1, publish)).rejects.toMatchObject({
      status: 422,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects excessive streamed bytes and caps concurrent scratch/CPU work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn(async () => {
      await gate;
      return { Body: Readable.from(Buffer.alloc(20)) };
    });
    const service = new SharedMediaDerivationService(
      { send } as unknown as StorageClient,
      { getOrThrow: () => 'bucket' } as unknown as ConfigService,
    );
    const identity = {
      key: 'shared/full.mp3',
      etag: '"full"',
      bytes: 10,
      sha256: Buffer.alloc(32, 1).toString('base64'),
      contentType: 'audio/mpeg',
    };
    const running = service.derive(identity, 1, vi.fn());
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await expect(service.derive(identity, 1, vi.fn())).rejects.toMatchObject({
      status: 503,
    });
    release();
    await expect(running).rejects.toMatchObject({ status: 422 });
  });
});
