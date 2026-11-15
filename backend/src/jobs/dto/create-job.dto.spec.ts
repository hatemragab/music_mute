import { ValidationPipe } from '@nestjs/common';
import { CreateJobDto } from './create-job.dto.js';

const payload = {
  policyVersion: 2,
  preparationProfileId: 'audio-cap-aac-lc-160-v1',
  source: 'audio_file',
  requestId: '12345678-1234-4567-8123-123456789ABC',
  input: {
    extension: 'mp3',
    contentType: 'audio/mpeg',
    bytes: 1024,
    durationSeconds: 30,
    sha256: Buffer.alloc(32).toString('base64'),
  },
};
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
});
const transform = (value: unknown) =>
  pipe.transform(value, { type: 'body', metatype: CreateJobDto });

describe('create-job HTTP declaration', () => {
  it('accepts a trimmed source title and client intake metadata', async () => {
    expect(
      await transform({
        ...payload,
        sourceTitle: '  لقاء صوتي  ',
        sourceKind: 'url',
        sourceUrl: '  https://www.youtube.com/watch?v=jNQXAC9IVRw  ',
        clientStartedAt: '2026-09-10T10:00:00.000Z',
      }),
    ).toMatchObject({
      sourceTitle: 'لقاء صوتي',
      sourceKind: 'url',
      sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      clientStartedAt: '2026-09-10T10:00:00.000Z',
    });
  });
  it('rejects non-canonical YouTube source URLs', async () => {
    for (const sourceUrl of [
      'https://youtu.be/jNQXAC9IVRw',
      'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5',
      'https://example.test/watch?v=jNQXAC9IVRw',
      'javascript:alert(1)',
    ]) {
      await expect(
        transform({ ...payload, sourceKind: 'url', sourceUrl }),
      ).rejects.toThrow();
    }
  });
  it('rejects blank, control-character, oversized, and null titles', async () => {
    for (const sourceTitle of ['   ', 'bad\nname', 'a'.repeat(201), null]) {
      await expect(transform({ ...payload, sourceTitle })).rejects.toThrow();
    }
  });
  it('normalizes request IDs and validates nested input', async () => {
    expect(await transform(payload)).toMatchObject({
      requestId: payload.requestId.toLowerCase(),
      input: payload.input,
    });
  });
  it('rejects owner/key injection and nested unknown fields', async () => {
    await expect(
      transform({ ...payload, userId: 'another-owner' }),
    ).rejects.toThrow();
    await expect(
      transform({
        ...payload,
        input: { ...payload.input, key: 'another/key' },
      }),
    ).rejects.toThrow();
  });
  it('does not coerce numeric strings and enforces inclusive standard limits', async () => {
    await expect(
      transform({ ...payload, input: { ...payload.input, bytes: '1024' } }),
    ).rejects.toThrow();
    await expect(
      transform({
        ...payload,
        input: {
          ...payload.input,
          bytes: 50_000_000,
          durationSeconds: 1_200,
        },
      }),
    ).resolves.toBeInstanceOf(CreateJobDto);
    await expect(
      transform({ ...payload, input: { ...payload.input, bytes: 50_000_001 } }),
    ).rejects.toThrow();
    await expect(
      transform({
        ...payload,
        input: { ...payload.input, durationSeconds: 1_200.001 },
      }),
    ).rejects.toThrow();
  });
  it('rejects missing or non-object input and invalid idempotency IDs', async () => {
    await expect(transform({ requestId: payload.requestId })).rejects.toThrow();
    await expect(transform({ ...payload, input: [] })).rejects.toThrow();
    await expect(
      transform({ ...payload, requestId: 'not-a-uuid' }),
    ).rejects.toThrow();
  });
});
