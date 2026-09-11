import { ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WorkerOutputDto } from './worker-output.dto.js';

describe('worker output attestations', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const valid = () => ({
    jobId: '0123456789abcdef01234567',
    attemptId: randomUUID(),
    sessionId: randomUUID(),
    generation: 1,
    eventId: randomUUID(),
    bytes: 100,
    durationSeconds: 10,
    sha256: Buffer.alloc(32).toString('base64'),
    contentType: 'audio/mpeg',
    playable: true,
    voiceOnly: true,
  });
  const parse = (value: unknown) =>
    pipe.transform(value, { type: 'body', metatype: WorkerOutputDto });
  it('accepts explicit MP3 integrity and acoustic attestations', async () => {
    await expect(parse(valid())).resolves.toBeInstanceOf(WorkerOutputDto);
  });
  it.each([
    { voiceOnly: false },
    { playable: false },
    { durationSeconds: 600 },
    { durationSeconds: 0 },
    { bytes: '100' },
    { generation: '1' },
    { contentType: 'audio/wav' },
    { key: 'other-user/object' },
    { sha256: 'invalid' },
  ])('rejects invalid or injected output fields %j', async (change) => {
    await expect(parse({ ...valid(), ...change })).rejects.toThrow();
  });
});
