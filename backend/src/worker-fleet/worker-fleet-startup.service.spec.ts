import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { WorkerMachine } from './machines/worker-machine.schema.js';
import { WorkerFleetPolicy } from './policy/worker-fleet-policy.schema.js';
import { WORKER_FLEET_MODELS } from './worker-fleet.models.js';
import { WorkerFleetStartupService } from './worker-fleet-startup.service.js';

function fixture(enabled: boolean) {
  const init = vi.fn().mockResolvedValue(undefined);
  const updateOne = vi.fn().mockResolvedValue({ acknowledged: true });
  const updateMany = vi.fn().mockResolvedValue({ acknowledged: true });
  const findPolicyById = vi.fn(() => ({
    select: vi.fn(() => ({
      lean: vi.fn().mockResolvedValue({ _id: 'worker-fleet', revision: 1 }),
    })),
  }));
  const model = vi.fn((name: string) => {
    if (name === WorkerFleetPolicy.name)
      return { init, updateOne, findById: findPolicyById };
    if (name === WorkerMachine.name) return { init, updateMany };
    return { init };
  });
  return {
    findPolicyById,
    init,
    model,
    updateOne,
    updateMany,
    startup: new WorkerFleetStartupService(
      { model } as never,
      new ConfigService({ AUDIO_PROCESSING_ENABLED: enabled }),
    ),
  };
}

describe('worker fleet startup', () => {
  it('does not initialize worker collections while processing is disabled', async () => {
    const f = fixture(false);
    await expect(f.startup.onModuleInit()).resolves.toBeUndefined();
    expect(f.model).not.toHaveBeenCalled();
  });

  it('initializes every declared worker collection while enabled', async () => {
    const f = fixture(true);
    await expect(f.startup.onModuleInit()).resolves.toBeUndefined();
    expect(f.model).toHaveBeenCalledTimes(WORKER_FLEET_MODELS.length + 2);
    expect(f.init).toHaveBeenCalledTimes(WORKER_FLEET_MODELS.length);
    expect(f.updateOne).toHaveBeenCalledWith(
      { _id: 'worker-fleet' },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          revision: 0,
          acceptClaims: true,
        }),
      }),
      { upsert: true, setDefaultsOnInsert: true },
    );
    expect(f.updateOne).toHaveBeenCalledOnce();
    expect(f.findPolicyById).toHaveBeenCalledWith('worker-fleet');
    expect(f.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $ne: 'revoked' } }),
      {
        $set: { policyRevision: 1, desiredRevision: 1 },
        $inc: { revision: 1 },
      },
      { runValidators: true },
    );
    expect(f.updateMany).toHaveBeenCalledOnce();
  });

  it('fails with a fixed redacted startup stage', async () => {
    const f = fixture(true);
    f.init.mockRejectedValue(new Error('private database topology'));
    await expect(f.startup.onModuleInit()).rejects.toThrow(
      'Worker fleet schema initialization failed',
    );
  });
});
