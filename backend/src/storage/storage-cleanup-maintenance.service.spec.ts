import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageCleanupService } from './storage-cleanup.service.js';
import { StorageCleanupMaintenanceService } from './storage-cleanup-maintenance.service.js';

describe('StorageCleanupMaintenanceService', () => {
  afterEach(() => vi.useRealTimers());

  it('runs independently and does not overlap cleanup work', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const cleanupDue = vi.fn(
      () => new Promise<boolean>((resolve) => (release = () => resolve(true))),
    );
    const service = new StorageCleanupMaintenanceService({
      cleanupDue,
    } as unknown as StorageCleanupService);
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cleanupDue).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cleanupDue).toHaveBeenCalledOnce();
    release();
    await service.onModuleDestroy();
  });
});
