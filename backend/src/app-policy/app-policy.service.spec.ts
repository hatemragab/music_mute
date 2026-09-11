import { describe, expect, it, vi } from 'vitest';
import type { Model } from 'mongoose';
import { AppPolicyService } from './app-policy.service.js';
import type { AppPolicy } from './app-policy.schema.js';

describe('live app policy reads', () => {
  it('distinguishes absent policy from database failure', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('private connection details'));
    const service = new AppPolicyService({
      findById: () => ({ lean: () => ({ exec }) }),
    } as unknown as Model<AppPolicy>);
    expect((await service.current()).requireVerifiedEmail).toBe(false);
    await expect(service.current()).rejects.toMatchObject({ status: 503 });
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
