import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { inspectLocalAudio } from './local-media-validation.service.js';
import {
  CreateLocalMediaSyncDto,
  LOCAL_MEDIA_PROFILE_ID,
} from './local-media-sync.dto.js';
import type { InputReservation } from '../jobs/job.types.js';
import { SnakeCaseRequestPipe } from '../http/snake-case-wire.js';
import { parseRealtimeCommand } from '../realtime/realtime-protocol.js';
import { affectsRealtimeResource } from '../realtime/realtime-dependencies.js';
const reservation: InputReservation = {
  key: 'users/012345678901234567890123/jobs/local/vocals.mp3',
  extension: 'mp3',
  contentType: 'audio/mpeg',
  durationSeconds: 10,
  bytes: 200_000,
  sha256: createHash('sha256').update('fixture').digest('base64'),
};
const audio = () => ({
  streams: [
    {
      codec_type: 'audio',
      codec_name: 'mp3',
      sample_rate: '44100',
      channels: 2,
    },
  ],
  format: { duration: '10', format_name: 'mp3' },
});
it('accepts the full-timeline stereo vocal profile and actual WAV/FLAC originals', () => {
  expect(inspectLocalAudio(audio(), reservation, true)).toBe(10);
  for (const [extension, contentType, codec] of [
    ['wav', 'audio/wav', 'pcm_s16le'],
    ['flac', 'audio/flac', 'flac'],
  ] as const) {
    const data = audio();
    data.streams[0]!.codec_name = codec;
    data.format.format_name = extension;
    expect(
      inspectLocalAudio(
        data,
        { ...reservation, extension, contentType },
        false,
      ),
    ).toBe(10);
  }
});
it('rejects trimmed timelines, fake types, video/multiple streams, non-stereo and non-44.1k vocals', () => {
  const bad = [audio(), audio(), audio(), audio(), audio(), audio()];
  bad[0]!.format.duration = '9.7';
  bad[1]!.format.format_name = 'aac';
  bad[2]!.streams.push({ ...bad[2]!.streams[0]! });
  bad[3]!.streams[0]!.codec_type = 'video';
  bad[4]!.streams[0]!.channels = 1;
  bad[5]!.streams[0]!.sample_rate = '48000';
  for (const data of bad)
    expect(() => inspectLocalAudio(data, reservation, true)).toThrow();
});
it('validates snake_case declarations with canonical base64 hashes and rejects unknown model/flags', async () => {
  const pipe = new SnakeCaseRequestPipe();
  const wire = {
    request_id: '018f2845-8860-438a-8628-294559f43bcb',
    profile_id: LOCAL_MEDIA_PROFILE_ID,
    source_kind: 'file',
    original: {
      extension: 'mp3',
      content_type: 'audio/mpeg',
      bytes: 200_000,
      duration_seconds: 10,
      sha256: reservation.sha256,
    },
    vocals: {
      extension: 'mp3',
      content_type: 'audio/mpeg',
      bytes: 200_000,
      duration_seconds: 10,
      sha256: reservation.sha256,
    },
  };
  const dto = plainToInstance(
    CreateLocalMediaSyncDto,
    pipe.transform(wire, { type: 'body' }),
  );
  expect(
    await validate(dto, { whitelist: true, forbidNonWhitelisted: true }),
  ).toEqual([]);
  dto.original.sha256 = 'a'.repeat(64);
  expect((await validate(dto)).length).toBeGreaterThan(0);
  dto.original.sha256 = reservation.sha256;
  const unsafe = Object.assign(dto, {
    trimEnabled: true,
    workerId: 'untrusted',
  });
  expect(
    (await validate(unsafe, { whitelist: true, forbidNonWhitelisted: true }))
      .length,
  ).toBe(2);
});
it('registers owner full-snapshot sync dependencies without signed grants in socket parameters', () => {
  expect(
    parseRealtimeCommand(
      JSON.stringify({
        type: 'subscribe',
        resource: 'local_media_sync',
        subscription_id: 'sync',
        params: { id: '012345678901234567890123' },
      }),
    ),
  ).not.toBeNull();
  expect(affectsRealtimeResource('local_media_sync', 'local_media_syncs')).toBe(
    true,
  );
  expect(affectsRealtimeResource('local_media_sync', 'audio_jobs')).toBe(true);
  expect(affectsRealtimeResource('local_media_sync', 'users')).toBe(true);
});
