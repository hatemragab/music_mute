import { ConfigService } from '@nestjs/config';
import { NotificationMaintenanceService } from './notification-maintenance.service.js';

describe('notification maintenance lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it('retains completed history without dispatching when processing is disabled', async () => {
    vi.useFakeTimers();
    const dispatchDue = vi.fn().mockResolvedValue(true);
    const scheduleCompletedRetention = vi.fn().mockResolvedValue(undefined);
    const scheduleInactiveRetention = vi.fn().mockResolvedValue(undefined);
    const maintenance = new NotificationMaintenanceService(
      new ConfigService({ AUDIO_PROCESSING_ENABLED: false }),
      { dispatchDue, scheduleCompletedRetention } as never,
      { scheduleInactiveRetention } as never,
    );
    maintenance.onApplicationBootstrap();
    expect(scheduleCompletedRetention).not.toHaveBeenCalled();
    expect(scheduleInactiveRetention).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(dispatchDue).not.toHaveBeenCalled();
    expect(scheduleCompletedRetention).toHaveBeenCalledTimes(3);
    expect(scheduleInactiveRetention).toHaveBeenCalledTimes(3);
    await maintenance.onModuleDestroy();
  });

  it('bounds a tick and stops its timer at shutdown', async () => {
    vi.useFakeTimers();
    const dispatchDue = vi.fn().mockResolvedValue(true);
    const scheduleCompletedRetention = vi.fn().mockResolvedValue(undefined);
    const scheduleInactiveRetention = vi.fn().mockResolvedValue(undefined);
    const maintenance = new NotificationMaintenanceService(
      new ConfigService({ AUDIO_PROCESSING_ENABLED: true }),
      { dispatchDue, scheduleCompletedRetention } as never,
      { scheduleInactiveRetention } as never,
    );
    maintenance.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(dispatchDue).toHaveBeenCalledTimes(10);
    expect(scheduleCompletedRetention).toHaveBeenCalledTimes(1);
    expect(scheduleInactiveRetention).toHaveBeenCalledTimes(1);
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
      { dispatchDue, scheduleCompletedRetention: vi.fn() } as never,
      { scheduleInactiveRetention: vi.fn() } as never,
    );
    maintenance.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(dispatchDue).toHaveBeenCalledTimes(1);
    const shutdown = maintenance.onModuleDestroy();
    finish(false);
    await shutdown;
  });
});
