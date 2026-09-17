import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { WORKER_FLEET_MODELS } from './worker-fleet.models.js';
import { WorkerFleetStartupService } from './worker-fleet-startup.service.js';

function fixture(enabled: boolean) {
  const init = vi.fn().mockResolvedValue(undefined);
  const model = vi.fn(() => ({ init }));
  return {
    init,
    model,
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
    expect(f.model).toHaveBeenCalledTimes(WORKER_FLEET_MODELS.length);
    expect(f.init).toHaveBeenCalledTimes(WORKER_FLEET_MODELS.length);
  });

  it('fails with a fixed redacted startup stage', async () => {
    const f = fixture(true);
    f.init.mockRejectedValue(new Error('private database topology'));
    await expect(f.startup.onModuleInit()).rejects.toThrow(
      'Worker fleet schema initialization failed',
    );
  });
});
