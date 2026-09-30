import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { assertJobRequestNotPurged } from './purged-job-request.js';
import { PurgedJobRequestSchema } from './purged-job-request.schema.js';

describe('purged job request replay protection', () => {
  it.each([
    ['a'.repeat(64), 'JOB_NOT_FOUND'],
    ['b'.repeat(64), 'IDEMPOTENCY_CONFLICT'],
  ])(
    'preserves previous rejection without new admission for hash%s',
    async (requestHash, code) => {
      const findOne = vi.fn(() => ({
        session: vi.fn(() => ({
          lean: vi.fn(async () => ({ requestHash: 'a'.repeat(64) })),
        })),
      }));
      const jobs = { db: { model: vi.fn(() => ({ findOne })) } };
      await expect(
        assertJobRequestNotPurged(
          jobs as never,
          new Types.ObjectId(),
          'request-id',
          requestHash,
          {} as never,
        ),
      ).rejects.toMatchObject({ response: { code } });
    },
  );
  it('allows unused request IDs and keeps compact replay proof until account deletion', async () => {
    const jobs = {
      db: {
        model: vi.fn(() => ({
          findOne: vi.fn(() => ({
            session: vi.fn(() => ({ lean: vi.fn(async () => null) })),
          })),
        })),
      },
    };
    await expect(
      assertJobRequestNotPurged(
        jobs as never,
        new Types.ObjectId(),
        'new-request',
        'a'.repeat(64),
        {} as never,
      ),
    ).resolves.toBeUndefined();
    expect(
      PurgedJobRequestSchema.indexes().some(
        ([, options]) => options.expireAfterSeconds !== undefined,
      ),
    ).toBe(false);
    expect(PurgedJobRequestSchema.paths).not.toHaveProperty('sourceUrl');
    expect(PurgedJobRequestSchema.paths).not.toHaveProperty('inputReservation');
  });
});
