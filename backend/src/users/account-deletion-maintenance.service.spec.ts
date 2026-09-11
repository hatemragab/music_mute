import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountDeletionMaintenanceService } from './account-deletion-maintenance.service.js';

afterEach(() => vi.useRealTimers());
describe('account deletion maintenance', () => {
  it('runs without the audio processing enablement flag and continues job storage cleanup', async () => {
    vi.useFakeTimers();
    const cleanup = { advanceDeletion: vi.fn(async () => false) };
    const jobs = { cleanupDue: vi.fn(async () => false) };
    const service = new AccountDeletionMaintenanceService(
      cleanup as never,
      jobs as never,
    );
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(15_000);
    await service.onModuleDestroy();
    expect(cleanup.advanceDeletion).toHaveBeenCalledTimes(2);
    expect(jobs.cleanupDue).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cleanup.advanceDeletion).toHaveBeenCalledTimes(2);
  });
  it('does not overlap a slow cleanup pass', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const cleanup = {
      advanceDeletion: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const jobs = { cleanupDue: vi.fn(async () => false) };
    const service = new AccountDeletionMaintenanceService(
      cleanup as never,
      jobs as never,
    );
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(cleanup.advanceDeletion).toHaveBeenCalledTimes(1);
    release();
    await service.onModuleDestroy();
    expect(jobs.cleanupDue).toHaveBeenCalledTimes(1);
  });
});
