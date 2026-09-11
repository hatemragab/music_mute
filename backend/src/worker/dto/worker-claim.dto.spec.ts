import { ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WorkerClaimDto, WorkerSelectorDto } from './worker-request.dto.js';

describe('worker claim wait', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const parse = (value: unknown) =>
    pipe.transform(value, { type: 'body', metatype: WorkerClaimDto });

  it('keeps old requests immediate by default', async () => {
    const result = await parse({ sessionId: randomUUID() });
    expect(result.waitSeconds).toBe(0);
  });

  it.each([0, 1, 25])('accepts a wait of %i seconds', async (waitSeconds) => {
    const result = await parse({ sessionId: randomUUID(), waitSeconds });
    expect(result.waitSeconds).toBe(waitSeconds);
  });

  it.each([-1, 26, 1.5, '25', null, true, {}, []])(
    'rejects invalid waits %j',
    async (waitSeconds) => {
      await expect(
        parse({ sessionId: randomUUID(), waitSeconds }),
      ).rejects.toThrow();
    },
  );

  it('does not accept claim-only waits on assignment callbacks', async () => {
    await expect(
      pipe.transform(
        {
          sessionId: randomUUID(),
          jobId: '0123456789abcdef01234567',
          attemptId: randomUUID(),
          generation: 1,
          waitSeconds: 25,
        },
        { type: 'body', metatype: WorkerSelectorDto },
      ),
    ).rejects.toThrow();
  });
});
