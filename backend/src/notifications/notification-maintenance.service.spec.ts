import { ConfigService } from '@nestjs/config';
import { NotificationMaintenanceService } from './notification-maintenance.service.js';

describe('notification maintenance lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it('does not dispatch when processing is disabled', async () => {
    vi.useFakeTimers();
    const dispatchDue = vi.fn().mockResolvedValue(true);
    const maintenance = new NotificationMaintenanceService(
      new ConfigService({ AUDIO_PROCESSING_ENABLED: false }),
      { dispatchDue } as never,
    );
    maintenance.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(dispatchDue).not.toHaveBeenCalled();
    await maintenance.onModuleDestroy();
  });

  it('bounds a tick and stops its timer at shutdown', async () => {
    vi.useFakeTimers();
    const dispatchDue = vi.fn().mockResolvedValue(true);
    const maintenance = new NotificationMaintenanceService(
      new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
      { dispatchDue } as never,
    );
    maintenance.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dispatchDue).toHaveBeenCalledTimes(10);
    await maintenance.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dispatchDue).toHaveBeenCalledTimes(10);
  });

  it('does not overlap a slow tick', async () => {
    vi.useFakeTimers();
    let finish!: (value: boolean) => void;
    const dispatchDue = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const maintenance = new NotificationMaintenanceService(
      new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
      { dispatchDue } as never,
    );
    maintenance.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(dispatchDue).toHaveBeenCalledTimes(1);
    const shutdown = maintenance.onModuleDestroy();
    finish(false);
    await shutdown;
  });
});
