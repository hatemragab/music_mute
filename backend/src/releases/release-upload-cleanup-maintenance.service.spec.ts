import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReleaseUploadCleanupService } from './release-upload-cleanup.service.js';
import { ReleaseUploadCleanupMaintenanceService } from './release-upload-cleanup-maintenance.service.js';

describe('ReleaseUploadCleanupMaintenanceService', () => {
  afterEach(() => vi.useRealTimers());

  it('starts immediately and never overlaps cleanup scheduling', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const scheduleDue = vi.fn(
      () => new Promise<boolean>((resolve) => (release = () => resolve(true))),
    );
    const service = new ReleaseUploadCleanupMaintenanceService({
      scheduleDue,
    } as unknown as ReleaseUploadCleanupService);

    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(scheduleDue).toHaveBeenCalledOnce();
    release();
    await service.onModuleDestroy();
  });
});
