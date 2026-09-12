import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { WorkerFailDto } from './worker-event.dto.js';

const body = {
  jobId: '507f1f77bcf86cd799439011',
  attemptId: '2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29',
  sessionId: '3bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29',
  eventId: '4bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29',
  generation: 1,
  stopped: true,
  stage: 'validating',
};

describe('WorkerFailDto', () => {
  it('does not let workers submit the server-owned upload-expiry code', async () => {
    const dto = plainToInstance(WorkerFailDto, {
      ...body,
      code: 'UPLOAD_EXPIRED',
    });

    expect(await validate(dto)).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'code' })]),
    );
  });
});
